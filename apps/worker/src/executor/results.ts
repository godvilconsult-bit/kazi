import type { Logger } from "pino";
import type { Prisma } from "@kazi/db";
import { type PrismaClient } from "@kazi/db";
import { jobIds, transition, type AgentOutput, type SubtaskEvent } from "@kazi/shared";
import type { ObjectStorage } from "@kazi/config/storage";
import { FileImportError, importAgentFiles } from "../files/files";
import type { JobSink } from "../jobs/sink";

/**
 * Apply what a provider sent back for one attempt (sync response or async callback), and record
 * attempts that failed without output (agent error, timeout). Stale results — for an attempt that
 * is no longer current — are logged and ignored, so duplicate deliveries are harmless.
 */

export type AgentResult =
  | { status: "completed"; output: AgentOutput }
  | { status: "failed"; error: { code: string; message: string } }
  | { status: "progress"; progress: number; message?: string | undefined };

export interface ResultDeps {
  prisma: PrismaClient;
  jobs: JobSink;
  log: Logger;
  now?: (() => Date) | undefined;
  /** Copies files an agent returns into Kazi's bucket (05-AGENT-SPEC §4). */
  storage?: ObjectStorage | undefined;
  fetch?: typeof fetch | undefined;
}

export async function applyAgentResult(
  deps: ResultDeps,
  subtaskId: string,
  attempt: number,
  result: AgentResult,
): Promise<"applied" | "stale"> {
  const now = deps.now?.() ?? new Date();
  const st = await deps.prisma.subtask.findUnique({ where: { id: subtaskId } });
  const providerId = st?.providerId;
  if (!st || st.status !== "DISPATCHED" || st.attempts !== attempt || !providerId) {
    deps.log.info(
      { subtaskId, attempt, status: st?.status, current: st?.attempts },
      "stale agent result ignored",
    );
    if (st)
      await event(deps.prisma, st.taskId, "STALE_AGENT_RESULT", {
        subtaskId,
        attempt,
        status: result.status,
      });
    return "stale";
  }

  if (result.status === "progress") {
    await event(deps.prisma, st.taskId, "SUBTASK_PROGRESS", {
      subtaskId,
      index: st.index,
      progress: result.progress,
      ...(result.message ? { message: result.message.slice(0, 500) } : {}),
    });
    return "applied";
  }

  const latencyMs = st.dispatchedAt ? now.getTime() - st.dispatchedAt.getTime() : null;
  if (result.status === "completed" && result.output.files?.length && deps.storage) {
    const task = await deps.prisma.task.findUniqueOrThrow({ where: { id: st.taskId }, select: { clientId: true } });
    try {
      result = {
        status: "completed",
        output: {
          ...result.output,
          files: await importAgentFiles(
            { prisma: deps.prisma, storage: deps.storage, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
            { taskId: st.taskId, clientId: task.clientId, subtaskId, attempt },
            result.output.files,
          ),
        },
      };
    } catch (err) {
      const message = err instanceof FileImportError ? err.message : "a returned file could not be downloaded";
      deps.log.warn({ err, subtaskId, attempt }, "agent output file import failed");
      return (await recordFailedAttempt(deps, st.id, attempt, "AGENT_ERROR", { code: "FILE_UNAVAILABLE", message }, latencyMs))
        ? "applied"
        : "stale";
    }
  }
  if (result.status === "completed") {
    const submission = await deps.prisma.$transaction(async (tx) => {
      const moved = await tx.subtask.updateMany({
        where: { id: st.id, status: "DISPATCHED", attempts: attempt },
        data: { status: transition("subtask", "DISPATCHED", "SUBMIT") },
      });
      if (moved.count !== 1) return null;
      const sub = await tx.submission.create({
        data: {
          subtaskId: st.id,
          providerId,
          attempt,
          output: result.output as Prisma.InputJsonValue,
          latencyMs,
        },
      });
      await tx.taskEvent.create({
        data: {
          taskId: st.taskId,
          type: "SUBTASK_SUBMITTED",
          data: { subtaskId, index: st.index, attempt },
        },
      });
      return sub;
    });
    if (!submission) return "stale";
    await deps.jobs.add(
      "evaluator",
      "evaluate",
      { submissionId: submission.id },
      jobIds.evaluate(submission.id),
    );
    return "applied";
  }

  return (await recordFailedAttempt(deps, st.id, attempt, "AGENT_ERROR", result.error, latencyMs))
    ? "applied"
    : "stale";
}

/** An attempt that produced no output: store it (for history and retry feedback) and move to REJECTED. */
export async function recordFailedAttempt(
  deps: Pick<ResultDeps, "prisma">,
  subtaskId: string,
  attempt: number,
  reason: Extract<SubtaskEvent, "AGENT_ERROR" | "TIMEOUT">,
  error: { code: string; message: string },
  latencyMs: number | null,
): Promise<boolean> {
  return deps.prisma.$transaction(async (tx) => {
    const st = await tx.subtask.findUnique({ where: { id: subtaskId } });
    if (!st?.providerId) return false;
    const moved = await tx.subtask.updateMany({
      where: { id: subtaskId, status: "DISPATCHED", attempts: attempt },
      data: { status: transition("subtask", "DISPATCHED", reason) },
    });
    if (moved.count !== 1) return false;
    const message = error.message.slice(0, 1_000);
    await tx.submission.upsert({
      where: { subtaskId_attempt: { subtaskId, attempt } },
      update: {},
      create: {
        subtaskId,
        providerId: st.providerId,
        attempt,
        output: { error: { code: error.code, message } },
        accepted: false,
        latencyMs,
        evaluation: { feedback: `The previous attempt failed (${error.code}): ${message}` },
      },
    });
    await tx.taskEvent.create({
      data: {
        taskId: st.taskId,
        type: reason === "TIMEOUT" ? "SUBTASK_TIMED_OUT" : "SUBTASK_AGENT_ERROR",
        data: { subtaskId, index: st.index, attempt, code: error.code },
      },
    });
    return true;
  });
}

async function event(
  prisma: PrismaClient,
  taskId: string,
  type: string,
  data: Prisma.InputJsonObject,
) {
  await prisma.taskEvent.create({ data: { taskId, type, data } });
}
