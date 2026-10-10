import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import { z } from "zod";
import type { Prisma } from "@kazi/db";
import { type PrismaClient } from "@kazi/db";
import {
  CAPABILITY_DEFINITIONS,
  jobIds,
  acceptanceSchema,
  capabilityOutputSchema,
  parseUnits,
  blockingFailures,
  runChecks,
  storedQuoteSchema,
  transition,
  type Acceptance,
  type AgentOutput,
  type CheckFailure,
} from "@kazi/shared";
import { buildAgentInput } from "../executor/input";
import type { JobSink } from "../jobs/sink";
import { addUsage, checkLlmCostAlert, recordLlmCost, type LlmClient, type LlmUsage } from "../llm";

/** Evaluator (docs/06-ROUTER.md §5): deterministic checks, then the LLM judge. */

export const judgeVerdictSchema = z.object({
  score: z.number().min(0).max(100),
  passed: z.boolean(),
  rubric: z.array(z.object({ item: z.string(), met: z.boolean(), note: z.string() })),
  feedback: z.string(),
});
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

export interface EvaluatorConfig {
  passThreshold: number;
  /** Milestones above this (decimal USDC) are judged twice; the lower score counts. */
  doubleJudgeAbove: string;
}

export interface EvaluateDeps {
  prisma: PrismaClient;
  llm: LlmClient;
  judgeModel: string;
  usdcDecimals: () => Promise<number>;
  config: EvaluatorConfig;
  log: Logger;
  /** Enqueues the provider's reputation recompute on acceptance. */
  jobs?: JobSink;
}

const JUDGE_SYSTEM = readFileSync(new URL("./prompts/judge.md", import.meta.url), "utf8");
/** Output text sent to the judge is capped; anything longer is judged on this prefix and flagged. */
const MAX_JUDGED_CHARS = 150_000;

export function renderJudgeUser(
  instructions: string,
  acceptance: Acceptance,
  output: AgentOutput,
  input?: string,
  notes: readonly string[] = [],
): string {
  const files = (output.files ?? [])
    .map((f) => `- ${f.mime} (sha256 ${f.sha256.slice(0, 12)}…)`)
    .join("\n");
  const text = output.text ?? "";
  return [
    "<instructions>",
    instructions,
    "</instructions>",
    "",
    "<rubric>",
    ...acceptance.rubric.map((r, i) => `${i + 1}. ${r}`),
    "</rubric>",
    `Required format: ${acceptance.format}`,
    ...(acceptance.mustInclude?.length
      ? [`Must include: ${acceptance.mustInclude.join("; ")}`]
      : []),
    "",
    ...(input !== undefined
      ? [
          "<task_input>",
          input.length > MAX_JUDGED_CHARS
            ? `${input.slice(0, MAX_JUDGED_CHARS)}\n[… truncated for review]`
            : input,
          "</task_input>",
          "",
        ]
      : []),
    ...(notes.length > 0
      ? [
          "<automated_notes>",
          ...notes.map((n) => `- ${n}`),
          "These notes come from Kazi's own checks, not from the provider. Word counts differ between languages; only lower the score if content was actually left out or added.",
          "</automated_notes>",
          "",
        ]
      : []),
    "<agent_output>",
    text.length > MAX_JUDGED_CHARS
      ? `${text.slice(0, MAX_JUDGED_CHARS)}\n[… truncated for review]`
      : text,
    ...(files ? ["", "Attached files (not shown):", files] : []),
    "</agent_output>",
  ].join("\n");
}

/** The LLM judge alone (no DB): used by the evaluator and by the house agents' golden tests. */
export async function judgeOutput(
  deps: { llm: LlmClient; judgeModel: string },
  input: {
    instructions: string;
    acceptance: Acceptance;
    output: AgentOutput;
    /** What the provider was given (client request + dependency outputs). */
    input?: string;
    /** Advisory findings from the deterministic checks (e.g. length outside ±30%). */
    notes?: readonly string[];
    runs?: number;
    taskId?: string;
    subtaskId?: string;
  },
): Promise<{ verdict: JudgeVerdict; usage: LlmUsage }> {
  let verdict: JudgeVerdict | undefined;
  let usage: LlmUsage | undefined;
  for (let i = 0; i < (input.runs ?? 1); i++) {
    const res = await deps.llm.structured({
      purpose: "judge",
      model: deps.judgeModel,
      system: JUDGE_SYSTEM,
      user: renderJudgeUser(
        input.instructions,
        input.acceptance,
        input.output,
        input.input,
        input.notes,
      ),
      schema: judgeVerdictSchema,
      effort: "medium",
      taskId: input.taskId,
      subtaskId: input.subtaskId,
    });
    usage = addUsage(usage, res.usage);
    if (!verdict || res.data.score < verdict.score) verdict = res.data;
  }
  if (!verdict || !usage) throw new Error("the judge returned no verdict");
  return { verdict, usage };
}

export async function evaluateSubmission(
  deps: EvaluateDeps,
  submissionId: string,
): Promise<"accepted" | "rejected" | "stale"> {
  const sub = await deps.prisma.submission.findUnique({
    where: { id: submissionId },
    include: { subtask: { include: { task: true } } },
  });
  if (!sub) return "stale";
  const st = sub.subtask;
  const log = deps.log.child({ taskId: st.taskId, subtaskId: st.id, attempt: sub.attempt });

  // Claim: SUBMITTED → EVALUATING for this exact attempt (a re-run of a finished job is a no-op).
  const claimed = await deps.prisma.subtask.updateMany({
    where: { id: st.id, status: "SUBMITTED", attempts: sub.attempt },
    data: { status: transition("subtask", "SUBMITTED", "EVALUATE") },
  });
  if (claimed.count !== 1 && !(st.status === "EVALUATING" && st.attempts === sub.attempt))
    return "stale";

  const output = capabilityOutputSchema.safeParse(sub.output);
  const acceptance = acceptanceSchema.safeParse(st.acceptance);
  if (!acceptance.success) throw new Error(`subtask ${st.id} has invalid acceptance criteria`);

  const failures: CheckFailure[] = output.success
    ? runChecks({
        output: output.data,
        acceptance: acceptance.data,
        expectedWords: expectedWords(st),
      })
    : [{ code: "FORMAT", message: "The output does not match the required structure." }];

  const blocking = blockingFailures(failures);
  let verdict: JudgeVerdict | null = null;
  let usage: LlmUsage | undefined;
  if (blocking.length === 0 && output.success) {
    const decimals = await deps.usdcDecimals();
    const runs = BigInt(st.amount) > parseUnits(deps.config.doubleJudgeAbove, decimals) ? 2 : 1;
    const agentInput = await buildAgentInput({ prisma: deps.prisma }, st);
    ({ verdict, usage } = await judgeOutput(deps, {
      instructions: st.instructions,
      acceptance: acceptance.data,
      output: output.data,
      input: agentInput.text ?? "",
      notes: failures.filter((f) => f.advisory).map((f) => f.message),
      runs,
      taskId: st.taskId,
      subtaskId: st.id,
    }));
    await recordLlmCost(deps.prisma, st.taskId, usage);
    await checkLlmCostAlert(deps.prisma, st.taskId, decimals, log);
  }

  const accepted =
    blocking.length === 0 &&
    verdict !== null &&
    verdict.passed &&
    verdict.score >= deps.config.passThreshold;
  const feedback = blocking.length
    ? blocking.map((f) => f.message).join(" ")
    : (verdict?.feedback ?? "The output could not be evaluated.");
  const evaluation = {
    checks: failures,
    judge: verdict,
    threshold: deps.config.passThreshold,
    feedback,
    ...(usage ? { llmCostUsd: Number(usage.costUsd.toFixed(6)) } : {}),
  };

  await deps.prisma.$transaction(async (tx) => {
    await tx.submission.update({
      where: { id: sub.id },
      data: {
        score: verdict?.score ?? 0,
        accepted,
        evaluation: evaluation as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.subtask.updateMany({
      where: { id: st.id, status: "EVALUATING", attempts: sub.attempt },
      data: { status: transition("subtask", "EVALUATING", accepted ? "ACCEPT" : "REJECT") },
    });
    if (accepted) {
      await tx.provider.update({
        where: { id: sub.providerId },
        data: {
          completedCount: { increment: 1 },
          ...(sub.latencyMs !== null
            ? { avgLatencyMs: await rollingLatency(tx, sub.providerId, sub.latencyMs) }
            : {}),
        },
      });
    }
    await tx.taskEvent.create({
      data: {
        taskId: st.taskId,
        type: accepted ? "SUBTASK_ACCEPTED" : "SUBTASK_REJECTED",
        data: {
          subtaskId: st.id,
          index: st.index,
          attempt: sub.attempt,
          score: verdict?.score ?? 0,
          checks: failures.map((f) => f.code),
        },
      },
    });
    if (failures.some((f) => f.code === "INJECTION")) {
      // Flag for human review (05-AGENT-SPEC §6); slashing is an admin decision, never automatic.
      await tx.taskEvent.create({
        data: {
          taskId: st.taskId,
          type: "INJECTION_SUSPECTED",
          data: { subtaskId: st.id, providerId: sub.providerId, attempt: sub.attempt },
        },
      });
    }
  });
  log.info({ accepted, score: verdict?.score ?? 0 }, "submission evaluated");
  if (accepted && deps.jobs) {
    await deps.jobs.add(
      "executor",
      "reputation",
      { providerId: sub.providerId },
      jobIds.reputation(sub.providerId, Date.now()),
    );
  }
  return accepted ? "accepted" : "rejected";
}

/** For per-1000-word capabilities, the plan's estimate gives the expected output size. */
function expectedWords(st: {
  index: number;
  capability: string;
  task: { quote: Prisma.JsonValue };
}): number | undefined {
  const unit = CAPABILITY_DEFINITIONS.find((c) => c.slug === st.capability)?.unit;
  if (unit !== "1000_words" || !st.capability.startsWith("translate.")) return undefined;
  const quote = storedQuoteSchema.safeParse(st.task.quote);
  if (!quote.success || quote.data.outcome !== "QUOTED") return undefined;
  const planned = quote.data.plan.subtasks.find((s) => s.index === st.index);
  return planned ? planned.estimatedUnits * 1000 : undefined;
}

async function rollingLatency(
  tx: Prisma.TransactionClient,
  providerId: string,
  latencyMs: number,
): Promise<number> {
  const p = await tx.provider.findUniqueOrThrow({
    where: { id: providerId },
    select: { avgLatencyMs: true },
  });
  return p.avgLatencyMs === null ? latencyMs : Math.round(p.avgLatencyMs * 0.8 + latencyMs * 0.2);
}
