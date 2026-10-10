/**
 * Load test (docs/10-BUILD-PLAN.md Phase 7): N simulated clients run the whole task lifecycle at
 * once against the isolated stack with mock LLM and house agents — sign in (SIWE) → create → quote
 * → exact USDC approve + createAndFund (each client's own wallet, onchain) → agent delivery and
 * evaluation → approve → milestone releases → COMPLETED.
 *
 *   LOAD_TEST=1 pnpm -F @kazi/worker e2e:stack          # terminal 1 (fresh chain + kazi_test_e2e DB)
 *   pnpm -F @kazi/worker load-test -- --tasks 500       # terminal 2
 *
 * Every client gets its own wallet and X-Forwarded-For address (the load stack runs with
 * TRUST_PROXY=true, like many users behind a proxy). Results → D:/KAZI/.tmp/load-results.json.
 * Local anvil and public dev keys only; never point it at a real network.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { mockUsdcAbi, taskEscrowAbi } from "@kazi/shared";
import { KEYS } from "../test/anvil";

const { values } = parseArgs({
  // `pnpm run x -- --flag` forwards a literal "--", which would end option parsing.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    tasks: { type: "string", default: "500" },
    "ramp-sec": { type: "string", default: "60" },
    "timeout-min": { type: "string", default: "45" },
    "poll-ms": { type: "string", default: "3000" },
  },
  allowPositionals: true,
});
const N = Number(values.tasks);
const RAMP_MS = Number(values["ramp-sec"]) * 1000;
const DEADLINE = Date.now() + Number(values["timeout-min"]) * 60_000;
const POLL_MS = Number(values["poll-ms"]);

const tmp = resolve(import.meta.dirname, "../../../..", ".tmp");
const stack = JSON.parse(readFileSync(resolve(tmp, "e2e-deployments", "stack.json"), "utf8")) as {
  api: string;
  web: string;
  rpcUrl: string;
  usdc: Address;
  escrow: Address;
};
const publicClient = createPublicClient({ chain: foundry, transport: http(stack.rpcUrl) });
const testClient = createTestClient({
  chain: foundry,
  mode: "anvil",
  transport: http(stack.rpcUrl),
});

// ── Measurements ────────────────────────────────────────────────────────────
type Phase = "login" | "create" | "quote" | "fund" | "deliver" | "complete";
const durations: Record<Phase, number[]> = {
  login: [],
  create: [],
  quote: [],
  fund: [],
  deliver: [],
  complete: [],
};
const requests: { route: string; ms: number; status: number }[] = [];
const failures: Record<string, number> = {};
const queuePeaks: Record<string, number> = {};
let completed = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0);
};

class Client {
  private readonly jar = new Map<string, string>();
  constructor(
    readonly account: PrivateKeyAccount,
    private readonly ip: string,
  ) {}

  private async send(method: "GET" | "POST", path: string, body: unknown, route: string) {
    const started = performance.now();
    const cookie = [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${stack.api}${path}`, {
      method,
      headers: {
        "x-forwarded-for": this.ip,
        ...(cookie ? { cookie } : {}),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    requests.push({
      route: `${method} ${route}`,
      ms: performance.now() - started,
      status: res.status,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }

  async call<T>(method: "GET" | "POST", path: string, body?: unknown, route = path): Promise<T> {
    let res = await this.send(method, path, body, route);
    // Access tokens live 15 minutes: refresh once and retry, like the web app does.
    if (res.status === 401 && !path.startsWith("/auth/")) {
      await this.send("POST", "/auth/refresh", {}, "/auth/refresh");
      res = await this.send(method, path, body, route);
    }
    if (!res.ok)
      throw new Error(`${method} ${route} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async login() {
    const { nonce } = await this.call<{ nonce: string }>("GET", "/auth/nonce");
    const web = new URL(stack.web);
    const message = createSiweMessage({
      address: this.account.address,
      chainId: foundry.id,
      domain: web.host,
      nonce,
      uri: web.origin,
      version: "1",
      issuedAt: new Date(),
      statement: "Sign in to Kazi",
    });
    await this.call("POST", "/auth/verify", {
      message,
      signature: await this.account.signMessage({ message }),
    });
  }
}

async function timed<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const out = await fn();
    durations[phase].push(performance.now() - started);
    return out;
  } catch (err) {
    const reason = `${phase}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
    failures[reason] = (failures[reason] ?? 0) + 1;
    throw err;
  }
}

async function waitForStatus(c: Client, taskId: string, want: string[], fail: string[] = []) {
  for (;;) {
    if (Date.now() > DEADLINE) throw new Error(`timed out waiting for ${want.join("/")}`);
    const { task } = await c.call<{ task: { status: string } }>(
      "GET",
      `/tasks/${taskId}`,
      undefined,
      "/tasks/:id",
    );
    if (want.includes(task.status)) return task.status;
    if (fail.includes(task.status)) throw new Error(`task ended ${task.status}`);
    await sleep(POLL_MS + Math.random() * 1000);
  }
}

async function lifecycle(i: number) {
  const account = privateKeyToAccount(generatePrivateKey());
  const c = new Client(account, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
  const wallet = createWalletClient({ account, chain: foundry, transport: http(stack.rpcUrl) });
  await testClient.setBalance({ address: account.address, value: parseEther("10") }); // gas (anvil only)

  await timed("login", () => c.login());
  const { task } = await timed("create", () =>
    c.call<{ task: { id: string } }>(
      "POST",
      "/tasks",
      {
        title: `Business plan ${i}`,
        description: `Write a business plan for a solar lamp shop in Arusha that sells ${100 + (i % 50)} lamps a month.`,
        deadline: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      },
      "/tasks",
    ),
  );
  await timed("quote", async () => {
    await c.call("POST", `/tasks/${task.id}/quote`, {}, "/tasks/:id/quote");
    for (;;) {
      if (Date.now() > DEADLINE) throw new Error("timed out waiting for the quote");
      const q = await c.call<{ quote: { outcome: string } | null }>(
        "GET",
        `/tasks/${task.id}/quote`,
        undefined,
        "/tasks/:id/quote",
      );
      if (q.quote?.outcome === "QUOTED") return;
      if (q.quote && q.quote.outcome !== "QUOTED") throw new Error(`quote ${q.quote.outcome}`);
      await sleep(POLL_MS / 2 + Math.random() * 500);
    }
  });
  await timed("fund", async () => {
    const p = await c.call<{
      escrowAddress: Address;
      usdcAddress: Address;
      total: string;
      quoteSig: Hex;
      quote: {
        taskId: Hex;
        providerIds: string[];
        amounts: string[];
        deadline: string;
        feeBps: number;
        expiry: string;
      };
    }>("GET", `/tasks/${task.id}/fund-params`, undefined, "/tasks/:id/fund-params");
    const total = BigInt(p.total);
    const wait = async (hash: Hex) => {
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("transaction reverted");
    };
    await wait(
      await wallet.writeContract({
        address: p.usdcAddress,
        abi: mockUsdcAbi,
        functionName: "mint",
        args: [account.address, total],
      }),
    );
    await wait(
      await wallet.writeContract({
        address: p.usdcAddress,
        abi: mockUsdcAbi,
        functionName: "approve",
        args: [p.escrowAddress, total],
      }),
    );
    await wait(
      await wallet.writeContract({
        address: p.escrowAddress,
        abi: taskEscrowAbi,
        functionName: "createAndFund",
        args: [
          {
            taskId: p.quote.taskId,
            providerIds: p.quote.providerIds.map(BigInt),
            amounts: p.quote.amounts.map(BigInt),
            deadline: BigInt(p.quote.deadline),
            feeBps: p.quote.feeBps,
            expiry: BigInt(p.quote.expiry),
          },
          p.quoteSig,
        ],
      }),
    );
    await waitForStatus(c, task.id, ["FUNDED", "IN_PROGRESS", "DELIVERED"]);
  });
  await timed("deliver", () =>
    waitForStatus(c, task.id, ["DELIVERED"], ["REFUNDED", "PARTIALLY_REFUNDED"]),
  );
  await timed("complete", async () => {
    await c.call("POST", `/tasks/${task.id}/approve`, {}, "/tasks/:id/approve");
    await waitForStatus(c, task.id, ["COMPLETED"], ["REFUNDED", "PARTIALLY_REFUNDED"]);
  });
  completed++;
}

// ── Queue depth sampling (admin session) ────────────────────────────────────
async function sampleQueues(stop: () => boolean) {
  const admin = new Client(privateKeyToAccount(KEYS.admin), "10.255.255.254");
  await admin.login();
  while (!stop()) {
    try {
      const { queues } = await admin.call<{ queues: Record<string, Record<string, number>> }>(
        "GET",
        "/admin/queues",
      );
      for (const [name, counts] of Object.entries(queues)) {
        const depth = (counts["waiting"] ?? 0) + (counts["active"] ?? 0) + (counts["delayed"] ?? 0);
        queuePeaks[name] = Math.max(queuePeaks[name] ?? 0, depth);
      }
    } catch {
      // Admin endpoints need a sign-in from the last 10 minutes: sign in again and keep sampling.
      await admin.login().catch(() => undefined);
    }
    await sleep(5_000);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
const started = Date.now();
console.log(`Load test: ${N} task lifecycles, ramp ${RAMP_MS / 1000}s, API ${stack.api}`);
let done = false;
const sampler = sampleQueues(() => done);
const results = await Promise.allSettled(
  Array.from({ length: N }, async (_, i) => {
    await sleep((RAMP_MS * i) / Math.max(1, N));
    return lifecycle(i);
  }),
);
done = true;
await sampler;

const byRoute = new Map<string, number[]>();
for (const r of requests) byRoute.set(r.route, [...(byRoute.get(r.route) ?? []), r.ms]);
const errors5xx = requests.filter((r) => r.status >= 500).length;
const summary = {
  tasks: N,
  completed,
  failed: results.filter((r) => r.status === "rejected").length,
  wallClockSec: Math.round((Date.now() - started) / 1000),
  phasesMs: Object.fromEntries(
    Object.entries(durations).map(([k, xs]) => [
      k,
      { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: pct(xs, 100) },
    ]),
  ),
  api: {
    requests: requests.length,
    errors5xx,
    status429: requests.filter((r) => r.status === 429).length,
    routesMs: Object.fromEntries(
      [...byRoute.entries()].map(([route, xs]) => [
        route,
        { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99) },
      ]),
    ),
  },
  queuePeaks,
  failures,
};
writeFileSync(resolve(tmp, "load-results.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
