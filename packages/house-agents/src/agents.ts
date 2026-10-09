import { readFileSync } from "node:fs";
import {
  createKaziAgent,
  type AgentManifest,
  type CapabilityHandler,
  type KaziAgent,
} from "@kazi/agent-sdk";
import { deriveHouseAgentSecret } from "@kazi/config/secrets";
import { HOUSE_AGENT_LISTINGS, renderAgentTask, type HouseAgentListing } from "@kazi/shared";
import { LlmError, type Effort, type LlmClient } from "@kazi/worker/llm";

/**
 * Kazi's house agents (docs/06-ROUTER.md §7). They speak exactly the public agent protocol via
 * @kazi/agent-sdk, so the router treats them like any third-party agent.
 */

interface AgentSpec {
  promptFile: string;
  effort: Effort;
  maxTokens: number;
  webSearch?: { maxUses: number };
}

const SPECS: Record<string, AgentSpec> = {
  "house-translator-en-sw": {
    promptFile: "translator/prompt.md",
    effort: "medium",
    maxTokens: 64_000,
  },
  "house-business-plan-writer": {
    promptFile: "business-plan/prompt.md",
    effort: "high",
    maxTokens: 64_000,
  },
  "house-market-research": {
    promptFile: "market-research/prompt.md",
    effort: "high",
    maxTokens: 64_000,
    webSearch: { maxUses: 8 },
  },
};

export interface HouseAgentsDeps {
  llm: LlmClient;
  model: string;
  /** Public base URL of this service, e.g. https://agents.kazi.app (endpoint = base/slug/run). */
  baseUrl: string;
  /** HOUSE_AGENTS_SECRET; each agent's webhook secret is derived from it per slug. */
  masterSecret: string;
  fetch?: typeof fetch;
  onError?: (err: unknown, slug: string) => void;
}

export function manifestFor(listing: HouseAgentListing, baseUrl: string): AgentManifest {
  return {
    schemaVersion: "1.0",
    name: listing.name,
    description: listing.description,
    version: "1.0.0",
    endpoint: `${baseUrl.replace(/\/$/, "")}/${listing.slug}/run`,
    capabilities: [...listing.capabilities],
    languages: [...listing.languages],
    pricing: { ...listing.pricing },
    limits: { maxInputBytes: 5_000_000, timeoutSec: listing.timeoutSec, concurrency: 10 },
    mode: listing.mode,
    contact: "agents@kazi.app",
  };
}

/** Kept for existing callers; the shared renderer is the single source. */
export const renderTask = renderAgentTask;

export function buildHouseAgents(deps: HouseAgentsDeps): Map<string, KaziAgent> {
  const agents = new Map<string, KaziAgent>();
  for (const listing of HOUSE_AGENT_LISTINGS) {
    const spec = SPECS[listing.slug];
    if (!spec) throw new Error(`no spec for house agent ${listing.slug}`);
    const system = readFileSync(new URL(`./${spec.promptFile}`, import.meta.url), "utf8");

    const handler: CapabilityHandler = async (ctx) => {
      await ctx.progress(0.1, "Working on it");
      try {
        const { text, usage } = await deps.llm.text({
          purpose: "agent",
          model: deps.model,
          system,
          user: renderTask(ctx.request),
          effort: spec.effort,
          maxTokens: spec.maxTokens,
          ...(spec.webSearch ? { webSearch: spec.webSearch } : {}),
          subtaskId: ctx.request.subtaskId,
        });
        return {
          text,
          meta: {
            agent: listing.slug,
            model: usage.model,
            words: text.split(/\s+/).filter(Boolean).length,
          },
        };
      } catch (err) {
        if (err instanceof LlmError && err.code === "REFUSED")
          ctx.fail("DECLINED", "This request can't be completed.");
        if (err instanceof LlmError && err.code === "TRUNCATED")
          ctx.fail("OUTPUT_TOO_LONG", "The result exceeded the length limit.");
        throw err;
      }
    };

    agents.set(
      listing.slug,
      createKaziAgent({
        manifest: manifestFor(listing, deps.baseUrl),
        secret: deriveHouseAgentSecret(deps.masterSecret, listing.slug),
        handlers: Object.fromEntries(listing.capabilities.map((c) => [c, handler])),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        onError: (err) => deps.onError?.(err, listing.slug),
      }),
    );
  }
  return agents;
}
