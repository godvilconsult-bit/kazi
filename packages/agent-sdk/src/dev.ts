import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  SUBTASK_ID_HEADER,
  agentCallbackSchema,
  agentResponseSchema,
  runChecks,
  type AgentCallback,
  type AgentOutput,
  type AgentRequest,
  type CheckFailure,
} from "@kazi/shared";
import { signPayload, verifySignature } from "./signature";

export { sampleTask } from "@kazi/shared";

/**
 * `kazi-agent dev` (docs/05-AGENT-SPEC.md §7): a local mock of Kazi. Sends one signed sample task
 * to your agent, receives sync responses or signed async callbacks, and runs the same
 * deterministic checks as Kazi's evaluator. (Kazi's LLM judge runs only on Kazi.)
 */

export interface DevTaskOptions {
  endpoint: string;
  secret: string;
  capability: string;
  instructions: string;
  input: string;
  rubric: string[];
  format: "markdown" | "text" | "json" | "file";
  mustInclude?: string[];
  timeoutSec: number;
  fetch?: typeof fetch;
  onEvent?: (line: string) => void;
}

export interface DevTaskResult {
  ok: boolean;
  mode: "sync" | "async";
  latencyMs: number;
  output?: AgentOutput;
  error?: { code: string; message: string };
  checks: CheckFailure[];
  callbacks: AgentCallback[];
  problems: string[];
}

export async function runDevTask(opts: DevTaskOptions): Promise<DevTaskResult> {
  const say = opts.onEvent ?? (() => {});
  const problems: string[] = [];
  const callbacks: AgentCallback[] = [];
  const subtaskId = `dev_${randomUUID().slice(0, 8)}`;
  let settle: (cb: AgentCallback) => void = () => {};
  const finished = new Promise<AgentCallback>((resolve) => (settle = resolve));

  // Mock of Kazi's callback endpoint: verifies the agent's signature like Kazi does.
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const header = req.headers[SIGNATURE_HEADER];
      const sig = verifySignature(raw, Array.isArray(header) ? header[0] : header, opts.secret);
      if (!sig.ok) {
        problems.push(`callback signature ${sig.reason.toLowerCase()}`);
        res.writeHead(401).end();
        return;
      }
      const parsed = agentCallbackSchema.safeParse(JSON.parse(raw || "null"));
      if (!parsed.success) {
        problems.push("callback body does not match the protocol");
        res.writeHead(400).end();
        return;
      }
      callbacks.push(parsed.data);
      say(
        `← callback: ${parsed.data.status}${parsed.data.status === "progress" ? ` ${Math.round(parsed.data.progress * 100)}%` : ""}`,
      );
      res.writeHead(202).end();
      if (parsed.data.status !== "progress") settle(parsed.data);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const request: AgentRequest = {
    subtaskId,
    attempt: 1,
    capability: opts.capability,
    instructions: opts.instructions,
    input: { text: opts.input },
    acceptance: {
      rubric: opts.rubric,
      format: opts.format,
      ...(opts.mustInclude?.length ? { mustInclude: opts.mustInclude } : {}),
    },
    deadline: new Date(Date.now() + opts.timeoutSec * 1000).toISOString(),
    callbackUrl: `http://127.0.0.1:${port}/agent/callback/${subtaskId}?attempt=1`,
    budget: "1.00",
  };
  const rawBody = JSON.stringify(request);
  const started = Date.now();
  say(`→ POST ${opts.endpoint} (${opts.capability})`);
  try {
    const res = await (opts.fetch ?? globalThis.fetch)(opts.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signPayload(rawBody, opts.secret),
        [SUBTASK_ID_HEADER]: subtaskId,
        [IDEMPOTENCY_HEADER]: `${subtaskId}:1`,
      },
      body: rawBody,
      signal: AbortSignal.timeout(opts.timeoutSec * 1000),
    });
    const body = agentResponseSchema.safeParse(await res.json().catch(() => null));
    if (!body.success) {
      problems.push(`HTTP ${res.status}: the response body does not match the protocol`);
      return {
        ok: false,
        mode: "sync",
        latencyMs: Date.now() - started,
        checks: [],
        callbacks,
        problems,
      };
    }
    say(`← HTTP ${res.status}: ${body.data.status}`);

    let final: AgentCallback | undefined;
    let mode: "sync" | "async" = "sync";
    if (body.data.status === "accepted") {
      mode = "async";
      if (res.status !== 202)
        problems.push(`async acknowledgement should be HTTP 202, got ${res.status}`);
      final = await Promise.race([
        finished,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), opts.timeoutSec * 1000)),
      ]);
      if (!final) problems.push(`no completed/failed callback within ${opts.timeoutSec}s`);
    } else {
      final = body.data;
    }
    const latencyMs = Date.now() - started;
    if (final?.status === "completed") {
      const checks = runChecks({ output: final.output, acceptance: request.acceptance });
      return {
        ok: checks.length === 0 && problems.length === 0,
        mode,
        latencyMs,
        output: final.output,
        checks,
        callbacks,
        problems,
      };
    }
    return {
      ok: false,
      mode,
      latencyMs,
      ...(final?.status === "failed" ? { error: final.error } : {}),
      checks: [],
      callbacks,
      problems,
    };
  } finally {
    server.close();
  }
}
