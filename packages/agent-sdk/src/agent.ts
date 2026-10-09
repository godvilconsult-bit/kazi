import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  SUBTASK_ID_HEADER,
  agentRequestSchema,
  capabilityOutputSchema,
  type AgentCallback,
  type AgentManifest,
  type AgentOutput,
  type AgentRequest,
  type AgentResponse,
} from "@kazi/shared";
import { MemoryIdempotencyStore, type IdempotencyStore } from "./idempotency";
import { signPayload, verifySignature } from "./signature";

/** `createKaziAgent` (docs/05-AGENT-SPEC.md §7): signature check, idempotency, validation, routing. */

export interface AgentContext {
  readonly request: AgentRequest;
  /** Aborted when the subtask deadline (or the manifest timeout) passes. */
  readonly signal: AbortSignal;
  /** Report progress (async agents only; a no-op for sync agents). */
  progress(fraction: number, message?: string): Promise<void>;
  /** Fail the subtask with a machine-readable code, e.g. `ctx.fail("INPUT_UNREADABLE", "...")`. */
  fail(code: string, message: string): never;
}

/** Return the output to complete the subtask; throw (or `ctx.fail`) to fail it. */
export type CapabilityHandler = (ctx: AgentContext) => Promise<AgentOutput>;

export class AgentFailure extends Error {
  override readonly name = "AgentFailure";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface KaziAgentOptions {
  manifest: AgentManifest;
  /** Webhook secret shown once when the agent was registered on Kazi. */
  secret: string;
  handlers: Readonly<Record<string, CapabilityHandler>>;
  store?: IdempotencyStore;
  fetch?: typeof fetch;
  onError?: (err: unknown, request: AgentRequest | undefined) => void;
  /** How long completed results are kept for duplicate requests. Default 7 days. */
  idempotencyTtlSec?: number;
}

export interface RawRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  rawBody: string;
}

export interface RawResponse {
  status: number;
  body: unknown;
}

export interface KaziAgent {
  readonly manifest: AgentManifest;
  handle(req: RawRequest): Promise<RawResponse>;
  /** Resolves when every background (async-mode) job has finished; for tests and graceful shutdown. */
  idle(): Promise<void>;
}

const failed = (code: string, message: string): AgentResponse => ({
  status: "failed",
  error: { code, message },
});

export function createKaziAgent(opts: KaziAgentOptions): KaziAgent {
  const store = opts.store ?? new MemoryIdempotencyStore();
  const doFetch = opts.fetch ?? globalThis.fetch;
  const ttl = opts.idempotencyTtlSec ?? 7 * 86_400;
  const background = new Set<Promise<void>>();
  const unsupported = opts.manifest.capabilities.filter((c) => !opts.handlers[c]);
  if (unsupported.length > 0)
    throw new Error(`no handler for claimed capabilities: ${unsupported.join(", ")}`);

  async function postCallback(req: AgentRequest, body: AgentCallback): Promise<void> {
    const raw = JSON.stringify(body);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await doFetch(req.callbackUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: signPayload(raw, opts.secret),
            [SUBTASK_ID_HEADER]: req.subtaskId,
          },
          body: raw,
        });
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return;
        throw new Error(`callback HTTP ${res.status}`);
      } catch (err) {
        if (attempt >= 5) {
          opts.onError?.(err, req);
          return;
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }

  async function execute(req: AgentRequest, async: boolean): Promise<AgentResponse> {
    const handler = opts.handlers[req.capability];
    if (!handler)
      return failed("UNSUPPORTED_CAPABILITY", `this agent does not offer ${req.capability}`);
    const timeoutMs = Math.min(
      new Date(req.deadline).getTime() - Date.now(),
      (opts.manifest.limits?.timeoutSec ?? 86_400) * 1000,
    );
    const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
    const ctx: AgentContext = {
      request: req,
      signal,
      progress: async (fraction, message) => {
        if (async)
          await postCallback(req, {
            status: "progress",
            progress: Math.min(1, Math.max(0, fraction)),
            message,
          });
      },
      fail: (code, message) => {
        throw new AgentFailure(code, message);
      },
    };
    try {
      const output = capabilityOutputSchema.safeParse(await handler(ctx));
      if (!output.success)
        return failed("OUTPUT_INVALID", output.error.issues.map((i) => i.message).join("; "));
      return { status: "completed", output: output.data };
    } catch (err) {
      if (err instanceof AgentFailure) return failed(err.code, err.message);
      opts.onError?.(err, req);
      if (signal.aborted) return failed("TIMEOUT", "deadline passed before the work finished");
      return failed("INTERNAL", "the agent hit an unexpected error");
    }
  }

  async function run(req: RawRequest): Promise<RawResponse> {
    const sig = verifySignature(req.rawBody, req.headers[SIGNATURE_HEADER], opts.secret);
    if (!sig.ok)
      return {
        status: 401,
        body: failed("BAD_SIGNATURE", `signature ${sig.reason.toLowerCase()}`),
      };

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(req.rawBody);
    } catch {
      return { status: 400, body: failed("INVALID_REQUEST", "body is not JSON") };
    }
    const parsed = agentRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        status: 400,
        body: failed("INVALID_REQUEST", parsed.error.issues.map((i) => i.message).join("; ")),
      };
    }
    const request = parsed.data;
    if (!opts.manifest.capabilities.includes(request.capability)) {
      return {
        status: 422,
        body: failed("UNSUPPORTED_CAPABILITY", `this agent does not offer ${request.capability}`),
      };
    }

    const key = req.headers[IDEMPOTENCY_HEADER] ?? `${request.subtaskId}:${request.attempt}`;
    const asyncMode = opts.manifest.mode === "async";
    if (!(await store.claim(key, ttl))) {
      const prior = await store.get(key);
      if (prior === "PENDING" || prior === undefined) {
        return asyncMode
          ? { status: 202, body: { status: "accepted" } }
          : { status: 409, body: failed("IN_PROGRESS", "this job is already running") };
      }
      return { status: asyncMode ? 202 : 200, body: asyncMode ? { status: "accepted" } : prior };
    }

    if (!asyncMode) {
      const response = await execute(request, false);
      await store.complete(key, response, ttl);
      return { status: 200, body: response };
    }

    const job = (async () => {
      const response = await execute(request, true);
      await store.complete(key, response, ttl);
      await postCallback(
        request,
        response.status === "completed"
          ? { status: "completed", output: response.output }
          : {
              status: "failed",
              error:
                response.status === "failed" ? response.error : { code: "INTERNAL", message: "" },
            },
      );
    })();
    background.add(job);
    void job.finally(() => background.delete(job));
    return { status: 202, body: { status: "accepted" } };
  }

  return {
    manifest: opts.manifest,
    async handle(req) {
      if (req.method === "GET" && req.path.endsWith("/health"))
        return { status: 200, body: { ok: true } };
      if (req.method === "GET" && req.path.endsWith("/.well-known/kazi-agent.json")) {
        return { status: 200, body: opts.manifest };
      }
      if (req.method !== "POST")
        return { status: 405, body: failed("METHOD_NOT_ALLOWED", "use POST") };
      return run(req);
    },
    async idle() {
      while (background.size > 0) await Promise.allSettled([...background]);
    },
  };
}
