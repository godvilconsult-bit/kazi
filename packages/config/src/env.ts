import { z } from "zod";
import { NETWORKS, getChainConfig, type Address, type ChainConfig } from "./chains";

/**
 * Env schemas, composed per app so each one validates only what it uses.
 * Variable list mirrors docs/04-BACKEND-API.md §7 and .env.example.
 */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(emptyToUndefined, schema.optional());

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address")
  .transform((v) => v as Address);

const privateKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key");

const addressListSchema = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(addressSchema));

export const runtimeEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  KAZI_NETWORK: z.enum(NETWORKS),
});

export const chainEnvSchema = z.object({
  ARC_RPC_URL: optional(z.url()),
  ARC_CHAIN_ID: optional(z.coerce.number().int().positive()),
  CONFIRMATIONS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(64).default(2)),
  USDC_ADDRESS: optional(addressSchema),
});

export const dbEnvSchema = z.object({ DATABASE_URL: z.url() });
export const redisEnvSchema = z.object({ REDIS_URL: z.url() });

export const authEnvSchema = z.object({
  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  ADMIN_WALLETS: z.preprocess((v) => v ?? "", addressListSchema),
});

export const llmEnvSchema = z.object({ ANTHROPIC_API_KEY: z.string().min(1) });

export const signerEnvSchema = z.object({
  OPERATOR_PRIVATE_KEY: privateKeySchema,
  QUOTER_PRIVATE_KEY: privateKeySchema,
});

/** File storage: Supabase Storage signed-URL API, server-side only (docs/02 §7). */
export const storageEnvSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  STORAGE_BUCKET: z.string().min(1).default("kazi-files"),
});

/** Prefix for every Redis key/queue so environments and test runs never collide. */
export const redisPrefixEnvSchema = z.object({
  REDIS_KEY_PREFIX: z.preprocess(emptyToUndefined, z.string().min(1).default("kazi")),
});

export const urlEnvSchema = z.object({
  APP_URL: z.url(),
  API_URL: z.url(),
  SENTRY_DSN: optional(z.url()),
});

export class EnvValidationError extends Error {
  override readonly name = "EnvValidationError";
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}

/** Parse env with a schema; throws a readable error listing every bad variable. Never logs values. */
export function loadEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Load runtime + chain env and resolve the full chain config. Fails fast on mismatch. */
export function loadChainConfig(
  source: Record<string, string | undefined> = process.env,
): ChainConfig {
  const env = loadEnv(runtimeEnvSchema.extend(chainEnvSchema.shape), source);
  return getChainConfig(env.KAZI_NETWORK, {
    rpcUrl: env.ARC_RPC_URL,
    usdcAddress: env.USDC_ADDRESS,
    expectedChainId: env.ARC_CHAIN_ID,
    confirmations: env.CONFIRMATIONS,
  });
}
