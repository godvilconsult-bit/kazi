import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { PrismaClient } from "@kazi/db";
import { ROLES } from "@kazi/shared";

/** Access JWT: 15 min, HS256. Refresh token: 7 days, opaque, rotating, stored as SHA-256 only. */
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const ISSUER = "kazi-api";
const AUDIENCE = "kazi";

const accessClaimsSchema = z.object({
  sub: z.string().min(1),
  wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
  roles: z.array(z.enum(ROLES)),
  auth_time: z.number().int(), // unix seconds of the SIWE login this session descends from
});

export interface AuthContext {
  userId: string;
  wallet: `0x${string}`;
  roles: (typeof ROLES)[number][];
  authTime: number;
}

export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    jwtSecret: string,
    private readonly prisma: PrismaClient,
  ) {
    this.key = new TextEncoder().encode(jwtSecret);
  }

  async signAccess(ctx: AuthContext): Promise<string> {
    return new SignJWT({ wallet: ctx.wallet, roles: ctx.roles, auth_time: ctx.authTime })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(ctx.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(this.key);
  }

  /** Returns null for any invalid/expired/tampered token (never throws to callers). */
  async verifyAccess(token: string): Promise<AuthContext | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
      });
      const claims = accessClaimsSchema.parse(payload);
      return {
        userId: claims.sub,
        wallet: claims.wallet as `0x${string}`,
        roles: claims.roles,
        authTime: claims.auth_time,
      };
    } catch {
      return null;
    }
  }

  /** Issue a refresh token for a new login (new family) or a rotation (same family). */
  async issueRefresh(
    userId: string,
    authTime: Date,
    familyId: string = randomUUID(),
  ): Promise<{ token: string; id: string }> {
    const token = randomBytes(32).toString("base64url");
    const row = await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        authTime,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
      },
    });
    return { token, id: row.id };
  }

  /**
   * Rotate a refresh token. Reusing an already-rotated token revokes its whole family
   * (likely theft). Returns the user id, the new token and the original login time, or null.
   */
  async rotateRefresh(
    token: string,
  ): Promise<{ userId: string; token: string; authTime: Date } | null> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!row) return null;
    if (row.revokedAt !== null) {
      await this.revokeFamily(row.familyId);
      return null;
    }
    if (row.expiresAt.getTime() <= Date.now()) return null;

    const next = await this.issueRefresh(row.userId, row.authTime, row.familyId);
    // Conditional update: if two requests race with the same token, only one wins.
    const updated = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedBy: next.id },
    });
    if (updated.count === 0) {
      await this.revokeFamily(row.familyId);
      return null;
    }
    return { userId: row.userId, token: next.token, authTime: row.authTime };
  }

  async revoke(token: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
