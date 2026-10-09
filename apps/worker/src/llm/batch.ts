import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import { cacheWrites, type Effort, type LlmUsage } from "./client";
import { estimateCostUsd } from "./pricing";

/**
 * Message Batches: the same requests at 50% of the token price, answered asynchronously (most
 * within an hour, at most 24 h). Server tools (web search) work in batches; refusal `fallbacks`
 * and streaming don't. Used for Economy runs of Kazi-hosted agents (docs/11-HOSTED-AGENTS.md).
 */

export interface TextParamsInput {
  model: string;
  system: string;
  user: string;
  effort: Effort;
  maxTokens: number;
  webSearch?: { maxUses: number } | null;
  /** Assistant turns carried across `pause_turn` rounds. */
  turns?: readonly Anthropic.MessageParam[];
}

/** Request body for one batched text request. The system prompt is cached for 1 h (batches run long). */
export function batchTextParams(r: TextParamsInput): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: r.model,
    max_tokens: r.maxTokens,
    system: [{ type: "text", text: r.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: r.user }, ...(r.turns ?? [])],
    output_config: { effort: r.effort },
    ...(r.webSearch
      ? {
          tools: [
            { type: "web_search_20260209", name: "web_search", max_uses: r.webSearch.maxUses },
          ],
        }
      : {}),
  };
}

export type BatchItem =
  | { type: "succeeded"; message: Anthropic.Message }
  | { type: "errored"; error: string }
  | { type: "expired" }
  | { type: "canceled" };

/** The slice of the Batches API Kazi uses; a fake implements it in tests. */
export interface BatchApi {
  submit(
    requests: readonly { customId: string; params: Anthropic.MessageCreateParamsNonStreaming }[],
  ): Promise<string>;
  status(batchId: string): Promise<"in_progress" | "canceling" | "ended">;
  results(batchId: string): Promise<Map<string, BatchItem>>;
  cancel(batchId: string): Promise<void>;
}

export function anthropicBatchApi(client: Anthropic): BatchApi {
  return {
    async submit(requests) {
      const batch = await client.messages.batches.create({
        requests: requests.map((r) => ({ custom_id: r.customId, params: r.params })),
      });
      return batch.id;
    },
    async status(batchId) {
      return (await client.messages.batches.retrieve(batchId)).processing_status;
    },
    async results(batchId) {
      const out = new Map<string, BatchItem>();
      for await (const item of await client.messages.batches.results(batchId)) {
        const r = item.result;
        out.set(
          item.custom_id,
          r.type === "succeeded"
            ? { type: "succeeded", message: r.message }
            : r.type === "errored"
              ? { type: "errored", error: r.error.error.message }
              : { type: r.type },
        );
      }
      return out;
    },
    async cancel(batchId) {
      await client.messages.batches.cancel(batchId);
    },
  };
}

/** Usage of a batched message, priced at batch rates (tokens halved; searches full price). */
export function batchUsage(m: Anthropic.Message): LlmUsage {
  const counts = {
    inputTokens: m.usage.input_tokens,
    outputTokens: m.usage.output_tokens,
    cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
    ...cacheWrites(m.usage),
    webSearches: m.usage.server_tool_use?.web_search_requests ?? 0,
  };
  return { model: m.model, ...counts, costUsd: estimateCostUsd(m.model, counts, { batch: true }) };
}

export function messageText(m: Anthropic.Message): string {
  return m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

export type BatchTextResult =
  | { id: string; ok: true; text: string; usage: LlmUsage; stopReason: string | null }
  | { id: string; ok: false; error: string; usage?: LlmUsage };

/**
 * Blocking helper for scripts: run requests as one batch and wait. (The worker never blocks on a
 * batch; it polls — see hosted/run.ts.)
 */
export async function batchText(
  api: BatchApi,
  requests: readonly (TextParamsInput & { id: string })[],
  opts: { pollMs?: number; maxWaitMs?: number; log: Logger },
): Promise<BatchTextResult[]> {
  const state = new Map(
    requests.map((r) => [
      r.id,
      {
        req: r,
        turns: [] as Anthropic.MessageParam[],
        text: "",
        usage: undefined as LlmUsage | undefined,
      },
    ]),
  );
  const done: BatchTextResult[] = [];
  for (let round = 0; round < 4 && state.size > 0; round++) {
    const batchId = await api.submit(
      [...state.values()].map(({ req, turns }) => ({
        customId: req.id,
        params: batchTextParams({ ...req, turns }),
      })),
    );
    opts.log.info({ batchId, requests: state.size, round }, "batch submitted");
    const started = Date.now();
    while ((await api.status(batchId)) !== "ended") {
      if (Date.now() - started > (opts.maxWaitMs ?? 24 * 3_600_000)) {
        await api.cancel(batchId);
        throw new Error(`batch ${batchId} still running after ${opts.maxWaitMs} ms; cancelled`);
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 30_000));
    }
    for (const [id, item] of await api.results(batchId)) {
      const entry = state.get(id);
      if (!entry) continue;
      if (item.type !== "succeeded") {
        state.delete(id);
        done.push({
          id,
          ok: false,
          error: item.type === "errored" ? item.error : item.type,
          ...(entry.usage ? { usage: entry.usage } : {}),
        });
        continue;
      }
      const m = item.message;
      const usage = batchUsage(m);
      entry.usage = entry.usage ? addBatchUsage(entry.usage, usage) : usage;
      entry.text += messageText(m);
      if (m.stop_reason === "pause_turn" && round < 3) {
        entry.turns.push({
          role: "assistant",
          content: m.content as Anthropic.ContentBlockParam[],
        });
        continue;
      }
      state.delete(id);
      done.push(
        m.stop_reason === "refusal" || m.stop_reason === "max_tokens"
          ? { id, ok: false, error: `stopped: ${m.stop_reason}`, usage: entry.usage }
          : {
              id,
              ok: true,
              text: entry.text.trim(),
              usage: entry.usage,
              stopReason: m.stop_reason,
            },
      );
    }
  }
  for (const [id, entry] of state) {
    done.push({
      id,
      ok: false,
      error: "still paused after 4 rounds",
      ...(entry.usage ? { usage: entry.usage } : {}),
    });
  }
  return done;
}

export function addBatchUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
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
