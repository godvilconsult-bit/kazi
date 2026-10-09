import type { Logger } from "pino";
import type { PrismaClient } from "@kazi/db";

/**
 * Provider reputation, 0–100 (docs/06-ROUTER.md §6):
 *   rep = 100 · bayesianAvg(0.5·judge + 0.3·rating/5 + 0.2·onTime), prior mean 0.7 weight 5,
 *         events older than 180 days weigh 50%, minus penalties (lost disputes, slashes).
 * Without a client rating, the judge and on-time parts are re-weighted to sum to 1.
 * Every recompute stores a snapshot for history charts.
 */

const PRIOR_MEAN = 0.7;
const PRIOR_WEIGHT = 5;
const DECAY_AFTER_MS = 180 * 86_400_000;
const PENALTY_DISPUTE_LOST = 10;
const PENALTY_SLASH = 20;

export interface ReputationEvent {
  /** 0..1 judge score of the accepted output; 0 when the provider failed the step. */
  judge: number;
  /** Client's 1–5 rating of the task, when given. */
  rating: number | null;
  onTime: boolean;
  at: Date;
}

export function reputationScore(
  events: readonly ReputationEvent[],
  penalties: { disputesLost: number; slashes: number },
  now: Date,
): { value: number; weight: number } {
  let num = PRIOR_MEAN * PRIOR_WEIGHT;
  let den = PRIOR_WEIGHT;
  for (const e of events) {
    const t = e.onTime ? 1 : 0;
    const v = e.rating !== null ? 0.5 * e.judge + 0.3 * (e.rating / 5) + 0.2 * t : (0.5 * e.judge + 0.2 * t) / 0.7;
    const w = now.getTime() - e.at.getTime() > DECAY_AFTER_MS ? 0.5 : 1;
    num += w * v;
    den += w;
  }
  const raw = (100 * num) / den - PENALTY_DISPUTE_LOST * penalties.disputesLost - PENALTY_SLASH * penalties.slashes;
  return { value: Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10, weight: den - PRIOR_WEIGHT };
}

export async function recomputeReputation(
  prisma: PrismaClient,
  providerId: string,
  log: Logger,
  now = new Date(),
): Promise<number | null> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) return null;
  const subtasks = await prisma.subtask.findMany({
    where: {
      providerId,
      kind: "WORK",
      attempts: { gt: 0 },
      status: { in: ["ACCEPTED", "RELEASED", "FAILED", "REFUNDED"] },
    },
    include: {
      task: { select: { onchainId: true, deadline: true, rating: true, updatedAt: true } },
      submissions: { where: { accepted: true }, orderBy: { attempt: "desc" }, take: 1 },
    },
  });
  const events: ReputationEvent[] = [];
  for (const st of subtasks) {
    const ok = st.submissions[0];
    if (!ok) {
      // Settled by the client/arbiter without an accepted output: not part of this provider's record.
      if (st.status === "ACCEPTED" || st.status === "RELEASED") continue;
      events.push({ judge: 0, rating: null, onTime: false, at: st.task.updatedAt }); // failed the step
      continue;
    }
    events.push({
      judge: Math.min(1, Math.max(0, (ok.score ?? 0) / 100)),
      rating: st.task.rating,
      onTime: ok.createdAt <= st.task.deadline,
      at: ok.createdAt,
    });
  }

  // Disputes this provider lost: arbiter gave the client half or more of one of its milestones.
  const byTaskIndex = new Set(subtasks.map((s) => `${s.task.onchainId}:${s.index}`));
  const resolutions = byTaskIndex.size
    ? await prisma.chainEvent.findMany({ where: { name: "DisputeResolved" }, select: { args: true } })
    : [];
  const disputesLost = resolutions.filter((r) => {
    const a = r.args as { taskId?: string; index?: string | number; clientShareBps?: string | number };
    return byTaskIndex.has(`${a.taskId}:${a.index}`) && Number(a.clientShareBps ?? 0) >= 5_000;
  }).length;
  const slashes =
    provider.onchainId === null
      ? 0
      : (await prisma.chainEvent.findMany({ where: { name: "Slashed" }, select: { args: true } })).filter(
          (r) => String((r.args as { providerId?: unknown }).providerId) === provider.onchainId?.toString(),
        ).length;

  const { value, weight } = reputationScore(events, { disputesLost, slashes }, now);
  await prisma.$transaction([
    prisma.provider.update({ where: { id: providerId }, data: { reputation: value } }),
    prisma.reputationSnapshot.create({
      data: {
        providerId,
        value,
        components: { events: events.length, weight, disputesLost, slashes },
      },
    }),
  ]);
  log.info({ providerId, reputation: value, events: events.length }, "reputation recomputed");
  return value;
}

/** Daily: recompute everyone (time decay changes scores even without new work). */
export async function recomputeAllReputations(prisma: PrismaClient, log: Logger): Promise<number> {
  const providers = await prisma.provider.findMany({ where: { status: { in: ["ACTIVE", "SUSPENDED"] } }, select: { id: true } });
  for (const p of providers) await recomputeReputation(prisma, p.id, log);
  return providers.length;
}
