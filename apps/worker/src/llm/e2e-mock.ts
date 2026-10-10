import type { Plan } from "@kazi/shared";
import { MockLlm } from "./mock";

/**
 * Deterministic Claude stand-in for the browser end-to-end test (apps/web/e2e). Enabled with
 * KAZI_LLM_MOCK=e2e in the worker and house-agents processes; refused when NODE_ENV=production.
 * Every task is planned as one business-plan step for the house business-plan writer.
 */
export function createE2eMockLlm(): MockLlm {
  const plan: Plan = {
    feasible: true,
    clarifyingQuestions: [],
    subtasks: [
      {
        index: 0,
        title: "Write the business plan",
        capability: "write.business_plan",
        instructions: "Write a concise business plan for the client's business, covering market, operations and finances.",
        dependsOn: [],
        estimatedUnits: 1,
        acceptance: {
          rubric: ["Covers the market", "Covers operations", "Covers finances"],
          format: "markdown",
        },
        needsHuman: false,
      },
    ],
  };
  return new MockLlm()
    .on("decompose", () => plan)
    .on("summarize", () => "A short client document.")
    .on("agent", () =>
      [
        "# Business plan",
        "",
        "## Market",
        "Small shops and homes in Arusha need reliable, affordable solar lighting.",
        "",
        "## Operations",
        "Two technicians install and service systems; stock is bought monthly from a Dar es Salaam importer.",
        "",
        "## Finances",
        "Monthly revenue of TZS 12 million at a 30% gross margin; break-even in month 9.",
      ].join("\n"),
    )
    .on("judge", () => ({
      score: 90,
      passed: true,
      rubric: [
        { item: "Covers the market", met: true, note: "Market section present" },
        { item: "Covers operations", met: true, note: "Operations section present" },
        { item: "Covers finances", met: true, note: "Finances section present" },
      ],
      feedback: "No changes needed.",
    }));
}
