import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { taskEscrowAbi } from "@kazi/shared";
import { loadApiEnv } from "../src/env";
import { chainalysisScreen } from "../src/security/sanctions";
import { ADMIN_KEY, createHarness, inDays, login, newAccount, siweMessage, type Harness } from "./harness";

/** Phase 7: incident switches (router kill switch, escrow pause calldata) and the metrics endpoint. */

const ESCROW = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const sanctioned = newAccount();
let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    env: { ...loadApiEnv(), ROUTER_DISABLED: true, METRICS_TOKEN: "metrics-token-0123456789" },
    sanctions: { isSanctioned: async (wallet) => wallet.toLowerCase() === sanctioned.address.toLowerCase() },
  });
});
afterAll(async () => {
  await h.close();
});

describe("router kill switch", () => {
  it("refuses new quotes with 503 while ROUTER_DISABLED is on, and queues nothing", async () => {
    const user = await login(h);
    const created = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: user.cookie },
      payload: { title: "Menu translation", description: "Translate our menu into Swahili, keep the prices.", deadline: inDays(3) },
    });
    expect(created.statusCode).toBe(201);
    const { task } = created.json<{ task: { id: string } }>();
    const res = await h.app.inject({ method: "POST", url: `/tasks/${task.id}/quote`, headers: { cookie: user.cookie }, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });
    expect(h.jobs.jobs.some((j) => j.name === "quote")).toBe(false);
  });
});

describe("escrow pause", () => {
  it("gives admins pause (guardian) and unpause (Safe) calldata", async () => {
    const admin = await login(h, privateKeyToAccount(ADMIN_KEY));
    for (const action of ["pause", "unpause"] as const) {
      const res = await h.app.inject({ method: "POST", url: `/admin/escrow/${action}`, headers: { cookie: admin.cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ tx: { to: string; data: `0x${string}` }; signer: string }>();
      expect(body.tx.to).toBe(ESCROW);
      expect(decodeFunctionData({ abi: taskEscrowAbi, data: body.tx.data }).functionName).toBe(action);
      expect(body.signer).toBe(action === "pause" ? "guardian" : "adminSafe");
    }
    const user = await login(h);
    expect((await h.app.inject({ method: "POST", url: "/admin/escrow/pause", headers: { cookie: user.cookie } })).statusCode).toBe(403);
  });
});

describe("client IP", () => {
  it("ignores X-Forwarded-For unless TRUST_PROXY says a proxy sets it, so sign-in limits can't be dodged", async () => {
    // Every request claims a different client IP. If the header were trusted, none would be limited.
    // 61 parallel requests (2 × limit + 1) exceed the limit even if they straddle a 60 s window.
    const statuses = await Promise.all(
      Array.from({ length: 61 }, async (_, i) =>
        (await h.app.inject({ method: "GET", url: "/auth/nonce", remoteAddress: "10.7.7.7", headers: { "x-forwarded-for": `198.51.100.${i}` } })).statusCode,
      ),
    );
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe("sanctions screening", () => {
  it("refuses sign-in to a sanctioned wallet and payouts to a sanctioned address", async () => {
    const message = await siweMessage(h, sanctioned);
    const res = await h.app.inject({ method: "POST", url: "/auth/verify", payload: { message, signature: await sanctioned.signMessage({ message }) } });
    expect(res.statusCode).toBe(403);
    expect(await h.prisma.user.findUnique({ where: { wallet: sanctioned.address.toLowerCase() } })).toBeNull();

    const owner = await login(h);
    const provider = await h.app.inject({
      method: "POST",
      url: "/providers",
      headers: { cookie: owner.cookie },
      payload: {
        kind: "HUMAN",
        name: "Reviewer",
        description: "Reviews business plans for East African markets.",
        capabilities: ["human.review"],
        languages: ["en"],
        pricing: { model: "fixed", price: "5.00", currency: "USDC" },
        payoutAddress: sanctioned.address,
      },
    });
    expect(provider.statusCode).toBe(403);
  });

  it("caches answers and fails open (or closed, when configured) if the service is down", async () => {
    const store = new Map<string, string>();
    const redis = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => (store.set(k, v), "OK" as const) };
    let calls = 0;
    const log = h.app.log;
    const hit = chainalysisScreen({
      apiKey: "test-key-123",
      redis: redis as never,
      prefix: "t",
      log,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ identifications: [{ category: "sanctions" }] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(await hit.isSanctioned("0xAbC")).toBe(true);
    expect(await hit.isSanctioned("0xabc")).toBe(true);
    expect(calls).toBe(1);

    const down = (async () => new Response("", { status: 503 })) as typeof fetch;
    expect(await chainalysisScreen({ apiKey: "k-123456789", redis: redis as never, prefix: "u", log, fetchImpl: down }).isSanctioned("0x1")).toBe(false);
    expect(await chainalysisScreen({ apiKey: "k-123456789", redis: redis as never, prefix: "v", log, fetchImpl: down, failClosed: true }).isSanctioned("0x1")).toBe(true);
  });
});

describe("metrics", () => {
  it("serves Prometheus metrics only with the bearer token", async () => {
    expect((await h.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer wrong-token-0123456789" } })).statusCode).toBe(401);
    await h.app.inject({ method: "GET", url: "/config" });
    const res = await h.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer metrics-token-0123456789" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("kazi_api_request_duration_seconds");
    expect(res.body).toContain('route="/config"');
  });
});
