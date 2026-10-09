import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData } from "viem";
import { signPayload } from "@kazi/agent-sdk";
import { agentRegistryAbi, taskEscrowAbi, taskOnchainId } from "@kazi/shared";
import { ADMIN_KEY, createHarness, inDays, login, type Harness } from "./harness";

/** Phase 4 endpoints: task lifecycle, freelancer flow, notifications, admin, agent dry runs. */

let h: Harness;
let client: Awaited<ReturnType<typeof login>>;
let other: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  h = await createHarness();
  client = await login(h);
  other = await login(h);
});
afterAll(async () => {
  await h.close();
});

type Login = Awaited<ReturnType<typeof login>>;
const get = (who: Login, url: string) => h.app.inject({ method: "GET", url, headers: { cookie: who.cookie } });
const post = (who: Login, url: string, payload: object = {}) =>
  h.app.inject({ method: "POST", url, headers: { cookie: who.cookie }, payload });

async function provider(ownerId: string, kind: "AGENT" | "HUMAN", over: Record<string, unknown> = {}) {
  return h.prisma.provider.create({
    data: {
      ownerId,
      kind,
      name: `${kind} provider`,
      slug: `p-${randomUUID()}`,
      description: "test provider",
      capabilities: ["translate.en-sw"],
      pricing: { model: "fixed", price: "1.00", currency: "USDC" },
      payoutAddress: "0x000000000000000000000000000000000000dead",
      status: "ACTIVE",
      ...over,
    },
  });
}

async function task(status: "DELIVERED" | "IN_PROGRESS", over: Record<string, unknown> = {}) {
  const id = randomUUID();
  return h.prisma.task.create({
    data: {
      id,
      onchainId: taskOnchainId(id),
      clientId: client.user.id,
      title: "Translate my shop page",
      description: "Translate the attached page to Swahili.",
      deadline: new Date(inDays(3)),
      status,
      feeBps: 500,
      totalAmount: "3000000",
      fundTxHash: `0x${"ab".repeat(32)}`,
      ...over,
    },
  });
}

describe("task lifecycle: deliverables, revision, dispute, invoice", () => {
  it("shows accepted outputs, sends one step back once, records a dispute and renders an invoice", async () => {
    const agent = await provider(other.user.id, "AGENT");
    const t = await task("DELIVERED", { reviewUntil: new Date(inDays(2)) });
    const file = await h.prisma.fileObject.create({
      data: { ownerId: client.user.id, key: `out-${randomUUID()}`, filename: "page.md", mime: "text/markdown", size: 5, status: "UPLOADED" },
    });
    const st = await h.prisma.subtask.create({
      data: {
        taskId: t.id, index: 0, title: "Translate", instructions: "Translate it", capability: "translate.en-sw",
        dependsOn: [], acceptance: {}, providerId: agent.id, amount: "2500000", status: "ACCEPTED", attempts: 1,
      },
    });
    await h.prisma.subtask.create({
      data: {
        taskId: t.id, index: 1, kind: "SERVICE_FEE", title: "Kazi service", instructions: "-", capability: "kazi.service",
        dependsOn: [], acceptance: {}, amount: "500000", status: "ACCEPTED",
      },
    });
    const sub = await h.prisma.submission.create({
      data: {
        subtaskId: st.id, providerId: agent.id, attempt: 1, accepted: true, score: 88,
        output: { text: "# Duka letu", files: [{ url: `kazi://files/${file.id}`, sha256: "a".repeat(64), mime: "text/markdown" }] },
        evaluation: { feedback: "Good." },
      },
    });

    const del = await get(client, `/tasks/${t.id}/deliverables`);
    expect(del.statusCode).toBe(200);
    const steps = del.json<{ steps: { index: number; output: { text: string; files: { fileId: string }[] } }[] }>().steps;
    expect(steps).toHaveLength(1); // the service-fee milestone is not a deliverable
    expect(steps[0]!.output.text).toBe("# Duka letu");
    expect(steps[0]!.output.files[0]!.fileId).toBe(file.id);
    expect((await get(other, `/tasks/${t.id}/deliverables`)).statusCode).toBe(404);

    expect((await post(client, `/tasks/${t.id}/revision`, { subtaskIndex: 0, note: "short" })).statusCode).toBe(400);
    expect((await post(client, `/tasks/${t.id}/revision`, { subtaskIndex: 1, note: "Please fix the heading." })).statusCode).toBe(404);
    const rev = await post(client, `/tasks/${t.id}/revision`, { subtaskIndex: 0, note: "Please keep the heading in English." });
    expect(rev.statusCode).toBe(200);
    expect(await h.prisma.task.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: "IN_PROGRESS", reviewUntil: null });
    expect(await h.prisma.subtask.findUniqueOrThrow({ where: { id: st.id } })).toMatchObject({ status: "REJECTED", revisions: 1 });
    const ev = (await h.prisma.submission.findUniqueOrThrow({ where: { id: sub.id } })).evaluation as { feedback: string };
    expect(ev.feedback).toContain("keep the heading in English");

    // One free revision per step.
    await h.prisma.task.update({ where: { id: t.id }, data: { status: "DELIVERED" } });
    await h.prisma.subtask.update({ where: { id: st.id }, data: { status: "ACCEPTED" } });
    const again = await post(client, `/tasks/${t.id}/revision`, { subtaskIndex: 0, note: "One more change please." });
    expect(again.statusCode).toBe(409);

    const dispute = await post(client, `/tasks/${t.id}/dispute`, { reason: "The translation drops two paragraphs.", evidence: ["para 3", "para 5"] });
    expect(dispute.statusCode).toBe(200);
    expect(await h.prisma.dispute.findUniqueOrThrow({ where: { taskId: t.id } })).toMatchObject({ status: "OPEN", evidence: ["para 3", "para 5"] });

    const pdf = await get(client, `/tasks/${t.id}/invoice.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("freelancer offers", () => {
  it("first to accept gets the work; submission is handed to the evaluator as the client's files", async () => {
    const a = await login(h);
    const b = await login(h);
    const pa = await provider(a.user.id, "HUMAN", { onchainId: 101 });
    const pb = await provider(b.user.id, "HUMAN", { onchainId: 102 });
    const attachment = await h.prisma.fileObject.create({
      data: { ownerId: client.user.id, key: `att-${randomUUID()}`, filename: "page.txt", mime: "text/plain", size: 4, status: "UPLOADED" },
    });
    const t = await task("IN_PROGRESS", { attachments: [attachment.id] });
    const st = await h.prisma.subtask.create({
      data: {
        taskId: t.id, index: 0, title: "Review translation", instructions: "Check it", capability: "translate.en-sw",
        dependsOn: [], acceptance: {}, providerId: pa.id, amount: "2000000", status: "DISPATCHED", attempts: 1,
        timeoutAt: new Date(inDays(1)),
      },
    });
    const expiresAt = new Date(Date.now() + 3_600_000);
    await h.prisma.offer.createMany({
      data: [
        { subtaskId: st.id, attempt: 1, providerId: pa.id, wave: 1, expiresAt },
        { subtaskId: st.id, attempt: 1, providerId: pb.id, wave: 2, expiresAt },
      ],
    });

    const list = (await get(b, "/freelancer/offers")).json<{ offers: { subtaskId: string; payout: string }[] }>().offers;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ subtaskId: st.id, payout: "1900000" }); // 2.00 minus the 5% fee

    // B accepts first; A's offer is withdrawn.
    expect((await post(b, `/freelancer/offers/${st.id}/accept`)).statusCode).toBe(200);
    expect((await post(b, `/freelancer/offers/${st.id}/accept`)).statusCode).toBe(200); // idempotent
    expect((await post(a, `/freelancer/offers/${st.id}/accept`)).statusCode).toBe(409); // withdrawn
    expect(h.jobs.jobs.some((j) => j.name === "offerAccepted")).toBe(true);
    expect((await get(a, `/freelancer/subtasks/${st.id}`)).statusCode).toBe(404);

    const view = await get(b, `/freelancer/subtasks/${st.id}`);
    expect(view.statusCode).toBe(200);
    const work = view.json<{ subtask: { assigned: boolean }; files: { id: string }[] }>();
    expect(work.subtask.assigned).toBe(false); // the worker hasn't reassigned the milestone yet
    expect(work.files.map((f) => f.id)).toEqual([attachment.id]);
    expect((await get(b, `/freelancer/subtasks/${st.id}/files/${attachment.id}/download-url`)).statusCode).toBe(200);
    const stranger = await h.prisma.fileObject.create({
      data: { ownerId: other.user.id, key: `x-${randomUUID()}`, filename: "x", mime: "text/plain", size: 1, status: "UPLOADED" },
    });
    expect((await get(b, `/freelancer/subtasks/${st.id}/files/${stranger.id}/download-url`)).statusCode).toBe(404);

    const body = new TextEncoder().encode("Reviewed: all good.");
    const upload = await h.prisma.fileObject.create({
      data: { ownerId: b.user.id, key: `fl-${randomUUID()}`, filename: "review.txt", mime: "text/plain", size: body.byteLength, status: "UPLOADED" },
    });
    h.storage.put(upload.key, body.byteLength, "text/plain", body);
    const submit = () => post(b, `/freelancer/subtasks/${st.id}/submit`, { text: "Done, see file.", files: [upload.id] });
    expect((await submit()).statusCode).toBe(409); // not reassigned yet

    await h.prisma.subtask.update({ where: { id: st.id }, data: { providerId: pb.id } }); // what the worker does
    expect((await post(b, `/freelancer/subtasks/${st.id}/submit`, { files: [stranger.id] })).statusCode).toBe(400);
    expect((await submit()).statusCode).toBe(200);
    const job = h.jobs.jobs.find((j) => j.name === "agentResult" && j.data.subtaskId === st.id);
    const sha = createHash("sha256").update(body).digest("hex");
    expect(job?.data).toMatchObject({
      attempt: 1,
      callback: { status: "completed", output: { text: "Done, see file.", files: [{ url: `kazi://files/${upload.id}`, sha256: sha }] } },
    });
    expect(await h.prisma.fileObject.findUniqueOrThrow({ where: { id: upload.id } })).toMatchObject({
      ownerId: client.user.id,
      source: "freelancer",
      sha256: sha,
    });
  });
});

describe("notifications", () => {
  it("lists, counts and marks the caller's notifications only", async () => {
    await h.prisma.notification.createMany({
      data: [1, 2, 3].map((i) => ({ userId: client.user.id, type: "T", title: `n${i}`, body: "b" })),
    });
    await h.prisma.notification.create({ data: { userId: other.user.id, type: "T", title: "theirs", body: "b" } });
    const res = (await get(client, "/notifications")).json<{ notifications: { id: string }[]; unread: number }>();
    expect(res.unread).toBe(3);
    expect(res.notifications).toHaveLength(3);
    const theirs = await h.prisma.notification.findFirstOrThrow({ where: { userId: other.user.id } });
    const marked = await post(client, "/notifications/read", { ids: [res.notifications[0]!.id, theirs.id] });
    expect(marked.json<{ marked: number }>().marked).toBe(1);
    expect((await post(client, "/notifications/read", { all: true })).json<{ marked: number }>().marked).toBe(2);
    expect((await get(client, "/notifications?unread=1")).json<{ unread: number }>().unread).toBe(0);
    expect((await get(other, "/notifications")).json<{ unread: number }>().unread).toBe(1);
  });
});

describe("admin", () => {
  it("reviews providers and prepares registrar / arbiter transactions", async () => {
    const admin = await login(h, privateKeyToAccount(ADMIN_KEY));
    expect((await get(client, "/admin/providers")).statusCode).toBe(403);
    const pending = await provider(other.user.id, "AGENT", { status: "PENDING", onchainId: 77 });
    const listRes = await get(admin, "/admin/providers?status=PENDING");
    expect(listRes.statusCode, listRes.body).toBe(200);
    const list = listRes.json<{ providers: { id: string }[] }>();
    expect(list.providers.map((p) => p.id)).toContain(pending.id);

    expect((await post(admin, `/admin/providers/${pending.id}/review`, { reviewScore: 86 })).statusCode).toBe(200);
    expect((await h.prisma.provider.findUniqueOrThrow({ where: { id: pending.id } })).reviewScore).toBe(86);

    const act = (await post(admin, `/admin/providers/${pending.id}/activate`)).json<{ tx: { to: string; data: `0x${string}` } }>();
    const decoded = decodeFunctionData({ abi: agentRegistryAbi, data: act.tx.data });
    expect(decoded).toMatchObject({ functionName: "activate", args: [77n] });

    const t = await task("DELIVERED", { status: "DISPUTED" });
    await h.prisma.subtask.create({
      data: {
        taskId: t.id, index: 0, title: "S", instructions: "I", capability: "translate.en-sw", dependsOn: [],
        acceptance: {}, providerId: pending.id, amount: "1000000", status: "ACCEPTED",
      },
    });
    const d = await h.prisma.dispute.create({ data: { taskId: t.id, reason: "Missing sections in the report." } });
    const disputes = (await get(admin, "/admin/disputes")).json<{ disputes: { id: string }[] }>().disputes;
    expect(disputes.map((x) => x.id)).toContain(d.id);
    expect((await post(admin, `/admin/disputes/${d.id}/resolve`, { resolutions: [{ index: 3, clientShareBps: 5000 }] })).statusCode).toBe(409);
    const res = await post(admin, `/admin/disputes/${d.id}/resolve`, { resolutions: [{ index: 0, clientShareBps: 6000 }] });
    expect(res.statusCode).toBe(200);
    const call = decodeFunctionData({ abi: taskEscrowAbi, data: res.json<{ txs: { data: `0x${string}` }[] }>().txs[0]!.data });
    expect(call).toMatchObject({ functionName: "resolveDispute", args: [t.onchainId, 0n, 6000] });
    expect((await h.prisma.dispute.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("UNDER_REVIEW");

    const queues = (await get(admin, "/admin/queues")).json<{ queues: Record<string, { waiting: number }> }>().queues;
    expect(Object.keys(queues)).toContain("executor");

    expect((await h.app.inject({ method: "PATCH", url: "/admin/settings", headers: { cookie: admin.cookie }, payload: { announcement: "Testnet only" } })).statusCode).toBe(200);
    const config = (await h.app.inject({ method: "GET", url: "/config" })).json<{ usdcDecimals: number; settings: { announcement: string } }>();
    expect(config).toMatchObject({ usdcDecimals: 6, settings: { announcement: "Testnet only" } });
  });
});

describe("self-hosted agent dry run", () => {
  it("queues a signed sample request and accepts the async result at the test callback", async () => {
    const dev = await login(h);
    const created = await post(dev, "/providers", {
      kind: "AGENT",
      name: "Echo Agent",
      description: "Echoes the request for testing.",
      capabilities: ["translate.en-sw"],
      languages: ["en", "sw"],
      endpointUrl: "https://agent.example.com/run",
      pricing: { model: "fixed", price: "1.00", currency: "USDC" },
      payoutAddress: dev.account.address,
    });
    expect(created.statusCode).toBe(201);
    const { provider: p, webhookSecret } = created.json<{ provider: { id: string }; webhookSecret: string }>();

    const started = await post(dev, `/providers/${p.id}/test`);
    expect(started.statusCode).toBe(202);
    const testId = started.json<{ test: { testId: string } }>().test.testId;
    const job = h.jobs.jobs.find((j) => j.name === "providerTest" && j.data.testId === testId);
    expect(job?.data).toMatchObject({ providerId: p.id, capability: "translate.en-sw" });
    expect((await get(other, `/providers/${p.id}/tests/${testId}`)).statusCode).toBe(404);

    const callback = (body: string, secret: string) =>
      h.app.inject({
        method: "POST",
        url: `/agent/test-callback/${testId}`,
        headers: { "content-type": "application/json", "x-kazi-signature": signPayload(body, secret) },
        payload: body,
      });
    const result = JSON.stringify({ status: "completed", output: { text: "## Duka letu\n\nTunauza taa 120 kwa mwezi." } });
    expect((await callback(result, "wrong-secret")).statusCode).toBe(401);
    expect((await callback(result, webhookSecret)).statusCode).toBe(202);
    const state = (await get(dev, `/providers/${p.id}/tests/${testId}`)).json<{ test: { status: string; checks: unknown[] } }>().test;
    expect(state).toMatchObject({ status: "COMPLETED", checks: [] });

    const mine = (await get(dev, "/me/providers")).json<{ providers: { id: string }[] }>().providers;
    expect(mine.map((x) => x.id)).toEqual([p.id]);
  });
});
