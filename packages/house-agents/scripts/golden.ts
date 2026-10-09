/**
 * Golden tests for the house agents (docs/06-ROUTER.md §7): 5 cases per agent, each run through
 * the real agent (signed request → handler → callback) and then Kazi's evaluator (deterministic
 * checks + LLM judge). Spends real API credit, so it is not part of `pnpm test`.
 *   pnpm -F @kazi/house-agents golden [slug] [case-name-substring]
 */
import { readFileSync } from "node:fs";
import { pino } from "pino";
import { z } from "zod";
import { signPayload, type AgentRequest } from "@kazi/agent-sdk";
import { loadEnv, llmEnvSchema } from "@kazi/config";
import { deriveHouseAgentSecret } from "@kazi/config/secrets";
import {
  HOUSE_AGENT_LISTINGS,
  acceptanceSchema,
  agentCallbackSchema,
  capabilitySlugSchema,
  runChecks,
} from "@kazi/shared";
import { judgeOutput } from "@kazi/worker";
import { AnthropicLlm, addUsage, type LlmClient, type LlmUsage } from "@kazi/worker/llm";
import { buildHouseAgents } from "../src/agents";

const caseSchema = z.object({
  name: z.string(),
  capability: capabilitySlugSchema,
  instructions: z.string(),
  input: z.string(),
  acceptance: acceptanceSchema,
  expectPass: z.boolean(),
});

const env = loadEnv(
  llmEnvSchema.extend({
    LLM_MODEL_AGENT: z.string().default("claude-opus-5-5"),
    LLM_MODEL_JUDGE: z.string().default("claude-opus-5-5"),
  }),
);
const only = process.argv[2];
/** Optional: only cases whose name contains this text. */
const caseFilter = process.argv[3];
const log = pino({ level: "warn" });
const MASTER = "golden-test-master-secret-not-used-in-production";

/** Counts every call's cost. */
let total: LlmUsage | undefined;
const real = new AnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY, log, timeoutMs: 15 * 60_000 });
const llm: LlmClient = {
  structured: async (req) => {
    const r = await real.structured(req);
    total = addUsage(total, r.usage);
    return r;
  },
  text: async (req) => {
    const r = await real.text(req);
    total = addUsage(total, r.usage);
    return r;
  },
};

// Callbacks are captured in memory instead of being POSTed to Kazi.
const callbacks = new Map<string, unknown[]>();
const fakeFetch: typeof fetch = async (url, init) => {
  const id = new URL(String(url)).pathname.split("/").pop() ?? "";
  callbacks.set(id, [...(callbacks.get(id) ?? []), JSON.parse(String(init?.body))]);
  return new Response(null, { status: 200 });
};
const agents = buildHouseAgents({
  llm,
  model: env.LLM_MODEL_AGENT,
  baseUrl: "http://golden.local",
  masterSecret: MASTER,
  fetch: fakeFetch,
  onError: (err, slug) => console.error(`[${slug}]`, err),
});

let failures = 0;
for (const listing of HOUSE_AGENT_LISTINGS) {
  if (only && listing.slug !== only) continue;
  const agent = agents.get(listing.slug);
  if (!agent) throw new Error(`no agent for ${listing.slug}`);
  const cases = z
    .array(caseSchema)
    .parse(
      JSON.parse(readFileSync(new URL(`../golden/${listing.slug}.json`, import.meta.url), "utf8")),
    );
  console.log(`\n${listing.slug}`);
  for (const [i, c] of cases.entries()) {
    if (caseFilter && !c.name.includes(caseFilter)) continue;
    const before = total?.costUsd ?? 0;
    const subtaskId = `golden-${listing.slug}-${i}`;
    const request: AgentRequest = {
      subtaskId,
      attempt: 1,
      capability: c.capability,
      instructions: c.instructions,
      input: { text: c.input || "(no additional input)" },
      acceptance: c.acceptance,
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      callbackUrl: `http://kazi.local/agent/callback/${subtaskId}`,
      budget: listing.pricing.price,
    };
    const rawBody = JSON.stringify(request);
    const secret = deriveHouseAgentSecret(MASTER, listing.slug);
    await agent.handle({
      method: "POST",
      path: "/run",
      rawBody,
      headers: { "x-kazi-signature": signPayload(rawBody, secret) },
    });
    await agent.idle();

    const final = (callbacks.get(subtaskId) ?? [])
      .map((b) => agentCallbackSchema.parse(b))
      .find((b) => b.status !== "progress");
    let passed = false;
    let detail: string;
    if (final?.status === "completed") {
      const checks = runChecks({ output: final.output, acceptance: c.acceptance });
      if (checks.length > 0) {
        detail = `checks failed: ${checks.map((f) => f.code).join(", ")}`;
      } else {
        const { verdict } = await judgeOutput(
          { llm, judgeModel: env.LLM_MODEL_JUDGE },
          {
            instructions: c.instructions,
            acceptance: c.acceptance,
            output: final.output,
            input: request.input.text ?? "",
          },
        );
        passed = verdict.passed && verdict.score >= 70;
        detail = `score ${verdict.score}${passed ? "" : ` — ${verdict.feedback.slice(0, 160)}`}`;
      }
    } else {
      detail = `agent failed: ${final?.status === "failed" ? final.error.code : "no result"}`;
    }
    const ok = passed === c.expectPass;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${c.name} — ${detail} ($${((total?.costUsd ?? 0) - before).toFixed(3)})`,
    );
  }
}
console.log(
  `\nTotal LLM cost: $${(total?.costUsd ?? 0).toFixed(3)}; ${failures} unexpected result(s).`,
);
process.exitCode = failures > 0 ? 1 : 0;
