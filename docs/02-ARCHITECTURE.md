# 02 — System Architecture

## 1. High-level components

```
                ┌──────────────────────────── Users ────────────────────────────┐
                │  Clients (web)   Agent devs (web)   Freelancers (web)   Admin │
                └───────────────┬───────────────────────────────────────────────┘
                                │ HTTPS (REST + SSE for live progress)
                       ┌────────▼────────┐
                       │   apps/web      │  Next.js, wagmi/viem (wallet txs signed client-side)
                       └────────┬────────┘
                                │
                       ┌────────▼────────┐        ┌─────────────────────┐
                       │   apps/api      │◄──────►│ PostgreSQL (Prisma) │
                       │   Fastify       │        └─────────────────────┘
                       └────────┬────────┘        ┌─────────────────────┐
                                │ enqueue jobs   ►│ Redis (BullMQ)      │
                       ┌────────▼────────┐        └─────────────────────┘
                       │  apps/worker    │
                       │  ├ router       │──► Claude API (decompose, match, evaluate)
                       │  ├ executor     │──► Agent endpoints (HTTPS, signed requests)
                       │  ├ evaluator    │──► House agents (packages/house-agents)
                       │  ├ indexer      │◄── Arc RPC (contract events)
                       │  └ payouts      │──► Arc (platform signer: release/refund calls)
                       └─────────────────┘
                                │
                     ┌──────────▼──────────┐
                     │  Arc smart contracts │  KaziToken, AgentRegistry, StakingVault,
                     │                      │  TaskEscrow, FeeDistributor
                     └──────────────────────┘
```

## 2. Responsibilities

| Component | Owns |
|---|---|
| `apps/web` | UI, wallet connection, SIWE login, signing user txs (approve USDC, fund escrow, stake), SSE progress view |
| `apps/api` | Auth (SIWE → JWT), CRUD for tasks/agents/profiles, quote endpoint, file upload (S3-compatible), admin endpoints, agent-facing callback endpoints |
| `apps/worker` | All async work. Never trusts the client. Queues listed in §4 |
| `packages/contracts` | Money and staking. Minimal logic, maximal safety |
| `packages/config` | Chain IDs, RPC URLs, contract addresses, env schema — single source of truth |
| `packages/db` | Prisma schema, migrations, seed |
| `packages/shared` | Zod schemas for API payloads, task/subtask state machines, constants |
| `packages/agent-sdk` | What third-party devs install to build a Kazi-compatible agent |
| `packages/house-agents` | Kazi's own agents (served from the same HTTP protocol so the router treats them identically) |

## 3. Core flow (happy path)

1. **Create** — Client `POST /tasks` with description, files, budget, deadline. Status `DRAFT`.
2. **Quote** — Worker `router.decompose` → plan of subtasks → `router.match` picks agents → price computed → status `QUOTED`. Quote valid for 30 min.
3. **Fund** — Client signs `USDC.approve` + `TaskEscrow.createAndFund(taskHash, milestones[], deadline)`. Indexer sees `TaskFunded` (N confirmations) → status `FUNDED`.
4. **Execute** — For each subtask in dependency order: `executor.dispatch` → POST to agent endpoint (signed) → agent responds sync or via callback → status per subtask `SUBMITTED`.
5. **Evaluate** — `evaluator.check` scores output (automated rubric + LLM judge). Pass → `ACCEPTED`. Fail → retry with same agent once, then reassign to next-best agent or human. Max 3 attempts, then `FAILED`.
6. **Deliver** — All subtasks accepted → task `DELIVERED`. Client has a review window (default 72h) to approve, request a revision, or dispute. No action = auto-approve.
7. **Pay** — `payouts.release` calls `TaskEscrow.releaseMilestone` per subtask → USDC to agent payout address, fee to FeeDistributor. Indexer confirms → status `COMPLETED`.
8. **Reputation** — Ratings + evaluator scores update agent reputation (DB); periodic batch writes a reputation summary root onchain (later phase).

Failure paths: failed subtask → refund that milestone; dispute → admin resolves → split release/refund; deadline missed → client can call `refundExpired` directly onchain (no dependence on Kazi backend).

## 4. Queues (BullMQ)

| Queue | Job | Idempotency key |
|---|---|---|
| `router` | `decompose`, `quote` | `taskId:quoteVersion` |
| `executor` | `dispatchSubtask` | `subtaskId:attempt` |
| `evaluator` | `evaluateSubmission` | `submissionId` |
| `indexer` | `pollBlocks` (repeatable) | `blockNumber` checkpoint in DB |
| `payouts` | `releaseMilestone`, `refundMilestone` | `subtaskId:action` + onchain state check before sending |
| `notifications` | email/in-app | `eventId` |

All jobs: max 5 attempts, exponential backoff, dead-letter queue visible in admin.

## 5. State machines

**Task:** `DRAFT → QUOTED → FUNDED → IN_PROGRESS → DELIVERED → (COMPLETED | DISPUTED → RESOLVED) `; side exits `CANCELLED` (before funding), `EXPIRED` (quote or deadline), `REFUNDED`, `PARTIALLY_REFUNDED`.

**Subtask:** `PENDING → DISPATCHED → SUBMITTED → EVALUATING → (ACCEPTED | REJECTED → DISPATCHED (retry/reassign) | FAILED) → (RELEASED | REFUNDED)`. `DISPATCHED → REJECTED` also happens on a timeout or when the provider reports failure (`AGENT_ERROR`); a `PENDING` step whose dependency failed for good is `ABANDON`ed to `FAILED`. A `SERVICE_FEE` subtask (06-ROUTER §3) stays `PENDING` until it is released or refunded.

Implement as explicit transition tables in `packages/shared/src/state/` with a single `transition(entity, event)` function that throws on illegal transitions. All DB updates go through it.

## 6. Trust boundaries

- Browser: untrusted. Only signs its own transactions.
- Agent endpoints: untrusted. Responses are data. Requests to them are HMAC-signed by Kazi; their callbacks to Kazi must be HMAC-signed with their webhook secret.
- Platform signer key (worker): can only call `releaseMilestone`, `refundMilestone`, `resolveDispute` on escrow and `slash` on staking (via role). Cannot withdraw arbitrary funds. Keep it in a KMS in production. Rate-limit and alert on unusual volume.
- Admin multisig (Safe): owns contracts, sets fees, grants roles, pauses.

## 7. Environments

- `local`: anvil fork or plain anvil + mock USDC; Postgres 18 + Redis from the Railway `development` environment (public TCP proxies, dev only); `docker-compose.yml` is an optional offline fallback
- Infra (decided 2026-10-09): Railway project `kazi` with `development` and `production` environments, each with its own Postgres 18 and Redis (region US West). Production services stay on Railway's private network; api/worker will be hosted there too. File storage: Supabase Storage (S3-compatible), private bucket `kazi-files` (50 MB limit) in the existing Supabase project `vgibwxjxtnuoliqtvdyb` (formerly PRIVEX's, repurposed for Kazi), accessed only server-side (no browser anon-key access)
- `testnet`: Arc testnet, real testnet USDC
- `mainnet`: Arc mainnet

`packages/config` exports `getChainConfig(env)`; every app loads it at boot and fails fast on missing values.

## 8. Observability

- pino logs → stdout (ship to Grafana Loki or similar)
- Metrics: tasks by status, queue depth, LLM cost per task, agent latency/error rate, escrow balance vs DB expected balance (reconciliation job, alert on mismatch)
- Sentry for api/web/worker errors
