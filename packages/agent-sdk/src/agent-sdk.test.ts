import { describe, expect, it, vi } from "vitest";
import type { AgentManifest, AgentRequest } from "@kazi/shared";
import { createKaziAgent, signPayload, verifySignature, type CapabilityHandler } from "./index";

const SECRET = "test-secret-0123456789";

const manifest = (mode: "sync" | "async"): AgentManifest => ({
  schemaVersion: "1.0",
  name: "Echo Agent",
  description: "Echoes the input text back.",
  version: "1.0.0",
  endpoint: "https://agent.example.com/run",
  capabilities: ["write.blog_post"],
  languages: ["en"],
  pricing: { model: "fixed", price: "1.00", currency: "USDC" },
  mode,
});

const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  subtaskId: "st_1",
  attempt: 1,
  capability: "write.blog_post",
  instructions: "Echo it",
  input: { text: "hello" },
  acceptance: { rubric: ["echoes"], format: "text" },
  deadline: new Date(Date.now() + 60_000).toISOString(),
  callbackUrl: "https://kazi.example.com/agent/callback/st_1",
  budget: "1.00",
  ...over,
});

function signed(body: unknown, secret = SECRET) {
  const rawBody = JSON.stringify(body);
  return {
    method: "POST",
    path: "/run",
    rawBody,
    headers: { "x-kazi-signature": signPayload(rawBody, secret) },
  };
}

const echo: CapabilityHandler = async (ctx) => ({ text: `echo: ${ctx.request.input.text}` });

describe("signatures", () => {
  it("verifies its own signatures and rejects tampering, staleness and malformed headers", () => {
    const now = 1_800_000_000;
    const header = signPayload('{"a":1}', SECRET, now);
    expect(verifySignature('{"a":1}', header, SECRET, { nowSec: now + 10 })).toEqual({ ok: true });
    expect(verifySignature('{"a":2}', header, SECRET, { nowSec: now })).toEqual({
      ok: false,
      reason: "MISMATCH",
    });
    expect(verifySignature('{"a":1}', header, "other-secret", { nowSec: now })).toEqual({
      ok: false,
      reason: "MISMATCH",
    });
    expect(verifySignature('{"a":1}', header, SECRET, { nowSec: now + 301 })).toEqual({
      ok: false,
      reason: "STALE",
    });
    expect(verifySignature('{"a":1}', "t=abc,v1=zz", SECRET)).toEqual({
      ok: false,
      reason: "MALFORMED",
    });
    expect(verifySignature('{"a":1}', undefined, SECRET)).toEqual({ ok: false, reason: "MISSING" });
  });
});

describe("createKaziAgent", () => {
  it("sync: runs the handler once per idempotency key and replays the result", async () => {
    const handler = vi.fn(echo);
    const agent = createKaziAgent({
      manifest: manifest("sync"),
      secret: SECRET,
      handlers: { "write.blog_post": handler },
    });
    const first = await agent.handle(signed(request()));
    expect(first).toEqual({
      status: 200,
      body: { status: "completed", output: { text: "echo: hello" } },
    });
    const again = await agent.handle(signed(request()));
    expect(again).toEqual(first);
    expect(handler).toHaveBeenCalledTimes(1);
    await agent.handle(signed(request({ attempt: 2 })));
    expect(handler).toHaveBeenCalledTimes(2); // a retry is a new job
  });

  it("rejects bad signatures, invalid bodies and unsupported capabilities", async () => {
    const agent = createKaziAgent({
      manifest: manifest("sync"),
      secret: SECRET,
      handlers: { "write.blog_post": echo },
    });
    expect((await agent.handle(signed(request(), "wrong-secret"))).status).toBe(401);
    expect((await agent.handle(signed({ nope: true }))).status).toBe(400);
    expect((await agent.handle(signed(request({ capability: "translate.en-sw" })))).status).toBe(
      422,
    );
    expect(
      (await agent.handle({ method: "GET", path: "/run/health", headers: {}, rawBody: "" })).status,
    ).toBe(200);
  });

  it("turns ctx.fail, thrown errors and invalid outputs into failed responses", async () => {
    const agent = createKaziAgent({
      manifest: manifest("sync"),
      secret: SECRET,
      onError: () => {},
      handlers: {
        "write.blog_post": async (ctx) => {
          if (ctx.request.input.text === "fail") ctx.fail("INPUT_UNREADABLE", "cannot read");
          if (ctx.request.input.text === "throw") throw new Error("boom");
          return {} as never;
        },
      },
    });
    const body = async (text: string, id: string) =>
      (await agent.handle(signed(request({ subtaskId: id, input: { text } })))).body;
    expect(await body("fail", "a")).toEqual({
      status: "failed",
      error: { code: "INPUT_UNREADABLE", message: "cannot read" },
    });
    expect(await body("throw", "b")).toMatchObject({
      status: "failed",
      error: { code: "INTERNAL" },
    });
    expect(await body("empty", "c")).toMatchObject({
      status: "failed",
      error: { code: "OUTPUT_INVALID" },
    });
  });

  it("async: answers 202, then posts signed progress and completion callbacks", async () => {
    const calls: { url: string; body: string; sig: string }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ url: String(url), body: String(init?.body), sig: headers["x-kazi-signature"]! });
      return new Response(null, { status: 200 });
    });
    const agent = createKaziAgent({
      manifest: manifest("async"),
      secret: SECRET,
      fetch: fetchMock as typeof fetch,
      handlers: {
        "write.blog_post": async (ctx) => {
          await ctx.progress(0.5, "halfway");
          return { text: "done" };
        },
      },
    });
    expect(await agent.handle(signed(request()))).toEqual({
      status: 202,
      body: { status: "accepted" },
    });
    await agent.idle();
    expect(calls.map((c) => JSON.parse(c.body))).toEqual([
      { status: "progress", progress: 0.5, message: "halfway" },
      { status: "completed", output: { text: "done" } },
    ]);
    for (const c of calls) {
      expect(c.url).toBe("https://kazi.example.com/agent/callback/st_1");
      expect(verifySignature(c.body, c.sig, SECRET)).toEqual({ ok: true });
    }
    // duplicate delivery of the same job is acknowledged but not re-run
    expect((await agent.handle(signed(request()))).status).toBe(202);
    await agent.idle();
    expect(calls).toHaveLength(2);
  });

  it("refuses to start without a handler for every claimed capability", () => {
    expect(() =>
      createKaziAgent({ manifest: manifest("sync"), secret: SECRET, handlers: {} }),
    ).toThrow(/no handler/);
  });
});

describe("kazi-agent dev (local mock Kazi)", () => {
  it("drives an async agent over HTTP, verifies its callbacks and runs Kazi's checks", async () => {
    const { serveAgent, runDevTask } = await import("./index");
    const agent = createKaziAgent({
      manifest: { ...manifest("async"), endpoint: "http://127.0.0.1/run" },
      secret: SECRET,
      handlers: {
        "write.blog_post": async (ctx) => {
          await ctx.progress(0.5, "halfway");
          return { text: `Post about ${ctx.request.input.text ?? ""}` };
        },
      },
    });
    const server = await serveAgent(agent, 0, "127.0.0.1");
    const port = (server.address() as { port: number }).port;
    try {
      const lines: string[] = [];
      const result = await runDevTask({
        endpoint: `http://127.0.0.1:${port}/run`,
        secret: SECRET,
        capability: "write.blog_post",
        instructions: "Write a post",
        input: "Arusha solar",
        rubric: ["mentions the topic"],
        format: "markdown",
        mustInclude: ["Arusha"],
        timeoutSec: 20,
        onEvent: (l) => lines.push(l),
      });
      expect(result).toMatchObject({
        ok: true,
        mode: "async",
        output: { text: "Post about Arusha solar" },
        checks: [],
        problems: [],
      });
      expect(result.callbacks.map((c) => c.status)).toEqual(["progress", "completed"]);

      const missing = await runDevTask({
        endpoint: `http://127.0.0.1:${port}/run`,
        secret: SECRET,
        capability: "write.blog_post",
        instructions: "Write a post",
        input: "Moshi",
        rubric: ["x"],
        format: "markdown",
        mustInclude: ["Arusha"],
        timeoutSec: 20,
      });
      expect(missing.ok).toBe(false);
      expect(missing.checks.map((c) => c.code)).toEqual(["MISSING_TERMS"]);
    } finally {
      server.close();
      await agent.idle();
    }
  });
});
