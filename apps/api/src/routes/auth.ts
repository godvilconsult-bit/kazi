import type { FastifyInstance, FastifyReply } from "fastify";
import { siweVerifySchema } from "@kazi/shared";
import type { Role } from "@kazi/db";
import type { AppServices } from "../app";
import { requireAuth } from "../auth/guards";
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, type AuthContext } from "../auth/tokens";
import { clearCookie, parseCookies, serializeCookie } from "../http/cookies";
import { notFound, parse, unauthorized } from "../http/errors";
import { serializeUser } from "./serializers";

export const ACCESS_COOKIE = "kazi_access";
export const REFRESH_COOKIE = "kazi_refresh";
const REFRESH_PATH = "/auth";

export function authRoutes(s: AppServices) {
  const cookieBase = { secure: s.cookieSecure, domain: s.env.COOKIE_DOMAIN };

  async function startSession(reply: FastifyReply, ctx: AuthContext, refreshToken: string) {
    const access = await s.tokens.signAccess(ctx);
    void reply.header("set-cookie", [
      serializeCookie(ACCESS_COOKIE, access, {
        ...cookieBase,
        path: "/",
        maxAgeSeconds: ACCESS_TTL_SECONDS,
      }),
      serializeCookie(REFRESH_COOKIE, refreshToken, {
        ...cookieBase,
        path: REFRESH_PATH,
        maxAgeSeconds: REFRESH_TTL_SECONDS,
      }),
    ]);
  }

  return async function routes(app: FastifyInstance) {
    app.get("/auth/nonce", { preHandler: s.limiter.guard("auth-nonce", 30, 60) }, async () => ({
      nonce: await s.siwe.issueNonce(),
    }));

    app.post(
      "/auth/verify",
      { preHandler: s.limiter.guard("auth-verify", 20, 60) },
      async (req, reply) => {
        const body = parse(siweVerifySchema, req.body);
        const wallet = await s.siwe.verify(body.message, body.signature as `0x${string}`);

        const isAdmin = s.adminWallets.has(wallet);
        const existing = await s.prisma.user.findUnique({ where: { wallet } });
        const roles = new Set<Role>(existing?.roles ?? ["CLIENT"]);
        if (isAdmin) roles.add("ADMIN");
        else roles.delete("ADMIN"); // admin rights follow ADMIN_WALLETS, never a stale DB flag

        const user = await s.prisma.user.upsert({
          where: { wallet },
          update: { roles: { set: [...roles] } },
          create: { wallet, roles: [...roles] },
        });

        const authTime = new Date();
        const refresh = await s.tokens.issueRefresh(user.id, authTime);
        await startSession(
          reply,
          {
            userId: user.id,
            wallet,
            roles: user.roles,
            authTime: Math.floor(authTime.getTime() / 1000),
          },
          refresh.token,
        );
        return { user: serializeUser(user) };
      },
    );

    app.post(
      "/auth/refresh",
      { preHandler: s.limiter.guard("auth-refresh", 60, 60) },
      async (req, reply) => {
        const token = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
        if (!token) throw unauthorized("No refresh token");
        const rotated = await s.tokens.rotateRefresh(token);
        if (!rotated) throw unauthorized("Session expired, please sign in again");
        const user = await s.prisma.user.findUnique({ where: { id: rotated.userId } });
        if (!user) throw unauthorized("Session expired, please sign in again");
        await startSession(
          reply,
          {
            userId: user.id,
            wallet: user.wallet as `0x${string}`,
            roles: user.roles,
            authTime: Math.floor(rotated.authTime.getTime() / 1000),
          },
          rotated.token,
        );
        return { user: serializeUser(user) };
      },
    );

    app.post("/auth/logout", async (req, reply) => {
      const token = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
      if (token) await s.tokens.revoke(token);
      void reply.header("set-cookie", [
        clearCookie(ACCESS_COOKIE, { ...cookieBase, path: "/" }),
        clearCookie(REFRESH_COOKIE, { ...cookieBase, path: REFRESH_PATH }),
      ]);
      return { ok: true };
    });

    app.get("/me", async (req) => {
      const auth = requireAuth(req);
      const user = await s.prisma.user.findUnique({ where: { id: auth.userId } });
      if (!user) throw notFound("User");
      return { user: serializeUser(user) };
    });
  };
}
