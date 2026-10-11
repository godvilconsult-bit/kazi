# Kazi — handover (2026-10-10)

Everything in `docs/10-BUILD-PLAN.md` Phases 0–7 is built and tested; Phase 8 (growth) has the Python agent SDK built and a written roadmap for the rest. Mainnet: you chose a **guarded pre-audit launch**: 100 USDC per task, 2,000 USDC in open escrow, house agents only. Everything for it is built and was rehearsed on a local fork of Arc mainnet. It waits only on the inputs listed in [`deploy/README.md`](../deploy/README.md) §0: domain, Safe owners, guardian, AWS KMS keys, secrets, and gas.

## 1. Status by phase

| Phase | State | Where to look |
|---|---|---|
| 0 Arc facts & scaffold | ✅ | `docs/00-ARC-FACTS.md`, monorepo, CI |
| 1 Contracts | ✅ 100% line coverage on escrow + vault; fuzz + invariants | `packages/contracts`, `AUDIT.md` |
| 2 DB, API skeleton, auth, indexer | ✅ | `packages/db`, `apps/api`, `apps/worker/src/indexer` |
| 3 Router, executor, evaluator, SDK, first house agents | ✅ live-verified with Claude | `apps/worker/src/{router,executor,evaluator}`, `packages/agent-sdk` |
| 4 Web app MVP | ✅ browser e2e passing | `apps/web`, `apps/web/e2e/happy-path.spec.ts` |
| 5 All house agents, freelancer flow, public API | ✅ 10 house agents, golden tests pass | `packages/house-agents`, `docs/12-PUBLIC-API.md` |
| 6 Token launch readiness | ✅ contracts, scripts, pages, points, airdrop, geo hooks | `docs/08-TOKENOMICS.md` §7 |
| 7 Mainnet hardening | ✅ runbooks, KMS, monitoring, guarded launch, security pass, load test | `docs/09-SECURITY-COMPLIANCE.md` §6, `docs/runbooks/` |
| 8 Growth | 🟡 Python SDK built; roadmap for M-Pesa, mobile, enterprise, subcontracting, governance, reputation roots | `docs/13-GROWTH-ROADMAP.md` |

## 2. Deployed

### Arc mainnet (chain 5042), guarded launch, 2026-10-11, block 25,362,687

| Contract | Address |
|---|---|
| Admin Safe (2-of-2, v1.4.1) | `0xe4bF1a867949ea0dB5bdb6ADf611B6f0299d0af3` |
| TaskEscrow | `0xE83f9887742D1A8c84Aa5169cD3dcE57eC961039` |
| AgentRegistry | `0x10BAC5c3B04bC84cDda4C5c302F3fF7116C293C2` |
| StakingVault | `0x3764a642b8E22cdAe93CF8d9CCe5b59F5db44f78` |
| FeeDistributor | `0xaB0e80CD4F091D976FA099EE0CEcbE14551fE1FA` |
| KAZI Credits (KCRED) | `0xBeEF9ecDa2b9e16023D437d4d608d814230AfD1b` |
| KaziCreditsGate (KAZI ⇄ KCRED) | `0xb77f946dFf26B0bd9C0996c2889Dc461cF99F5bE` |
| KAZI on Argus | `0x9A4dE59eCB39c85E00687006E55624298D75F79b` |
| USDC | `0x3600000000000000000000000000000000000000` |

Verified onchain after the deploy:
- The Safe is admin everywhere, and the deployer has renounced.
- Operator `0x8A5C…3647` and quoter `0xf73e…EFE9` (Railway-held keys).
- Guardian `0xbBE6…871a` can pause the escrow and the exchange.
- Staker share 0, fee 12%.
- The whole KCRED supply is in the exchange reserve.

### Arc testnet (chain 5042002)

| Contract | Address |
|---|---|
| Admin Safe (1-of-1 on testnet) | `0x91C47058E45A2496e28F898f32D2231aAd2DDc2c` |
| TaskEscrow | `0xFbeeF1d2ac13F60E79a22943AA3502218D79C879` |
| AgentRegistry | `0x8f67995364fc3F576CE204348c82586ef8A5C52E` |
| StakingVault | `0xE93D0EBBe72aEed4d0FFD493EED04710778b9ed0` |
| FeeDistributor | `0x2b06De5129C44129e6c442Cb74DC91eCa26673f5` |
| KaziToken (test KAZI) | `0x05F357268B63D0259E4731C27396FdE2EdbFaAF0` |
| USDC | `0x3600000000000000000000000000000000000000` |

These were deployed in Phase 4. Contract changes since then: the escrow's guardian `PAUSER_ROLE` (Phase 7) and the token-launch contracts (Phase 6, not deployed). Redeploy testnet with `pnpm -F @kazi/contracts deploy:testnet` right before inviting testers, together with hosting the API/worker/web and running `setup-providers` against the testnet database.

## 3. Run it

See the root [`README.md`](../README.md): local stack (anvil + API + worker + house agents + web), all test commands, the isolated e2e stack, the load test. Every environment variable is documented in `.env.example`.

## 4. Test results (this pass)

| Suite | Result |
|---|---|
| Contracts — Foundry unit, fuzz (1,000 runs), invariants | **132 passed.** Coverage: TaskEscrow and StakingVault 100% lines and branches; AgentRegistry, FeeDistributor 100%; KaziToken 100% lines; KaziAirdrop 97.7% lines (its constructor revert paths are tested but not traced by `forge coverage`) |
| API — Vitest on Postgres + Redis | **53 passed** (8 files) |
| Worker — Vitest on anvil + Postgres | **55 passed** (9 files), incl. the KMS signer sending a real transaction and TypeScript Merkle proofs claimed through `KaziAirdrop` |
| Web unit · shared · config · agent SDK · house agents | **16 · 30 · 11 · 7 · 4 passed** |
| Python agent SDK | **8 passed**, incl. a signature produced by the TypeScript SDK |
| Browser e2e (Edge, isolated stack) | **3 passed**: task happy path (5.9 min); airdrop claim → stake → unstake → token page; restricted-country view |
| Golden cases with live Claude | 49 of 50 at their last runs (Phase 5's 35/35; Phase 3: translator 5/5, business plan 5/5, market research 4/5 before its prompt v2 — rerun it once) |
| Static analysis — Slither 0.11.3 | 19 results, none actionable ([triage](security/static-analysis.md)) |
| Web production build (`next build`) | succeeds, 21 routes |
| Lint · typecheck · Prettier | clean across the monorepo (typecheck now covers worker and API scripts and tests too) |
| Load test — 500 full task lifecycles (laptop + remote DB) | all 500 quoted, funded and delivered; 268 completed within 75 min; 0 errors in 179,200 requests. Bottlenecks: router queue and one-at-a-time payouts ([details](../load/README.md)) |

## 5. Decisions made for you ("best recommended")

You asked me to pick the recommended option whenever there was a question. Each is reversible; the doc that records it is in brackets.

**Product & architecture**
- Notifications are in-app only for now; email can be added in one place (`notify()`) [04 §11].
- The public API is non-custodial: a client's own wallet funds the escrow; x402 is an adapter left for later [12].
- The translation length check (±30%) is advisory to the judge, not a hard reject [06 §9].

**Token (Phase 6)**
- Airdrop vesting is built into the Merkle distributor (`KaziAirdrop`) instead of one VestingWallet per recipient (doesn't scale) [08 §1, §7].
- Points follow USDC fees (clients 100/USDC, providers 50/USDC) with sybil filters; Kazi's own house agents earn no provider points [08 §7].
- Airdrop snapshot defaults: ≥ 100 points, max 1% of the airdrop per wallet (excess re-split), Kazi wallets excluded, unallocated tokens swept to the treasury after the deadline [08 §7].
- Staking shows realized 30-day rewards per 1,000 KAZI, never an APR; the fee keeper activates matured warm-up stake before each distribution [08 §7].
- The 2-point fee discount counts only earning stake (warm-up excluded) so it can't be bought for one quote [08 §7].
- Geo hooks: suggested list `US,CU,IR,KP,SY`; restricted visitors can't stake or claim airdropped tokens, but can always exit; bonds aren't restricted. The real list is a legal decision [08 §7].
- Provider bond is on by default; networks with a zero minimum hide it [07 §7].

**KAZI on Argus (2026-10-11)**
- Kazi's own token is "KAZI Credits" (`KCRED`). It is exchanged 1:1 with the KAZI you launch on Argus through `KaziCreditsGate`, and its whole supply is the exchange's reserve. Staking, bonds and discounts keep working on Credits unchanged [08 §8].

**Hardening (Phase 7)**
- A guardian wallet (`PAUSER_ROLE`) can pause the escrow; only the Safe can unpause [03 §9, runbooks/pause].
- AWS KMS is the target signer backend (secp256k1, viem custom account). For the guarded launch you chose Railway-held keys instead of AWS (2026-10-11). The worker allows them on mainnet only with `ALLOW_PLAINTEXT_KEYS=true` and open escrow capped at ≤ 10,000 USDC; move to KMS before raising the caps [runbooks/deploy §4].
- Guarded-launch caps are enforced when quoting (backend), not onchain, to keep the audited escrow unchanged [09 §6].
- Sanctions screening uses Chainalysis' free API and fails open (configurable) so an outage there doesn't lock everyone out [09 §6].
- `TRUST_PROXY` defaults to off; production sets the proxy hop count [runbooks/deploy §5].
- New dependencies (your rule 10, decided by the "best recommended" instruction): `@aws-sdk/client-kms` 3.1141.0, `@sentry/node` 10.75.3, `prom-client` 15.1.3.

## 6. Remaining risks before mainnet

1. **No external audit yet.** Scope and invariants are ready in `packages/contracts/AUDIT.md`; include `KaziAirdrop` and both deploy scripts.
2. **Legal.** Token classification (fee sharing to stakers), escrow / money-transmission rules where you operate, data protection (Tanzania PDPA 2022, Kenya DPA), terms of service, provider agreement, privacy policy — none written yet (`docs/09` §4 checklist).
3. **Operational single points.** One worker process holds the operator key and settles payouts one at a time; Redis/BullMQ and the database are single instances. Fine for a guarded launch; plan HA before volume.
4. **KMS tested against a local stand-in only.** Do one testnet deploy with real AWS KMS keys before mainnet.
5. **LLM dependency.** If Anthropic is down, quoting stops and house-agent work stalls (funded tasks still refund after deadline + grace). `ROUTER_DISABLED` exists for incidents.
6. **Throughput.** The load test (`load/README.md`) shows two bottlenecks to fix before real volume: quoting (raise `ROUTER_CONCURRENCY`, add worker replicas) and payouts (one operator key, one release at a time — pipeline nonces or shard operator keys). Run API/worker in the same region as Postgres/Redis and size pools with `connection_limit`.
7. **Not wired yet:** Sentry in the web app, a public status page, Aderyn (needs Linux; runs in CI), the M-Pesa on-ramp (needs a licensed partner).
8. **Testnet is behind the code** (no guardian role; house agents not registered there yet) — redeploy as in §2.

## 7. What you need to do

1. **Delete the `DEPLOYER_PRIVATE_KEY` line from `D:\KAZI\kazi\.env`.** It is your personal wallet's key (the treasury address `0x43DA…8470`, which holds funds on Arc mainnet). Nothing in Kazi uses it; it shouldn't sit in a project file.
2. Choose hosting for the API, worker, house agents and web app (same region as the database); set `TRUST_PROXY`, `SENTRY_DSN`, `ALERT_WEBHOOK_URL`, `METRICS_TOKEN`.
3. Create the production signers in AWS KMS and the mainnet admin Safe (≥ 3/5 hardware wallets) and guardian wallet.
4. Commission the audit (send `AUDIT.md` + the commit hash) and the legal review.
5. Get a Chainalysis sanctions API key; set up a status page.
6. Testnet launch: host the backend, redeploy contracts, `setup-providers`, invite 10–20 users and 3–5 agent developers (build plan, after Phase 4).
7. Token launch only after real mainnet volume (docs/08 §4) — follow docs/08 §7 and `runbooks/deploy.md` §6.

## 8. This package

`kazi-package-2026-10-10.zip` contains the repository without `node_modules`, build outputs, caches, `.env` and `.env.testnet` (secrets never leave your machine). `git log` has the full history; the repository is also on GitHub (private): `godvilconsult-bit/kazi`. After unzipping: `git submodule update --init` (Foundry's forge-std), `pnpm install`, then copy `.env.example` to `.env` and fill it in.
