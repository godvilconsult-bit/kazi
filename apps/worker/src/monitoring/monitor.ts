import type { Queue } from "bullmq";
import type { Logger } from "pino";
import type { Redis } from "ioredis";
import type { Address, PublicClient } from "viem";
import type { PrismaClient } from "@kazi/db";
import { formatUnits, parseUnits } from "@kazi/shared";
import type { Alerter } from "./alerts";
import { llmHourKey } from "./llm-spend";
import type { WorkerMetrics } from "./metrics";

/**
 * Periodic health checks (every MONITOR_EVERY_MS): queue backlog and failures, stuck payouts,
 * operator gas, 24-hour release volume, LLM spend. Each check is independent; one failing check
 * doesn't stop the others.
 */

export interface MonitorThresholds {
  /** Waiting jobs in one queue above this → QUEUE_BACKLOG. */
  queueBacklog: number;
  /** Native-currency balance (decimal) below which the operator can't send releases → OPERATOR_GAS_LOW. */
  operatorMinGas: string;
  /** USDC released in 24 h above this → DAILY_RELEASE_VOLUME; null = off. */
  dailyReleaseUsdc: string | null;
  /** LLM USD spent in the current hour above this → LLM_COST_SPIKE; null = off. */
  llmHourlyUsd: number | null;
}

export interface MonitorDeps {
  prisma: PrismaClient;
  redis: Pick<Redis, "get" | "set" | "incr" | "expire">;
  prefix: string;
  queues: Record<string, Queue>;
  publicClient: PublicClient;
  operator: Address;
  escrow: Address;
  nativeDecimals: number;
  usdcDecimals: () => Promise<number>;
  alerter: Alerter;
  metrics?: WorkerMetrics | undefined;
  thresholds: MonitorThresholds;
  log: Logger;
  now?: () => Date;
}

/** Failed release/refund jobs are retried after this long (transient RPC or gas problems)… */
const PAYOUT_RETRY_AFTER_MS = 10 * 60_000;
/** …at most this many times each, then they wait for a human (JOB_FAILURES). */
const PAYOUT_MAX_AUTO_RETRIES = 6;

export async function monitorTick(deps: MonitorDeps): Promise<{ retriedPayouts: number }> {
  const now = deps.now?.() ?? new Date();
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      deps.log.warn({ err, check: name }, "monitor check failed");
    }
  };
  let retriedPayouts = 0;

  await check("queues", async () => {
    for (const [name, queue] of Object.entries(deps.queues)) {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
      for (const [state, n] of Object.entries(counts))
        deps.metrics?.queueJobs.set({ queue: name, state }, n);
      const waiting = counts["waiting"] ?? 0;
      if (waiting > deps.thresholds.queueBacklog) {
        await deps.alerter.send(
          "QUEUE_BACKLOG",
          `${waiting} jobs waiting in ${name}`,
          { queue: name, ...counts },
          { key: name, dedupeSec: 30 * 60 },
        );
      }
      // New failures since the last check (failed jobs are kept as a dead-letter list).
      const failed = counts["failed"] ?? 0;
      const seenKey = `${deps.prefix}:monitor:failed:${name}`;
      const seen = Number((await deps.redis.get(seenKey)) ?? failed);
      await deps.redis.set(seenKey, String(failed));
      if (failed > seen) {
        await deps.alerter.send(
          "JOB_FAILURES",
          `${failed - seen} new failed jobs in ${name} (${failed} total)`,
          { queue: name, failed },
          { key: name, dedupeSec: 30 * 60 },
        );
      }
    }
  });

  await check("stuck-payouts", async () => {
    const payouts = deps.queues["payouts"];
    if (!payouts) return;
    for (const job of await payouts.getFailed(0, 100)) {
      if (retriedPayouts >= 25) break;
      if (
        !["release", "refund"].includes(job.name) ||
        !job.finishedOn ||
        now.getTime() - job.finishedOn < PAYOUT_RETRY_AFTER_MS
      )
        continue;
      const key = `${deps.prefix}:monitor:payout-retries:${job.id ?? job.name}`;
      const tries = await deps.redis.incr(key);
      await deps.redis.expire(key, 7 * 24 * 3_600);
      if (tries > PAYOUT_MAX_AUTO_RETRIES) continue;
      await job.retry();
      retriedPayouts++;
    }
    if (retriedPayouts > 0) deps.log.info({ retriedPayouts }, "retried failed payout jobs");
  });

  await check("operator-gas", async () => {
    const balance = await deps.publicClient.getBalance({ address: deps.operator });
    deps.metrics?.operatorBalance.set(Number(formatUnits(balance, deps.nativeDecimals)));
    if (balance < parseUnits(deps.thresholds.operatorMinGas, deps.nativeDecimals)) {
      await deps.alerter.send(
        "OPERATOR_GAS_LOW",
        `operator ${deps.operator} has ${formatUnits(balance, deps.nativeDecimals)} for gas (minimum ${deps.thresholds.operatorMinGas})`,
        { operator: deps.operator, balance: balance.toString() },
        { dedupeSec: 6 * 3_600 },
      );
    }
  });

  await check("release-volume", async () => {
    const rows = await deps.prisma.chainEvent.findMany({
      where: {
        contract: deps.escrow.toLowerCase(),
        name: "MilestoneReleased",
        indexedAt: { gte: new Date(now.getTime() - 86_400_000) },
      },
      select: { args: true },
    });
    const total = rows.reduce((sum, r) => {
      const a = r.args as Record<string, unknown>;
      return sum + BigInt(String(a["providerAmount"] ?? "0")) + BigInt(String(a["fee"] ?? "0"));
    }, 0n);
    const decimals = await deps.usdcDecimals();
    deps.metrics?.releases24hUsdc.set(Number(formatUnits(total, decimals)));
    if (
      deps.thresholds.dailyReleaseUsdc !== null &&
      total > parseUnits(deps.thresholds.dailyReleaseUsdc, decimals)
    ) {
      await deps.alerter.send(
        "DAILY_RELEASE_VOLUME",
        `${formatUnits(total, decimals)} USDC released in the last 24 h (alert above ${deps.thresholds.dailyReleaseUsdc})`,
        { total: total.toString(), releases: rows.length },
        { dedupeSec: 12 * 3_600 },
      );
    }
  });

  await check("llm-spend", async () => {
    const usd = Number((await deps.redis.get(llmHourKey(deps.prefix, now))) ?? 0);
    deps.metrics?.llmCostThisHourUsd.set(usd);
    if (deps.thresholds.llmHourlyUsd !== null && usd > deps.thresholds.llmHourlyUsd) {
      await deps.alerter.send(
        "LLM_COST_SPIKE",
        `$${usd.toFixed(2)} of LLM spend this hour (alert above $${deps.thresholds.llmHourlyUsd})`,
        { usd },
        { dedupeSec: 3_600 },
      );
    }
  });

  return { retriedPayouts };
}
