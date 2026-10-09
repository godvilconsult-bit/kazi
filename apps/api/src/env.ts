import { z } from "zod";
import {
  authEnvSchema,
  chainEnvSchema,
  dbEnvSchema,
  loadEnv,
  redisEnvSchema,
  redisPrefixEnvSchema,
  runtimeEnvSchema,
  storageEnvSchema,
  urlEnvSchema,
} from "@kazi/config";

export const apiEnvSchema = runtimeEnvSchema
  .extend(dbEnvSchema.shape)
  .extend(redisEnvSchema.shape)
  .extend(redisPrefixEnvSchema.shape)
  .extend(authEnvSchema.shape)
  .extend(urlEnvSchema.shape)
  .extend(storageEnvSchema.shape)
  .extend(chainEnvSchema.shape)
  .extend({
    API_HOST: z.string().default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    /** Optional cookie Domain (e.g. ".kazi.app" so app.kazi.app and api.kazi.app share the session). */
    COOKIE_DOMAIN: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    /** Free quotes per wallet per day: each new quote costs Kazi a router call (06-ROUTER §8). */
    QUOTE_DAILY_LIMIT: z.coerce.number().int().min(1).default(30),
    /** RPC URL handed to browsers via GET /config. Defaults to the network's public RPC, never ARC_RPC_URL (it may carry a key). */
    PUBLIC_RPC_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()),
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return loadEnv(apiEnvSchema, source);
}
