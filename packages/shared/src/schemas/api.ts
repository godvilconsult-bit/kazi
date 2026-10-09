import { z } from "zod";
import { addressSchema } from "@kazi/config";
import { capabilitySlugSchema } from "../capabilities";
import { decimalAmountSchema, baseUnitsSchema } from "../money";
import { TASK_SPEEDS, hostedConfigSchema } from "../hosted";

/** Zod schemas for every API payload (docs/04-BACKEND-API.md §3). */

// ─── Errors ──────────────────────────────────────────────────────────────────

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INVALID_STATE",
  "STORAGE_ERROR",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

// ─── Shared fields ───────────────────────────────────────────────────────────

export const idSchema = z.string().min(1).max(64);
export const cursorQuerySchema = z.object({
  cursor: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ─── Auth ────────────────────────────────────────────────────────────────────

export const siweVerifySchema = z.object({
  message: z.string().min(1).max(4_000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "must be 0x-prefixed hex"),
});
export type SiweVerifyInput = z.infer<typeof siweVerifySchema>;

export const ROLES = ["CLIENT", "PROVIDER_OWNER", "FREELANCER", "ADMIN"] as const;
export const userSchema = z.object({
  id: idSchema,
  wallet: addressSchema,
  displayName: z.string().nullable(),
  roles: z.array(z.enum(ROLES)),
});

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const createTaskSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(20_000),
  attachments: z.array(idSchema).max(20).default([]), // FileObject ids owned by the caller
  budgetMax: baseUnitsSchema.optional(),
  deadline: z.iso.datetime({ offset: true }),
  /** Kazi-hosted steps: Economy (Batch API, cheaper) or Express (docs/11-HOSTED-AGENTS.md §3). */
  speed: z.enum(TASK_SPEEDS).default("ECONOMY"),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/** Edit an unfunded task that has no live signed quote (DRAFT, or an expired quote). Re-quotes by default. */
export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    description: z.string().trim().min(10).max(20_000).optional(),
    attachments: z.array(idSchema).max(20).optional(),
    budgetMax: baseUnitsSchema.nullable().optional(),
    deadline: z.iso.datetime({ offset: true }).optional(),
    speed: z.enum(TASK_SPEEDS).optional(),
    requote: z.boolean().default(true),
  })
  .strict();
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const listTasksQuerySchema = cursorQuerySchema.extend({
  status: z
    .enum([
      "DRAFT",
      "QUOTED",
      "FUNDED",
      "IN_PROGRESS",
      "DELIVERED",
      "COMPLETED",
      "DISPUTED",
      "RESOLVED",
      "CANCELLED",
      "EXPIRED",
      "REFUNDED",
      "PARTIALLY_REFUNDED",
    ])
    .optional(),
});

export const rateTaskSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2_000).optional(),
});

// ─── Providers ───────────────────────────────────────────────────────────────

/** Manifest pricing (05-AGENT-SPEC §1): decimal strings, converted to base units by Kazi. */
export const pricingSchema = z.object({
  model: z.enum(["per_unit", "fixed"]),
  unit: z.string().min(1).max(32).optional(),
  price: decimalAmountSchema,
  currency: z.literal("USDC"),
  minimum: decimalAmountSchema.optional(),
});

const httpsUrl = z.url().refine((u) => u.startsWith("https://"), "must be an https:// URL");
const manifestUrl = z
  .url()
  .refine(
    (u) => u.startsWith("https://") || u.startsWith("ipfs://"),
    "must be https:// or ipfs://",
  );

const languageSchema = z.string().regex(/^[a-z]{2}$/, "ISO 639-1 code, e.g. en");

export const createProviderSchema = z
  .object({
    kind: z.enum(["AGENT", "HUMAN"]),
    name: z.string().trim().min(3).max(80),
    description: z.string().trim().min(10).max(4_000),
    capabilities: z.array(capabilitySlugSchema).min(1).max(20),
    languages: z.array(languageSchema).min(1).max(20),
    endpointUrl: httpsUrl.optional(),
    manifestUrl: manifestUrl.optional(),
    pricing: pricingSchema,
    payoutAddress: addressSchema,
    /** KAZI = the agent runs on Kazi from `hostedConfig` (docs/11-HOSTED-AGENTS.md); no endpoint. */
    hosting: z.enum(["SELF", "KAZI"]).default("SELF"),
    hostedConfig: hostedConfigSchema.optional(),
  })
  .refine((p) => p.kind === "HUMAN" || p.hosting === "KAZI" || p.endpointUrl !== undefined, {
    message: "self-hosted agents require endpointUrl",
    path: ["endpointUrl"],
  })
  .refine((p) => p.hosting === "SELF" || (p.kind === "AGENT" && p.hostedConfig !== undefined), {
    message: "Kazi-hosted agents require hostedConfig",
    path: ["hostedConfig"],
  });
export type CreateProviderInput = z.infer<typeof createProviderSchema>;

/** Payout address is NOT editable here: it changes onchain with a 48 h delay (03 §2). */
export const updateProviderSchema = z
  .object({
    name: z.string().trim().min(3).max(80),
    description: z.string().trim().min(10).max(4_000),
    capabilities: z.array(capabilitySlugSchema).min(1).max(20),
    languages: z.array(languageSchema).min(1).max(20),
    endpointUrl: httpsUrl,
    manifestUrl: manifestUrl,
    pricing: pricingSchema,
    hostedConfig: hostedConfigSchema,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "at least one field is required");

export const listProvidersQuerySchema = cursorQuerySchema.extend({
  capability: capabilitySlugSchema.optional(),
  language: languageSchema.optional(),
  kind: z.enum(["AGENT", "HUMAN"]).optional(),
  minReputation: z.coerce.number().min(0).max(100).optional(),
  sort: z.enum(["reputation", "newest"]).default("reputation"),
});

// ─── Files ───────────────────────────────────────────────────────────────────

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const presignUploadSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (f) => !/[\\/]/.test(f) && f !== "." && f !== "..",
      "filename must not contain path separators",
    ),
  mime: z
    .string()
    .regex(/^[\w.+-]+\/[\w.+-]+$/, "invalid MIME type")
    .max(200),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "lowercase hex sha256")
    .optional(),
});
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
