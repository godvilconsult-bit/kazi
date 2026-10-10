import type { Logger } from "pino";
import type { PrismaClient } from "@kazi/db";
import {
  CLIENT_POINTS_PER_USDC,
  POINTS_DAILY_CAP,
  POINTS_MIN_TASK_USDC,
  POINTS_REPEAT_PAIR_FACTOR_BPS,
  POINTS_REPEAT_PAIR_LIMIT,
  PROVIDER_POINTS_PER_USDC,
  parseUnits,
  providerPayout,
  type PointsFlag,
} from "@kazi/shared";

/**
 * Points program (docs/08-TOKENOMICS.md §5): points follow the USDC fees a task paid on released
 * milestones. Sybil heuristics, applied before writing:
 * - self-dealing: the client also owns (or is paid by) the provider → no points for either side;
 * - tasks paying less than POINTS_MIN_TASK_USDC in total → no points;
 * - the same client and provider owner, beyond POINTS_REPEAT_PAIR_LIMIT tasks in 30 days → a fifth;
 * - at most POINTS_DAILY_CAP points per user per day.
 * Kazi's own house agents earn no provider points (their clients still do).
 * Idempotent: one row per (user, task, role), rewritten on every run.
 */

const CLOSED = ["COMPLETED", "PARTIALLY_REFUNDED", "RESOLVED"] as const;
const DAY = 86_400_000;

interface Entry {
  userId: string;
  taskId: string;
  role: "CLIENT" | "PROVIDER";
  feeUnits: bigint;
  points: number;
  flag: PointsFlag | null;
  day: string;
}

export async function recomputePoints(
  deps: { prisma: PrismaClient; usdcDecimals: () => Promise<number>; log: Logger },
  opts: { sinceDays?: number } = {},
): Promise<{ tasks: number; entries: number }> {
  const decimals = await deps.usdcDecimals();
  const unit = 10n ** BigInt(decimals);
  const minTask = parseUnits(POINTS_MIN_TASK_USDC, decimals);
  const since = opts.sinceDays ? new Date(Date.now() - opts.sinceDays * DAY) : undefined;
  const tasks = await deps.prisma.task.findMany({
    where: { status: { in: [...CLOSED] }, ...(since ? { updatedAt: { gte: since } } : {}) },
    orderBy: { updatedAt: "asc" },
    include: {
      client: { select: { id: true, wallet: true } },
      subtasks: {
        include: {
          provider: {
            select: {
              ownerId: true,
              payoutAddress: true,
              isHouse: true,
              owner: { select: { wallet: true } },
            },
          },
        },
      },
    },
  });

  const entries: Entry[] = [];
  const pairHistory = new Map<string, number[]>(); // client|owner → closing times
  for (const t of tasks) {
    const released = t.subtasks.filter((s) => s.status === "RELEASED");
    const feeBps = t.feeBps ?? 0;
    const total = released.reduce((a, s) => a + BigInt(s.amount), 0n);
    const day = t.updatedAt.toISOString().slice(0, 10);
    let clientFees = 0n;
    let clientFlag: PointsFlag | null = total < minTask ? "below-minimum" : null;
    const providerFees = new Map<string, { fees: bigint; flag: PointsFlag | null }>();

    for (const s of released) {
      const amount = BigInt(s.amount);
      // Service-fee milestones are Kazi's fee in full; work milestones pay the escrow fee.
      const fee = s.kind === "SERVICE_FEE" ? amount : amount - providerPayout(amount, feeBps);
      clientFees += fee;
      if (s.kind !== "WORK" || !s.provider) continue;
      const selfDealing =
        s.provider.ownerId === t.client.id ||
        s.provider.payoutAddress.toLowerCase() === t.client.wallet.toLowerCase() ||
        s.provider.owner.wallet.toLowerCase() === t.client.wallet.toLowerCase();
      if (selfDealing) clientFlag = "self-dealing";
      if (s.provider.isHouse) continue;
      const current = providerFees.get(s.provider.ownerId) ?? { fees: 0n, flag: null };
      current.fees += fee;
      if (selfDealing) current.flag = "self-dealing";
      providerFees.set(s.provider.ownerId, current);
    }

    // Repeat pairs: diminishing points between the same client and provider owner.
    let repeat = false;
    for (const ownerId of providerFees.keys()) {
      const key = `${t.client.id}|${ownerId}`;
      const recent = (pairHistory.get(key) ?? []).filter(
        (at) => t.updatedAt.getTime() - at < 30 * DAY,
      );
      recent.push(t.updatedAt.getTime());
      pairHistory.set(key, recent);
      if (recent.length > POINTS_REPEAT_PAIR_LIMIT) {
        repeat = true;
        const pf = providerFees.get(ownerId);
        if (pf && !pf.flag) pf.flag = "repeat-pair";
      }
    }
    if (repeat && !clientFlag) clientFlag = "repeat-pair";

    const toPoints = (fees: bigint, perUsdc: bigint, flag: PointsFlag | null) => {
      if (flag === "self-dealing" || flag === "below-minimum") return 0;
      let p = (fees * perUsdc) / unit;
      if (flag === "repeat-pair") p = (p * POINTS_REPEAT_PAIR_FACTOR_BPS) / 10_000n;
      return Number(p);
    };
    entries.push({
      userId: t.client.id,
      taskId: t.id,
      role: "CLIENT",
      feeUnits: clientFees,
      points: toPoints(clientFees, CLIENT_POINTS_PER_USDC, clientFlag),
      flag: clientFlag,
      day,
    });
    for (const [ownerId, pf] of providerFees) {
      const flag = pf.flag ?? (total < minTask ? "below-minimum" : null);
      entries.push({
        userId: ownerId,
        taskId: t.id,
        role: "PROVIDER",
        feeUnits: pf.fees,
        points: toPoints(pf.fees, PROVIDER_POINTS_PER_USDC, flag),
        flag,
        day,
      });
    }
  }

  // Daily cap per user, in closing order.
  const perDay = new Map<string, number>();
  for (const e of entries) {
    const key = `${e.userId}|${e.day}`;
    const used = perDay.get(key) ?? 0;
    if (used + e.points > POINTS_DAILY_CAP) {
      e.points = Math.max(0, POINTS_DAILY_CAP - used);
      e.flag ??= "daily-cap";
    }
    perDay.set(key, used + e.points);
  }

  for (const e of entries) {
    await deps.prisma.pointsEntry.upsert({
      where: { userId_taskId_role: { userId: e.userId, taskId: e.taskId, role: e.role } },
      update: { feeUnits: e.feeUnits.toString(), points: e.points, flag: e.flag },
      create: {
        userId: e.userId,
        taskId: e.taskId,
        role: e.role,
        feeUnits: e.feeUnits.toString(),
        points: e.points,
        flag: e.flag,
      },
    });
  }
  deps.log.info({ tasks: tasks.length, entries: entries.length }, "points recomputed");
  return { tasks: tasks.length, entries: entries.length };
}
