# Incident response

## Severity

| Level | Examples | Response |
|---|---|---|
| **SEV1** | Funds at risk or lost; contract exploit; key compromise; reconciliation mismatch you can't explain | Page on-call now, all hands, pause first ([pause.md](pause.md)), status page within 15 min, updates every 30 min |
| **SEV2** | Payments stuck (funded tasks not progressing, releases failing), API/web down, indexer stalled > 15 min, data exposure of one user | On-call within 30 min, status page within 1 h, updates hourly |
| **SEV3** | One agent failing, slow quotes, LLM provider degraded, a broken page | Next business day; ticket |

When unsure, pick the higher level; downgrading is free.

## Roles

- **Incident lead** — decides, delegates, keeps the timeline. Not the person debugging.
- **Operator** — hands on keyboard (logs, queries, transactions).
- **Comms** — status page and user messages. For SEV1 with one person on call, the lead does comms.

## First 15 minutes

1. Acknowledge the alert; open an incident doc (copy [post-mortem-template.md](post-mortem-template.md); fill the timeline as you go).
2. Assess money risk first: Admin → Reconciliation (escrow balance vs expected), Admin → Queues (stuck payouts), explorer for the escrow's recent transactions.
3. Contain: pause the escrow if funds may be at risk; revoke a role if a key is suspect ([key-compromise.md](key-compromise.md)); disable a broken provider (Admin → suspend) or the router (`ROUTER_DISABLED=true` stops new quotes; funded work continues).
4. Communicate (templates below).

## Where to look

| Symptom | Check |
|---|---|
| Tasks stuck in FUNDED / IN_PROGRESS | Admin → Queues (`executor`, `payouts` waiting/failed); worker logs filtered by `taskId`; provider endpoint health |
| Task paid onchain but not FUNDED in the app | Indexer lag: worker logs `component: "indexer"`, `IndexerCursor` vs chain head, RPC health |
| Releases failing | Operator gas (`OPERATOR_GAS_LOW`), `paused()`, the payout address blocklisted by USDC (refund path, see docs/03 §8) |
| Quotes failing | Anthropic status, `LLM_COST_SPIKE`, `QUOTE_DAILY_LIMIT`, `ROUTER_DISABLED` |
| Reconciliation mismatch | Compare `TaskFunded`/`MilestoneReleased`/`MilestoneRefunded` ChainEvents with DB subtask states for the window; an unindexed block range (reorg, RPC gap) is the most common benign cause — re-index from the cursor before assuming theft |
| Errors spike | Sentry (grouped by release), `/metrics` error rates |

Logs are structured (pino JSON): filter by `taskId`, `subtaskId`, `providerId`, `component`.

## Message templates

**Status page — investigating (SEV1, funds)**
> We're investigating an issue with payments. As a precaution, new task funding and payouts are paused. Funds already in escrow are safe in the contract, and refunds still work. Next update in 30 minutes.

**Status page — investigating (SEV2)**
> Some tasks are taking longer than usual to start/finish. Your payment is safe in escrow. We're working on it; next update in 1 hour.

**Resolved**
> Resolved at HH:MM UTC. [One sentence on what happened.] [What users need to do — usually nothing.] A full write-up follows within 5 days.

**Direct message to affected users**
> Your task "[title]" was affected by [issue] between HH:MM and HH:MM UTC. Your USDC stayed in escrow the whole time. [What we did: e.g. the step was refunded / re-run.] Sorry for the delay — reply here if anything still looks wrong.

## Cost incidents (LLM)

`LLM_COST_SPIKE` fires when hourly spend passes `ALERT_LLM_HOURLY_USD`. Check for a quote loop (same task re-quoted), an agent retry storm, or abuse (many quotes from new wallets). Levers: `ROUTER_DISABLED=true`, lower `QUOTE_DAILY_LIMIT`, suspend the hosted agent, revoke abusive API keys.

## Afterwards

SEV1/SEV2: post-mortem within 5 business days using [post-mortem-template.md](post-mortem-template.md); blameless; every action item gets an owner and a date. Update the runbook that was missing or wrong.
