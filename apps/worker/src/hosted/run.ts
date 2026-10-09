import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import type { Prisma, PrismaClient } from "@kazi/db";
import type { ObjectStorage } from "@kazi/config/storage";
import {
  aiCostEstimateSchema,
  aiCostNano,
  hostedConfigSchema,
  hostedRunMode,
  renderAgentTask,
  type HostedConfig,
} from "@kazi/shared";
import { buildAgentRequest, type ExecutorConfig } from "../executor/dispatch";
import { applyAgentResult } from "../executor/results";
import type { JobSink } from "../jobs/sink";
import {
  LlmError,
  addBatchUsage,
  batchTextParams,
  batchUsage,
  messageText,
  type BatchApi,
  type LlmClient,
  type LlmUsage,
} from "../llm";

/**
 * Runs Kazi-hosted agents (docs/11-HOSTED-AGENTS.md §4). Express → one standard call. Economy →
 * a Message Batch, collected later by `pollHostedRuns` (the worker never blocks on a batch).
 * Results go through `applyAgentResult`, exactly like a third-party agent's response.
 */

const RULES = readFileSync(new URL("./prompts/rules.md", import.meta.url), "utf8");
const MAX_ROUNDS = 4;

export function hostedSystem(config: HostedConfig): string {
  return `${RULES}\n<agent_instructions>\n${config.instructions}\n</agent_instructions>`;
}

export interface HostedDeps {
  prisma: PrismaClient;
  llm: LlmClient;
  batch: BatchApi;
  jobs: JobSink;
  usdcDecimals: () => Promise<number>;
  config: ExecutorConfig;
  log: Logger;
  now?: () => Date;
  storage?: ObjectStorage;
}

type Outcome =
  | { ok: true; text: string; usage: LlmUsage }
  | { ok: false; code: string; message: string; usage?: LlmUsage | undefined };

export async function runHosted(
  deps: HostedDeps,
  subtaskId: string,
  attempt: number,
): Promise<"stale" | "submitted" | "pending" | "done"> {
  const now = deps.now?.() ?? new Date();
  const st = await deps.prisma.subtask.findUnique({
    where: { id: subtaskId },
    include: { task: true, provider: true },
  });
  if (!st || st.status !== "DISPATCHED" || st.attempts !== attempt) return "stale";
  if (st.provider?.hosting !== "KAZI")
    throw new Error(`subtask ${subtaskId} is not on a hosted agent`);
  const config = hostedConfigSchema.parse(st.provider.hostedConfig);
  const log = deps.log.child({ taskId: st.taskId, subtaskId, attempt, providerId: st.provider.id });

  const existing = await deps.prisma.hostedRun.findUnique({
    where: { subtaskId_attempt: { subtaskId, attempt } },
  });
  if (existing && existing.status !== "RUNNING") return "done";
  if (existing?.mode === "BATCH" && existing.batchId) return "pending";

  const mode = existing?.mode ?? hostedRunMode(st.task.speed, st.task.deadline, now);
  const run =
    existing ?? (await deps.prisma.hostedRun.create({ data: { subtaskId, attempt, mode } }));

  const request = await buildAgentRequest(deps, st, attempt);
  const params = {
    model: config.model,
    system: hostedSystem(config),
    user: renderAgentTask(request),
    effort: config.effort,
    maxTokens: config.maxOutputTokens,
    webSearch: config.webSearch,
  };

  if (mode === "BATCH") {
    const batchId = await deps.batch.submit([
      { customId: run.id, params: batchTextParams(params) },
    ]);
    await deps.prisma.hostedRun.update({ where: { id: run.id }, data: { batchId } });
    log.info({ batchId }, "hosted run submitted as batch");
    return "submitted";
  }

  let outcome: Outcome;
  try {
    const res = await deps.llm.text({
      purpose: "agent",
      ...params,
      webSearch: params.webSearch ?? undefined,
      taskId: st.taskId,
      subtaskId,
    });
    outcome = { ok: true, ...res };
  } catch (err) {
    if (!(err instanceof LlmError) || (err.code !== "REFUSED" && err.code !== "TRUNCATED"))
      throw err;
    outcome =
      err.code === "REFUSED"
        ? {
            ok: false,
            code: "DECLINED",
            message: "This request can't be completed.",
            usage: err.usage,
          }
        : {
            ok: false,
            code: "OUTPUT_TOO_LONG",
            message: "The result exceeded the length limit.",
            usage: err.usage,
          };
  }
  await finishRun(deps, run.id, outcome, log);
  return "done";
}

/** Collect finished Economy batches; resubmit paused turns. Safe to run concurrently with itself. */
export async function pollHostedRuns(
  deps: HostedDeps,
): Promise<{ checked: number; finished: number }> {
  const runs = await deps.prisma.hostedRun.findMany({
    where: { status: "RUNNING", mode: "BATCH", batchId: { not: null } },
    include: { subtask: { include: { task: true, provider: true } } },
    take: 200,
  });
  let finished = 0;
  for (const run of runs) {
    const log = deps.log.child({
      subtaskId: run.subtaskId,
      attempt: run.attempt,
      batchId: run.batchId,
    });
    const st = run.subtask;
    const current = st.status === "DISPATCHED" && st.attempts === run.attempt;
    const batchId = run.batchId as string;
    const status = await deps.batch.status(batchId);
    if (status !== "ended") {
      if (!current) {
        // The attempt timed out or was settled elsewhere: stop paying for it.
        await deps.batch.cancel(batchId).catch(() => undefined);
        await deps.prisma.hostedRun.update({
          where: { id: run.id },
          data: { status: "FAILED", error: "superseded", finishedAt: new Date() },
        });
      }
      continue;
    }

    const item = (await deps.batch.results(batchId)).get(run.id);
    const prior = run.usage as unknown as LlmUsage | null;
    if (!item || item.type !== "succeeded") {
      const reason = !item ? "missing" : item.type === "errored" ? item.error : item.type;
      await finishRun(
        deps,
        run.id,
        {
          ok: false,
          code: "BATCH_FAILED",
          message: `batch request ${reason}`,
          usage: prior ?? undefined,
        },
        log,
      );
      finished++;
      continue;
    }

    const m = item.message;
    const usage = prior ? addBatchUsage(prior, batchUsage(m)) : batchUsage(m);
    const partial = run.partial + messageText(m);
    const turns = [...(run.turns as unknown as Anthropic.MessageParam[])];
    if (m.stop_reason === "pause_turn" && turns.length < MAX_ROUNDS - 1 && current) {
      turns.push({ role: "assistant", content: m.content as Anthropic.ContentBlockParam[] });
      const config = hostedConfigSchema.parse(st.provider?.hostedConfig);
      const request = await buildAgentRequest(deps, st, run.attempt);
      const nextId = await deps.batch.submit([
        {
          customId: run.id,
          params: batchTextParams({
            model: config.model,
            system: hostedSystem(config),
            user: renderAgentTask(request),
            effort: config.effort,
            maxTokens: config.maxOutputTokens,
            webSearch: config.webSearch,
            turns,
          }),
        },
      ]);
      await deps.prisma.hostedRun.update({
        where: { id: run.id },
        data: {
          batchId: nextId,
          turns: turns as unknown as Prisma.InputJsonValue,
          partial,
          usage: usage as unknown as Prisma.InputJsonValue,
          costNano: aiCostNano(usage.model, usage, { batch: true }).toString(),
        },
      });
      log.info({ next: nextId }, "hosted batch paused; resubmitted");
      continue;
    }
    const outcome: Outcome =
      m.stop_reason === "refusal"
        ? { ok: false, code: "DECLINED", message: "This request can't be completed.", usage }
        : m.stop_reason === "max_tokens"
          ? {
              ok: false,
              code: "OUTPUT_TOO_LONG",
              message: "The result exceeded the length limit.",
              usage,
            }
          : partial.trim().length === 0
            ? { ok: false, code: "EMPTY_OUTPUT", message: "The agent produced no text.", usage }
            : { ok: true, text: partial.trim(), usage };
    await finishRun(deps, run.id, outcome, log);
    finished++;
  }
  return { checked: runs.length, finished };
}

/** Record cost, apply the result to the subtask, update the agent's cost estimate. */
async function finishRun(
  deps: HostedDeps,
  runId: string,
  outcome: Outcome,
  log: Logger,
): Promise<void> {
  const run = await deps.prisma.hostedRun.findUniqueOrThrow({
    where: { id: runId },
    include: { subtask: { select: { providerId: true } } },
  });
  const batch = run.mode === "BATCH";
  const cost = outcome.usage ? aiCostNano(outcome.usage.model, outcome.usage, { batch }) : 0n;
  const updated = await deps.prisma.hostedRun.updateMany({
    where: { id: runId, status: "RUNNING" },
    data: {
      status: outcome.ok ? "SUCCEEDED" : "FAILED",
      ...(outcome.ok ? {} : { error: `${outcome.code}: ${outcome.message}` }),
      ...(outcome.usage ? { usage: outcome.usage as unknown as Prisma.InputJsonValue } : {}),
      costNano: cost.toString(),
      finishedAt: new Date(),
    },
  });
  if (updated.count !== 1) return; // another poller finished it

  log.info({ ok: outcome.ok, mode: run.mode, costUsd: Number(cost) / 1e9 }, "hosted run finished");
  if (outcome.usage && run.subtask.providerId) {
    await updateCostEstimate(deps.prisma, run.subtask.providerId, outcome.usage);
  }
  await applyAgentResult(
    { prisma: deps.prisma, jobs: deps.jobs, log, ...(deps.now ? { now: deps.now } : {}) },
    run.subtaskId,
    run.attempt,
    outcome.ok
      ? {
          status: "completed",
          output: {
            text: outcome.text,
            meta: { hosted: true, mode: run.mode, model: outcome.usage.model },
          },
        }
      : { status: "failed", error: { code: outcome.code, message: outcome.message } },
  );
}

/** Rolling (exponential, α = 0.2) per-task cost estimate at both speeds, from the same token usage. */
export async function updateCostEstimate(
  prisma: PrismaClient,
  providerId: string,
  usage: LlmUsage,
): Promise<void> {
  const econ = aiCostNano(usage.model, usage, { batch: true });
  const exp = aiCostNano(usage.model, usage);
  const p = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { aiCost: true },
  });
  const prev = aiCostEstimateSchema.safeParse(p?.aiCost);
  const blend = (old: string, x: bigint) => (BigInt(old) * 4n + x + 4n) / 5n; // round up
  const next = prev.success
    ? {
        economyNano: blend(prev.data.economyNano, econ).toString(),
        expressNano: blend(prev.data.expressNano, exp).toString(),
        samples: prev.data.samples + 1,
        updatedAt: new Date().toISOString(),
      }
    : {
        economyNano: econ.toString(),
        expressNano: exp.toString(),
        samples: 1,
        updatedAt: new Date().toISOString(),
      };
  await prisma.provider.update({ where: { id: providerId }, data: { aiCost: next } });
}
