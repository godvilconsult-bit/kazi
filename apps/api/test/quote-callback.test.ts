import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signPayload } from "@kazi/agent-sdk";
import { SecretBox } from "@kazi/config/secrets";
import { taskOnchainId, type StoredQuote } from "@kazi/shared";
import { createHarness, inDays, login, type Harness } from "./harness";

/** Phase 3 API: quote requests, fund params, approval, and signed agent callbacks. */

let h: Harness;
let client: Awaited<ReturnType<typeof login>>;
const SECRET = "whsec_test_callback_secret_0123456789";

beforeAll(async () => {
  h = await createHarness();
  client = await login(h);
});
afterAll(async () => {
  await h.close();
});

async function newTask(status: "DRAFT" | "QUOTED" | "DELIVERED" = "DRAFT", quote?: StoredQuote) {
  const id = crypto.randomUUID();
  return h.prisma.task.create({
    data: {
      id,
      onchainId: taskOnchainId(id),
      clientId: client.user.id,
      title: "Translate",
      description: "Translate my summary",
      deadline: new Date(inDays(3)),
      status,
      ...(quote ? { quote: quote as never, quoteVersion: quote.version } : {}),
    },
  });
}

const signedQuote = (_taskId: string, onchainId: string, expiresInMs: number): StoredQuote => ({
  outcome: "QUOTED",
  version: 1,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  client: client.account.address.toLowerCase(),
  onchain: {
    taskId: onchainId,
    providerIds: ["1", "2"],
    amounts: ["1000000", "120000"],
    deadline: "1900000000",
    feeBps: 1200,
    expiry: "1800000000",
  },
  signature: `0x${"ab".repeat(65)}`,
  subtotal: "880000",
  serviceFee: "100000",
  total: "1120000",
  overBudget: false,
  steps: [
    {
      index: 0,
      kind: "WORK",
      title: "Translate",
      capability: "translate.en-sw",
      providerId: "p1",
      providerName: "T",
      amount: "1000000",
      cost: "880000",
      fallbackProviderIds: ["secret-fallback"],
    },
    {
      index: 1,
      kind: "SERVICE_FEE",
      title: "Kazi service fee",
      capability: null,
      providerId: "p2",
      providerName: "Kazi",
      amount: "120000",
      cost: "105600",
      fallbackProviderIds: [],
    },
  ],
  plan: { feasible: true, clarifyingQuestions: [], subtasks: [] },
});

describe("quotes", () => {
  it("enqueues a router job once per quote version", async () => {
    const task = await newTask();
    const res = await h.app.inject({
      method: "POST",
      url: `/tasks/${task.id}/quote`,
      headers: { cookie: client.cookie },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "queued", version: 1 });
    await h.app.inject({
      method: "POST",
      url: `/tasks/${task.id}/quote`,
      headers: { cookie: client.cookie },
    });
    expect(h.jobs.jobs.filter((j) => j.data["taskId"] === task.id)).toEqual([
      { queue: "router", name: "quote", data: { taskId: task.id }, jobId: `quote-${task.id}-1` },
    ]);
  });

  it("serves the quote without router-internal fallbacks, and fund params for the signing wallet", async () => {
    const draft = await newTask();
    await h.prisma.task.update({
      where: { id: draft.id },
      data: { status: "QUOTED", quote: signedQuote(draft.id, draft.onchainId, 600_000) as never },
    });
    const q = await h.app.inject({
      method: "GET",
      url: `/tasks/${draft.id}/quote`,
      headers: { cookie: client.cookie },
    });
    expect(q.statusCode).toBe(200);
    expect(q.body).not.toContain("secret-fallback");
    expect(q.json<{ quote: { total: string; expired: boolean } }>().quote).toMatchObject({
      total: "1120000",
      expired: false,
    });

    const fp = await h.app.inject({
      method: "GET",
      url: `/tasks/${draft.id}/fund-params`,
      headers: { cookie: client.cookie },
    });
    expect(fp.statusCode).toBe(200);
    expect(fp.json()).toMatchObject({
      escrowAddress: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
      quote: { taskId: draft.onchainId, amounts: ["1000000", "120000"], feeBps: 1200 },
      total: "1120000",
    });
    // A live quote is not re-queued.
    const again = await h.app.inject({
      method: "POST",
      url: `/tasks/${draft.id}/quote`,
      headers: { cookie: client.cookie },
    });
    expect(again.statusCode).toBe(200);
  });

  it("refuses fund params for an expired quote", async () => {
    const draft = await newTask();
    await h.prisma.task.update({
      where: { id: draft.id },
      data: { status: "QUOTED", quote: signedQuote(draft.id, draft.onchainId, -1) as never },
    });
    const fp = await h.app.inject({
      method: "GET",
      url: `/tasks/${draft.id}/fund-params`,
      headers: { cookie: client.cookie },
    });
    expect(fp.statusCode).toBe(409);
  });

  it("approves only delivered tasks, once", async () => {
    const draft = await newTask();
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/tasks/${draft.id}/approve`,
          headers: { cookie: client.cookie },
        })
      ).statusCode,
    ).toBe(409);
    const delivered = await newTask("DELIVERED");
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/tasks/${delivered.id}/approve`,
          headers: { cookie: client.cookie },
        })
      ).statusCode,
    ).toBe(200);
    await h.app.inject({
      method: "POST",
      url: `/tasks/${delivered.id}/approve`,
      headers: { cookie: client.cookie },
    });
    expect(
      (await h.prisma.task.findUniqueOrThrow({ where: { id: delivered.id } })).approvedAt,
    ).not.toBeNull();
    expect(
      await h.prisma.taskEvent.count({ where: { taskId: delivered.id, type: "CLIENT_APPROVED" } }),
    ).toBe(1);
  });
});

describe("agent callbacks", () => {
  async function dispatchedSubtask() {
    const task = await newTask();
    const owner = await h.prisma.user.create({
      data: { wallet: `0x${crypto.randomUUID().replace(/-/g, "").padEnd(40, "0")}` },
    });
    const provider = await h.prisma.provider.create({
      data: {
        ownerId: owner.id,
        kind: "AGENT",
        name: "Agent",
        slug: `agent-${crypto.randomUUID()}`,
        description: "test agent",
        pricing: { model: "fixed", price: "1.00", currency: "USDC" },
        payoutAddress: owner.wallet,
        webhookSecretEnc: new SecretBox(h.env.ENCRYPTION_KEY).encrypt(SECRET),
      },
    });
    return h.prisma.subtask.create({
      data: {
        taskId: task.id,
        index: 0,
        title: "T",
        instructions: "I",
        capability: "translate.en-sw",
        dependsOn: [],
        acceptance: {},
        providerId: provider.id,
        amount: "1000000",
        status: "DISPATCHED",
        attempts: 1,
      },
    });
  }
  const body = JSON.stringify({ status: "completed", output: { text: "Habari" } });

  it("verifies the HMAC over the raw body and enqueues the result", async () => {
    const st = await dispatchedSubtask();
    const res = await h.app.inject({
      method: "POST",
      url: `/agent/callback/${st.id}?attempt=1`,
      headers: {
        "content-type": "application/json",
        "x-kazi-signature": signPayload(body, SECRET),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const job = h.jobs.jobs.find((j) => j.name === "agentResult" && j.data["subtaskId"] === st.id);
    expect(job?.data).toMatchObject({
      subtaskId: st.id,
      attempt: 1,
      callback: { status: "completed", output: { text: "Habari" } },
    });
  });

  it("rejects bad signatures, tampered bodies, unknown attempts and invalid payloads", async () => {
    const st = await dispatchedSubtask();
    const post = (payload: string, sig: string, attempt = 1) =>
      h.app.inject({
        method: "POST",
        url: `/agent/callback/${st.id}?attempt=${attempt}`,
        headers: { "content-type": "application/json", "x-kazi-signature": sig },
        payload,
      });
    expect((await post(body, signPayload(body, "wrong-secret"))).statusCode).toBe(401);
    expect(
      (await post(body.replace("Habari", "Hacked"), signPayload(body, SECRET))).statusCode,
    ).toBe(401);
    expect(
      (await post(body, signPayload(body, SECRET, Math.floor(Date.now() / 1000) - 3_600)))
        .statusCode,
    ).toBe(401);
    expect((await post(body, signPayload(body, SECRET), 2)).statusCode).toBe(404);
    const junk = JSON.stringify({ status: "completed" });
    expect((await post(junk, signPayload(junk, SECRET))).statusCode).toBe(400);
    expect(h.jobs.jobs.some((j) => j.data["subtaskId"] === st.id)).toBe(false);
  });
});
