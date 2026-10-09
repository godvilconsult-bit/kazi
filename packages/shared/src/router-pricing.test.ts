import { describe, expect, it } from "vitest";
import {
  PlanValidationError,
  QuotePricingError,
  grossUp,
  priceQuote,
  providerCost,
  providerPayout,
  readySubtasks,
  validatePlan,
  type Plan,
} from "./index";

const caps = new Set(["translate.en-sw", "write.business_plan", "human.review"]);
const sub = (index: number, dependsOn: number[] = [], capability = "translate.en-sw") => ({
  index,
  title: `step ${index}`,
  capability,
  instructions: "do it",
  dependsOn,
  estimatedUnits: 1,
  acceptance: { rubric: ["complete"], format: "markdown" as const },
  needsHuman: false,
});
const plan = (subtasks: Plan["subtasks"]): Plan => ({
  feasible: true,
  clarifyingQuestions: [],
  subtasks,
});

describe("plan validation", () => {
  it("accepts a valid DAG", () => {
    expect(() =>
      validatePlan(plan([sub(0), sub(1, [0]), sub(2, [0, 1], "human.review")]), caps),
    ).not.toThrow();
  });

  it("rejects cycles, gaps, self/forward-out-of-range deps and unknown capabilities", () => {
    expect(() => validatePlan(plan([sub(0, [1]), sub(1, [0])]), caps)).toThrow(/cycle/);
    expect(() => validatePlan(plan([sub(0), sub(2)]), caps)).toThrow(/contiguous/);
    expect(() => validatePlan(plan([sub(0, [0])]), caps)).toThrow(PlanValidationError);
    expect(() => validatePlan(plan([sub(0, [5])]), caps)).toThrow(/invalid dependency/);
    expect(() => validatePlan(plan([sub(0, [], "write.poetry")]), caps)).toThrow(
      /unknown capability/,
    );
    expect(() => validatePlan(plan([]), caps)).toThrow(/no subtasks/);
  });

  it("finds ready subtasks in dependency order", () => {
    const subs = [sub(0), sub(1, [0]), sub(2), sub(3, [1, 2])];
    expect(readySubtasks(subs, new Set()).map((s) => s.index)).toEqual([0, 2]);
    expect(readySubtasks(subs, new Set([0, 2])).map((s) => s.index)).toEqual([1]);
    expect(readySubtasks(subs, new Set([0, 1, 2])).map((s) => s.index)).toEqual([3]);
  });
});

describe("pricing", () => {
  const perUnit = {
    model: "per_unit" as const,
    unit: "1000_words",
    price: "0.80",
    currency: "USDC" as const,
    minimum: "0.20",
  };

  it("prices per unit with a minimum, and fixed prices", () => {
    expect(providerCost(perUnit, 1.52, 6)).toBe(1_216_000n); // 1.52 × 0.80 USDC
    expect(providerCost(perUnit, 0.1, 6)).toBe(200_000n); // minimum applies
    expect(providerCost({ model: "fixed", price: "6.00", currency: "USDC" }, 99, 6)).toBe(
      6_000_000n,
    );
    expect(providerCost(perUnit, 1.52, 18)).toBe(1_216_000_000_000_000_000n);
  });

  it("gross-up always pays the provider at least its price", () => {
    for (const fee of [0, 1, 1000, 1200, 1999]) {
      for (const cost of [1n, 7n, 999_999n, 123_456_789n]) {
        expect(providerPayout(grossUp(cost, fee), fee)).toBeGreaterThanOrEqual(cost);
        // and never by more than one base unit's worth of rounding
        expect(providerPayout(grossUp(cost, fee), fee) - cost).toBeLessThanOrEqual(1n);
      }
    }
  });

  const base = { feeBps: 1200, publishedFeeBps: 1200, serviceFeeBps: 500, minServiceFee: 100_000n };

  it("no service fee: one milestone per subtask, every provider covered", () => {
    const q = priceQuote({
      ...base,
      costs: [1_216_000n, 6_000_000n],
      serviceFeeBps: 0,
      minServiceFee: 0n,
    });
    expect(q.serviceMilestone).toBeNull();
    expect(q.serviceFee).toBe(0n);
    q.milestones.forEach((m, i) =>
      expect(providerPayout(m, q.feeBps)).toBeGreaterThanOrEqual([1_216_000n, 6_000_000n][i]!),
    );
    expect(q.total).toBe(q.milestones.reduce((a, b) => a + b, 0n));
    // Kazi gets ≈ 12% of the client total
    expect(Number((q.kaziRevenue * 10_000n) / q.total)).toBeGreaterThanOrEqual(1199);
  });

  it("service fee is its own milestone: providers get their price, Kazi's treasury nets the full fee", () => {
    const costs = [10_000_000n, 10_000_000n]; // 20 USDC subtotal → 5% = 1 USDC service fee
    const q = priceQuote({ ...base, costs });
    expect(q.serviceFee).toBe(1_000_000n);
    expect(q.serviceMilestone).not.toBeNull();
    expect(providerPayout(q.serviceMilestone!, q.feeBps)).toBeGreaterThanOrEqual(1_000_000n);
    const paid = q.milestones.reduce((a, m) => a + providerPayout(m, q.feeBps), 0n);
    expect(paid - 20_000_000n).toBeLessThanOrEqual(2n); // no service fee leaks to providers
    expect(q.total).toBe(q.milestones.reduce((a, b) => a + b, 0n) + q.serviceMilestone!);
    expect(q.kaziRevenue).toBe(q.total - paid);
  });

  it("applies the minimum service fee on small tasks and the staking discount", () => {
    const small = priceQuote({ ...base, costs: [200_000n] }); // 5% of 0.20 = 0.01 < 0.10 minimum
    expect(small.serviceFee).toBe(100_000n);
    const staker = priceQuote({ ...base, feeBps: 1000, costs: [10_000_000n] });
    expect(staker.feeBps).toBe(1000);
    expect(staker.total).toBeLessThan(priceQuote({ ...base, costs: [10_000_000n] }).total);
  });

  it("refuses fees above the published fee, empty plans and too many milestones", () => {
    expect(() => priceQuote({ ...base, feeBps: 1300, costs: [1_000_000n] })).toThrow(
      QuotePricingError,
    );
    expect(() => priceQuote({ ...base, costs: [] })).toThrow(/no subtasks/);
    expect(() => priceQuote({ ...base, costs: Array<bigint>(20).fill(1_000_000n) })).toThrow(
      /escrow limit/,
    );
    expect(() =>
      priceQuote({
        ...base,
        serviceFeeBps: 0,
        minServiceFee: 0n,
        costs: Array<bigint>(20).fill(1n),
      }),
    ).not.toThrow();
  });
});

describe("hosted-agent AI cost (docs/11-HOSTED-AGENTS.md §3)", () => {
  const base = { feeBps: 1200, publishedFeeBps: 1200, serviceFeeBps: 500, minServiceFee: 100_000n };

  it("carries the AI cost in Kazi's milestone; the developer nets price minus Economy AI cost", () => {
    // Hosted step: listed 4.00 USDC, Economy AI cost 0.30 → developer nets 3.70.
    const q = priceQuote({ ...base, costs: [3_700_000n], aiCost: 300_000n });
    expect(q.aiCost).toBe(300_000n);
    expect(q.serviceFee).toBe(200_000n); // 5% of 3.70 + 0.30
    expect(providerPayout(q.milestones[0]!, 1200)).toBeGreaterThanOrEqual(3_700_000n);
    expect(providerPayout(q.serviceMilestone!, 1200)).toBeGreaterThanOrEqual(500_000n); // fee + AI cost
  });

  it("Express costs the client exactly the extra AI cost (grossed up), the developer earns the same", () => {
    const economy = priceQuote({ ...base, costs: [3_700_000n], aiCost: 300_000n });
    const express = priceQuote({ ...base, costs: [3_700_000n], aiCost: 600_000n });
    expect(express.milestones[0]).toBe(economy.milestones[0]);
    expect(express.total).toBeGreaterThan(economy.total);
  });

  it("rejects a negative AI cost", () => {
    expect(() => priceQuote({ ...base, costs: [1n], aiCost: -1n })).toThrow(QuotePricingError);
  });
});

describe("AI cost math in nano-USD", () => {
  it("prices tokens, cache and searches exactly, halves tokens in batch, rounds units up", async () => {
    const { aiCostNano, nanoUsdToUnits } = await import("./ai-cost");
    const t = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      webSearches: 3,
    };
    // Opus 5.5: $4 in + $2 out + $0.20 read + $5 5m-write + $0.03 searches = $11.23
    expect(aiCostNano("claude-opus-5-5", t)).toBe(11_230_000_000n);
    // Batch halves tokens only: $5.60 + $0.03
    expect(aiCostNano("claude-opus-5-5", t, { batch: true })).toBe(5_630_000_000n);
    expect(
      aiCostNano("claude-sonnet-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 1_000_000,
      }),
    ).toBe(6_000_000_000n); // $2 + $4 (2×)
    expect(nanoUsdToUnits(1n, 6)).toBe(1n); // never under-recover
    expect(nanoUsdToUnits(1_000n, 6)).toBe(1n);
    expect(nanoUsdToUnits(1_001n, 6)).toBe(2n);
    expect(nanoUsdToUnits(1_000_000_000n, 18)).toBe(10n ** 18n);
  });
});
