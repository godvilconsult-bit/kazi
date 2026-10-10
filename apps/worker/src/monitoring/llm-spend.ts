import type { Redis } from "ioredis";
import { LlmError, type LlmClient } from "../llm";

/** Hourly LLM spend counter (UTC hour), read by the monitor for LLM_COST_SPIKE. */
export const llmHourKey = (prefix: string, at: Date) => `${prefix}:llm:usd:${at.toISOString().slice(0, 13)}`;

/** Wraps an LlmClient so every call's cost (including failed calls that still cost money) is recorded. */
export function trackLlmSpend(llm: LlmClient, record: (usd: number) => void): LlmClient {
  const charge = (usd: number | undefined) => {
    if (usd && usd > 0) record(usd);
  };
  return {
    async structured(req) {
      try {
        const res = await llm.structured(req);
        charge(res.usage.costUsd);
        return res;
      } catch (err) {
        if (err instanceof LlmError) charge(err.usage?.costUsd);
        throw err;
      }
    },
    async text(req) {
      try {
        const res = await llm.text(req);
        charge(res.usage.costUsd);
        return res;
      } catch (err) {
        if (err instanceof LlmError) charge(err.usage?.costUsd);
        throw err;
      }
    },
  };
}

export function redisSpendRecorder(redis: Pick<Redis, "incrbyfloat" | "expire">, prefix: string, onCost?: (usd: number) => void) {
  return (usd: number) => {
    onCost?.(usd);
    const key = llmHourKey(prefix, new Date());
    void redis
      .incrbyfloat(key, usd)
      .then(() => redis.expire(key, 48 * 3_600))
      .catch(() => undefined); // spend tracking must never break an LLM call
  };
}
