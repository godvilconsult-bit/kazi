import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskOnchainId } from "@kazi/shared";
import { SecretBox } from "@kazi/config/secrets";
import { createHarness, inDays, login, type Harness } from "./harness";

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

const validTask = () => ({
  title: "Translate my business plan",
  description: "Translate the attached business plan into formal Swahili.",
  deadline: inDays(3),
  budgetMax: "25000000",
});

describe("tasks", () => {
  it("creates a DRAFT task with a deterministic onchain id and an audit event", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: client.cookie },
      payload: validTask(),
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json<{
      task: { id: string; onchainId: string; status: string; budgetMax: string };
    }>();
    expect(task.status).toBe("DRAFT");
    expect(task.onchainId).toBe(taskOnchainId(task.id));
    expect(task.budgetMax).toBe("25000000");
    const events = await h.prisma.taskEvent.findMany({ where: { taskId: task.id } });
    expect(events.map((e) => e.type)).toEqual(["CREATED"]);
  });

  it("validates input and deadline bounds", async () => {
    const tooSoon = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: client.cookie },
      payload: { ...validTask(), deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    });
    expect(tooSoon.statusCode).toBe(400);
    const floatBudget = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: client.cookie },
      payload: { ...validTask(), budgetMax: "12.5" },
    });
    expect(floatBudget.statusCode).toBe(400);
    const anon = await h.app.inject({ method: "POST", url: "/tasks", payload: validTask() });
    expect(anon.statusCode).toBe(401);
  });

  it("hides other clients' tasks (404, not 403)", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: client.cookie },
      payload: validTask(),
    });
    const id = created.json<{ task: { id: string } }>().task.id;
    const res = await h.app.inject({
      method: "GET",
      url: `/tasks/${id}`,
      headers: { cookie: other.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists own tasks with cursor pagination", async () => {
    const page1 = await h.app.inject({
      method: "GET",
      url: "/tasks?limit=1",
      headers: { cookie: client.cookie },
    });
    const body1 = page1.json<{ tasks: { id: string }[]; nextCursor: string | null }>();
    expect(body1.tasks).toHaveLength(1);
    expect(body1.nextCursor).toBeTruthy();
    const page2 = await h.app.inject({
      method: "GET",
      url: `/tasks?limit=1&cursor=${body1.nextCursor}`,
      headers: { cookie: client.cookie },
    });
    const body2 = page2.json<{ tasks: { id: string }[] }>();
    expect(body2.tasks[0]?.id).not.toBe(body1.tasks[0]?.id);
    const otherList = await h.app.inject({
      method: "GET",
      url: "/tasks",
      headers: { cookie: other.cookie },
    });
    expect(otherList.json<{ tasks: unknown[] }>().tasks).toHaveLength(0);
  });

  it("cancels through the state machine and rejects illegal moves", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: client.cookie },
      payload: validTask(),
    });
    const id = created.json<{ task: { id: string } }>().task.id;
    const cancel = await h.app.inject({
      method: "POST",
      url: `/tasks/${id}/cancel`,
      headers: { cookie: client.cookie },
    });
    expect(cancel.json()).toEqual({ status: "CANCELLED" });
    const again = await h.app.inject({
      method: "POST",
      url: `/tasks/${id}/cancel`,
      headers: { cookie: client.cookie },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe("INVALID_STATE");
    const rate = await h.app.inject({
      method: "POST",
      url: `/tasks/${id}/rate`,
      headers: { cookie: client.cookie },
      payload: { rating: 5 },
    });
    expect(rate.statusCode).toBe(409);
  });

  it("rates a completed task exactly once", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: client.cookie },
      payload: validTask(),
    });
    const id = created.json<{ task: { id: string } }>().task.id;
    await h.prisma.task.update({ where: { id }, data: { status: "COMPLETED" } });
    const first = await h.app.inject({
      method: "POST",
      url: `/tasks/${id}/rate`,
      headers: { cookie: client.cookie },
      payload: { rating: 4, comment: "Good" },
    });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({
      method: "POST",
      url: `/tasks/${id}/rate`,
      headers: { cookie: client.cookie },
      payload: { rating: 1 },
    });
    expect(second.statusCode).toBe(409);
  });

  it("streams task events over SSE", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: client.cookie },
      payload: validTask(),
    });
    const id = created.json<{ task: { id: string } }>().task.id;
    const address = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const controller = new AbortController();
    const res = await fetch(`${address}/tasks/${id}/events`, {
      headers: { cookie: client.cookie },
      signal: controller.signal,
    });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    controller.abort();
    expect(new TextDecoder().decode(value)).toMatch(/event: task\ndata: .*"type":"CREATED"/);
  });
});

describe("providers", () => {
  const agent = {
    kind: "AGENT",
    name: "Swahili Translator",
    description: "Translates business documents between English and Swahili.",
    capabilities: ["translate.en-sw"],
    languages: ["en", "sw"],
    endpointUrl: "https://agent.example.com/kazi/run",
    pricing: { model: "per_unit", unit: "1000_words", price: "0.80", currency: "USDC" },
    payoutAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  };

  it("registers a PENDING agent, returns the webhook secret once and stores it encrypted", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/providers",
      headers: { cookie: client.cookie },
      payload: agent,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      provider: { id: string; status: string; payoutAddress: string };
      webhookSecret: string;
    }>();
    expect(body.provider.status).toBe("PENDING");
    expect(body.provider.payoutAddress).toBe(agent.payoutAddress.toLowerCase());
    expect(body.webhookSecret).toMatch(/^whsec_/);

    const row = await h.prisma.provider.findUniqueOrThrow({ where: { id: body.provider.id } });
    expect(row.webhookSecretEnc).not.toContain(body.webhookSecret);
    expect(new SecretBox(h.env.ENCRYPTION_KEY).decrypt(row.webhookSecretEnc!)).toBe(
      body.webhookSecret,
    );
    expect(JSON.stringify(res.json<{ provider: unknown }>().provider)).not.toMatch(
      /webhookSecretEnc|apiKeyHash/,
    );
    const user = await h.prisma.user.findUniqueOrThrow({ where: { id: client.user.id } });
    expect(user.roles).toContain("PROVIDER_OWNER");

    const rotated = await h.app.inject({
      method: "POST",
      url: `/providers/${body.provider.id}/rotate-secret`,
      headers: { cookie: client.cookie },
    });
    expect(rotated.json<{ webhookSecret: string }>().webhookSecret).not.toBe(body.webhookSecret);
  });

  it("rejects unknown capabilities and agents without endpoints", async () => {
    const unknown = await h.app.inject({
      method: "POST",
      url: "/providers",
      headers: { cookie: client.cookie },
      payload: { ...agent, capabilities: ["write.poetry"] },
    });
    expect(unknown.statusCode).toBe(400);
    const noEndpoint = await h.app.inject({
      method: "POST",
      url: "/providers",
      headers: { cookie: client.cookie },
      payload: { ...agent, endpointUrl: undefined },
    });
    expect(noEndpoint.statusCode).toBe(400);
  });

  it("only the owner can update; the public directory shows ACTIVE providers only", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/providers",
      headers: { cookie: client.cookie },
      payload: { ...agent, kind: "HUMAN", endpointUrl: undefined, capabilities: ["human.review"] },
    });
    const { id, slug } = created.json<{ provider: { id: string; slug: string } }>().provider;

    const hijack = await h.app.inject({
      method: "PATCH",
      url: `/providers/${id}`,
      headers: { cookie: other.cookie },
      payload: { name: "Hacked name" },
    });
    expect(hijack.statusCode).toBe(404);
    const ok = await h.app.inject({
      method: "PATCH",
      url: `/providers/${id}`,
      headers: { cookie: client.cookie },
      payload: { name: "Reviewed by Asha" },
    });
    expect(ok.json<{ provider: { name: string } }>().provider.name).toBe("Reviewed by Asha");

    expect((await h.app.inject({ method: "GET", url: `/providers/${slug}` })).statusCode).toBe(404);
    await h.prisma.provider.update({ where: { id }, data: { status: "ACTIVE", reputation: 80 } });
    expect((await h.app.inject({ method: "GET", url: `/providers/${slug}` })).statusCode).toBe(200);
    const list = await h.app.inject({
      method: "GET",
      url: "/providers?capability=human.review&minReputation=50",
    });
    const providers = list.json<{ providers: { id: string }[] }>().providers;
    expect(providers.map((p) => p.id)).toEqual([id]);

    const stats = await h.app.inject({
      method: "GET",
      url: `/providers/${id}/stats`,
      headers: { cookie: client.cookie },
    });
    expect(stats.json<{ stats: { earningsGross: string } }>().stats.earningsGross).toBe("0");
  });
});

describe("files", () => {
  it("presigns, confirms the upload by size, and allows the file as a task attachment", async () => {
    const presign = await h.app.inject({
      method: "POST",
      url: "/files/presign",
      headers: { cookie: client.cookie },
      payload: { filename: "business plan.pdf", mime: "application/pdf", size: 1234 },
    });
    expect(presign.statusCode).toBe(201);
    const { file, upload } = presign.json<{
      file: { id: string; status: string };
      upload: { url: string; method: string };
    }>();
    expect(file.status).toBe("PENDING");
    expect(upload.method).toBe("PUT");
    const row = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.key).toMatch(new RegExp(`^${client.user.id}/[0-9a-f-]+/business_plan.pdf$`));

    // Not uploaded yet → can't confirm, can't attach.
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/files/${file.id}/complete`,
          headers: { cookie: client.cookie },
        })
      ).statusCode,
    ).toBe(409);
    const early = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: client.cookie },
      payload: { ...validTask(), attachments: [file.id] },
    });
    expect(early.statusCode).toBe(400);

    h.storage.put(row.key, 999, "application/pdf"); // wrong size
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/files/${file.id}/complete`,
          headers: { cookie: client.cookie },
        })
      ).statusCode,
    ).toBe(409);
    h.storage.put(row.key, 1234, "application/pdf");
    const done = await h.app.inject({
      method: "POST",
      url: `/files/${file.id}/complete`,
      headers: { cookie: client.cookie },
    });
    expect(done.json<{ file: { status: string } }>().file.status).toBe("UPLOADED");

    const task = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: client.cookie },
      payload: { ...validTask(), attachments: [file.id] },
    });
    expect(task.statusCode).toBe(201);
    // Someone else can't attach or download it.
    const stolen = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: other.cookie },
      payload: { ...validTask(), attachments: [file.id] },
    });
    expect(stolen.statusCode).toBe(400);
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: `/files/${file.id}/download-url`,
          headers: { cookie: other.cookie },
        })
      ).statusCode,
    ).toBe(404);
    const dl = await h.app.inject({
      method: "GET",
      url: `/files/${file.id}/download-url`,
      headers: { cookie: client.cookie },
    });
    expect(dl.json<{ url: string }>().url).toMatch(/ttl=900$/);
  });

  it("rejects oversized and path-traversal uploads", async () => {
    const big = await h.app.inject({
      method: "POST",
      url: "/files/presign",
      headers: { cookie: client.cookie },
      payload: { filename: "a.zip", mime: "application/zip", size: 51 * 1024 * 1024 },
    });
    expect(big.statusCode).toBe(400);
    const traversal = await h.app.inject({
      method: "POST",
      url: "/files/presign",
      headers: { cookie: client.cookie },
      payload: { filename: "../../etc/passwd", mime: "text/plain", size: 10 },
    });
    expect(traversal.statusCode).toBe(400);
  });
});
