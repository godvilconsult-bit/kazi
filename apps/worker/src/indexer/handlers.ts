import { notify } from "../notify";
import type { Logger } from "pino";
import type { PublicClient } from "viem";
import { z } from "zod";
import type { ChainEvent, Prisma, PrismaClient, Task } from "@kazi/db";
import type { Deployment } from "@kazi/config/deployments";
import {
  canTransition,
  stakingVaultAbi,
  transition,
  type SubtaskEvent,
  type TaskEvent as TaskTransitionEvent,
} from "@kazi/shared";

export type ContractKind = "TaskEscrow" | "AgentRegistry" | "StakingVault" | "FeeDistributor";

interface Ctx {
  client: PublicClient;
  deployment: Deployment;
  log: Logger;
}

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uint = z.string().regex(/^\d+$/);

const taskFunded = z.object({
  taskId: hex32,
  client: z.string(),
  totalAmount: uint,
  feeBps: z.number().or(uint),
});
const milestoneReleased = z.object({ taskId: hex32, index: uint, providerAmount: uint, fee: uint });
const milestoneRefunded = z.object({ taskId: hex32, index: uint, amount: uint });
const disputeResolved = z.object({
  taskId: hex32,
  index: uint,
  clientShareBps: z.number().or(uint),
});
const byTask = z.object({ taskId: hex32 });
const byProvider = z.object({ providerId: uint });

/**
 * Applies one indexed event to DB state. Every branch is idempotent: it checks the current
 * state first and does nothing when the change was already applied.
 */
export async function applyChainEvent(
  prisma: PrismaClient,
  kind: ContractKind,
  ev: ChainEvent,
  ctx: Ctx,
): Promise<void> {
  if (kind === "TaskEscrow") return applyEscrowEvent(prisma, ev, ctx);
  if (kind === "AgentRegistry") return applyRegistryEvent(prisma, ev);
  if (kind === "StakingVault") return applyVaultEvent(prisma, ev, ctx);
  // FeeDistributor events are stored for metrics (/token page) — no DB state to change yet.
}

async function applyEscrowEvent(prisma: PrismaClient, ev: ChainEvent, ctx: Ctx) {
  switch (ev.name) {
    case "TaskFunded": {
      const a = taskFunded.parse(ev.args);
      const task = await taskByOnchainId(prisma, a.taskId, ctx, ev);
      if (!task) return;
      if (task.fundTxHash !== null) return; // already applied
      const client = await prisma.user.findUnique({ where: { id: task.clientId } });
      if (client?.wallet !== a.client.toLowerCase()) {
        ctx.log.error(
          { taskId: task.id, onchainClient: a.client },
          "TaskFunded client does not match task owner",
        );
      }
      if (!canTransition("task", task.status, "FUND")) {
        // Money arrived onchain for a task the DB doesn't consider fundable: never block the
        // indexer — record the anomaly for admins (reconciliation will also flag it).
        ctx.log.error(
          { taskId: task.id, status: task.status },
          "TaskFunded for a task in an unexpected state",
        );
        await recordEvent(prisma, task.id, "CHAIN_ANOMALY", ev, {
          status: task.status,
          totalAmount: a.totalAmount,
        });
        return;
      }
      await moveTask(
        prisma,
        task,
        "FUND",
        ev,
        {
          totalAmount: a.totalAmount,
          feeBps: Number(a.feeBps),
          fundTxHash: ev.txHash,
        },
        { totalAmount: a.totalAmount, feeBps: Number(a.feeBps), client: a.client.toLowerCase() },
      );
      return;
    }
    case "MilestoneReleased": {
      const a = milestoneReleased.parse(ev.args);
      await settleMilestone(
        prisma,
        a.taskId,
        Number(a.index),
        "RELEASE",
        ev,
        ctx,
        { releaseTxHash: ev.txHash },
        {
          providerAmount: a.providerAmount,
          fee: a.fee,
        },
      );
      return;
    }
    case "MilestoneRefunded": {
      const a = milestoneRefunded.parse(ev.args);
      await settleMilestone(
        prisma,
        a.taskId,
        Number(a.index),
        "REFUND",
        ev,
        ctx,
        { refundTxHash: ev.txHash },
        { amount: a.amount },
      );
      return;
    }
    case "DisputeResolved": {
      const a = disputeResolved.parse(ev.args);
      const refundedFully = Number(a.clientShareBps) === 10_000;
      await settleMilestone(
        prisma,
        a.taskId,
        Number(a.index),
        refundedFully ? "REFUND" : "RELEASE",
        ev,
        ctx,
        refundedFully ? { refundTxHash: ev.txHash } : { releaseTxHash: ev.txHash },
        ev.args as Record<string, unknown>,
      );
      return;
    }
    case "DisputeOpened": {
      const task = await taskByOnchainId(prisma, byTask.parse(ev.args).taskId, ctx, ev);
      if (task && canTransition("task", task.status, "DISPUTE")) {
        await moveTask(prisma, task, "DISPUTE", ev);
        // The client normally records a reason via the API first; keep a row either way.
        await prisma.dispute.upsert({
          where: { taskId: task.id },
          update: {},
          create: { taskId: task.id, reason: "Opened onchain without a written reason." },
        });
        const admins = await prisma.user.findMany({
          where: { roles: { has: "ADMIN" } },
          select: { id: true },
        });
        for (const a of admins) {
          await notify(prisma, a.id, {
            type: "DISPUTE_OPENED",
            title: "New dispute",
            body: `"${task.title}" is disputed and waiting for review.`,
            link: "/admin/disputes",
          });
        }
      }
      return;
    }
    case "TaskClosed": {
      const task = await taskByOnchainId(prisma, byTask.parse(ev.args).taskId, ctx, ev);
      if (!task) return;
      const outcome = await closingOutcome(prisma, task.onchainId);
      if (canTransition("task", task.status, outcome)) {
        await moveTask(prisma, task, outcome, ev);
        const text: Record<string, { title: string; body: string }> = {
          COMPLETE: {
            title: "Task completed",
            body: `"${task.title}" is complete and the providers have been paid.`,
          },
          REFUND: {
            title: "Task refunded",
            body: `"${task.title}" couldn't be completed; your USDC was refunded.`,
          },
          PARTIAL_REFUND: {
            title: "Task closed with a partial refund",
            body: `"${task.title}" closed: delivered steps were paid, the rest refunded.`,
          },
          RESOLVE: {
            title: "Dispute resolved",
            body: `The dispute on "${task.title}" was settled.`,
          },
        };
        if (outcome === "RESOLVE") {
          await prisma.dispute.updateMany({
            where: { taskId: task.id, status: { not: "RESOLVED" } },
            data: { status: "RESOLVED", resolvedAt: new Date() },
          });
        }
        const n = text[outcome];
        if (n)
          await notify(prisma, task.clientId, {
            type: `TASK_${outcome}`,
            ...n,
            link: `/tasks/${task.id}`,
          });
      } else
        await recordEvent(prisma, task.id, "CHAIN_TASK_CLOSED", ev, {
          status: task.status,
          outcome,
        });
      return;
    }
    default:
      return; // admin events (FeeUpdated, Paused, ...) are kept as raw ChainEvents only
  }
}

/** Closed task → which terminal status: disputed→RESOLVED, all released→COMPLETED, all refunded→REFUNDED, mixed→PARTIALLY_REFUNDED. */
async function closingOutcome(
  prisma: PrismaClient,
  onchainId: string,
): Promise<TaskTransitionEvent> {
  const settlements = await prisma.chainEvent.findMany({
    where: {
      name: { in: ["MilestoneReleased", "MilestoneRefunded", "DisputeResolved", "DisputeOpened"] },
      args: { path: ["taskId"], equals: onchainId },
    },
    select: { name: true, args: true },
  });
  if (settlements.some((s) => s.name === "DisputeOpened")) return "RESOLVE";
  const refunded = settlements.filter((s) => s.name === "MilestoneRefunded").length;
  const released = settlements.filter((s) => s.name === "MilestoneReleased").length;
  if (released === 0 && refunded > 0) return "REFUND";
  if (refunded > 0) return "PARTIAL_REFUND";
  return "COMPLETE";
}

async function settleMilestone(
  prisma: PrismaClient,
  onchainTaskId: string,
  index: number,
  event: Extract<SubtaskEvent, "RELEASE" | "REFUND">,
  ev: ChainEvent,
  ctx: Ctx,
  data: Prisma.SubtaskUpdateInput,
  eventData: Record<string, unknown>,
) {
  const task = await taskByOnchainId(prisma, onchainTaskId, ctx, ev);
  if (!task) return;
  const subtask = await prisma.subtask.findUnique({
    where: { taskId_index: { taskId: task.id, index } },
  });
  if (subtask && subtask.status !== "RELEASED" && subtask.status !== "REFUNDED") {
    const next = transition("subtask", subtask.status, event);
    await prisma.subtask.updateMany({
      where: { id: subtask.id, status: subtask.status },
      data: { ...data, status: next },
    });
  }
  await recordEvent(
    prisma,
    task.id,
    event === "RELEASE" ? "MILESTONE_RELEASED" : "MILESTONE_REFUNDED",
    ev,
    { index, ...eventData },
  );
}

async function moveTask(
  prisma: PrismaClient,
  task: Task,
  event: TaskTransitionEvent,
  ev: ChainEvent,
  data: Prisma.TaskUpdateManyMutationInput = {},
  eventData: Record<string, unknown> = {},
) {
  const next = transition("task", task.status, event);
  const updated = await prisma.task.updateMany({
    where: { id: task.id, status: task.status },
    data: { ...data, status: next },
  });
  if (updated.count === 0) throw new Error(`task ${task.id} changed concurrently; retrying`);
  await recordEvent(prisma, task.id, `STATUS_${next}`, ev, {
    from: task.status,
    event,
    ...eventData,
  });
}

/** Audit event keyed by the chain event, so replays never duplicate it. */
async function recordEvent(
  prisma: PrismaClient,
  taskId: string,
  type: string,
  ev: ChainEvent,
  data: Record<string, unknown>,
) {
  const id = `chain:${ev.id}:${type}`;
  await prisma.taskEvent.upsert({
    where: { id },
    update: {},
    create: {
      id,
      taskId,
      type,
      data: toPlain({ ...data, txHash: ev.txHash, blockNumber: ev.blockNumber.toString() }),
    },
  });
}

async function taskByOnchainId(prisma: PrismaClient, onchainId: string, ctx: Ctx, ev: ChainEvent) {
  const task = await prisma.task.findUnique({ where: { onchainId: onchainId.toLowerCase() } });
  if (!task)
    ctx.log.warn(
      { onchainId, name: ev.name, txHash: ev.txHash },
      "event for unknown task (funded outside Kazi?)",
    );
  return task;
}

/** Registrations made from the provider wizard carry `kazi://providers/<db id>` as metadata. */
const providerRegistered = z.object({
  providerId: z.union([z.string(), z.number()]),
  owner: z.string(),
  payout: z.string(),
  metadataURI: z.string(),
});

async function applyRegistryEvent(prisma: PrismaClient, ev: ChainEvent) {
  if (ev.name === "ProviderRegistered") {
    const a = providerRegistered.safeParse(ev.args);
    const dbId = a.success
      ? /^kazi:\/\/providers\/([A-Za-z0-9_-]{1,64})$/.exec(a.data.metadataURI)?.[1]
      : undefined;
    if (!a.success || !dbId) return;
    // Link only when the registering wallet owns the listing and the payout matches (no hijacking).
    const p = await prisma.provider.findUnique({ where: { id: dbId }, include: { owner: true } });
    if (
      p &&
      p.onchainId === null &&
      p.owner.wallet.toLowerCase() === a.data.owner.toLowerCase() &&
      p.payoutAddress.toLowerCase() === a.data.payout.toLowerCase()
    ) {
      await prisma.provider.update({
        where: { id: p.id },
        data: { onchainId: BigInt(a.data.providerId) },
      });
    }
    return;
  }
  const status = {
    ProviderActivated: "ACTIVE",
    ProviderSuspended: "SUSPENDED",
    ProviderDelisted: "DELISTED",
  }[ev.name];
  if (!status) return;
  const { providerId } = byProvider.parse(ev.args);
  await prisma.provider.updateMany({
    where: { onchainId: BigInt(providerId) },
    data: { status: status as "ACTIVE" | "SUSPENDED" | "DELISTED" },
  });
}

/** Mirror the bonded stake from chain (authoritative) whenever it changes. */
async function applyVaultEvent(prisma: PrismaClient, ev: ChainEvent, ctx: Ctx) {
  if (!["Bonded", "UnbondRequested", "Unbonded", "Slashed"].includes(ev.name)) return;
  const { providerId } = byProvider.parse(ev.args);
  const staked = await ctx.client.readContract({
    address: ctx.deployment.stakingVault,
    abi: stakingVaultAbi,
    functionName: "stakedOf",
    args: [BigInt(providerId)],
    blockNumber: ev.blockNumber,
  });
  await prisma.provider.updateMany({
    where: { onchainId: BigInt(providerId) },
    data: { stakeAmount: staked.toString() },
  });
}

function toPlain(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}
