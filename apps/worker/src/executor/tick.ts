import type { Logger } from "pino";
import type { PrismaClient } from "@kazi/db";
import { jobIds, transition, type SubtaskStatus } from "@kazi/shared";
import type { JobSink } from "../jobs/sink";
import { notifyTaskClient } from "../notify";
import { offersTick } from "./offers";
import { recordFailedAttempt } from "./results";

/**
 * Executor heartbeat (docs/06-ROUTER.md §4). Scans active tasks and enqueues the next step for
 * each subtask. Safe to run concurrently with itself and with job handlers: every state change is
 * a conditional update and every enqueue has a deterministic job id.
 */

export interface TickConfig {
  maxAttempts: number;
  /** Client review window after delivery; then milestones release automatically. */
  reviewWindowHours: number;
}

export interface TickDeps {
  prisma: PrismaClient;
  jobs: JobSink;
  config: TickConfig;
  log: Logger;
  now?: () => Date;
}

const DONE: ReadonlySet<SubtaskStatus> = new Set(["ACCEPTED", "RELEASED"]);
const DEAD: ReadonlySet<SubtaskStatus> = new Set(["FAILED", "REFUNDED"]);

export async function executorTick(deps: TickDeps): Promise<{ tasks: number; enqueued: number }> {
  const now = deps.now?.() ?? new Date();
  const tasks = await deps.prisma.task.findMany({
    where: { status: { in: ["FUNDED", "IN_PROGRESS"] } },
    include: { subtasks: { where: { kind: "WORK" }, orderBy: { index: "asc" } } },
  });
  let enqueued = 0;
  const add = async (...args: Parameters<JobSink["add"]>) => {
    await deps.jobs.add(...args);
    enqueued++;
  };

  for (const task of tasks) {
    const log = deps.log.child({ taskId: task.id });
    const status = new Map(task.subtasks.map((s) => [s.index, s.status as SubtaskStatus]));

    for (const st of task.subtasks) {
      switch (st.status) {
        case "PENDING": {
          const deps_ = st.dependsOn.map((i) => status.get(i));
          if (deps_.some((s) => s !== undefined && DEAD.has(s))) {
            const moved = await deps.prisma.subtask.updateMany({
              where: { id: st.id, status: "PENDING" },
              data: { status: transition("subtask", "PENDING", "ABANDON") },
            });
            if (moved.count === 1) {
              status.set(st.index, "FAILED");
              await event(deps.prisma, task.id, "SUBTASK_ABANDONED", {
                subtaskId: st.id,
                index: st.index,
              });
            }
          } else if (deps_.every((s) => s !== undefined && DONE.has(s))) {
            await add(
              "executor",
              "dispatch",
              { subtaskId: st.id, attempt: 1 },
              jobIds.dispatch(st.id, 1),
            );
          }
          break;
        }
        case "DISPATCHED":
          if (st.timeoutAt && st.timeoutAt <= now) {
            await recordFailedAttempt(
              deps,
              st.id,
              st.attempts,
              "TIMEOUT",
              {
                code: "TIMEOUT",
                message: "No result arrived before the attempt's time limit.",
              },
              st.dispatchedAt ? now.getTime() - st.dispatchedAt.getTime() : null,
            );
          }
          break;
        case "SUBMITTED": {
          const sub = await deps.prisma.submission.findUnique({
            where: { subtaskId_attempt: { subtaskId: st.id, attempt: st.attempts } },
          });
          if (sub)
            await add("evaluator", "evaluate", { submissionId: sub.id }, jobIds.evaluate(sub.id));
          break;
        }
        case "REJECTED":
          if (st.attempts < deps.config.maxAttempts + st.revisions && task.deadline > now) {
            await add(
              "executor",
              "dispatch",
              { subtaskId: st.id, attempt: st.attempts + 1 },
              jobIds.dispatch(st.id, st.attempts + 1),
            );
          } else {
            const moved = await deps.prisma.subtask.updateMany({
              where: { id: st.id, status: "REJECTED", attempts: st.attempts },
              data: { status: transition("subtask", "REJECTED", "FAIL") },
            });
            if (moved.count === 1) {
              status.set(st.index, "FAILED");
              if (st.providerId) {
                await deps.prisma.provider.update({
                  where: { id: st.providerId },
                  data: { failedCount: { increment: 1 } },
                });
                await add(
                  "executor",
                  "reputation",
                  { providerId: st.providerId },
                  jobIds.reputation(st.providerId, now.getTime()),
                );
              }
              await event(deps.prisma, task.id, "SUBTASK_FAILED", {
                subtaskId: st.id,
                index: st.index,
                attempts: st.attempts,
              });
              log.warn(
                { subtaskId: st.id, attempts: st.attempts },
                "subtask failed for good; milestone will be refunded",
              );
            }
          }
          break;
        default:
          break;
      }
    }

    // Delivery: every step finished, at least one accepted → client review window starts.
    const all = [...status.values()];
    const settled = all.every((s) => DONE.has(s) || DEAD.has(s));
    if (task.status === "IN_PROGRESS" && settled && all.some((s) => DONE.has(s))) {
      const reviewUntil = new Date(now.getTime() + deps.config.reviewWindowHours * 3_600_000);
      const moved = await deps.prisma.task.updateMany({
        where: { id: task.id, status: "IN_PROGRESS" },
        data: {
          status: transition("task", "IN_PROGRESS", "DELIVER"),
          deliveredAt: now,
          reviewUntil,
        },
      });
      if (moved.count === 1) {
        await event(deps.prisma, task.id, "STATUS_DELIVERED", {
          reviewUntil: reviewUntil.toISOString(),
        });
        await notifyTaskClient(deps.prisma, task.id, {
          type: "DELIVERED",
          title: "Your task is ready to review",
          body: `"${task.title}" was delivered. Approve it, or ask for a revision before ${reviewUntil.toUTCString()}.`,
        });
        log.info({ reviewUntil }, "task delivered");
      }
    }
  }
  await offersTick(deps);
  return { tasks: tasks.length, enqueued };
}

async function event(
  prisma: PrismaClient,
  taskId: string,
  type: string,
  data: Record<string, string | number>,
) {
  await prisma.taskEvent.create({ data: { taskId, type, data } });
}
