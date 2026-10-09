import type { PrismaClient } from "@kazi/db";
import type { LlmUsage } from "./client";

export {
  AnthropicLlm,
  LlmError,
  addUsage,
  type Effort,
  type LlmClient,
  type LlmPurpose,
  type LlmUsage,
  type StructuredRequest,
  type TextRequest,
} from "./client";
export { MockLlm, MOCK_USAGE } from "./mock";
export {
  addBatchUsage,
  anthropicBatchApi,
  batchText,
  batchTextParams,
  batchUsage,
  messageText,
  type BatchApi,
  type BatchItem,
  type BatchTextResult,
  type TextParamsInput,
} from "./batch";
export { estimateCostUsd, supportsServerFallback } from "./pricing";

/** Charge an LLM call to its task (06-ROUTER §8). Internal cost tracking, not money movement. */
export async function recordLlmCost(
  prisma: PrismaClient,
  taskId: string,
  usage: LlmUsage,
): Promise<void> {
  if (usage.costUsd <= 0) return;
  await prisma.task.update({
    where: { id: taskId },
    data: { llmCostUsd: { increment: usage.costUsd.toFixed(6) } },
  });
}

/** Above this share of the task's value, Kazi's own LLM spend (router + judge) raises an alert (06-ROUTER §8). */
export const LLM_COST_ALERT_RATIO = 0.08;

/** Records one `LLM_COST_HIGH` event per task when router + judge spend passes 8% of the task value. */
export async function checkLlmCostAlert(
  prisma: PrismaClient,
  taskId: string,
  decimals: number,
  log: { warn: (obj: object, msg: string) => void },
): Promise<boolean> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { totalAmount: true, llmCostUsd: true },
  });
  if (!task?.totalAmount) return false;
  // USDC ≈ USD; a ratio for alerting only, never money movement.
  const valueUsd = Number(BigInt(task.totalAmount)) / 10 ** decimals;
  const spentUsd = Number(task.llmCostUsd);
  if (valueUsd <= 0 || spentUsd / valueUsd <= LLM_COST_ALERT_RATIO) return false;
  const already = await prisma.taskEvent.count({ where: { taskId, type: "LLM_COST_HIGH" } });
  if (already > 0) return true;
  await prisma.taskEvent.create({
    data: {
      taskId,
      type: "LLM_COST_HIGH",
      data: { spentUsd: Number(spentUsd.toFixed(6)), valueUsd, ratio: Number((spentUsd / valueUsd).toFixed(4)) },
    },
  });
  log.warn({ taskId, spentUsd, valueUsd }, "router + judge LLM cost above 8% of task value");
  return true;
}
