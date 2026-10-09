import type { Logger } from "pino";
import type { Hex } from "viem";
import type { PrismaClient } from "@kazi/db";
import { jobIds } from "@kazi/shared";
import type { EscrowOperator } from "../chain/operator";
import type { JobSink } from "../jobs/sink";

/**
 * Payout worker (docs/10-BUILD-PLAN Phase 3 step 5). Decides which milestones to release or
 * refund and sends those transactions, always checking the escrow first. The DB status changes
 * only when the indexer sees the event (CLAUDE.md rule 3: escrow is the source of truth).
 */

export interface PayoutDeps {
  prisma: PrismaClient;
  jobs: JobSink;
  operator: EscrowOperator;
  log: Logger;
  now?: () => Date;
}

const ACCEPTED_OR_DONE = new Set(["ACCEPTED", "RELEASED"]);
const DEAD = new Set(["FAILED", "REFUNDED"]);

/** Enqueue every release/refund that is due. Idempotent (deterministic job ids + onchain check). */
export async function payoutsTick(deps: PayoutDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  let enqueued = 0;
  const tasks = await deps.prisma.task.findMany({
    where: { status: { in: ["FUNDED", "IN_PROGRESS", "DELIVERED"] } },
    include: { subtasks: { orderBy: { index: "asc" } } },
  });

  for (const task of tasks) {
    const work = task.subtasks.filter((s) => s.kind === "WORK");
    const service = task.subtasks.find((s) => s.kind === "SERVICE_FEE");

    // Failed steps are refunded right away; the rest of the task carries on.
    for (const st of work) {
      if (st.status === "FAILED") {
        await deps.jobs.add("payouts", "refund", { subtaskId: st.id }, jobIds.refund(st.id));
        enqueued++;
      }
    }

    const allDead = work.length > 0 && work.every((s) => DEAD.has(s.status));
    const approved =
      task.status === "DELIVERED" &&
      (task.approvedAt !== null || (task.reviewUntil !== null && task.reviewUntil <= now));

    if (approved) {
      for (const st of work) {
        if (st.status === "ACCEPTED") {
          await deps.jobs.add("payouts", "release", { subtaskId: st.id }, jobIds.release(st.id));
          enqueued++;
        }
      }
    }
    if (service && service.status === "PENDING") {
      // The service fee follows the work: released once delivery is approved, refunded if nothing was delivered.
      if (allDead) {
        await deps.jobs.add(
          "payouts",
          "refund",
          { subtaskId: service.id },
          jobIds.refund(service.id),
        );
        enqueued++;
      } else if (approved && work.some((s) => ACCEPTED_OR_DONE.has(s.status))) {
        await deps.jobs.add(
          "payouts",
          "release",
          { subtaskId: service.id },
          jobIds.release(service.id),
        );
        enqueued++;
      }
    }
  }
  return enqueued;
}

/** Send one release/refund, after confirming the milestone is still FUNDED onchain. */
export async function settleMilestone(
  deps: PayoutDeps,
  subtaskId: string,
  action: "release" | "refund",
): Promise<"sent" | "already-settled" | "skipped"> {
  const st = await deps.prisma.subtask.findUnique({
    where: { id: subtaskId },
    include: { task: true },
  });
  if (!st) return "skipped";
  const expected =
    action === "release"
      ? st.kind === "SERVICE_FEE"
        ? "PENDING"
        : "ACCEPTED"
      : st.kind === "SERVICE_FEE"
        ? "PENDING"
        : "FAILED";
  if (st.status !== expected) return "skipped";

  const taskId = st.task.onchainId as Hex;
  const onchain = await deps.operator.milestone(taskId, st.index);
  if (onchain.status !== "FUNDED") return "already-settled"; // the indexer will (or did) record it
  const hash =
    action === "release"
      ? await deps.operator.release(taskId, st.index)
      : await deps.operator.refund(taskId, st.index);
  await deps.prisma.taskEvent.create({
    data: {
      taskId: st.taskId,
      type: action === "release" ? "MILESTONE_RELEASE_SENT" : "MILESTONE_REFUND_SENT",
      data: { subtaskId, index: st.index, txHash: hash },
    },
  });
  deps.log.info(
    { taskId: st.taskId, subtaskId, index: st.index, action, hash },
    "milestone settlement sent",
  );
  return "sent";
}
