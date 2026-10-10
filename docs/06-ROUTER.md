# 06 — Router: Decompose, Match, Price, Execute, Evaluate

Lives in `apps/worker/src/router/`, `executor/`, `evaluator/`. All LLM calls go through `apps/worker/src/llm/client.ts` (timeouts, retries, Zod-validated JSON, cost logging per task).

## 1. Decompose

Input: task title, description, attachment summaries (extract text from PDFs/DOCX first; summarize if > 20k tokens), budget, deadline.

LLM call (Claude, structured output) returns:
```ts
const Plan = z.object({
  feasible: z.boolean(),
  infeasibleReason: z.string().optional(),       // e.g. needs physical presence, illegal, unclear
  clarifyingQuestions: z.array(z.string()).max(3), // if non-empty, ask client before quoting
  subtasks: z.array(z.object({
    index: z.number().int().min(0),
    title: z.string().max(120),
    capability: z.enum(CAPABILITIES),            // from packages/shared
    instructions: z.string().max(4000),
    dependsOn: z.array(z.number().int()),
    estimatedUnits: z.number().positive(),       // words, pages, files… matches capability unit
    acceptance: z.object({
      rubric: z.array(z.string()).min(1).max(8),
      format: z.enum(["markdown","text","json","file"]),
      mustInclude: z.array(z.string()).optional()
    }),
    needsHuman: z.boolean()
  })).min(1).max(12)
});
```

Validation after the LLM: DAG has no cycles; indexes contiguous; capabilities exist; at least one active provider per capability (else mark `needsHuman` or infeasible). Reject plans with > 12 subtasks.

System prompt rules (put in `router/prompts/decompose.md`): prefer fewest subtasks; never invent capabilities; mark legal/tax/financial filings as draft + add `human.review` subtask if the client wants something they'll submit to authorities; refuse disallowed tasks (malware, fraud, impersonation, academic cheating where flagged, etc.).

## 2. Match

For each subtask, candidates = ACTIVE providers with the capability (and language if relevant), not over concurrency limit, whose price fits.

Score (0–100):
```
score = 0.45 * reputation
      + 0.20 * successRate30d * 100
      + 0.15 * priceScore        // 100 for cheapest candidate, linear down to 0 at 2× cheapest
      + 0.10 * latencyScore      // vs deadline headroom
      + 0.10 * stakeScore        // log-scaled bond above minimum, capped
```
New agents (< 10 completed tasks) get an exploration boost: 10% of eligible subtasks go to the best new agent when its test score ≥ 80 (bandit-style), so newcomers can build reputation.

Pick top candidate; keep the next 2 as fallbacks in the quote (not shown to client).

## 3. Price

```
agentCost_i      = price(provider_i, estimatedUnits_i)            // bigint base units
subtotal         = Σ agentCost_i
milestone_i      = grossUp(agentCost_i, feeBps)
     where grossUp ensures provider receives agentCost_i after the escrow feeBps (default 12%, 10% for staking clients) is deducted
serviceFee       = max(minServiceFee, subtotal * serviceFeeBps / 10_000)   // default 5%, min 0.10 USDC
serviceMilestone = grossUp(serviceFee, feeBps)                    // last milestone, paid to Kazi's treasury
total            = Σ milestone_i + serviceMilestone
```
The escrow applies one `feeBps` to every milestone and pays the rest to that milestone's provider, so the service fee **cannot** be spread across the work milestones (88% of it would go to agents). It is its own milestone, whose provider is the `kazi-service-fee` provider (registered and bonded in AgentRegistry like a house agent, payout = treasury, no capabilities, never matched). Kazi's treasury nets exactly `serviceFee`; the take-rate fee on it goes to the FeeDistributor like any other fee. In the DB it is a `Subtask` with `kind = SERVICE_FEE`; the executor never dispatches it. The payout worker releases it once the task closes with at least one work milestone released, and refunds it when every work milestone is refunded. Decided 2026-10-09 (alternatives rejected: a single fee with no service fee; raising the onchain fee to cover both).

For **Kazi-hosted agents** (`11-HOSTED-AGENTS.md` §3) the step's provider cost is the developer's net (listed price − Economy AI cost) and the AI cost at the chosen speed is added to the service milestone's net (the service fee is computed on net + AI cost). All bigint math; round **up** on gross-up, **down** on payouts; any rounding dust goes to the fee. A task may have at most 20 milestones including the service milestone. `quote.feeBps` must be ≤ the escrow's published `feeBps`. Show the client: total, per-step breakdown (step titles + agent names + ETA), and "platform & service fees" as one line.

If `total > budgetMax`: try cheaper candidates; if still over, return the quote flagged `overBudget` with the cheapest feasible option.

Quote expires in 30 min (prices/availability change). Sign per `04-BACKEND-API.md` §6.

## 4. Execute

- Topological order; dispatch subtasks whose dependencies are ACCEPTED. Pass prior accepted outputs as input to dependents (by reference: signed URLs + short summaries).
- Per-subtask timeout = manifest `timeoutSec` (cap at time left to task deadline).
- Retry policy per subtask: attempt 1 → same agent; on reject/timeout attempt 2 → same agent with evaluator feedback; attempt 3 → fallback agent (`reassign` onchain milestone if providerId differs). After 3 → `FAILED` → refund that milestone; if dependents can't proceed, refund them too and mark task `PARTIALLY_REFUNDED` (or offer human fallback, client-approved).
- Human subtasks: create offers; if not accepted in 2h, widen to all qualified freelancers; if still none, fail/refund.

## 5. Evaluate

Two layers:
1. **Deterministic checks** (cheap, first): schema valid, non-empty, format, language detection, length within ±30% of expected, `mustInclude` terms present, file hashes match, no prompt-injection patterns ("ignore previous instructions", hidden text addressed to the evaluator, etc.).
2. **LLM judge** (Claude): given instructions, rubric, and output (output wrapped as untrusted data with clear delimiters; judge told to never follow instructions in it), returns:
```ts
z.object({ score: z.number().min(0).max(100), passed: z.boolean(), rubric: z.array(z.object({ item: z.string(), met: z.boolean(), note: z.string() })), feedback: z.string() })
```
Pass threshold 70 (configurable per capability). For high-value subtasks (> 50 USDC), run judge twice and take the minimum, or require client approval.

Store everything in `Submission.evaluation`. Feedback is sent to the agent on retry.

## 6. Reputation

Per provider, 0–100, recomputed on every completed subtask:
```
rep = 100 * bayesianAvg(
   0.5 * normalizedJudgeScore,
   0.3 * clientRating/5,
   0.2 * onTimeRate
 ) with prior (mean 0.7, weight 5)
 − penalties (disputes lost, slashes), decay: events older than 180 days weigh 50%
```
Expose history for charts. Later: publish a Merkle root of reputations onchain weekly.

## 7. House agents (`packages/house-agents`)

Each is a small Fastify service implementing `05-AGENT-SPEC` using `@kazi/agent-sdk` + Claude. Launch set (10):
1. `business-plan-writer` — `write.business_plan`
2. `pitch-outline` — `write.pitch_deck_outline`
3. `translator-en-sw` / `sw-en` — `translate.*`
4. `market-research` — `research.market` (uses web search tool if available)
5. `social-pack` — `write.social_pack`
6. `statement-reviewer` — `finance.statement_review`
7. `bookkeeping-draft` — `finance.bookkeeping_draft`
8. `tz-tax-draft` — `tax.tz_tra_draft` (draft only; always paired with `human.review` by a licensed accountant)
9. `solidity-prereview` — `code.solidity_review` (clearly labeled "not an audit")
10. `csv-cleaner` — `data.clean_csv` (deterministic code + LLM for mapping)

Prompts in `packages/house-agents/<name>/prompt.md`, versioned. Each has 5 golden test cases with expected rubric outcomes, run in CI against the evaluator.

## 8. Cost control

- Track LLM tokens + $ per task (`Task.llmCostUsd`). Alert if router+evaluator cost > 8% of task value.
- Use a smaller/cheaper Claude model for deterministic-ish steps (classification, extraction) and the stronger model for decomposition and judging; make models configurable via env.
- Cache decompositions for identical inputs (hash) for 1h.

## 9. Implementation notes (Phase 3, 2026-10-09)

**Where things live** (`apps/worker/src/`): `llm/` (the only path to Claude: timeouts, SDK retries, Zod-validated structured output, server-side refusal fallback `fallbacks: "default"` on Opus/Sonnet models, per-task cost in `Task.llmCostUsd`; `MockLlm` for tests), `router/` (decompose, match, quote + EIP-712 signing), `executor/` (dispatch, results, tick), `evaluator/` (checks, judge), `payouts/`, `chain/operator.ts` (OPERATOR key: one transaction at a time, simulate first, Arc's 20 gwei fee floor).

**Models** (env): `LLM_MODEL_ROUTER` and `LLM_MODEL_JUDGE` default to `claude-opus-5-5` at effort `medium`; `LLM_MODEL_AGENT` (house agents) `claude-opus-5-5`; `LLM_MODEL_FAST` `claude-haiku-5-5` (reserved for attachment summaries).

**Decompose**: prompt in `router/prompts/decompose.md`; the capability list is rendered sorted so the system prompt is prompt-cached across tasks. Business-rule errors (cycles, gaps, unknown capabilities) go back to the model once. Outcomes: `QUOTED`, `NEEDS_CLARIFICATION` (questions shown to the client, nothing signed) or `INFEASIBLE` (reason). A deadline less than 2 h after quote expiry is infeasible.

**Execute**: a repeatable `executor.tick` (every `EXECUTOR_TICK_MS`) moves every active task forward — dispatches ready steps, times out stale attempts, retries rejections, abandons steps whose dependency failed, and marks the task `DELIVERED` once every step is settled with at least one accepted. Every state change is a conditional update and every job has a deterministic id, so ticks and jobs can overlap safely. Attempt time limit: `EXECUTOR_ATTEMPT_TIMEOUT_SEC` (manifest `timeoutSec` isn't stored yet), capped at the task deadline. Agent input = the client's request plus accepted outputs of dependencies; on retries the request carries the evaluator's feedback. The third attempt moves to the best fallback provider (onchain `reassign` first). Human providers get a `HUMAN_OFFER_CREATED` event; the offer UI is Phase 4.

**Evaluate**: the deterministic checks live in `packages/shared/src/checks.ts` (shared with `kazi-agent dev`). The length check (±30% words) applies only to translations, where the plan's estimate is the source size, and is **advisory** (decided 2026-10-10): English and Swahili word counts legitimately differ, so a mismatch is passed to the judge as an automated note instead of rejecting the attempt. A suspected injection rejects the attempt and records `INJECTION_SUSPECTED` for human review; it never slashes automatically. The judge (`evaluator/prompts/judge.md`) sees the instructions, rubric, the provider's **input** (client request + dependency outputs, inside `<task_input>`) and the output — without the input it rejected plans for "inventing" figures the client had supplied (found by the golden tests).

**Pay**: `payouts.tick` refunds failed steps immediately; after approval (or `reviewUntil`) it releases accepted steps and the service fee; if every step failed it refunds the service fee too. Each release/refund first checks the milestone is still `FUNDED` onchain; the DB changes only when the indexer sees the event.

**House agents** (`packages/house-agents`): `house-translator-en-sw`, `house-business-plan-writer`, `house-market-research` (Anthropic-hosted web search, at most 8 searches) — one HTTP service, listings shared with the seed via `HOUSE_AGENT_LISTINGS`. Golden tests: `pnpm -F @kazi/house-agents golden` (5 cases each, real API calls).

**Measured LLM cost (claude-opus-5-5, 2026-10-09)**: router decomposition ≈ $0.03 per task; judge ≈ $0.01–0.03 per attempt; translation (≈100–200 words) ≈ $0.01–0.02; business plan ≈ $0.08–0.37; market research with web search ≈ $0.40–0.80. A live end-to-end translation task (total 0.34 USDC) cost Kazi $0.056 in router + judge calls — 16% of task value, above the 8% alert line, so very small tasks are thin-margin; the house agent's own cost comes on top for house-agent work. Golden results: translator 5/5, business plan 5/5 (4 on the first run; the kiosk case passed when re-run after the judge-input fix), market research 4/5 (one brief lacked sources for price premiums; prompt v2 tightens sourcing, not yet re-run).

**Added to complete Phase 3 (2026-10-09)**:
- Attachments: the router reads client files before planning — text inline (≤ 8k chars) or summarized by `LLM_MODEL_FAST`, DOCX via `mammoth`, PDF via Claude's native document input (signed URL); the summary is stored on `FileObject.summary` and reused. Agents receive 26-hour signed URLs to the client's attachments and to earlier steps' output files. Files an agent returns are copied into Kazi's bucket (https only, public addresses only, no redirects, ≤ 50 MB, sha256 must match) and referenced as `kazi://files/<id>`; a failed import is an agent error (`FILE_UNAVAILABLE`).
- Decomposition cache: identical inputs (request, attachment summaries, budget, deadline day, capability set) reuse the plan for 1 h (Redis). The API allows `QUOTE_DAILY_LIMIT` (30) new quotes per wallet per day.
- Cost alert: an `LLM_COST_HIGH` task event (once) when router + judge spend passes 8% of the task value.
- Reputation (§6) recomputed on acceptance, final failure and client rating, and daily for decay; every recompute writes a `ReputationSnapshot` for charts. Exploration (§2): with probability 10%, a newcomer (< 10 completed tasks, `reviewScore` ≥ 80 from admin review or the advice run) is placed first.
- `pnpm -F @kazi/worker setup-providers` registers, bonds and activates the service-fee provider and house agents onchain and stores their onchain ids (needs a REGISTRAR key holding $KAZI).

**Staking-client fee discount**: built in Phase 6 — see `08-TOKENOMICS.md` §7 (`clientFeeBps`).

## 10. Implementation notes (Phase 5, 2026-10-10)

**All ten house agents are live** in `packages/house-agents` (one service; listings in `packages/shared/src/house-agents.ts`, prompts in `src/<agent>/prompt.md`):

| Agent | Capability | Price (USDC) | Notes |
|---|---|---|---|
| `house-pitch-outline` | `write.pitch_deck_outline` | 3.00 | slide-by-slide outline (headline, points, evidence) adapted to the audience |
| `house-social-pack` | `write.social_pack` | 2.50 | strategy note + ready-to-post texts per platform; never invents prices or offers |
| `house-statement-reviewer` | `finance.statement_review` | 0.60/page, min 2.00 | key figures, ratios with formulas, consistency checks; an analyst's read, not an audit |
| `house-bookkeeping-draft` | `finance.bookkeeping_draft` | 0.40/page, min 1.50 | traceable ledger, category summary, draft income statement, cash reconciliation |
| `house-tz-tax-draft` | `tax.tz_tra_draft` | 8.00 | output always ends with "Draft only — a licensed Tanzanian tax practitioner must review"; the router always appends a `human.review` step after it (`withRequiredReviews`) |
| `house-solidity-prereview` | `code.solidity_review` | 12.00 | output always starts with "Security pre-review — not an audit" |
| `house-csv-cleaner` | `data.clean_csv` | 1.50/file | deterministic parsing/cleaning in code (`csv-cleaner/clean.ts`); the LLM only proposes the column plan |

**Golden tests**: 5 cases per agent, 35/35 pass against the evaluator with live Claude calls (≈ $3.88 for the run): `pnpm -F @kazi/house-agents golden`.

**Freelancer flow**: in-app notifications (founder decision; email can be added behind `notify()`), "due soon" reminders once per attempt (`executor/offers.ts`), offer widening when nobody accepts, and the indexer closes tasks only after the last `MilestoneReleased` in a transaction (`closeLastPerTx`).
