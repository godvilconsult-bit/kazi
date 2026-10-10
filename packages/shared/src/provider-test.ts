import { z } from "zod";

/**
 * Self-hosted agent dry runs (docs/04-BACKEND-API.md `POST /providers/:id/test`): Kazi sends one
 * signed sample request, the agent answers (sync or via the test callback), and the deterministic
 * checks run on the output. No escrow, no payment, no LLM judge.
 */

export const PROVIDER_TEST_TTL_SEC = 24 * 3_600;
export const providerTestKey = (prefix: string, testId: string) =>
  `${prefix}:provider-test:${testId}`;
export const providerTestCallbackPath = (testId: string) => `/agent/test-callback/${testId}`;

export const providerTestStateSchema = z.object({
  testId: z.string(),
  providerId: z.string(),
  capability: z.string(),
  status: z.enum(["QUEUED", "SENT", "COMPLETED", "FAILED"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** HTTP status and time to the agent's first response. */
  http: z.number().int().optional(),
  latencyMs: z.number().int().optional(),
  progress: z.number().min(0).max(1).optional(),
  output: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  checks: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
});
export type ProviderTestState = z.infer<typeof providerTestStateSchema>;

/** Sample work per capability family, used when the developer gives no instructions. */
export function sampleTask(capability: string): {
  instructions: string;
  input: string;
  rubric: string[];
} {
  if (capability.startsWith("translate.")) {
    const [, pair = "en-sw"] = capability.split(".");
    return {
      instructions: `Translate the text below (${pair}). Keep the heading and every figure unchanged.`,
      input: "## Our shop\n\nWe sell 120 solar lamps a month in Arusha and deliver within 2 days.",
      rubric: ["Complete translation", "Heading kept", "Figures 120 and 2 unchanged"],
    };
  }
  if (capability.startsWith("research.")) {
    return {
      instructions:
        "Write a one-page brief on the market for solar lamps in Tanzania, with sources.",
      input: "Audience: a small retailer.",
      rubric: ["Cites sources", "Names competitors", "Gives recommendations"],
    };
  }
  return {
    instructions: `Produce a short sample deliverable for the capability ${capability}.`,
    input: "Client: a small solar retailer in Arusha selling 120 lamps a month.",
    rubric: ["Relevant to the client", "Complete and well structured"],
  };
}
