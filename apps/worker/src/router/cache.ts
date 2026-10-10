import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { planSchema, type Plan } from "@kazi/shared";

/**
 * Decomposition cache (docs/06-ROUTER.md §8): identical inputs within an hour reuse the plan, so
 * re-quoting the same request doesn't pay for another router call.
 */
export interface PlanCache {
  get(key: string): Promise<Plan | null>;
  set(key: string, plan: Plan, ttlSec: number): Promise<void>;
}

export const PLAN_CACHE_TTL_SEC = 3_600;

/** Everything that shapes the plan: the request, attachment summaries, budget, deadline day, capabilities. */
export function planCacheKey(parts: {
  title: string;
  description: string;
  attachments: readonly {
    filename: string;
    mime: string;
    size: number;
    summary?: string | undefined;
  }[];
  budget?: string | undefined;
  deadline: Date;
  capabilities: readonly string[];
}): string {
  const canonical = JSON.stringify([
    parts.title,
    parts.description,
    parts.attachments.map((a) => [a.filename, a.mime, a.size, a.summary ?? null]),
    parts.budget ?? null,
    parts.deadline.toISOString().slice(0, 10),
    [...parts.capabilities].sort(),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function redisPlanCache(redis: Redis, prefix: string): PlanCache {
  const k = (key: string) => `${prefix}:plan:${key}`;
  return {
    async get(key) {
      const raw = await redis.get(k(key));
      if (!raw) return null;
      const parsed = planSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    },
    async set(key, plan, ttlSec) {
      await redis.set(k(key), JSON.stringify(plan), "EX", ttlSec);
    },
  };
}

export class MemoryPlanCache implements PlanCache {
  readonly entries = new Map<string, Plan>();
  async get(key: string) {
    return this.entries.get(key) ?? null;
  }
  async set(key: string, plan: Plan) {
    this.entries.set(key, plan);
  }
}
