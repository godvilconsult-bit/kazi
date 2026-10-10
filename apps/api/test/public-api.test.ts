import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ADMIN_KEY, createHarness, login, type Harness } from "./harness";

/** Public API (docs/12-PUBLIC-API.md): API keys, quick tasks, payment instructions. */

let h: Harness;
let user: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  h = await createHarness();
  user = await login(h);
});
afterAll(async () => {
  await h.close();
});

const withKey = (key: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  h.app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) });

describe("API keys", () => {
  it("are shown once, authenticate as their owner, and stop working when revoked", async () => {
    const created = await h.app.inject({ method: "POST", url: "/me/api-keys", headers: { cookie: user.cookie }, payload: { name: "my agent" } });
    expect(created.statusCode).toBe(201);
    const { key, apiKey } = created.json<{ key: string; apiKey: { id: string; prefix: string } }>();
    expect(key).toMatch(/^kz_test_[a-z0-9]{8}_/);
    expect(key).toContain(apiKey.prefix);

    const listed = await h.app.inject({ method: "GET", url: "/me/api-keys", headers: { cookie: user.cookie } });
    expect(listed.body).not.toContain(key); // never shown again
    expect(await h.prisma.apiKey.findFirst({ where: { keyHash: key } })).toBeNull(); // only the hash is stored

    const me = await withKey(key, "GET", "/me");
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { id: string } }>().user.id).toBe(user.user.id);

    // Keys can't manage keys.
    expect((await withKey(key, "POST", "/me/api-keys", { name: "another" })).statusCode).toBe(403);

    expect((await h.app.inject({ method: "DELETE", url: `/me/api-keys/${apiKey.id}`, headers: { cookie: user.cookie } })).statusCode).toBe(200);
    expect((await withKey(key, "GET", "/me")).statusCode).toBe(401);
    expect((await withKey("kz_test_badbadba_" + "x".repeat(40), "GET", "/me")).statusCode).toBe(401);
  });

  it("never grant admin rights, even to an admin's key", async () => {
    const admin = await login(h, privateKeyToAccount(ADMIN_KEY));
    const { key } = (await h.app.inject({ method: "POST", url: "/me/api-keys", headers: { cookie: admin.cookie }, payload: { name: "ops" } })).json<{ key: string }>();
    expect((await withKey(key, "GET", "/admin/queues")).statusCode).toBe(403);
  });
});

describe("quick tasks and payment", () => {
  it("creates a task and queues its quote in one call; x402 is not enabled", async () => {
    const { key } = (await h.app.inject({ method: "POST", url: "/me/api-keys", headers: { cookie: user.cookie }, payload: { name: "bot" } })).json<{ key: string }>();
    const res = await withKey(key, "POST", "/v1/quick-tasks", { description: "Translate our 2-page price list into Swahili, keep the table." });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ task: { id: string; status: string; title: string }; quote: string; next: { payment: string } }>();
    expect(body).toMatchObject({ quote: "queued", task: { status: "DRAFT" } });
    expect(body.task.title).toContain("Translate our 2-page price list");
    expect(h.jobs.jobs.some((j) => j.name === "quote" && j.data.taskId === body.task.id)).toBe(true);

    // No quote yet → no payment instructions; x402 is a reserved method that isn't enabled.
    expect((await withKey(key, "GET", body.next.payment)).statusCode).toBe(409);
    const x402 = await withKey(key, "GET", `${body.next.payment}?method=x402`);
    expect(x402.statusCode).toBe(501);
    expect(x402.json<{ status: string }>().status).toBe("unavailable");

    // Another user's key can't see the task.
    const other = await login(h);
    const { key: otherKey } = (await h.app.inject({ method: "POST", url: "/me/api-keys", headers: { cookie: other.cookie }, payload: { name: "x" } })).json<{ key: string }>();
    expect((await withKey(otherKey, "GET", `/tasks/${body.task.id}`)).statusCode).toBe(404);
  });
});
