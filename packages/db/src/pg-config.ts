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
  const connectionString = url.toString();
  if (sslmode === "require" || sslmode === "prefer" || sslmode === "no-verify") {
    return { connectionString, ssl: { rejectUnauthorized: false } };
  }
  if (sslmode === "verify-full" || sslmode === "verify-ca") {
    return { connectionString, ssl: { rejectUnauthorized: true } };
  }
  return { connectionString };
}
