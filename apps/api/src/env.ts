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
    /** Requests per minute per API key (public API, docs/12-PUBLIC-API.md). */
    API_KEY_RATE_LIMIT: z.coerce.number().int().min(1).default(120),
    PUBLIC_RPC_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()),
    /**
     * Which proxies may set X-Forwarded-For (rate limits key on the client IP). "false" (default):
     * use the socket address; a number: trust that many hops (e.g. 1 behind one load balancer);
     * otherwise a comma-separated list of proxy IPs/CIDRs. Never "true" on the internet — any client
     * could spoof its IP and dodge the sign-in rate limits.
     */
    TRUST_PROXY: z
      .string()
      .default("false")
      .transform((v): boolean | string[] | ((address: string, hop: number) => boolean) => {
        if (v === "false" || v === "") return false;
        if (v === "true") return true;
        if (/^\d+$/.test(v)) {
          const hops = Number(v);
          return (_address, hop) => hop < hops; // trust the n proxies closest to the API
        }
        return v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }),
    /** Wallet sanctions screening at sign-in and for payout addresses (security/sanctions.ts). */
    CHAINALYSIS_API_KEY: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().min(8).optional(),
    ),
    SANCTIONS_FAIL_CLOSED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** Incident switch: refuse new quote requests (docs/runbooks/incident-response.md). */
    ROUTER_DISABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** Bearer token for GET /metrics (Prometheus); unset = /metrics is off. */
    METRICS_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16).optional()),
    SENTRY_DSN: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()),
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return loadEnv(apiEnvSchema, source);
}
