import { providerCost, type PlanSubtask, type ProviderPricing } from "@kazi/shared";

/** Step 2 of the router (docs/06-ROUTER.md §2): rank providers for one subtask. */

export interface Candidate {
  id: string;
  name: string;
  capabilities: readonly string[];
  pricing: ProviderPricing;
  /** 0..100 */
  reputation: number;
  completedCount: number;
  failedCount: number;
  avgLatencyMs: number | null;
  /** Bonded $KAZI, base units. */
  stake: bigint;
  onchainId: bigint;
  /** 0..100 qualification score (review suite / advice run); gates the exploration boost. */
  reviewScore?: number | null;
  /** Kazi-hosted agents: per-task AI cost estimate in USDC base units (docs/11-HOSTED-AGENTS.md). */
  hosted?: { economy: bigint; express: bigint };
}

export interface MatchContext {
  /** USDC decimals, read from the token contract. */
  decimals: number;
  /** AgentRegistry minimum bond; stake above it earns a capped, log-scaled bonus. */
  minStake: bigint;
  /** Time left until the task deadline. */
  headroomMs: number;
}

export interface ScoredCandidate {
  provider: Candidate;
  cost: bigint;
  score: number;
}

/** Success-rate prior for providers with no completed or failed work yet. */
const PRIOR_SUCCESS_RATE = 0.8;

export function rankCandidates(
  subtask: Pick<PlanSubtask, "capability" | "estimatedUnits">,
  providers: readonly Candidate[],
  ctx: MatchContext,
): ScoredCandidate[] {
  const priced = providers.flatMap((p) => {
    if (!p.capabilities.includes(subtask.capability)) return [];
    try {
      return [{ provider: p, cost: providerCost(p.pricing, subtask.estimatedUnits, ctx.decimals) }];
    } catch {
      return []; // unparseable pricing: never quote this provider
    }
  });
  if (priced.length === 0) return [];
  const cheapest = priced.map((c) => c.cost).reduce((min, c) => (c < min ? c : min));

  return priced
    .map(({ provider, cost }) => ({ provider, cost, score: score(provider, cost, cheapest, ctx) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareBigint(a.cost, b.cost) ||
        a.provider.id.localeCompare(b.provider.id),
    );
}

function score(p: Candidate, cost: bigint, cheapest: bigint, ctx: MatchContext): number {
  const attempts = p.completedCount + p.failedCount;
  const successRate = attempts === 0 ? PRIOR_SUCCESS_RATE : p.completedCount / attempts;
  // 100 for the cheapest candidate, linear down to 0 at 2× the cheapest. Ratios, not money.
  const priceScore = cheapest === 0n ? 100 : 100 * clamp(2 - Number(cost) / Number(cheapest));
  const latencyScore =
    p.avgLatencyMs === null || ctx.headroomMs <= 0
      ? 50
      : 100 * clamp(1 - p.avgLatencyMs / ctx.headroomMs);
  const stakeRatio = ctx.minStake > 0n ? Number(p.stake) / Number(ctx.minStake) : 0;
  const stakeScore = stakeRatio <= 1 ? 0 : Math.min(100, 25 * Math.log2(stakeRatio));
  return (
    0.45 * clamp(p.reputation / 100) * 100 +
    0.2 * successRate * 100 +
    0.15 * priceScore +
    0.1 * latencyScore +
    0.1 * stakeScore
  );
}

function clamp(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Exploration (06-ROUTER §2): newcomers with a strong qualification score get ~10% of eligible subtasks. */
export const EXPLORATION_RATE = 0.1;
export const NEWCOMER_MAX_COMPLETED = 10;
export const NEWCOMER_MIN_REVIEW_SCORE = 80;

export function applyExploration(ranked: ScoredCandidate[], random: () => number): ScoredCandidate[] {
  if (ranked.length < 2 || random() >= EXPLORATION_RATE) return ranked;
  const newcomer = ranked.find(
    (c) =>
      c.provider.completedCount < NEWCOMER_MAX_COMPLETED &&
      (c.provider.reviewScore ?? 0) >= NEWCOMER_MIN_REVIEW_SCORE,
  );
  if (!newcomer || newcomer === ranked[0]) return ranked;
  return [newcomer, ...ranked.filter((c) => c !== newcomer)];
}

