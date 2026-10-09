import type { Logger } from "pino";
import type { PrismaClient } from "@kazi/db";
import { sampleTask } from "@kazi/agent-sdk";
import {
  HOSTED_MODELS,
  aiCostEstimateSchema,
  aiCostNano,
  hostedAdviceSchema,
  hostedConfigSchema,
  renderAgentTask,
  runChecks,
  type AgentRequest,
  type HostedAdvice,
  type HostedModel,
} from "@kazi/shared";
import { judgeOutput } from "../evaluator/evaluate";
import { LlmError, type LlmClient } from "../llm";
import { hostedSystem } from "./run";

/**
 * Advice run (docs/11-HOSTED-AGENTS.md §5): the developer's agent on its sample tasks with each
 * eligible model, judged by Kazi's evaluator. Shows score and per-task cost (Economy and Express)
 * per model so the developer chooses with evidence; seeds the cost estimate quotes need.
 */

export interface AdviseDeps {
  prisma: PrismaClient;
  llm: LlmClient;
  judgeModel: string;
  log: Logger;
}

const GENERIC_RUBRIC = [
  "Does everything the instructions ask",
  "Accurate, specific and well organized",
  "Ready for the client to use as delivered",
];

export async function adviseProvider(
  deps: AdviseDeps,
  providerId: string,
  requestedAt: string,
): Promise<HostedAdvice | "stale"> {
  const provider = await deps.prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider || provider.hosting !== "KAZI") return "stale";
  const current = hostedAdviceSchema.safeParse(provider.hostedAdvice);
  if (
    !current.success ||
    current.data.requestedAt !== requestedAt ||
    current.data.status !== "RUNNING"
  ) {
    return "stale"; // superseded by a newer request, or already done
  }
  const config = hostedConfigSchema.parse(provider.hostedConfig);
  const capability = provider.capabilities[0] ?? "write.blog_post";
  const samples = (
    config.samples.length
      ? config.samples.map((s) => ({ ...s, rubric: GENERIC_RUBRIC }))
      : [sampleTask(capability)]
  ).slice(0, 3);
  const models = HOSTED_MODELS.filter((m) => !(config.webSearch && m === "claude-haiku-5-5"));
  const log = deps.log.child({ providerId });

  const rows = await Promise.all(
    models.map(async (model) => {
      let runs = 0;
      let passed = 0;
      let scoreSum = 0;
      let econ = 0n;
      let exp = 0n;
      let error: string | undefined;
      for (const [i, sample] of samples.entries()) {
        const request: AgentRequest = {
          subtaskId: `advice-${providerId}-${i}`,
          attempt: 1,
          capability,
          instructions: sample.instructions,
          input: { text: sample.input || "(no additional input)" },
          acceptance: { rubric: sample.rubric, format: "markdown" },
          deadline: new Date(Date.now() + 3_600_000).toISOString(),
          callbackUrl: "https://kazi.invalid/advice",
          budget: "0",
        };
        try {
          const { text, usage } = await deps.llm.text({
            purpose: "agent",
            model,
            system: hostedSystem({ ...config, model }),
            user: renderAgentTask(request),
            effort: config.effort,
            maxTokens: config.maxOutputTokens,
            ...(config.webSearch ? { webSearch: config.webSearch } : {}),
          });
          econ += aiCostNano(usage.model, usage, { batch: true });
          exp += aiCostNano(usage.model, usage);
          const output = { text };
          const checks = runChecks({ output, acceptance: request.acceptance });
          const { verdict } = await judgeOutput(
            { llm: deps.llm, judgeModel: deps.judgeModel },
            {
              instructions: request.instructions,
              acceptance: request.acceptance,
              output,
              input: request.input.text ?? "",
            },
          );
          runs++;
          scoreSum += checks.length ? 0 : verdict.score;
          if (checks.length === 0 && verdict.passed && verdict.score >= 70) passed++;
        } catch (err) {
          error = err instanceof LlmError ? `${err.code}: ${err.message}` : "unexpected error";
          log.warn({ err, model }, "advice run failed");
        }
      }
      return {
        model: model as HostedModel,
        runs,
        passed,
        avgScore: runs ? Math.round(scoreSum / runs) : 0,
        economyNano: runs ? (econ / BigInt(runs)).toString() : "0",
        expressNano: runs ? (exp / BigInt(runs)).toString() : "0",
        ...(error ? { error } : {}),
      };
    }),
  );

  const advice: HostedAdvice = {
    status: rows.some((r) => r.runs > 0) ? "DONE" : "FAILED",
    requestedAt,
    finishedAt: new Date().toISOString(),
    rows,
  };
  // Seed the quote estimate from the chosen model's measured runs, unless real runs already exist.
  const chosen = rows.find((r) => r.model === config.model && r.runs > 0);
  const hasEstimate = aiCostEstimateSchema.safeParse(provider.aiCost).success;
  await deps.prisma.provider.update({
    where: { id: providerId },
    data: {
      hostedAdvice: advice,
      ...(chosen ? { reviewScore: chosen.avgScore } : {}),
      ...(chosen && !hasEstimate
        ? {
            aiCost: {
              economyNano: chosen.economyNano,
              expressNano: chosen.expressNano,
              samples: chosen.runs,
              updatedAt: advice.finishedAt ?? new Date().toISOString(),
            },
          }
        : {}),
    },
  });
  log.info(
    {
      rows: rows.map((r) => ({
        model: r.model,
        score: r.avgScore,
        passed: `${r.passed}/${r.runs}`,
      })),
    },
    "advice run done",
  );
  return advice;
}
