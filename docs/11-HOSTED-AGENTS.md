# 11 — Kazi-hosted agents (lower AI cost for developers)

Decided with the founder on 2026-10-09. Goal: developers who list agents on Kazi pay 50–75% less for Claude than they would running the same agent themselves, without Kazi reselling API access.

## 1. Why hosted, not a proxy

Anthropic's Commercial Terms allow using Claude "to power products and services Customer makes available to its own customers and end users" (A.1) but forbid reselling the Services without Anthropic's approval (D.4(a)), and make Kazi responsible for all activity on its account (D.5). So Kazi does **not** offer developers a discounted Claude endpoint for their own code. Instead a developer **builds the agent on Kazi** (instructions, model, tools, price) and Kazi runs it as part of its service. Self-hosted agents (05-AGENT-SPEC) are unchanged: their owners pay their own AI costs. Confirm the setup with Anthropic before launch (and ask about volume pricing).

## 2. Where the savings come from

- **Batch API**: 50% off every token, web-search content included; results usually within an hour, at most 24 h. Web search itself stays $10 per 1,000 searches.
- **Prompt caching**: Kazi's fixed rules and each agent's instructions are a stable, cached prefix (1-hour TTL); Kazi's pooled traffic keeps it warm.
- **Model choice with evidence**: the developer picks Opus 5.5, Sonnet 5.5 or Haiku 5.5; Kazi's advice run shows each model's judge score and cost on sample tasks (§5).

## 3. Speed and who pays what

The client chooses per task:
- **Economy** (default when the deadline is ≥ 48 h away): hosted steps run through the Batch API.
- **Express**: hosted steps run on the standard API.

For a hosted step with listed price `P` (the client price for that step in Economy):
```
E_econ  = estimated AI cost at batch rates      (per task, capped by the agent's token/search limits)
E_exp   = estimated AI cost at standard rates
developer nets    P − E_econ                    (same at both speeds)
Kazi AI share     E_econ (Economy) | E_exp (Express)   → added to Kazi's milestone (06-ROUTER §3)
client pays       P (Economy) | P + (E_exp − E_econ) (Express surcharge)
```
So the developer's AI cost is always the discounted batch-rate cost, and Express costs the client the extra AI spend. Kazi absorbs differences between the estimate and the actual cost (estimates are rolling averages of measured runs). A hosted agent whose price doesn't cover `E_econ` with a margin is not quoted. Self-hosted agents' prices are unaffected by speed. AI costs are computed in integer nano-USD and converted to USDC base units rounding up (USDC ≈ USD).

## 4. Running hosted steps

- The executor doesn't make an HTTP call: it enqueues `hosted.run`. The request is the same `AgentRequest` third-party agents receive, rendered into the prompt; the system prompt is Kazi's fixed rules + the developer's instructions (both cached).
- **Express**: one standard (streaming) call; result applied like a sync agent response.
- **Economy**: submitted as a batch; `hosted.poll` (repeatable) collects results, resubmits on `pause_turn`, and applies the result. Attempt time limit 24 h + 30 min, capped at the deadline; a retry with less than 26 h left runs in Express mode (Kazi absorbs the difference).
- Each run is a `HostedRun` row (mode, batch id, actual cost). Actual costs update the agent's estimates.
- The evaluator, retries and payouts are identical to self-hosted agents.

## 5. Advice run (developer picks the model, Kazi advises)

`POST /providers/:id/advise` runs the agent on its sample tasks (developer-provided, or Kazi's defaults for the capability) with each eligible model, judges every output, and stores per model: average score, pass rate, and cost per task in Economy and Express. It also seeds the cost estimates for the chosen model. Web search requires Opus or Sonnet. Advice runs cost Kazi money, so they are rate-limited.

## 6. Limits and safety

- Hosted agents are prompt + Kazi tools only (no custom code) in v1.
- Instructions are reviewed (advice run + admin activation) because Kazi is responsible for usage on its account. Client input and agent output stay untrusted (CLAUDE.md rule 7).
- Per-task caps: `maxOutputTokens` and `webSearch.maxUses` bound the worst-case cost.
