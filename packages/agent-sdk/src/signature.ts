import { createHmac, timingSafeEqual } from "node:crypto";
import { SIGNATURE_TOLERANCE_SECONDS } from "@kazi/shared";

/**
 * `X-Kazi-Signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + rawBody)>` (docs/05-AGENT-SPEC.md §3).
 * Used both ways: Kazi signs requests to agents, agents sign callbacks to Kazi, with the
 * agent's webhook secret. Always sign/verify the exact raw bytes, never re-serialized JSON.
 */

export function signPayload(
  rawBody: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  return `t=${nowSec},v1=${hmac(secret, `${nowSec}.${rawBody}`)}`;
}

export type VerifyResult =
  { ok: true } | { ok: false; reason: "MISSING" | "MALFORMED" | "STALE" | "MISMATCH" };

export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  opts: { nowSec?: number; toleranceSec?: number } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "MISSING" };
  const parts = new Map(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as const;
    }),
  );
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !/^\d+$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1))
    return { ok: false, reason: "MALFORMED" };
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > (opts.toleranceSec ?? SIGNATURE_TOLERANCE_SECONDS)) {
    return { ok: false, reason: "STALE" };
  }
  const expected = Buffer.from(hmac(secret, `${t}.${rawBody}`), "hex");
  const given = Buffer.from(v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? { ok: true }
    : { ok: false, reason: "MISMATCH" };
}

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}
