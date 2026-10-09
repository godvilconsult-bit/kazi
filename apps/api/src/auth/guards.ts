import type { FastifyRequest } from "fastify";
import { forbidden, unauthorized } from "../http/errors";
import type { AuthContext } from "./tokens";

/** Admin endpoints also require a fresh SIWE login (docs/04 §1). */
export const ADMIN_FRESH_LOGIN_SECONDS = 10 * 60;

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** ADMIN role + wallet listed in ADMIN_WALLETS + SIWE login no older than 10 minutes. */
export function requireAdmin(req: FastifyRequest, adminWallets: ReadonlySet<string>): AuthContext {
  const auth = requireAuth(req);
  if (!auth.roles.includes("ADMIN") || !adminWallets.has(auth.wallet))
    throw forbidden("Admin only");
  if (Date.now() / 1000 - auth.authTime > ADMIN_FRESH_LOGIN_SECONDS) {
    throw forbidden("Admin actions need a fresh sign-in (within 10 minutes)");
  }
  return auth;
}
