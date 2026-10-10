import { pino } from "pino";
import { z } from "zod";
import { loadEnv, llmEnvSchema } from "@kazi/config";
import { AnthropicLlm, createE2eMockLlm } from "@kazi/worker/llm";
import { buildHouseAgents } from "./agents";
import { createHouseServer } from "./server";

const env = loadEnv(
  llmEnvSchema.extend({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOUSE_AGENTS_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
    HOUSE_AGENTS_BASE_URL: z.url().default("http://localhost:4100"),
    HOUSE_AGENTS_SECRET: z.string().min(32, "must be at least 32 characters"),
    LLM_MODEL_AGENT: z.string().min(1).default("claude-opus-5-5"),
    /** Browser e2e only: a deterministic stand-in for Claude. */
    KAZI_LLM_MOCK: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["e2e"]).optional()),
  }),
);
if (env.KAZI_LLM_MOCK && env.NODE_ENV === "production") throw new Error("KAZI_LLM_MOCK is not allowed in production");
const log = pino({
  level: "info",
  ...(env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
});

const agents = buildHouseAgents({
  llm: env.KAZI_LLM_MOCK
    ? createE2eMockLlm()
    : new AnthropicLlm({
        apiKey: env.ANTHROPIC_API_KEY,
        log: log.child({ component: "llm" }),
        timeoutMs: 15 * 60_000,
      }),
  model: env.LLM_MODEL_AGENT,
  baseUrl: env.HOUSE_AGENTS_BASE_URL,
  masterSecret: env.HOUSE_AGENTS_SECRET,
  onError: (err, slug) => log.error({ err, slug }, "house agent error"),
});
const server = createHouseServer(agents);
server.listen(env.HOUSE_AGENTS_PORT, () =>
  log.info({ port: env.HOUSE_AGENTS_PORT, agents: [...agents.keys()] }, "house agents listening"),
);

const shutdown = async () => {
  server.close();
  await Promise.all([...agents.values()].map((a) => a.idle()));
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
