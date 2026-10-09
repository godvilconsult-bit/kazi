import { z } from "zod";
import { planSchema } from "./router";
import { TASK_SPEEDS } from "./hosted";
import { baseUnitsSchema } from "./money";

/**
 * Quote wire + storage format (docs/04-BACKEND-API.md §6, docs/06-ROUTER.md §3). The EIP-712
 * types must match TaskEscrow exactly (verified against the contract in the worker tests).
 */

/** Kazi's own provider that receives the router service-fee milestone (06-ROUTER §3). */
export const SERVICE_FEE_PROVIDER_SLUG = "kazi-service-fee";
/** Quotes are valid for 30 minutes (prices/availability change). */
export const QUOTE_TTL_SECONDS = 30 * 60;

export const QUOTE_EIP712_TYPES = {
  Quote: [
    { name: "taskId", type: "bytes32" },
    { name: "client", type: "address" },
    { name: "providerIds", type: "uint256[]" },
    { name: "amounts", type: "uint128[]" },
    { name: "deadline", type: "uint64" },
    { name: "feeBps", type: "uint16" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export function quoteDomain(chainId: number, escrow: `0x${string}`) {
  return { name: "KaziEscrow", version: "1", chainId, verifyingContract: escrow } as const;
}

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const uintString = z.string().regex(/^\d+$/);

/** Exactly what the client passes to `createAndFund` (bigints as decimal strings). */
export const onchainQuoteSchema = z.object({
  taskId: hexSchema.length(66),
  providerIds: z.array(uintString).min(1).max(20),
  amounts: z.array(baseUnitsSchema).min(1).max(20),
  deadline: uintString,
  feeBps: z.number().int().min(0).max(2_000),
  expiry: uintString,
});
export type OnchainQuote = z.infer<typeof onchainQuoteSchema>;

export const quoteStepSchema = z.object({
  index: z.number().int().min(0),
  kind: z.enum(["WORK", "SERVICE_FEE"]),
  title: z.string(),
  capability: z.string().nullable(),
  providerId: z.string(),
  providerName: z.string(),
  /** Milestone amount the client funds (base units). */
  amount: baseUnitsSchema,
  /** What the provider nets (base units). */
  cost: baseUnitsSchema,
  /** Kazi-hosted steps: AI cost carried in Kazi's milestone for this step (base units). */
  aiCost: baseUnitsSchema.optional(),
  /** Router-internal fallbacks (DB provider ids); never shown to the client. */
  fallbackProviderIds: z.array(z.string()),
});
export type QuoteStep = z.infer<typeof quoteStepSchema>;

/** `Task.quote` JSON. Only QUOTED carries a signature; the other outcomes ask the client to act. */
export const storedQuoteSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("QUOTED"),
    version: z.number().int().min(1),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    /** Wallet the quote was signed for; the escrow recovers against msg.sender. */
    client: hexSchema.length(42),
    onchain: onchainQuoteSchema,
    signature: hexSchema,
    subtotal: baseUnitsSchema,
    serviceFee: baseUnitsSchema,
    /** Σ AI cost of hosted steps, in Kazi's milestone (docs/11-HOSTED-AGENTS.md §3). */
    aiCost: baseUnitsSchema.optional(),
    /** Effective speed: Economy can fall back to Express when the deadline is too close. */
    speed: z.enum(TASK_SPEEDS).optional(),
    total: baseUnitsSchema,
    overBudget: z.boolean(),
    steps: z.array(quoteStepSchema).min(1),
    plan: planSchema,
  }),
  z.object({
    outcome: z.literal("NEEDS_CLARIFICATION"),
    version: z.number().int().min(1),
    createdAt: z.iso.datetime(),
    questions: z.array(z.string()).min(1),
    plan: planSchema,
  }),
  z.object({
    outcome: z.literal("INFEASIBLE"),
    version: z.number().int().min(1),
    createdAt: z.iso.datetime(),
    reason: z.string(),
    plan: planSchema.nullable(),
  }),
]);
export type StoredQuote = z.infer<typeof storedQuoteSchema>;
