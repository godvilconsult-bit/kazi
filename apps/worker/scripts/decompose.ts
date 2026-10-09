/**
 * Dev tool: run the router's decomposition step against the real Claude API and print the plan.
 *   pnpm -F @kazi/worker decompose "<title>" "<description>"
 * Spends real API credit (one call, usually a few cents).
 */
import { pino } from "pino";
import { z } from "zod";
import { loadEnv, llmEnvSchema } from "@kazi/config";
import { CAPABILITY_DEFINITIONS } from "@kazi/shared";
import { AnthropicLlm } from "../src/llm";
import { decompose } from "../src/router/decompose";
import { llmModelsEnvSchema } from "../src/env";

const env = loadEnv(
  llmEnvSchema.extend(llmModelsEnvSchema.shape).extend({ NODE_ENV: z.string().optional() }),
);
const [title, description] = process.argv.slice(2);
if (!title || !description) {
  console.error('usage: decompose "<title>" "<description>"');
  process.exit(1);
}

const log = pino({ level: "info" });
const llm = new AnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY, log });
const now = new Date();
const { plan, usage } = await decompose(
  { llm, model: env.LLM_MODEL_ROUTER, capabilities: CAPABILITY_DEFINITIONS },
  { title, description, attachments: [], deadline: new Date(now.getTime() + 3 * 86_400_000), now },
);
console.log(JSON.stringify(plan, null, 2));
console.log(
  `\nmodel ${usage.model}: ${usage.inputTokens} in / ${usage.outputTokens} out → $${usage.costUsd.toFixed(4)}`,
);
