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
import type { AgentContext, AgentRequest } from "@kazi/agent-sdk";
import { applyPlan, cleaningPlanSchema, parseCsv, toCsv } from "./csv-cleaner/clean";

/**
 * Kazi's house agents (docs/06-ROUTER.md §7). They speak exactly the public agent protocol via
 * @kazi/agent-sdk, so the router treats them like any third-party agent.
 */

interface AgentSpec {
  promptFile: string;
  effort: Effort;
  maxTokens: number;
  webSearch?: { maxUses: number };
  /** Added by code (not left to the model): disclaimers that must always be present. */
  prefix?: string;
  suffix?: string;
  /** Custom pipeline instead of a single text call. */
  kind?: "csv";
}

const NOT_AN_AUDIT =
  "> **Security pre-review — not an audit.** This automated first pass can miss issues. Have the contracts professionally audited before deploying with real funds.\n\n";
const TAX_DRAFT =
  "\n\n> **Draft only.** A licensed Tanzanian tax practitioner must review these workings before anything is filed with TRA.";

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
  "house-pitch-outline": { promptFile: "pitch-outline/prompt.md", effort: "medium", maxTokens: 32_000 },
  "house-social-pack": { promptFile: "social-pack/prompt.md", effort: "medium", maxTokens: 16_000 },
  "house-statement-reviewer": { promptFile: "statement-reviewer/prompt.md", effort: "high", maxTokens: 64_000 },
  "house-bookkeeping-draft": { promptFile: "bookkeeping-draft/prompt.md", effort: "high", maxTokens: 64_000 },
  "house-tz-tax-draft": {
    promptFile: "tz-tax-draft/prompt.md",
    effort: "high",
    maxTokens: 64_000,
    webSearch: { maxUses: 5 },
    suffix: TAX_DRAFT,
  },
  "house-solidity-prereview": {
    promptFile: "solidity-prereview/prompt.md",
    effort: "high",
    maxTokens: 64_000,
    prefix: NOT_AN_AUDIT,
  },
  "house-csv-cleaner": { promptFile: "csv-cleaner/prompt.md", effort: "medium", maxTokens: 8_000, kind: "csv" },
};

/** CSV input: the request text, or the first CSV-like file (fetched with a size cap). */
const MAX_CSV_BYTES = 2_000_000;
async function readCsvInput(req: AgentRequest, doFetch: typeof fetch): Promise<string> {
  const file = (req.input.files ?? []).find((f) => /csv|text\/plain|excel/i.test(f.mime)) ?? req.input.files?.[0];
  if (file) {
    const res = await doFetch(file.url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`could not download the CSV (HTTP ${res.status})`);
    const body = await res.text();
    if (body.length > MAX_CSV_BYTES) throw new Error("the CSV is larger than 2 MB");
    return body;
  }
  return req.input.text ?? "";
}

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
      if (spec.kind === "csv") return cleanCsv(ctx, deps, system, spec, listing.slug);
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
        const final = `${spec.prefix ?? ""}${text}${spec.suffix ?? ""}`;
        return {
          text: final,
          meta: {
            agent: listing.slug,
            model: usage.model,
            words: final.split(/\s+/).filter(Boolean).length,
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

/** Claude plans the cleaning from the header and a sample; code applies it to every row. */
async function cleanCsv(ctx: AgentContext, deps: HouseAgentsDeps, system: string, spec: AgentSpec, slug: string) {
  const raw = await readCsvInput(ctx.request, deps.fetch ?? globalThis.fetch).catch((err: unknown) =>
    ctx.fail("INPUT_UNREADABLE", err instanceof Error ? err.message : "the CSV could not be read"),
  );
  const { rows } = parseCsv(raw);
  const [header, ...body] = rows;
  if (!header || header.length === 0 || body.length === 0) ctx.fail("INPUT_UNREADABLE", "no CSV rows found in the input");
  if (body.length > 50_000) ctx.fail("INPUT_TOO_LARGE", "the CSV has more than 50,000 rows");
  const sample = toCsv([header, ...body.slice(0, 25)]);
  const { data: plan, usage } = await deps.llm.structured({
    purpose: "agent",
    model: deps.model,
    system,
    user: `<task>\n## Client instructions\n${ctx.request.instructions}\n\n## Header and first rows\n${sample}\n</task>`,
    schema: cleaningPlanSchema,
    effort: spec.effort,
    maxTokens: spec.maxTokens,
    subtaskId: ctx.request.subtaskId,
  });
  await ctx.progress(0.6, "Cleaning rows");
  const result = applyPlan(header, body, plan);
  const invalidLines = Object.entries(result.invalid).map(([col, n]) => `- \`${col}\`: ${n} value(s) could not be converted and were kept as-is`);
  const text = [
    "# Cleaned CSV",
    "",
    `Rows in: **${result.rowsIn}** · rows out: **${result.rowsOut}** · duplicates removed: ${result.duplicatesRemoved} · empty rows removed: ${result.emptyRemoved}`,
    "",
    "## Column mapping",
    "",
    "| Source | Clean column | Type |",
    "|---|---|---|",
    ...plan.columns.map((c) => `| ${c.source.replace(/\|/g, "\\|")} | ${c.type === "drop" ? "*(dropped)*" : c.target} | ${c.type}${c.dateFormat ? ` (${c.dateFormat})` : ""} |`),
    ...(invalidLines.length ? ["", "## Values to check", "", ...invalidLines] : []),
    ...(plan.notes.length ? ["", "## Notes", "", ...plan.notes.map((n) => `- ${n}`)] : []),
    "",
    "## Data",
    "",
    "```csv",
    toCsv(result.rows),
    "```",
  ].join("\n");
  return { text, meta: { agent: slug, model: usage.model, rowsIn: result.rowsIn, rowsOut: result.rowsOut } };
}
