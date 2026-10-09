import { z } from "zod";

/**
 * Capability taxonomy v1 (docs/05-AGENT-SPEC.md §2). Agents may only claim capabilities from
 * this list (plus admin-added rows in the Capability table). Each has an input/output schema.
 */

const fileRefSchema = z.object({
  url: z.url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().min(1).max(200),
});

/** Default input: instructions text and/or files. Capability-specific schemas can refine it. */
export const capabilityInputSchema = z
  .object({
    text: z.string().max(200_000).optional(),
    files: z.array(fileRefSchema).max(20).optional(),
  })
  .refine((v) => v.text !== undefined || (v.files?.length ?? 0) > 0, "text or files is required");

export const capabilityOutputSchema = z
  .object({
    text: z.string().max(500_000).optional(),
    files: z.array(fileRefSchema).max(50).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.text !== undefined || (v.files?.length ?? 0) > 0, "text or files is required");

export interface CapabilityDefinition {
  readonly slug: string;
  readonly description: string;
  /** Pricing unit used when estimating `estimatedUnits` (06-ROUTER §1). */
  readonly unit: "1000_words" | "page" | "file" | "task" | "hour" | "minute_audio" | "image";
  readonly human: boolean;
}

const TRANSLATION_PAIRS = ["en-sw", "sw-en", "en-fr", "fr-en"] as const;

export const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  { slug: "write.business_plan", description: "Business plan writing", unit: "task", human: false },
  {
    slug: "write.pitch_deck_outline",
    description: "Pitch deck outline",
    unit: "task",
    human: false,
  },
  { slug: "write.marketing_copy", description: "Marketing copy", unit: "1000_words", human: false },
  {
    slug: "write.social_pack",
    description: "Social media content pack",
    unit: "task",
    human: false,
  },
  { slug: "write.blog_post", description: "Blog post", unit: "1000_words", human: false },
  ...TRANSLATION_PAIRS.map((pair) => ({
    slug: `translate.${pair}`,
    description: `Translation ${pair.replace("-", " → ")}`,
    unit: "1000_words" as const,
    human: false,
  })),
  { slug: "research.market", description: "Market research report", unit: "task", human: false },
  { slug: "research.web_summary", description: "Web research summary", unit: "task", human: false },
  {
    slug: "finance.statement_review",
    description: "Financial statement review",
    unit: "page",
    human: false,
  },
  {
    slug: "finance.bookkeeping_draft",
    description: "Bookkeeping draft",
    unit: "page",
    human: false,
  },
  {
    slug: "tax.tz_tra_draft",
    description: "Tanzania TRA tax filing draft (draft only)",
    unit: "task",
    human: false,
  },
  {
    slug: "tax.ke_kra_draft",
    description: "Kenya KRA tax filing draft (draft only)",
    unit: "task",
    human: false,
  },
  {
    slug: "code.solidity_review",
    description: "Smart-contract pre-review (not an audit)",
    unit: "task",
    human: false,
  },
  { slug: "code.review", description: "Code review", unit: "task", human: false },
  { slug: "data.clean_csv", description: "CSV cleaning", unit: "file", human: false },
  { slug: "data.analysis", description: "Data analysis", unit: "task", human: false },
  { slug: "design.brief", description: "Design brief", unit: "task", human: false },
  { slug: "image.generate", description: "Image generation", unit: "image", human: false },
  {
    slug: "audio.transcribe",
    description: "Audio transcription",
    unit: "minute_audio",
    human: false,
  },
  { slug: "human.review", description: "Human professional review", unit: "hour", human: true },
  { slug: "human.sign_off", description: "Human sign-off", unit: "task", human: true },
  { slug: "human.design", description: "Human design work", unit: "hour", human: true },
];

export const CAPABILITIES = CAPABILITY_DEFINITIONS.map((c) => c.slug);

/** Slug shape: `area.name` or `translate.xx-yy`; lowercase. Used for admin-added capabilities too. */
export const capabilitySlugSchema = z
  .string()
  .regex(/^[a-z]+\.[a-z0-9_]+(-[a-z0-9_]+)?$/, "invalid capability slug")
  .max(64);

export function isBuiltInCapability(slug: string): boolean {
  return CAPABILITIES.includes(slug);
}
