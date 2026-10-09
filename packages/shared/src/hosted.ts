import { z } from "zod";
import { HOSTED_MODELS } from "./ai-cost";
import type { AgentRequest } from "./protocol";

/** Kazi-hosted agents (docs/11-HOSTED-AGENTS.md). */

export const TASK_SPEEDS = ["ECONOMY", "EXPRESS"] as const;
export type TaskSpeed = (typeof TASK_SPEEDS)[number];
/** Economy (Batch API) is offered only when the deadline is at least this far away. */
export const ECONOMY_MIN_HEADROOM_MS = 48 * 3_600_000;
/** A batch attempt may take up to 24 h; this is its time limit before it counts as timed out. */
export const ECONOMY_ATTEMPT_MS = 24 * 3_600_000 + 30 * 60_000;
/** A retry with less time left than this runs in Express mode. */
export const ECONOMY_RETRY_MIN_LEFT_MS = 26 * 3_600_000;

/** How a hosted attempt runs: Economy uses the Batch API unless too little time is left for a (worst-case 24 h) batch. */
export function hostedRunMode(speed: TaskSpeed, deadline: Date, now: Date): "BATCH" | "STANDARD" {
  return speed === "ECONOMY" && deadline.getTime() - now.getTime() >= ECONOMY_RETRY_MIN_LEFT_MS
    ? "BATCH"
    : "STANDARD";
}

export const hostedSampleSchema = z.object({
  instructions: z.string().trim().min(10).max(4_000),
  input: z.string().max(20_000),
});

export const hostedConfigSchema = z
  .object({
    /** The developer's system instructions for the agent. */
    instructions: z.string().trim().min(50).max(20_000),
    model: z.enum(HOSTED_MODELS),
    effort: z.enum(["low", "medium", "high"]).default("medium"),
    /** Anthropic-hosted web search, at most this many searches per task. */
    webSearch: z
      .object({ maxUses: z.number().int().min(1).max(10) })
      .nullable()
      .default(null),
    /** Hard cap on output (incl. thinking) per call; bounds the worst-case AI cost. */
    maxOutputTokens: z.number().int().min(1_000).max(64_000).default(32_000),
    /** Sample tasks for the advice run (§5); Kazi's defaults are used when empty. */
    samples: z.array(hostedSampleSchema).max(3).default([]),
  })
  .refine((c) => !(c.webSearch && c.model === "claude-haiku-5-5"), {
    message: "web search needs Opus or Sonnet",
    path: ["webSearch"],
  });
export type HostedConfig = z.infer<typeof hostedConfigSchema>;

/** Per-task AI cost estimates (nano-USD, decimal strings), from advice runs then actual runs. */
export const aiCostEstimateSchema = z.object({
  economyNano: z.string().regex(/^\d+$/),
  expressNano: z.string().regex(/^\d+$/),
  samples: z.number().int().min(0),
  updatedAt: z.iso.datetime(),
});
export type AiCostEstimate = z.infer<typeof aiCostEstimateSchema>;

/** One model's row in the advice report shown to the developer. */
export const adviceRowSchema = z.object({
  model: z.enum(HOSTED_MODELS),
  runs: z.number().int().min(0),
  passed: z.number().int().min(0),
  avgScore: z.number().min(0).max(100),
  economyNano: z.string().regex(/^\d+$/),
  expressNano: z.string().regex(/^\d+$/),
  error: z.string().optional(),
});
export const hostedAdviceSchema = z.object({
  status: z.enum(["RUNNING", "DONE", "FAILED"]),
  requestedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  rows: z.array(adviceRowSchema),
});
export type HostedAdvice = z.infer<typeof hostedAdviceSchema>;

/**
 * The task as an agent's model sees it (house and hosted agents). Everything client- or
 * agent-supplied sits inside <task>, which agent prompts treat as data.
 */
export function renderAgentTask(r: AgentRequest): string {
  const files = (r.input.files ?? []).map((f) => `- ${f.mime}: ${f.url}`).join("\n");
  return [
    "<task>",
    "## Instructions",
    r.instructions,
    "",
    "## Acceptance criteria",
    ...r.acceptance.rubric.map((c) => `- ${c}`),
    `Output format: ${r.acceptance.format}`,
    ...(r.acceptance.mustInclude?.length
      ? [`Must include: ${r.acceptance.mustInclude.join("; ")}`]
      : []),
    "",
    "## Input",
    r.input.text ?? "(no text input)",
    ...(files ? ["", "Attached files:", files] : []),
    ...(r.feedback
      ? ["", "## Reviewer feedback on your previous attempt (fix these points)", r.feedback]
      : []),
    "</task>",
  ].join("\n");
}
