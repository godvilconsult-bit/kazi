import type { PublicConfig } from "./types";

/**
 * Display name of Kazi's own token: "KAZI Credits" where the KAZI (Argus) ⇄ Credits exchange is
 * deployed, so it can't be confused with the KAZI traded on Argus; "KAZI" elsewhere.
 * Plain module (not "use client") so server components can use it too.
 */
export function tokenName(cfg: Pick<PublicConfig, "contracts"> | null | undefined): string {
  return cfg?.contracts.creditsGate ? "KAZI Credits" : "KAZI";
}
