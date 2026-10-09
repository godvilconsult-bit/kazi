# 10 — Build Plan (paste prompts into Claude Code one phase at a time)

Rules for you (the human):
- Paste **one prompt**, let Claude Code finish, run the tests yourself, read the summary, commit. Then the next.
- If something looks wrong, say so before moving on. Small corrections early save days later.
- Phases 0–4 = working MVP on testnet. Don't skip ahead to the token.

---

## Phase 0 — Verify Arc facts & scaffold

```
Read CLAUDE.md and all files in docs/. Then:
1. Fetch the official Arc docs (https://docs.arc.network and linked pages) and write docs/00-ARC-FACTS.md with: mainnet + testnet chain IDs, RPC URLs, explorer URLs, USDC contract addresses and their ERC-20 decimals(), native gas decimals, whether USDC supports EIP-2612 permit or EIP-3009, faucet info, and the current status of Circle Gateway / x402 / Agent Stack on Arc. Cite the URL for each fact. Mark anything you couldn't confirm as UNVERIFIED.
2. Scaffold the monorepo exactly as in CLAUDE.md: pnpm workspaces, Turborepo, TypeScript strict base config, ESLint + Prettier, Vitest, docker-compose with Postgres 16 and Redis, .env.example from docs/04-BACKEND-API.md §7, and packages/config with a Zod-validated env + chain config (values from docs/00-ARC-FACTS.md, never hardcoded elsewhere).
3. Add root scripts: dev, test, lint, typecheck, db:migrate, db:seed.
4. Add a GitHub Actions CI workflow running lint, typecheck, tests.
Stop and summarize. Do not write contracts yet.
```

## Phase 1 — Smart contracts

```
Implement packages/contracts per docs/03-SMART-CONTRACTS.md using Foundry and OpenZeppelin v5:
KaziToken, AgentRegistry (with payout change delay), StakingVault (provider bonds + holder staking with USDC rewards), FeeDistributor, TaskEscrow (EIP-712 signed quotes, milestones, disputes, refundExpired that works even when paused), and MockUSDC with configurable decimals.
Write unit, fuzz (decimals 6 and 18) and invariant tests listed in the doc. Reach 100% line coverage on TaskEscrow and StakingVault (show forge coverage output). Run slither if available and fix or justify findings.
Write script/Deploy.s.sol that deploys, wires, grants roles per the doc, and writes addresses to packages/config/deployments/<network>.json.
Generate typed ABIs into packages/shared via @wagmi/cli Foundry plugin.
Stop and summarize, listing any design decisions you had to make that aren't in the doc (and update the doc).
```

## Phase 2 — Database, API skeleton, auth, indexer

```
Implement packages/db with the Prisma schema from docs/04-BACKEND-API.md §2 (adjust only if needed and update the doc), migrations, and a seed that creates an admin user, 2 house agent providers and sample capabilities.
Implement packages/shared: Zod schemas for every API payload, capability registry (docs/05-AGENT-SPEC.md §2), and task/subtask state machines with transition tables + tests (docs/02-ARCHITECTURE.md §5).
Implement apps/api (Fastify): SIWE auth with JWT + refresh rotation, roles, error format, rate limiting, presigned uploads (S3-compatible: Supabase Storage, private bucket `kazi-files` in the repurposed former-PRIVEX project — see docs/02-ARCHITECTURE.md §7), and the Tasks + Providers endpoints that don't need the router yet.
Implement apps/worker with BullMQ setup and the chain indexer (docs/04-BACKEND-API.md §4) against local anvil with deployed contracts, including a reconciliation job comparing escrow USDC balance to DB expectations.
Tests: API integration tests with a test DB; indexer test that funds a task on anvil and sees status FUNDED.
Stop and summarize.
```

## Phase 3 — Router, executor, evaluator, agent SDK, first house agents

```
Implement per docs/06-ROUTER.md and docs/05-AGENT-SPEC.md:
1. apps/worker/src/llm/: Anthropic client wrapper (models from env, timeouts, retries, Zod-validated structured output, token+cost logging per task). Provide a deterministic mock LLM for tests.
2. Router: decompose (with prompts in router/prompts/), match scoring, bigint pricing with gross-up, EIP-712 quote signing, quote expiry.
3. Executor: DAG dispatch, HMAC-signed requests, sync + async modes, callbacks endpoint in apps/api, retries/reassign, human offers.
4. Evaluator: deterministic checks incl. prompt-injection patterns, LLM judge, scoring threshold, feedback to retries.
5. Payout worker: release/refund with onchain-state check first, nonce management.
6. packages/agent-sdk: createKaziAgent, signature verify, idempotency, ctx.progress/complete/fail, plus `kazi-agent dev` mock CLI and examples/echo-agent.
7. packages/house-agents: implement 3 first: translator-en-sw, business-plan-writer, market-research, each with 5 golden tests.
End-to-end test on local stack: create task → quote → fund (anvil) → agents complete → evaluator passes → client approves → milestones released → provider USDC balance increased and fee reached FeeDistributor.
Stop and summarize, including LLM cost per test task.
```

## Phase 4 — Web app MVP

```
Build apps/web per docs/07-FRONTEND.md: wagmi/viem Arc chain from packages/config, SIWE login, landing page, agent directory and profile, task composer, quote page with fund flow (exact USDC approve + createAndFund with tx stepper), live task timeline via SSE, deliverables viewer with sanitized markdown, approve/revision/dispute, rating, task list, receipt + invoice PDF.
Provider wizard (register, bond $KAZI — hide behind a feature flag until token launch; in MVP use admin-approved house/allowlisted agents with a mock bond on testnet), provider dashboard, freelancer offers.
Admin pages: provider review, disputes, queues, reconciliation.
English + Swahili via next-intl. Mobile-first. Use the frontend-design guidance for a distinctive look, not a template.
Playwright e2e of the full happy path on local stack.
Stop and summarize, with screenshots if possible.
```

**→ Deploy to Arc testnet now. Invite 10–20 real users and 3–5 outside agent developers. Fix what breaks. Only then continue.**

## Phase 5 — Remaining house agents, freelancer flow polish, x402 API

```
1. Implement the remaining 7 house agents from docs/06-ROUTER.md §7 with golden tests. tz-tax-draft must always add a human.review subtask.
2. Polish human freelancer flow: notifications (email + in-app), offer widening, deadlines.
3. Public programmatic API: let external apps/agents create and pay for tasks. Check docs/00-ARC-FACTS.md for x402/Gateway support on Arc; if supported, implement x402 payment for a "quick task" endpoint; if not, implement API-key + prepaid USDC escrow and leave an adapter interface for x402.
4. Reputation recompute job + history charts.
Stop and summarize.
```

## Phase 6 — Token launch readiness

```
Per docs/08-TOKENOMICS.md: VestingWallet deployments for team and airdrop, points program (backend + /points page) weighting by USDC fees paid with sybil heuristics, airdrop Merkle distributor contract + claim page, /stake page (stake, cooldown, claim USDC rewards, realized APR only), /token metrics page, provider bond flow switched from mock to real.
Enable FeeDistributor staker share. Add geo-restriction hooks for staking/sale UI (configurable country list).
Tests for vesting, Merkle claims, staking UI flows.
Stop and summarize. Do NOT deploy to mainnet; I will do that after audit and legal review.
```

## Phase 7 — Mainnet hardening

```
1. Create docs/runbooks/: deploy, key compromise, pause, dispute handling, incident response, post-mortem template.
2. Production config: KMS signer adapter for viem, Sentry, structured logs, metrics + alerts (escrow reconciliation mismatch, large releases, role changes, queue backlog, LLM cost spikes).
3. Deposit caps and allowlisted providers config for guarded launch.
4. Security review pass: run slither/aderyn, review all access control, write an audit-prep README for auditors (scope, invariants, known issues).
5. Load test the API and worker (k6) with 500 concurrent tasks using mock agents.
Stop and summarize remaining risks before mainnet.
```

## Phase 8 — Growth (later)

- M-Pesa → USDC on-ramp via a licensed partner
- Expo mobile app
- Enterprise accounts (teams, spending limits, monthly invoices)
- Agent-to-agent subcontracting
- Governance voting
- Python agent SDK
- Onchain reputation Merkle roots / ERC-8004 identity alignment

---

## Rough timeline (solo founder + Claude Code)

| Phase | Time |
|---|---|
| 0–1 | 1–2 weeks |
| 2–3 | 2–3 weeks |
| 4 | 2 weeks |
| Testnet with users | 2–4 weeks |
| 5–6 | 2–3 weeks |
| Audit + legal | 3–6 weeks (in parallel where possible) |
| 7 + mainnet | 1–2 weeks |
