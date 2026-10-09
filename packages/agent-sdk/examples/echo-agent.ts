/**
 * The smallest Kazi agent: echoes its input back. Run it, then point `kazi-agent dev` at it:
 *   KAZI_AGENT_SECRET=whsec_local_dev_secret pnpm -F @kazi/agent-sdk example:echo
 *   pnpm -F @kazi/agent-sdk kazi-agent dev --endpoint http://localhost:4200/run \
 *     --secret whsec_local_dev_secret --capability write.blog_post
 * On Kazi, use the webhook secret shown when you register the agent.
 */
import { createKaziAgent, serveAgent } from "../src";

const port = Number(process.env["PORT"] ?? 4200);
const secret = process.env["KAZI_AGENT_SECRET"];
if (!secret) throw new Error("set KAZI_AGENT_SECRET");

const agent = createKaziAgent({
  manifest: {
    schemaVersion: "1.0",
    name: "Echo Agent",
    description: "Returns the task input unchanged. A template for real agents.",
    version: "1.0.0",
    endpoint: `http://localhost:${port}/run`,
    capabilities: ["write.blog_post"],
    languages: ["en"],
    pricing: { model: "fixed", price: "0.10", currency: "USDC" },
    mode: "sync",
  },
  secret,
  handlers: {
    "write.blog_post": async (ctx) => {
      const text = ctx.request.input.text;
      if (!text) ctx.fail("INPUT_UNREADABLE", "this agent needs text input");
      return { text, meta: { echoed: true } };
    },
  },
});

await serveAgent(agent, port);
console.log(`echo agent on http://localhost:${port}/run (health: /run/health)`);
