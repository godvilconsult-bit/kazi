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

/** Empty env values count as unset. */
const optionalString = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

/**
 * Platform signers (docs/09 §3, docs/runbooks/deploy.md §4): `aws-kms` in production; `env` private
 * keys for local development and testnet only (refused on mainnet, and in production unless
 * ALLOW_PLAINTEXT_KEYS=true).
 */
export const signerBackendEnvSchema = z.object({
  SIGNER_BACKEND: z.enum(["env", "aws-kms"]).default("env"),
  ALLOW_PLAINTEXT_KEYS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  OPERATOR_PRIVATE_KEY: optionalString(
    z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key"),
  ),
  QUOTER_PRIVATE_KEY: optionalString(
    z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key"),
  ),
  OPERATOR_KMS_KEY_ID: optionalString(z.string().min(1)),
  QUOTER_KMS_KEY_ID: optionalString(z.string().min(1)),
});

const decimalUsdc = z.string().regex(/^\d+(\.\d+)?$/, "must be a decimal amount like 1000");
const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

/**
 * Guarded launch (docs/09 §2.4) and incident switches (docs/runbooks/). Empty = no limit.
 */
export const guardEnvSchema = z.object({
  /** Stop quoting new tasks; funded work continues. */
  ROUTER_DISABLED: flag,
  MAX_TASK_USDC: optionalString(decimalUsdc),
  MAX_OPEN_ESCROW_USDC: optionalString(decimalUsdc),
  /** Comma-separated provider slugs quotable besides house agents; empty = all active providers. */
  PROVIDER_ALLOWLIST: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

/** Monitoring and alerts (docs/runbooks/deploy.md §5). */
export const monitoringEnvSchema = z.object({
  SENTRY_DSN: optionalString(z.url()),
  ALERT_WEBHOOK_URL: optionalString(z.url()),
  MONITOR_EVERY_MS: z.coerce.number().int().min(10_000).default(60_000),
  /** Serve Prometheus metrics on this port (unset = off); METRICS_TOKEN requires a bearer token. */
  WORKER_METRICS_PORT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(1).max(65_535).optional(),
  ),
  METRICS_TOKEN: optionalString(z.string().min(16)),
  ALERT_LARGE_RELEASE_USDC: optionalString(decimalUsdc),
  ALERT_DAILY_RELEASE_USDC: optionalString(decimalUsdc),
  ALERT_QUEUE_BACKLOG: z.coerce.number().int().min(1).default(200),
  /** Operator gas balance (native currency, decimal) below which releases may stall. */
  ALERT_OPERATOR_MIN_GAS: decimalUsdc.default("1"),
  ALERT_LLM_HOURLY_USD: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().positive().optional(),
  ),
});

/** Quote pricing (06-ROUTER §3). Bps are integers; the minimum fee is a decimal USDC string. */
export const feeEnvSchema = z.object({
  /** The keeper calls FeeDistributor.distribute() once it holds at least this much USDC. */
  FEE_DISTRIBUTE_MIN_USDC: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "must be a decimal USDC amount like 10")
    .default("10"),
  FEE_DISTRIBUTE_EVERY_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  TAKE_RATE_BPS: z.coerce.number().int().min(500).max(2_000).default(1_200),
  SERVICE_FEE_BPS: z.coerce.number().int().min(0).max(2_000).default(500),
  MIN_SERVICE_FEE: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "must be a decimal USDC amount like 0.10")
    .default("0.10"),
});
