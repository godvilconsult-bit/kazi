import { describe, expect, it } from "vitest";
import { pino } from "pino";
import type { Queue } from "bullmq";
import type { ChainEvent, PrismaClient } from "@kazi/db";
import { createAlerter, type AlertKind } from "../src/monitoring/alerts";
import { chainEventAlerts } from "../src/monitoring/chain-alerts";
import { llmHourKey, trackLlmSpend } from "../src/monitoring/llm-spend";
import { monitorTick } from "../src/monitoring/monitor";
import { MockLlm } from "../src/llm";

/** Phase 7 monitoring: alert de-duplication and delivery, event → alert mapping, health checks. */

const log = pino({ level: "silent" });

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes("NX") && store.has(k)) return null;
      store.set(k, v);
      return "OK" as const;
    },
    incr: async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    },
    expire: async () => 1,
  };
}

function recorder() {
  const sent: { kind: AlertKind; summary: string; details: Record<string, unknown> }[] = [];
  return {
    sent,
    alerter: {
      send: async (kind: AlertKind, summary: string, details: Record<string, unknown> = {}) => {
        sent.push({ kind, summary, details });
        return true;
      },
    },
  };
}

describe("alerter", () => {
  it("sends once per (kind, key) within the window, posts to the webhook and never throws", async () => {
    const redis = fakeRedis();
    const posts: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const counted: string[] = [];
    const alerter = createAlerter({ log, redis: redis as never, prefix: "t", webhookUrl: "https://hooks.example/x", fetchImpl, onSent: (k) => counted.push(k) });

    expect(await alerter.send("QUEUE_BACKLOG", "300 waiting", { queue: "payouts" }, { key: "payouts" })).toBe(true);
    expect(await alerter.send("QUEUE_BACKLOG", "301 waiting", { queue: "payouts" }, { key: "payouts" })).toBe(false); // suppressed
    expect(await alerter.send("QUEUE_BACKLOG", "250 waiting", { queue: "router" }, { key: "router" })).toBe(true);
    expect(counted).toEqual(["QUEUE_BACKLOG", "QUEUE_BACKLOG"]);
    expect(posts[0]).toMatchObject({ kind: "QUEUE_BACKLOG", severity: "warning", text: "[WARNING] QUEUE_BACKLOG — 300 waiting" });

    const failing = createAlerter({ log, webhookUrl: "https://hooks.example/x", fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch });
    await expect(failing.send("ROLE_CHANGED", "RoleGranted", {}, { dedupeSec: 0 })).resolves.toBe(true);
  });
});

describe("chain event alerts", () => {
  const ev = (name: string, args: Record<string, unknown>, i = 0): ChainEvent =>
    ({ id: `e${i}`, chainId: 31337, contract: "0xescrow", name, txHash: `0x${i}`, logIndex: i, blockNumber: 10n, args, processed: true, indexedAt: new Date() }) as ChainEvent;

  it("maps role changes, pauses, admin settings and large releases", async () => {
    const { sent, alerter } = recorder();
    const prisma = { provider: { findFirst: async () => null } } as unknown as PrismaClient;
    const observe = chainEventAlerts({ alerter, prisma, usdcDecimals: async () => 6, largeReleaseUsdc: "500" });

    await observe(ev("RoleGranted", { role: "0x01", account: "0xabc", sender: "0xsafe" }, 1), "TaskEscrow");
    await observe(ev("Paused", { account: "0xguardian" }, 2), "TaskEscrow");
    await observe(ev("SplitUpdated", { treasuryBps: 5000, stakerBps: 3000, buybackBps: 2000 }, 3), "FeeDistributor");
    await observe(ev("MilestoneReleased", { taskId: "0xt", index: "0", providerAmount: "440000000", fee: "60000000" }, 4), "TaskEscrow"); // 500 USDC
    await observe(ev("MilestoneReleased", { taskId: "0xt", index: "1", providerAmount: "1000000", fee: "0" }, 5), "TaskEscrow"); // 1 USDC
    await observe(ev("PayoutChangeRequested", { providerId: "7", newPayout: "0xnew", effectiveAt: "1" }, 6), "AgentRegistry");
    await observe(ev("TaskFunded", { taskId: "0xt" }, 7), "TaskEscrow");

    expect(sent.map((s) => s.kind)).toEqual(["ROLE_CHANGED", "ESCROW_PAUSED", "ADMIN_SETTING_CHANGED", "LARGE_RELEASE", "PAYOUT_CHANGE_REQUESTED"]);
    expect(sent[3]?.summary).toContain("500 USDC released");
  });
});

describe("LLM spend tracking", () => {
  it("records the cost of every call, including failed ones", async () => {
    const costs: number[] = [];
    const llm = trackLlmSpend(new MockLlm(), (usd) => costs.push(usd));
    await llm.text({ purpose: "summary", model: "m", system: "s", user: "u" } as never).catch(() => undefined);
    expect(llmHourKey("kazi", new Date("2026-10-10T14:05:00Z"))).toBe("kazi:llm:usd:2026-10-10T14");
    expect(costs.every((c) => c > 0)).toBe(true);
  });
});

describe("health monitor", () => {
  it("alerts on backlog, new failures, low gas and LLM spend, and retries stuck payouts", async () => {
    const redis = fakeRedis();
    const now = new Date("2026-10-10T14:30:00Z");
    redis.store.set(llmHourKey("t", now), "40.5");
    redis.store.set("t:monitor:failed:payouts", "1");
    const retried: string[] = [];
    const failedJob = (id: string, name: string, minutesAgo: number) => ({
      id,
      name,
      finishedOn: now.getTime() - minutesAgo * 60_000,
      retry: async () => void retried.push(id),
    });
    const queue = (counts: Record<string, number>, failed: unknown[] = []) =>
      ({ getJobCounts: async () => counts, getFailed: async () => failed }) as unknown as Queue;
    const { sent, alerter } = recorder();

    const res = await monitorTick({
      prisma: { chainEvent: { findMany: async () => [] } } as unknown as PrismaClient,
      redis: redis as never,
      prefix: "t",
      queues: {
        router: queue({ waiting: 500, active: 1, delayed: 0, failed: 0 }),
        payouts: queue({ waiting: 0, active: 0, delayed: 0, failed: 3 }, [failedJob("release-a", "release", 30), failedJob("release-b", "release", 2), failedJob("tick-1", "tick", 60)]),
      },
      publicClient: { getBalance: async () => 10n ** 17n } as never, // 0.1 native USDC
      operator: "0x0000000000000000000000000000000000000001",
      escrow: "0x0000000000000000000000000000000000000002",
      nativeDecimals: 18,
      usdcDecimals: async () => 6,
      alerter,
      thresholds: { queueBacklog: 200, operatorMinGas: "1", dailyReleaseUsdc: "10000", llmHourlyUsd: 25 },
      log,
      now: () => now,
    });

    expect(sent.map((s) => s.kind).sort()).toEqual(["JOB_FAILURES", "LLM_COST_SPIKE", "OPERATOR_GAS_LOW", "QUEUE_BACKLOG"]);
    expect(retried).toEqual(["release-a"]); // only payout jobs that failed > 10 min ago
    expect(res.retriedPayouts).toBe(1);
  });
});
