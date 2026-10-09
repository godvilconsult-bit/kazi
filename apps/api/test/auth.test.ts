import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { TokenService } from "../src/auth/tokens";
import {
  ADMIN_KEY,
  cookieValue,
  createHarness,
  login,
  newAccount,
  siweMessage,
  type Harness,
} from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe("SIWE login", () => {
  it("logs in, sets httpOnly cookies and returns the user", async () => {
    const account = newAccount();
    const message = await siweMessage(h, account);
    const signature = await account.signMessage({ message });
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { message, signature },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ user: { wallet: string; roles: string[] } }>();
    expect(body.user.wallet).toBe(account.address.toLowerCase());
    expect(body.user.roles).toEqual(["CLIENT"]);
    const access = res.cookies.find((c) => c.name === "kazi_access");
    const refresh = res.cookies.find((c) => c.name === "kazi_refresh");
    expect(access?.httpOnly).toBe(true);
    expect(access?.sameSite).toBe("Lax");
    expect(refresh?.path).toBe("/auth");

    // Refresh token is stored hashed, never in clear text.
    const stored = await h.prisma.refreshToken.findMany({
      where: { user: { wallet: account.address.toLowerCase() } },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).not.toBe(refresh?.value);

    const me = await h.app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: `kazi_access=${access?.value}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it("rejects a replayed message (nonce is single-use)", async () => {
    const account = newAccount();
    const message = await siweMessage(h, account);
    const signature = await account.signMessage({ message });
    expect(
      (await h.app.inject({ method: "POST", url: "/auth/verify", payload: { message, signature } }))
        .statusCode,
    ).toBe(200);
    const replay = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { message, signature },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Unknown or already used nonce" },
    });
  });

  it("rejects wrong domain, wrong chain, stale messages and bad signatures", async () => {
    const account = newAccount();
    const cases = [
      { m: await siweMessage(h, account, { domain: "evil.example" }), msg: /different site/ },
      { m: await siweMessage(h, account, { chainId: 1 }), msg: /different chain/ },
      {
        m: await siweMessage(h, account, { issuedAt: new Date(Date.now() - 11 * 60 * 1000) }),
        msg: /too old/,
      },
    ];
    for (const c of cases) {
      const signature = await account.signMessage({ message: c.m });
      const res = await h.app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: { message: c.m, signature },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { message: string } }>().error.message).toMatch(c.msg);
    }
    const message = await siweMessage(h, account);
    const otherSig = await newAccount().signMessage({ message });
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { message, signature: otherSig },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { message: string } }>().error.message).toBe("Invalid signature");
  });

  it("validates the request body", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { message: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("requires auth for /me", async () => {
    const res = await h.app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    const forged = await h.app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(forged.statusCode).toBe(401);
  });
});

describe("refresh rotation", () => {
  it("rotates, and reusing an old refresh token revokes the whole family", async () => {
    const { refresh } = await login(h);
    const first = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `kazi_refresh=${refresh}` },
    });
    expect(first.statusCode).toBe(200);
    const rotated = cookieValue(first, "kazi_refresh");
    expect(rotated).not.toBe(refresh);

    // Attacker replays the old token → rejected AND the legitimate new token dies too.
    const reuse = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `kazi_refresh=${refresh}` },
    });
    expect(reuse.statusCode).toBe(401);
    const afterTheft = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `kazi_refresh=${rotated}` },
    });
    expect(afterTheft.statusCode).toBe(401);
  });

  it("logout revokes the refresh token and clears cookies", async () => {
    const { refresh, cookie } = await login(h);
    const out = await h.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(out.cookies.find((c) => c.name === "kazi_access")?.maxAge).toBe(0);
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: `kazi_refresh=${refresh}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("admin", () => {
  it("grants ADMIN only to ADMIN_WALLETS and requires a fresh login", async () => {
    const admin = await login(h, privateKeyToAccount(ADMIN_KEY));
    const res = await h.app.inject({
      method: "GET",
      url: "/admin/reconciliation",
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reconciliation: null });

    const user = await login(h);
    const denied = await h.app.inject({
      method: "GET",
      url: "/admin/reconciliation",
      headers: { cookie: user.cookie },
    });
    expect(denied.statusCode).toBe(403);

    // A valid token whose SIWE login is 11 minutes old is not enough for admin actions.
    const tokens = new TokenService(h.env.JWT_SECRET, h.prisma);
    const stale = await tokens.signAccess({
      userId: admin.user.id,
      wallet: admin.account.address.toLowerCase() as `0x${string}`,
      roles: ["CLIENT", "ADMIN"],
      authTime: Math.floor(Date.now() / 1000) - 11 * 60,
    });
    const staleRes = await h.app.inject({
      method: "GET",
      url: "/admin/reconciliation",
      headers: { authorization: `Bearer ${stale}` },
    });
    expect(staleRes.statusCode).toBe(403);
    expect(staleRes.json<{ error: { message: string } }>().error.message).toMatch(/fresh sign-in/);
  });
});

describe("platform behaviour", () => {
  it("rate limits nonce requests per IP", async () => {
    // Fixed 60s windows: 61 requests (2 × limit + 1) guarantee one window exceeds 30 even if the
    // burst straddles a window boundary; sent in parallel so remote-Redis latency doesn't matter.
    const statuses = await Promise.all(
      Array.from(
        { length: 61 },
        async () =>
          (await h.app.inject({ method: "GET", url: "/auth/nonce", remoteAddress: "10.9.9.9" }))
            .statusCode,
      ),
    );
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("returns the standard error shape for unknown routes and bad JSON", async () => {
    const nf = await h.app.inject({ method: "GET", url: "/nope" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
    const bad = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("allows CORS only for the web app origin", async () => {
    const ok = await h.app.inject({
      method: "OPTIONS",
      url: "/tasks",
      headers: { origin: "http://localhost:3000" },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const evil = await h.app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example" },
    });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
