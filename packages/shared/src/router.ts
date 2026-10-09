import { z } from "zod";
import { capabilitySlugSchema } from "./capabilities";

/** Router output contract (docs/06-ROUTER.md §1). The LLM must return exactly this shape. */

export const MAX_SUBTASKS = 12;

export const acceptanceSchema = z.object({
  rubric: z.array(z.string().min(1).max(300)).min(1).max(8),
  format: z.enum(["markdown", "text", "json", "file"]),
  mustInclude: z.array(z.string().min(1).max(200)).max(20).optional(),
});
export type Acceptance = z.infer<typeof acceptanceSchema>;

export const planSubtaskSchema = z.object({
  index: z.number().int().min(0),
  title: z.string().min(1).max(120),
  capability: capabilitySlugSchema,
  instructions: z.string().min(1).max(4000),
  dependsOn: z.array(z.number().int().min(0)),
  estimatedUnits: z.number().positive(),
  acceptance: acceptanceSchema,
  needsHuman: z.boolean(),
});
export type PlanSubtask = z.infer<typeof planSubtaskSchema>;

export const planSchema = z.object({
  feasible: z.boolean(),
  infeasibleReason: z.string().max(500).optional(),
  clarifyingQuestions: z.array(z.string().max(300)).max(3),
  subtasks: z.array(planSubtaskSchema).max(MAX_SUBTASKS),
});
export type Plan = z.infer<typeof planSchema>;

export class PlanValidationError extends Error {
  override readonly name = "PlanValidationError";
}

/**
 * Business-rule validation after the LLM (06-ROUTER §1): contiguous indexes, known
 * capabilities, dependencies point backwards-or-sideways only within the plan, no cycles.
 */
export function validatePlan(plan: Plan, knownCapabilities: ReadonlySet<string>): void {
  if (!plan.feasible) return;
  const n = plan.subtasks.length;
  if (n === 0) throw new PlanValidationError("feasible plan has no subtasks");
  plan.subtasks.forEach((st, i) => {
    if (st.index !== i)
      throw new PlanValidationError(
        `subtask indexes must be contiguous from 0 (got ${st.index} at ${i})`,
      );
    if (!knownCapabilities.has(st.capability))
      throw new PlanValidationError(`unknown capability ${st.capability}`);
    for (const d of st.dependsOn) {
      if (d < 0 || d >= n || d === i)
        throw new PlanValidationError(`subtask ${i} has invalid dependency ${d}`);
    }
  });
  // Cycle check (Kahn's algorithm).
  const indegree = plan.subtasks.map((st) => new Set(st.dependsOn).size);
  const queue = indegree.flatMap((d, i) => (d === 0 ? [i] : []));
  let visited = 0;
  while (queue.length > 0) {
    const i = queue.shift() as number;
    visited++;
    plan.subtasks.forEach((st, j) => {
      if (st.dependsOn.includes(i)) {
        indegree[j] = (indegree[j] ?? 0) - 1;
        if (indegree[j] === 0) queue.push(j);
      }
    });
  }
  if (visited !== n) throw new PlanValidationError("plan dependencies contain a cycle");
}

/** Subtasks whose dependencies are all in `done`, in index order. */
export function readySubtasks<T extends { index: number; dependsOn: number[] }>(
  subtasks: readonly T[],
  done: ReadonlySet<number>,
): T[] {
  return subtasks.filter((st) => !done.has(st.index) && st.dependsOn.every((d) => done.has(d)));
}
