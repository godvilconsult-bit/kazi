import { z } from "zod";
import { agentCallbackSchema } from "./protocol";

/**
 * BullMQ queues and job payloads shared by the API (producer) and worker (consumer)
 * (docs/02-ARCHITECTURE.md §4). Every job is idempotent; job ids dedupe repeats.
 */

export const QUEUE_NAMES = [
  "router",
  "executor",
  "evaluator",
  "indexer",
  "payouts",
  "notifications",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const id = z.string().min(1).max(64);
const attempt = z.number().int().min(1).max(10);

export const jobSchemas = {
  router: {
    quote: z.object({ taskId: id }),
  },
  executor: {
    tick: z.object({}),
    dispatch: z.object({ subtaskId: id, attempt }),
    /** A signed agent callback, already verified by the API. */
    agentResult: z.object({
      subtaskId: id,
      attempt,
      callback: agentCallbackSchema,
      receivedAt: z.iso.datetime(),
    }),
    /** Run one attempt of a Kazi-hosted agent (docs/11-HOSTED-AGENTS.md §4). */
    hostedRun: z.object({ subtaskId: id, attempt }),
    /** Collect finished Economy (batch) runs. Repeatable. */
    hostedPoll: z.object({}),
    /** Advice run for a hosted agent: score + cost per model (§5). */
    advise: z.object({ providerId: id, requestedAt: z.iso.datetime() }),
    /** Recompute one provider's reputation (06-ROUTER §6). */
    reputation: z.object({ providerId: id }),
    /** Daily: recompute every provider (time decay). Repeatable. */
    reputationAll: z.object({}),
    /** Daily: recompute the points program from closed tasks. Repeatable. */
    points: z.object({}),
    /** A freelancer accepted an offer: reassign the milestone onchain if needed. */
    offerAccepted: z.object({ offerId: id }),
    /** Dry run of a self-hosted agent (no money): send one signed sample request. */
    providerTest: z.object({
      providerId: id,
      testId: z.string().regex(/^[0-9a-f]{24}$/),
      capability: z.string().min(1).max(64),
      instructions: z.string().min(1).max(20_000),
      text: z.string().min(1).max(20_000),
      rubric: z.array(z.string().min(1).max(300)).min(1).max(8),
    }),
  },
  evaluator: {
    evaluate: z.object({ submissionId: id }),
  },
  payouts: {
    tick: z.object({}),
    /** Hourly: FeeDistributor.distribute() once enough fees have accumulated. Repeatable. */
    distributeFees: z.object({}),
    release: z.object({ subtaskId: id }),
    refund: z.object({ subtaskId: id }),
  },
} as const;

export type QuoteJob = z.infer<typeof jobSchemas.router.quote>;
export type DispatchJob = z.infer<typeof jobSchemas.executor.dispatch>;
export type AgentResultJob = z.infer<typeof jobSchemas.executor.agentResult>;
export type EvaluateJob = z.infer<typeof jobSchemas.evaluator.evaluate>;
export type PayoutJob = z.infer<typeof jobSchemas.payouts.release>;

/**
 * Deterministic job ids: enqueueing the same work twice is a no-op while the job exists.
 * BullMQ forbids ":" in custom ids, so timestamps are epoch milliseconds.
 */
export const jobIds = {
  quote: (taskId: string, version: number) => `quote-${taskId}-${version}`,
  dispatch: (subtaskId: string, attempt: number) => `dispatch-${subtaskId}-${attempt}`,
  agentResult: (subtaskId: string, attempt: number, status: string, atMs: number) =>
    `result-${subtaskId}-${attempt}-${status}-${atMs}`,
  evaluate: (submissionId: string) => `evaluate-${submissionId}`,
  hostedRun: (subtaskId: string, attempt: number) => `hosted-${subtaskId}-${attempt}`,
  advise: (providerId: string, atMs: number) => `advise-${providerId}-${atMs}`,
  /** At most one recompute per provider per minute. */
  reputation: (providerId: string, atMs: number) => `rep-${providerId}-${Math.floor(atMs / 60_000)}`,
  offerAccepted: (offerId: string) => `offer-${offerId}`,
  providerTest: (testId: string) => `ptest-${testId}`,
  release: (subtaskId: string) => `release-${subtaskId}`,
  refund: (subtaskId: string) => `refund-${subtaskId}`,
};
