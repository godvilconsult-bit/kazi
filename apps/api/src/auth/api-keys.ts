import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@kazi/db";
import type { AuthContext } from "./tokens";

/**
 * API keys for programmatic clients (docs/12-PUBLIC-API.md). Format `kz_<live|test>_<prefix>_<secret>`;
 * only a SHA-256 hash is stored and the full key is shown once. A key acts as its owner for task
 * and provider endpoints but never grants admin rights and can't manage other keys.
 */

export const API_KEY_PATTERN = /^kz_(live|test)_[a-z0-9]{8}_[A-Za-z0-9_-]{32,64}$/;
/** Keys per user; old ones can be revoked. */
export const MAX_ACTIVE_KEYS = 10;
/** lastUsedAt is written at most this often per key. */
const TOUCH_EVERY_MS = 5 * 60_000;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(mainnet: boolean): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(6)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .padEnd(8, "0")
    .slice(0, 8);
  const secret = randomBytes(32).toString("base64url");
  const key = `kz_${mainnet ? "live" : "test"}_${prefix}_${secret}`;
  return { key, prefix, hash: hashApiKey(key) };
}

export interface ApiKeyAuth extends AuthContext {
  apiKeyId: string;
}

/** Resolves a Bearer API key to its owner, or null. Admin is always stripped. */
export async function authenticateApiKey(
  prisma: PrismaClient,
  key: string,
): Promise<ApiKeyAuth | null> {
  if (!API_KEY_PATTERN.test(key)) return null;
  const row = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(key) },
    include: { user: true },
  });
  if (!row || row.revokedAt) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await prisma.apiKey
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
  return {
    userId: row.userId,
    wallet: row.user.wallet as `0x${string}`,
    roles: row.user.roles.filter((r) => r !== "ADMIN"),
    // No interactive sign-in behind a key: admin freshness checks always fail.
    authTime: 0,
    apiKeyId: row.id,
  };
}
