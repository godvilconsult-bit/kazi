import { z } from "zod";

/**
 * Worker-only env (router, executor, evaluator). Models are configurable per job type
 * (docs/06-ROUTER.md §8): the strong model plans and judges; the fast one summarizes.
 */
export const llmModelsEnvSchema = z.object({
  LLM_MODEL_ROUTER: z.string().min(1).default("claude-opus-5-5"),
  LLM_MODEL_JUDGE: z.string().min(1).default("claude-opus-5-5"),
  LLM_MODEL_FAST: z.string().min(1).default("claude-haiku-5-5"),
});

/** Executor / evaluator tuning (06-ROUTER §4–5). */
export const executorEnvSchema = z.object({
  EXECUTOR_TICK_MS: z.coerce.number().int().min(1_000).default(5_000),
  EXECUTOR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  EXECUTOR_ATTEMPT_TIMEOUT_SEC: z.coerce
    .number()
    .int()
    .min(30)
    .default(15 * 60),
  EXECUTOR_SYNC_RESPONSE_MS: z.coerce.number().int().min(1_000).default(75_000),
  /** Local development only: allow third-party agent endpoints on localhost / private networks. */
  EXECUTOR_ALLOW_PRIVATE_ENDPOINTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  REVIEW_WINDOW_HOURS: z.coerce.number().min(0).default(72),
  EVAL_PASS_THRESHOLD: z.coerce.number().min(0).max(100).default(70),
  EVAL_DOUBLE_JUDGE_ABOVE: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default("50"),
  PAYOUTS_TICK_MS: z.coerce.number().int().min(1_000).default(15_000),
  /** How often finished Economy (batch) runs of hosted agents are collected. */
  HOSTED_POLL_MS: z.coerce.number().int().min(5_000).default(60_000),
});

/** Quote pricing (06-ROUTER §3). Bps are integers; the minimum fee is a decimal USDC string. */
export const feeEnvSchema = z.object({
  TAKE_RATE_BPS: z.coerce.number().int().min(500).max(2_000).default(1_200),
  SERVICE_FEE_BPS: z.coerce.number().int().min(0).max(2_000).default(500),
  MIN_SERVICE_FEE: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "must be a decimal USDC amount like 0.10")
    .default("0.10"),
});
