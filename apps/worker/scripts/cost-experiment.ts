/**
 * Measures how much cheaper an agent task gets on Kazi's discounted execution paths, with the
 * same quality bar (Kazi's judge). Runs one golden case of a house agent three ways:
 *   A) standard API, Opus 5.5 (today's setup)   B) Batch API, Opus 5.5   C) Batch API, Sonnet 5.5
 *   pnpm -F @kazi/worker cost-experiment [agent-slug] [case-name-substring]
 * Spends real API credit (~$1–2 for a research case).
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { pino } from "pino";
import { z } from "zod";
import { loadEnv, llmEnvSchema } from "@kazi/config";
// By path, not as a dependency: house agents depend on the worker (see test/e2e.test.ts).
import { renderTask } from "../../../packages/house-agents/src/index";
import { acceptanceSchema, runChecks, type AgentRequest } from "@kazi/shared";
import { judgeOutput } from "../src/evaluator/evaluate";
import { AnthropicLlm, anthropicBatchApi, batchText, type Effort, type LlmUsage } from "../src/llm";

const SPECS: Record<
  string,
  { prompt: string; maxTokens: number; webSearch?: { maxUses: number } }
> = {
  "house-market-research": {
    prompt: "market-research/prompt.md",
    maxTokens: 64_000,
    webSearch: { maxUses: 8 },
  },
  "house-business-plan-writer": { prompt: "business-plan/prompt.md", maxTokens: 64_000 },
  "house-translator-en-sw": { prompt: "translator/prompt.md", maxTokens: 64_000 },
};
const VARIANTS: { key: string; name: string; model: string; effort: Effort; batch: boolean }[] = [
  {
    key: "A",
    name: "A standard · Opus 5.5 · high",
    model: "claude-opus-5-5",
    effort: "high",
    batch: false,
  },
  {
    key: "B",
    name: "B batch · Opus 5.5 · high",
    model: "claude-opus-5-5",
    effort: "high",
    batch: true,
  },
  {
    key: "C",
    name: "C batch · Sonnet 5.5 · medium",
    model: "claude-sonnet-5-5",
    effort: "medium",
    batch: true,
  },
];

const env = loadEnv(
  llmEnvSchema.extend({ LLM_MODEL_JUDGE: z.string().default("claude-opus-5-5") }),
);
const [slug = "house-market-research", caseFilter = "solar"] = process.argv.slice(2);
const spec = SPECS[slug];
if (!spec) throw new Error(`unknown agent ${slug}`);
const golden = z
  .array(
    z.object({
      name: z.string(),
      capability: z.string(),
      instructions: z.string(),
      input: z.string(),
      acceptance: acceptanceSchema,
    }),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL(`../../../packages/house-agents/golden/${slug}.json`, import.meta.url),
        "utf8",
      ),
    ),
  );
const c = golden.find((g) => g.name.includes(caseFilter));
if (!c) throw new Error(`no case matching "${caseFilter}"`);

const log = pino({ level: "warn" });
const system = readFileSync(
  new URL(`../../../packages/house-agents/src/${spec.prompt}`, import.meta.url),
  "utf8",
);
const request: AgentRequest = {
  subtaskId: "cost-experiment",
  attempt: 1,
  capability: c.capability,
  instructions: c.instructions,
  input: { text: c.input || "(no additional input)" },
  acceptance: c.acceptance,
  deadline: new Date(Date.now() + 86_400_000).toISOString(),
  callbackUrl: "https://kazi.invalid/cb",
  budget: "4.00",
};
const user = renderTask(request);
const llm = new AnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY, log, timeoutMs: 15 * 60_000 });
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

console.log(`Agent ${slug}, case "${c.name}"\n`);
const outputs = new Map<string, { text: string; usage: LlmUsage; ms: number }>();

// A: today's path (standard, streaming).
const a = VARIANTS.find((v) => !v.batch);
if (!a) throw new Error("no standard variant");
let t0 = Date.now();
const std = await llm.text({
  purpose: "agent",
  model: a.model,
  system,
  user,
  effort: a.effort,
  maxTokens: spec.maxTokens,
  ...(spec.webSearch ? { webSearch: spec.webSearch } : {}),
});
outputs.set(a.name, { ...std, ms: Date.now() - t0 });
console.log(`${a.name}: done in ${Math.round((Date.now() - t0) / 1000)}s`);

// B and C: one batch with both requests.
t0 = Date.now();
const batched = await batchText(
  anthropicBatchApi(client),
  VARIANTS.filter((v) => v.batch).map((v) => ({
    id: v.key,
    model: v.model,
    system,
    user,
    effort: v.effort,
    maxTokens: spec.maxTokens,
    ...(spec.webSearch ? { webSearch: spec.webSearch } : {}),
  })),
  { log, pollMs: 15_000, maxWaitMs: 3 * 3_600_000 },
);
const batchMs = Date.now() - t0;
console.log(`batch (B + C): done in ${Math.round(batchMs / 1000)}s`);
for (const r of batched) {
  const v = VARIANTS.find((x) => x.key === r.id);
  if (!v) continue;
  if (r.ok) outputs.set(v.name, { text: r.text, usage: r.usage, ms: batchMs });
  else console.log(`${v.name}: FAILED — ${r.error}`);
}

console.log("\n| Variant | Agent cost | vs A | Searches | Tokens in/out | Score | Passed | Wait |");
console.log("|---|---|---|---|---|---|---|---|");
const base = outputs.get(a.name)?.usage.costUsd ?? 0;
let judgeUsd = 0;
for (const v of VARIANTS) {
  const o = outputs.get(v.name);
  if (!o) continue;
  const output = { text: o.text };
  const checks = runChecks({ output, acceptance: c.acceptance });
  const { verdict, usage } = await judgeOutput(
    { llm, judgeModel: env.LLM_MODEL_JUDGE },
    {
      instructions: c.instructions,
      acceptance: c.acceptance,
      output,
      input: request.input.text ?? "",
    },
  );
  judgeUsd += usage.costUsd;
  const passed = checks.length === 0 && verdict.passed && verdict.score >= 70;
  const saving = base > 0 ? `${Math.round((1 - o.usage.costUsd / base) * 100)}% less` : "—";
  console.log(
    `| ${v.name} | $${o.usage.costUsd.toFixed(3)} | ${v === a ? "baseline" : saving} | ${o.usage.webSearches ?? 0} | ${o.usage.inputTokens + o.usage.cacheReadTokens + o.usage.cacheWriteTokens}/${o.usage.outputTokens} | ${verdict.score} | ${passed ? "yes" : `no${checks.length ? ` (${checks.map((x) => x.code).join(",")})` : ""}`} | ${Math.round(o.ms / 1000)}s |`,
  );
}
console.log(`\nJudge cost (Kazi's side, all variants): $${judgeUsd.toFixed(3)}`);
