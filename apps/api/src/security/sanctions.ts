import type { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";

/**
 * Wallet sanctions screening (docs/09-SECURITY-COMPLIANCE.md §4: "at minimum, sanctions screening
 * of wallets"). Checked at sign-in and for provider payout addresses. Results are cached; if the
 * screening service is unreachable the check fails open (logged) so an outage there doesn't lock
 * every user out — set SANCTIONS_FAIL_CLOSED=true to refuse instead.
 */
export interface SanctionsScreen {
  isSanctioned(wallet: string): Promise<boolean>;
}

/** Chainalysis' free sanctions API (an API key from chainalysis.com/free-cryptocurrency-sanctions-screening-tools). */
export function chainalysisScreen(opts: {
  apiKey: string;
  redis: Pick<Redis, "get" | "set">;
  prefix: string;
  log: FastifyBaseLogger;
  failClosed?: boolean;
  fetchImpl?: typeof fetch;
}): SanctionsScreen {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async isSanctioned(wallet) {
      const key = `${opts.prefix}:sanctions:${wallet.toLowerCase()}`;
      const cached = await opts.redis.get(key);
      if (cached !== null) return cached === "1";
      try {
        const res = await doFetch(`https://public.chainalysis.com/api/v1/address/${wallet}`, {
          headers: { "X-API-Key": opts.apiKey, accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`sanctions API HTTP ${res.status}`);
        const body = (await res.json()) as { identifications?: unknown[] };
        const hit = (body.identifications?.length ?? 0) > 0;
        await opts.redis.set(key, hit ? "1" : "0", "EX", hit ? 7 * 86_400 : 86_400);
        if (hit) opts.log.warn({ wallet: wallet.toLowerCase() }, "sanctioned wallet refused");
        return hit;
      } catch (err) {
        opts.log.error({ err }, "sanctions screening unavailable");
        return opts.failClosed ?? false;
      }
    },
  };
}
