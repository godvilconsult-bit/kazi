import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Logger } from "pino";
import type { z } from "zod";
import { estimateCostUsd, supportsServerFallback, type TokenCounts } from "./pricing";

/**
 * The only path to Claude (CLAUDE.md rule 8, docs/06-ROUTER.md). Every call gets a timeout,
 * SDK retries with backoff on 408/409/429/5xx, Zod-validated output, and a usage record the
 * caller charges to the task.
 */

export type LlmPurpose = "decompose" | "summarize" | "judge" | "agent";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmUsage extends TokenCounts {
  /** The model that actually answered (differs from the requested one after a refusal fallback). */
  model: string;
  costUsd: number;
}

interface BaseRequest {
  purpose: LlmPurpose;
  model: string;
  /** Stable instructions (cached). Must not contain per-request data. */
  system: string;
  /** Per-request content. Untrusted text must already be wrapped by the caller. */
  user: string;
  effort: Effort;
  maxTokens?: number;
  /** PDFs Claude reads natively, placed before the text (e.g. signed URLs of client attachments). */
  documents?: readonly { url: string }[];
  /** For log context only. */
  taskId?: string;
  subtaskId?: string;
}

export interface StructuredRequest<T> extends BaseRequest {
  schema: z.ZodType<T>;
}

export interface TextRequest extends BaseRequest {
  /** Let Claude search the web (Anthropic-hosted tool), at most this many searches. */
  webSearch?: { maxUses: number };
}

export interface LlmClient {
  structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: LlmUsage }>;
  text(req: TextRequest): Promise<{ text: string; usage: LlmUsage }>;
}

export class LlmError extends Error {
  override readonly name: string = "LlmError";
  constructor(
    message: string,
    readonly code: "REFUSED" | "TRUNCATED" | "INVALID_OUTPUT" | "API",
    readonly usage?: LlmUsage,
  ) {
    super(message);
  }
}

export interface AnthropicLlmOptions {
  apiKey: string;
  /** Per-attempt timeout; SDK retries count separately. */
  timeoutMs?: number;
  maxRetries?: number;
  log: Logger;
}

const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;
  private readonly log: Logger;

  constructor(opts: AnthropicLlmOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs ?? 5 * 60_000,
      maxRetries: opts.maxRetries ?? 3,
    });
    this.log = opts.log;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: LlmUsage }> {
    // One extra attempt if the model's JSON fails schema validation (rare with structured outputs).
    for (let attempt = 1; ; attempt++) {
      const res = await this.call(req, (params) =>
        this.client.beta.messages.parse({
          ...params,
          output_config: { ...params.output_config, format: betaZodOutputFormat(req.schema) },
        }),
      );
      const parsed = req.schema.safeParse(res.message.parsed_output);
      if (parsed.success) return { data: parsed.data, usage: res.usage };
      this.log.warn(
        {
          purpose: req.purpose,
          taskId: req.taskId,
          attempt,
          issues: parsed.error.issues.slice(0, 5),
        },
        "llm structured output failed validation",
      );
      if (attempt >= 2)
        throw new LlmError("structured output failed validation", "INVALID_OUTPUT", res.usage);
    }
  }

  async text(req: TextRequest): Promise<{ text: string; usage: LlmUsage }> {
    const tools: Anthropic.Beta.BetaToolUnion[] = req.webSearch
      ? [{ type: "web_search_20260209", name: "web_search", max_uses: req.webSearch.maxUses }]
      : [];
    const turns: Anthropic.Beta.BetaMessageParam[] = [];
    let usage: LlmUsage | undefined;
    let text = "";
    // Server tools can pause a long turn (stop_reason "pause_turn"): send the partial turn back to resume.
    for (let round = 0; round < 4; round++) {
      // Streaming so long agent outputs never hit HTTP timeouts.
      const res = await this.call(
        req,
        (params) =>
          this.client.beta.messages
            .stream({ ...params, ...(tools.length ? { tools } : {}) })
            .finalMessage(),
        turns,
      );
      usage = addUsage(usage, res.usage);
      text += res.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (res.message.stop_reason !== "pause_turn") break;
      turns.push({
        role: "assistant",
        content: res.message.content as Anthropic.Beta.BetaContentBlockParam[],
      });
    }
    text = text.trim();
    if (!usage) throw new LlmError("no response", "API");
    if (text.length === 0) throw new LlmError("empty response", "INVALID_OUTPUT", usage);
    return { text, usage };
  }

  private async call<M extends Anthropic.Beta.BetaMessage>(
    req: BaseRequest,
    send: (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<M>,
    continuation: readonly Anthropic.Beta.BetaMessageParam[] = [],
  ): Promise<{ message: M; usage: LlmUsage }> {
    const fallback = supportsServerFallback(req.model);
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxTokens ?? 16_000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: req.documents?.length
            ? [
                ...req.documents.map((d) => ({
                  type: "document" as const,
                  source: { type: "url" as const, url: d.url },
                })),
                { type: "text" as const, text: req.user },
              ]
            : req.user,
        },
        ...continuation,
      ],
      output_config: { effort: req.effort },
      ...(fallback ? { betas: [SERVER_FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };
    const started = Date.now();
    let message: M;
    try {
      message = await send(params);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Anthropic.APIError) {
        throw new LlmError(`Claude API error ${err.status ?? "?"}: ${err.message}`, "API");
      }
      throw err;
    }
    const usage = toUsage(message);
    this.log.info(
      {
        purpose: req.purpose,
        taskId: req.taskId,
        subtaskId: req.subtaskId,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd: Number(usage.costUsd.toFixed(6)),
        ms: Date.now() - started,
        stop: message.stop_reason,
      },
      "llm call",
    );
    if (message.stop_reason === "refusal") {
      throw new LlmError(
        `declined (${message.stop_details?.category ?? "unknown"})`,
        "REFUSED",
        usage,
      );
    }
    if (message.stop_reason === "max_tokens") {
      throw new LlmError("output hit max_tokens", "TRUNCATED", usage);
    }
    return { message, usage };
  }
}

function toUsage(message: Anthropic.Beta.BetaMessage): LlmUsage {
  const counts: TokenCounts = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    ...cacheWrites(message.usage),
    webSearches: message.usage.server_tool_use?.web_search_requests ?? 0,
  };
  return { model: message.model, ...counts, costUsd: estimateCostUsd(message.model, counts) };
}

/** Sum usages (e.g. all calls for one task). */
export function addUsage(a: LlmUsage | undefined, b: LlmUsage): LlmUsage {
  if (!a) return b;
  return {
    model: b.model,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: (a.cacheWrite1hTokens ?? 0) + (b.cacheWrite1hTokens ?? 0),
    webSearches: (a.webSearches ?? 0) + (b.webSearches ?? 0),
    costUsd: a.costUsd + b.costUsd,
  };
}

/** Split cache writes by TTL (1-hour writes bill 2× input, 5-minute writes 1.25×). */
export function cacheWrites(u: {
  cache_creation_input_tokens: number | null;
  cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } | null;
}): { cacheWriteTokens: number; cacheWrite1hTokens: number } {
  if (u.cache_creation) {
    return {
      cacheWriteTokens: u.cache_creation.ephemeral_5m_input_tokens,
      cacheWrite1hTokens: u.cache_creation.ephemeral_1h_input_tokens,
    };
  }
  return { cacheWriteTokens: u.cache_creation_input_tokens ?? 0, cacheWrite1hTokens: 0 };
}
