import type { z } from "zod";
import type { pricingSchema } from "./schemas/api";
import { parseUnits } from "./money";

/**
 * Quote pricing (docs/06-ROUTER.md §3). All bigint base units; decimals come from the USDC
 * contract at startup. Rounding: gross-ups round UP, payouts round DOWN, dust goes to Kazi.
 */

const BPS = 10_000n;
/** TaskEscrow accepts 1–20 milestones per task. */
export const MAX_MILESTONES = 20;
export type ProviderPricing = z.infer<typeof pricingSchema>;

/** What a provider charges for `estimatedUnits` (units are a count, not money → milli-unit precision). */
export function providerCost(
  pricing: ProviderPricing,
  estimatedUnits: number,
  decimals: number,
): bigint {
  const price = parseUnits(pricing.price, decimals);
  const minimum = pricing.minimum ? parseUnits(pricing.minimum, decimals) : 0n;
  if (pricing.model === "fixed") return price > minimum ? price : minimum;
  if (!Number.isFinite(estimatedUnits) || estimatedUnits <= 0)
    throw new RangeError("estimatedUnits must be > 0");
  const milliUnits = BigInt(Math.ceil(estimatedUnits * 1000));
  const cost = ceilDiv(price * milliUnits, 1000n);
  return cost > minimum ? cost : minimum;
}

/** Smallest milestone m such that the escrow's provider payout floor(m·(1−f)) ≥ cost. */
export function grossUp(cost: bigint, feeBps: number): bigint {
  if (feeBps < 0 || feeBps >= 10_000) throw new RangeError("feeBps out of range");
  return ceilDiv(cost * BPS, BPS - BigInt(feeBps));
}

/** Exactly what TaskEscrow pays the provider for a milestone (mirrors `_split`). */
export function providerPayout(milestone: bigint, feeBps: number): bigint {
  return (milestone * (BPS - BigInt(feeBps))) / BPS;
}

export interface QuotePricingInput {
  /** Per-subtask provider prices, in base units. */
  costs: readonly bigint[];
  /** Kazi take rate for this client (12% default, 10% for staking clients); the escrow applies it to every milestone. */
  feeBps: number;
  /** The escrow's onchain `feeBps`: a quote may never exceed it (TaskEscrow rejects it). */
  publishedFeeBps: number;
  /** Router service fee (06-ROUTER §3), as bps of the subtotal, with an absolute minimum. */
  serviceFeeBps: number;
  minServiceFee: bigint;
  /**
   * AI cost of Kazi-hosted steps (docs/11-HOSTED-AGENTS.md §3), carried in Kazi's milestone.
   * Hosted steps' `costs` are then the developer's net (price minus the Economy AI cost).
   */
  aiCost?: bigint;
}

export interface QuotePricing {
  feeBps: number;
  /** One milestone per subtask, in subtask order. */
  milestones: bigint[];
  /** What Kazi's treasury nets from the service-fee milestone for the router's work. */
  serviceFee: bigint;
  /** Hosted agents' AI cost, also netted by the treasury from the same milestone. */
  aiCost: bigint;
  /** Kazi's milestone (last onchain, paid to Kazi's service provider): nets serviceFee + aiCost. Null when both are 0. */
  serviceMilestone: bigint | null;
  subtotal: bigint;
  /** What the client funds: Σ milestones + serviceMilestone. */
  total: bigint;
  /** Kazi's take = total − Σ provider payouts (take-rate fees + service fee + AI cost pass-through + dust). */
  kaziRevenue: bigint;
}

export class QuotePricingError extends Error {
  override readonly name = "QuotePricingError";
}

/**
 * Builds milestones so every provider receives at least its price after the escrow fee. The
 * service fee is its own milestone paid to Kazi's treasury (grossed up so the treasury nets the
 * full fee), so providers never receive any of it.
 */
export function priceQuote(input: QuotePricingInput): QuotePricing {
  if (input.costs.length === 0) throw new QuotePricingError("no subtasks to price");
  if (input.costs.some((c) => c <= 0n)) throw new QuotePricingError("every subtask must cost > 0");
  if (input.feeBps > input.publishedFeeBps) {
    throw new QuotePricingError(
      `quote fee ${input.feeBps} bps exceeds the escrow's published fee ${input.publishedFeeBps} bps`,
    );
  }
  const aiCost = input.aiCost ?? 0n;
  if (aiCost < 0n) throw new QuotePricingError("aiCost must be >= 0");
  const subtotal = input.costs.reduce((a, b) => a + b, 0n);

  // The service fee is charged on the value of the work, AI cost of hosted steps included.
  const byBps = ((subtotal + aiCost) * BigInt(input.serviceFeeBps)) / BPS;
  const serviceFee = byBps > input.minServiceFee ? byBps : input.minServiceFee;
  const kaziNet = serviceFee + aiCost;
  const serviceMilestone = kaziNet > 0n ? grossUp(kaziNet, input.feeBps) : null;

  const milestoneCount = input.costs.length + (serviceMilestone === null ? 0 : 1);
  if (milestoneCount > MAX_MILESTONES) {
    throw new QuotePricingError(
      `${milestoneCount} milestones exceeds the escrow limit of ${MAX_MILESTONES}`,
    );
  }

  const milestones = input.costs.map((c) => grossUp(c, input.feeBps));
  const total = milestones.reduce((a, b) => a + b, 0n) + (serviceMilestone ?? 0n);
  const paidToProviders = milestones.reduce((a, m) => a + providerPayout(m, input.feeBps), 0n);
  return {
    feeBps: input.feeBps,
    milestones,
    serviceFee,
    aiCost,
    serviceMilestone,
    subtotal,
    total,
    kaziRevenue: total - paidToProviders,
  };
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
