import { z } from "zod";
import { acceptanceSchema } from "./router";
import {
  capabilityInputSchema,
  capabilityOutputSchema,
  capabilitySlugSchema,
} from "./capabilities";
import { decimalAmountSchema } from "./money";

/**
 * Wire contract between Kazi and agents (docs/05-AGENT-SPEC.md §3–4).
 * HMAC signing lives in @kazi/agent-sdk (Node crypto); these are the data shapes only.
 */

export const SIGNATURE_HEADER = "x-kazi-signature";
export const SUBTASK_ID_HEADER = "x-kazi-subtask-id";
export const IDEMPOTENCY_HEADER = "x-kazi-idempotency-key";
/** Reject signatures whose timestamp is more than this far from now (seconds). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const agentRequestSchema = z.object({
  subtaskId: z.string().min(1),
  attempt: z.number().int().min(1),
  capability: capabilitySlugSchema,
  instructions: z.string().min(1).max(20_000),
  input: capabilityInputSchema,
  acceptance: acceptanceSchema,
  deadline: z.iso.datetime({ offset: true }),
  callbackUrl: z.url(),
  /** Price for this subtask as a decimal USDC string (what the agent gets paid). */
  budget: decimalAmountSchema,
  /** Evaluator feedback from the previous attempt, when retrying. */
  feedback: z.string().max(4_000).optional(),
});
export type AgentRequest = z.infer<typeof agentRequestSchema>;
export type AgentInput = z.infer<typeof capabilityInputSchema>;
export type AgentOutput = z.infer<typeof capabilityOutputSchema>;

export const agentErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(2_000),
});

/** Sync-mode response body, or async-mode acknowledgement. */
export const agentResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), output: capabilityOutputSchema }),
  z.object({ status: z.literal("accepted"), etaSec: z.number().int().positive().optional() }),
  z.object({ status: z.literal("failed"), error: agentErrorSchema }),
]);
export type AgentResponse = z.infer<typeof agentResponseSchema>;

/** Async callback body (agent → Kazi). */
export const agentCallbackSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("progress"),
    progress: z.number().min(0).max(1),
    message: z.string().max(500).optional(),
  }),
  z.object({ status: z.literal("completed"), output: capabilityOutputSchema }),
  z.object({ status: z.literal("failed"), error: agentErrorSchema }),
]);
export type AgentCallback = z.infer<typeof agentCallbackSchema>;

/** Agent manifest (05-AGENT-SPEC §1). */
export const agentManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  name: z.string().min(3).max(80),
  description: z.string().min(10).max(4_000),
  version: z.string().min(1).max(32),
  endpoint: z.url(),
  capabilities: z.array(capabilitySlugSchema).min(1),
  languages: z.array(z.string().regex(/^[a-z]{2}$/)).min(1),
  pricing: z.object({
    model: z.enum(["per_unit", "fixed"]),
    unit: z.string().optional(),
    price: decimalAmountSchema,
    currency: z.literal("USDC"),
    minimum: decimalAmountSchema.optional(),
  }),
  limits: z
    .object({
      maxInputBytes: z.number().int().positive(),
      timeoutSec: z.number().int().positive().max(86_400),
      concurrency: z.number().int().positive(),
    })
    .partial()
    .optional(),
  mode: z.enum(["sync", "async"]),
  contact: z.string().optional(),
  termsUrl: z.url().optional(),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;
