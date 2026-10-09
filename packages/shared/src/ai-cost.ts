/**
 * Claude prices in integer nano-USD (1e-9 USD) per token, from the pricing page (2026-10-09).
 * Integer math because hosted-agent AI costs become onchain milestone amounts (CLAUDE.md rule 1,
 * docs/11-HOSTED-AGENTS.md §3). 5-minute cache writes bill 1.25× input, 1-hour writes 2×.
 * The Batch API halves every token price; web search is $10 per 1,000 searches on top.
 */

export const HOSTED_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type HostedModel = (typeof HOSTED_MODELS)[number];

interface NanoPrice {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
}

/** $X per million tokens = X × 1,000 nano-USD per token. */
const price = (input: number, output: number, cacheRead: number): NanoPrice => ({
  input: BigInt(Math.round(input * 1000)),
  output: BigInt(Math.round(output * 1000)),
  cacheRead: BigInt(Math.round(cacheRead * 1000)),
});

const PRICES: Record<string, NanoPrice> = {
  "claude-fable-5-1": price(10, 50, 0.25),
  "claude-opus-5-5": price(4, 20, 0.2),
  "claude-opus-5": price(5, 25, 0.5),
  "claude-opus-4-8": price(5, 25, 0.5),
  "claude-sonnet-5-5": price(2, 10, 0.2),
  "claude-sonnet-5": price(2, 10, 0.2),
  "claude-haiku-5-5": price(0.1, 0.5, 0.01),
};
/** Haiku 5.5 prompts over 100k tokens (input incl. cache reads/writes) are billed at higher rates. */
const HAIKU_LONG = price(0.5, 2.5, 0.05);
/** Unknown models are costed at the most expensive rate so estimates err on the safe side. */
const FALLBACK = price(10, 50, 0.25);
export const WEB_SEARCH_NANO = 10_000_000n; // $0.01 per search

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 5-minute cache writes. */
  cacheWriteTokens: number;
  /** 1-hour cache writes. */
  cacheWrite1hTokens?: number;
  webSearches?: number;
}

export function aiCostNano(model: string, t: TokenUsage, opts: { batch?: boolean } = {}): bigint {
  const prompt =
    t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + (t.cacheWrite1hTokens ?? 0);
  const p =
    model === "claude-haiku-5-5" && prompt > 100_000 ? HAIKU_LONG : (PRICES[model] ?? FALLBACK);
  const n = (x: number | undefined) => BigInt(Math.max(0, Math.round(x ?? 0)));
  // ×4 to keep the 1.25× and 2× cache-write multipliers exact in integers.
  const tokens4 =
    n(t.inputTokens) * p.input * 4n +
    n(t.cacheWriteTokens) * p.input * 5n +
    n(t.cacheWrite1hTokens) * p.input * 8n +
    n(t.cacheReadTokens) * p.cacheRead * 4n +
    n(t.outputTokens) * p.output * 4n;
  const tokens = opts.batch ? ceilDiv(tokens4, 8n) : ceilDiv(tokens4, 4n);
  return tokens + n(t.webSearches) * WEB_SEARCH_NANO;
}

/** nano-USD → USDC base units, rounding up (Kazi never under-recovers a cost). USDC ≈ USD. */
export function nanoUsdToUnits(nano: bigint, decimals: number): bigint {
  if (nano <= 0n) return 0n;
  return ceilDiv(nano * 10n ** BigInt(decimals), 1_000_000_000n);
}

export function nanoToUsd(nano: bigint): number {
  return Number(nano) / 1e9;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
