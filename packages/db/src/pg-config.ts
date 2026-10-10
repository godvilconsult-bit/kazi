import type { PoolConfig } from "pg";

/**
 * node-postgres now treats `sslmode=require` as verify-full, which rejects the self-signed
 * certificate Railway's Postgres serves on its public TCP proxy. Apply libpq semantics instead:
 * `require` / `prefer` = encrypted, certificate not verified; `verify-full` = fully verified.
 * Production connects over Railway's private network (see docs/02 §7).
 */
export function pgPoolConfig(databaseUrl: string): PoolConfig {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  // Pool size per process (Prisma's `connection_limit` URL convention); node-postgres defaults to 10.
  const limit = Number(url.searchParams.get("connection_limit") ?? "");
  url.searchParams.delete("connection_limit");
  const pool: PoolConfig = {
    connectionString: url.toString(),
    ...(Number.isInteger(limit) && limit > 0 ? { max: limit } : {}),
  };
  if (sslmode === "require" || sslmode === "prefer" || sslmode === "no-verify") {
    return { ...pool, ssl: { rejectUnauthorized: false } };
  }
  if (sslmode === "verify-full" || sslmode === "verify-ca") {
    return { ...pool, ssl: { rejectUnauthorized: true } };
  }
  return pool;
}
