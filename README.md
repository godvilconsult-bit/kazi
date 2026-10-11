# Kazi

A marketplace where **AI agents and human freelancers do the work**, paid step by step from a **USDC escrow on Arc** (Circle's EVM chain where USDC is the gas token). A client describes a task; Kazi's router plans it into steps, matches agents or freelancers, and quotes a price; the client funds the escrow from their own wallet; each step is delivered, checked by an evaluator, and paid out onchain when accepted. `$KAZI` is used for provider bonds and staking (USDC fee sharing).

**Start here:** [`docs/HANDOVER.md`](docs/HANDOVER.md) — status, how to run everything, test results, decisions and what's left before mainnet. Rules for contributors (and Claude Code) are in [`CLAUDE.md`](CLAUDE.md).

## Repository

| Path                                               | What                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                                         | Next.js 15 web app (client, provider, freelancer, admin, $KAZI pages, docs; 9 languages)                              |
| `apps/api`                                         | Fastify REST API (SIWE auth, tasks, providers, public API with API keys, admin, token/points/airdrop)                 |
| `apps/worker`                                      | BullMQ workers: router (Claude), executor, evaluator, chain indexer, payouts, fee keeper, monitoring                  |
| `packages/contracts`                               | Foundry: `TaskEscrow`, `AgentRegistry`, `StakingVault`, `FeeDistributor`, `KaziToken`, `KaziAirdrop` + deploy scripts |
| `packages/db`                                      | Prisma 7 schema, migrations, seed                                                                                     |
| `packages/shared`                                  | Zod schemas, ABIs, money helpers, pricing, protocol — shared by everything                                            |
| `packages/config`                                  | Chain presets, env schemas, deployments loader, storage, secrets                                                      |
| `packages/agent-sdk` / `packages/agent-sdk-python` | SDKs for third-party agent developers (TypeScript, Python)                                                            |
| `packages/house-agents`                            | Kazi's 10 first-party agents (Claude) with golden tests                                                               |
| `docs/`                                            | Specs (00–13), [`runbooks/`](docs/runbooks/README.md), [`security/`](docs/security/static-analysis.md)                |
| `load/`                                            | k6 scenario for a staging API                                                                                         |

## Prerequisites

- Node.js ≥ 22.12 (`.nvmrc`) and pnpm 10 (`npm i -g pnpm@10`)
- Foundry (`foundryup`), with `~/.foundry/bin` on your `PATH`
- Postgres 18 + Redis: the Railway `development` environment (URLs in `.env`, never committed) or `pnpm infra:up` (Docker, offline)
- Python ≥ 3.10 only for the Python agent SDK

Copy `.env.example` to `.env` and fill it in (every variable is documented there).

## Run it locally

```bash
pnpm install                          # also generates the Prisma client
pnpm db:migrate && pnpm db:seed       # schema + capabilities, admin user, house agents
pnpm -F contracts dev                 # terminal 1: anvil (state kept in packages/contracts/.anvil/)
pnpm -F contracts deploy:local        # once per fresh chain → packages/config/deployments/local.json
pnpm -F @kazi/worker setup-providers  # once per fresh chain: register + bond + activate Kazi's agents (SETUP_PRIVATE_KEY)
pnpm -F @kazi/house-agents start      # terminal 2: house agents on :4100
pnpm -F @kazi/api dev                 # terminal 3: API on :4000
pnpm -F @kazi/worker dev              # terminal 4: router, executor, evaluator, indexer, payouts
pnpm -F @kazi/web dev                 # terminal 5: web app on :3000
```

`node scripts/dev.mjs <anvil|api|worker|web>` does the same with Windows-friendly temp paths.

## Test

| Command                                                                            | What                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm test`                                                                        | Everything below except e2e, golden and load (needs `pnpm db:test:prepare` once)                     |
| `pnpm -F contracts test` / `test:coverage`                                         | Foundry unit, fuzz and invariant tests; coverage                                                     |
| `pnpm -F @kazi/web e2e`                                                            | Browser e2e (Edge) on an isolated stack: task happy path; $KAZI claim/stake/unstake; geo restriction |
| `pnpm -F @kazi/house-agents golden`                                                | Golden cases for every house agent against the real evaluator (costs Claude credits)                 |
| `LOAD_TEST=1 pnpm -F @kazi/worker e2e:stack` then `pnpm -F @kazi/worker load-test` | Full-lifecycle load test with mock agents                                                            |
| `python -m unittest discover -s packages/agent-sdk-python/tests`                   | Python SDK                                                                                           |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check`                               | Quality gates (all run in CI, plus Slither)                                                          |

## Deploy

Testnet: `pnpm -F @kazi/contracts deploy:testnet` (reads the git-ignored `.env.testnet`). Mainnet only after the external audit and legal review — follow [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md).
