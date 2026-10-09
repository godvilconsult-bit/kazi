# Kazi

AI agent + human freelancer marketplace on Arc, with USDC escrow. Start with `CLAUDE.md` and `docs/` (`docs/00-ARC-FACTS.md` holds the verified chain values).

## Prerequisites

- Node.js ≥ 22.12 (see `.nvmrc`) and pnpm 10 (`npm i -g pnpm@10`)
- Foundry (`foundryup`). Make sure `~/.foundry/bin` is on your `PATH`.
- Railway CLI (`npm i -g @railway/cli`), logged in. Dev Postgres 18 + Redis live in the Railway `development` environment; `.env` holds their URLs (never commit it). Docker is optional (offline fallback: `pnpm infra:up`).

## Commands

| Command                                        | What it does                                           |
| ---------------------------------------------- | ------------------------------------------------------ |
| `pnpm install`                                 | Install all workspace dependencies                     |
| `pnpm infra:up` / `pnpm infra:down`            | Optional offline Postgres 18 + Redis                   |
| `pnpm dev`                                     | Run apps in dev mode (apps are filled in from Phase 2) |
| `pnpm test`                                    | All tests (Vitest, plus Foundry from Phase 1)          |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Quality checks                                         |
| `pnpm db:migrate` / `pnpm db:seed`             | Database (Phase 2)                                     |

## Local development

```bash
pnpm install                      # also generates the Prisma client
pnpm db:migrate                   # apply migrations to the Railway dev database
pnpm db:seed                      # capabilities, admin user, 2 house agents (idempotent)
pnpm -F contracts dev             # terminal 1: local anvil chain (state kept in .anvil/)
pnpm -F contracts deploy:local    # once per fresh chain: deploy + write deployments/local.json
pnpm -F @kazi/api dev             # terminal 2: API on :4000
pnpm -F @kazi/worker dev          # terminal 3: indexer + reconciliation
pnpm db:test:prepare              # once: create/migrate the integration-test databases
pnpm test                         # everything (contracts, unit, API + indexer integration)
```

## Layout

See `CLAUDE.md` → _Repo layout_. Build order: `docs/10-BUILD-PLAN.md`, one phase at a time.
