import { aiCostNano, nanoToUsd, type TokenUsage } from "@kazi/shared";

/**
 * USD cost of a call for internal tracking (`Task.llmCostUsd`), from the single price table in
 * `@kazi/shared` (ai-cost.ts). Hosted-agent charges use the nano-USD bigint form directly.
 */
export type TokenCounts = TokenUsage;

export function estimateCostUsd(
  model: string,
  t: TokenCounts,
  opts: { batch?: boolean } = {},
): number {
  return nanoToUsd(aiCostNano(model, t, opts));
}

/** Server-side refusal fallback exists for Opus/Fable/Sonnet; Haiku 5.5 rejects the array form and ignores "default". */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(opus|fable|sonnet)-/.test(model);
}
