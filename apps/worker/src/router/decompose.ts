import { readFileSync } from "node:fs";
import { PlanValidationError, planSchema, validatePlan, type Plan } from "@kazi/shared";
import { addUsage, type LlmClient, type LlmUsage } from "../llm";

/** Step 1 of the router (docs/06-ROUTER.md §1): one client request → validated plan. */

export interface CapabilityInfo {
  slug: string;
  description: string;
  unit: string;
}

export interface AttachmentInfo {
  filename: string;
  mime: string;
  size: number;
  /** Extracted/summarized text, when available. */
  summary?: string;
}

export interface DecomposeInput {
  title: string;
  description: string;
  attachments: readonly AttachmentInfo[];
  /** Human-readable budget, e.g. "25.00 USDC", or undefined when the client set none. */
  budget?: string;
  deadline: Date;
  now: Date;
}

export interface DecomposeDeps {
  llm: LlmClient;
  model: string;
  capabilities: readonly CapabilityInfo[];
  taskId?: string;
}

const TEMPLATE = readFileSync(new URL("./prompts/decompose.md", import.meta.url), "utf8");

/** Stable for a given capability set, so it is prompt-cached across tasks. */
export function renderDecomposeSystem(capabilities: readonly CapabilityInfo[]): string {
  const list = [...capabilities]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((c) => `- \`${c.slug}\` — ${c.description} (${c.unit})`)
    .join("\n");
  return TEMPLATE.replace("{{CAPABILITIES}}", list);
}

export function renderDecomposeUser(input: DecomposeInput): string {
  const hours = Math.max(
    0,
    Math.round((input.deadline.getTime() - input.now.getTime()) / 3_600_000),
  );
  const attachments =
    input.attachments.length === 0
      ? "none"
      : input.attachments
          .map((a, i) => {
            const head = `${i + 1}. ${a.filename} (${a.mime}, ${a.size} bytes)`;
            return a.summary ? `${head}\n   Summary: ${a.summary}` : head;
          })
          .join("\n");
  return [
    "<client_request>",
    `Title: ${input.title}`,
    "",
    "Description:",
    input.description,
    "",
    `Attachments: ${attachments}`,
    `Budget: ${input.budget ?? "not set"}`,
    `Deadline: ${input.deadline.toISOString()} (in about ${hours} hours)`,
    "</client_request>",
    "",
    `Current time: ${input.now.toISOString()}. Plan this request.`,
  ].join("\n");
}

export async function decompose(
  deps: DecomposeDeps,
  input: DecomposeInput,
): Promise<{ plan: Plan; usage: LlmUsage }> {
  const known = new Set(deps.capabilities.map((c) => c.slug));
  const system = renderDecomposeSystem(deps.capabilities);
  let user = renderDecomposeUser(input);
  let usage: LlmUsage | undefined;

  // One corrective retry: business-rule errors (cycles, gaps, unknown capabilities) go back to the model.
  for (let attempt = 1; ; attempt++) {
    const res = await deps.llm.structured({
      purpose: "decompose",
      model: deps.model,
      system,
      user,
      schema: planSchema,
      effort: "medium",
      taskId: deps.taskId,
    });
    usage = addUsage(usage, res.usage);
    try {
      validatePlan(res.data, known);
      return { plan: res.data, usage };
    } catch (err) {
      if (!(err instanceof PlanValidationError) || attempt >= 2) throw err;
      user = `${renderDecomposeUser(input)}\n\nYour previous plan was rejected: ${err.message}. Return a corrected plan.`;
    }
  }
}
