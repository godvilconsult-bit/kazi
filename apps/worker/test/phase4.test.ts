import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { Redis } from "ioredis";
import { SecretBox } from "@kazi/config/secrets";
import { createPrismaClient, type PrismaClient } from "@kazi/db";
import { verifySignature } from "@kazi/agent-sdk";
import { SIGNATURE_HEADER, agentRequestSchema, providerTestKey, providerTestStateSchema, taskOnchainId } from "@kazi/shared";
import { runProviderTest } from "../src/executor/provider-test";
import { dispatchSubtask } from "../src/executor/dispatch";

/** Phase 4 worker pieces: self-hosted agent dry runs, endpoint SSRF guard, revision attempts. */

const log = pino({ level: "silent" });
const prefix = process.env["REDIS_KEY_PREFIX"]!;
const SECRET = "whsec_test_secret_value_0123456789";
const secrets = new SecretBox(process.env["ENCRYPTION_KEY"]!);
let prisma: PrismaClient;
let redis: Redis;
let ownerId: string;

beforeAll(async () => {
  prisma = createPrismaClient(process.env["DATABASE_URL"]!);
  redis = new Redis(process.env["REDIS_URL"]!, { maxRetriesPerRequest: 3 });
  const u = await prisma.user.create({ data: { wallet: `0x${randomBytes(20).toString("hex")}` } });
  ownerId = u.id;
});
afterAll(async () => {
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
  await prisma.$disconnect();
});

const agent = (endpointUrl: string, over: Record<string, unknown> = {}) =>
  prisma.provider.create({
    data: {
      ownerId,
      kind: "AGENT",
      name: "Agent",
      slug: `a-${randomUUID()}`,
      description: "test agent",
      capabilities: ["translate.en-sw"],
      pricing: { model: "fixed", price: "1.00", currency: "USDC" },
      payoutAddress: "0x000000000000000000000000000000000000dead",
      endpointUrl,
      webhookSecretEnc: secrets.encrypt(SECRET),
      status: "ACTIVE",
      ...over,
    },
  });

async function queuedTest(providerId: string) {
  const testId = randomBytes(12).toString("hex");
  const now = new Date().toISOString();
  await redis.set(
    providerTestKey(prefix, testId),
    JSON.stringify({ testId, providerId, capability: "translate.en-sw", status: "QUEUED", createdAt: now, updatedAt: now }),
  );
  const job = {
    providerId,
    testId,
    capability: "translate.en-sw",
    instructions: "Translate the text below.",
    text: "We sell 120 solar lamps a month.",
    rubric: ["Complete translation"],
  };
  const state = async () => providerTestStateSchema.parse(JSON.parse((await redis.get(providerTestKey(prefix, testId)))!));
  return { testId, job, state };
}

const config = { apiUrl: "https://api.kazi.test", syncResponseTimeoutMs: 5_000 };

describe("self-hosted agent dry run", () => {
  it("sends a signed, schema-valid sample request and checks a sync answer", async () => {
    const p = await agent("https://93.184.215.14/run");
    const { job, state, testId } = await queuedTest(p.id);
    const seen: unknown[] = [];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const headers = init?.headers as Record<string, string>;
      expect(verifySignature(body, headers[SIGNATURE_HEADER], SECRET).ok).toBe(true);
      seen.push(agentRequestSchema.parse(JSON.parse(body)));
      return Response.json({ status: "completed", output: { text: "Tunauza taa 120 za sola kwa mwezi." } });
    };
    const out = await runProviderTest({ prisma, secrets, redis, keyPrefix: prefix, config, log, fetch: fakeFetch as typeof fetch }, job);
    expect(out).toBe("COMPLETED");
    expect(seen[0]).toMatchObject({ subtaskId: `test_${testId}`, budget: "0", callbackUrl: `https://api.kazi.test/agent/test-callback/${testId}` });
    expect(await state()).toMatchObject({ status: "COMPLETED", http: 200, checks: [] });
  });

  it("never calls a private endpoint, and an async ack doesn't overwrite a result that already arrived", async () => {
    let calls = 0;
    const ack = (async () => {
      calls++;
      return Response.json({ status: "accepted" });
    }) as unknown as typeof fetch;
    const internal = await agent("https://10.0.0.5/run");
    const t1 = await queuedTest(internal.id);
    expect(await runProviderTest({ prisma, secrets, redis, keyPrefix: prefix, config, log, fetch: ack }, t1.job)).toBe("FAILED");
    expect(calls).toBe(0);
    expect((await t1.state()).error?.code).toBe("BAD_ENDPOINT");

    const p = await agent("https://93.184.215.14/run");
    const t2 = await queuedTest(p.id);
    const now = new Date().toISOString();
    await redis.set(
      providerTestKey(prefix, t2.testId),
      JSON.stringify({ ...(await t2.state()), status: "COMPLETED", output: { text: "x" }, checks: [], updatedAt: now }),
    );
    expect(await runProviderTest({ prisma, secrets, redis, keyPrefix: prefix, config, log, fetch: ack }, t2.job)).toBe("SENT");
    expect((await t2.state()).status).toBe("COMPLETED");
  });
});

describe("dispatch", () => {
  const deps = (fetch: typeof globalThis.fetch) => ({
    prisma,
    secrets,
    jobs: { add: async () => {} },
    usdcDecimals: async () => 6,
    config: { maxAttempts: 3, attemptTimeoutSec: 900, syncResponseTimeoutMs: 5_000, apiUrl: "https://api.kazi.test" },
    log,
    fetch,
  });

  async function subtask(providerId: string, over: Record<string, unknown> = {}) {
    const id = randomUUID();
    const task = await prisma.task.create({
      data: {
        id, onchainId: taskOnchainId(id), clientId: ownerId, title: "T", description: "D",
        deadline: new Date(Date.now() + 86_400_000), status: "IN_PROGRESS", feeBps: 500,
      },
    });
    return prisma.subtask.create({
      data: {
        taskId: task.id, index: 0, title: "S", instructions: "Translate", capability: "translate.en-sw", dependsOn: [],
        acceptance: { rubric: ["ok"], format: "markdown" }, providerId, amount: "1000000", ...over,
      },
    });
  }

  it("fails the attempt instead of calling a third-party endpoint on a private network", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return Response.json({ status: "accepted" });
    }) as unknown as typeof fetch;
    const p = await agent("https://192.168.1.20/run");
    const st = await subtask(p.id);
    expect(await dispatchSubtask(deps(fakeFetch), st.id, 1)).toBe("sent");
    expect(calls).toBe(0);
    const sub = await prisma.submission.findUnique({ where: { subtaskId_attempt: { subtaskId: st.id, attempt: 1 } } });
    const after = await prisma.subtask.findUniqueOrThrow({ where: { id: st.id } });
    expect(after.status).toBe("REJECTED");
    expect(JSON.stringify(sub?.evaluation ?? after)).toContain("BAD_ENDPOINT");
  });

  it("a revision after the last regular attempt goes back to the same provider", async () => {
    const bodies: string[] = [];
    const fakeFetch = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({ status: "accepted" });
    }) as unknown as typeof fetch;
    const p = await agent("https://93.184.215.14/run");
    const st = await subtask(p.id, { status: "REJECTED", attempts: 3, revisions: 1 });
    await prisma.submission.create({
      data: { subtaskId: st.id, providerId: p.id, attempt: 3, output: { text: "v3" }, accepted: true, evaluation: { feedback: "The client asked for a revision: keep the heading." } },
    });
    expect(await dispatchSubtask(deps(fakeFetch), st.id, 4)).toBe("sent");
    const after = await prisma.subtask.findUniqueOrThrow({ where: { id: st.id } });
    expect(after).toMatchObject({ status: "DISPATCHED", attempts: 4, providerId: p.id });
    expect(JSON.parse(bodies[0]!)).toMatchObject({ attempt: 4, feedback: expect.stringContaining("keep the heading") });
    expect(createHash("sha256").update(bodies[0]!).digest("hex")).toHaveLength(64);
  });
});
