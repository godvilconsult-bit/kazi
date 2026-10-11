# 09 — Security & Compliance

## 1. Threat model (top risks → mitigations)

| Threat | Mitigation |
|---|---|
| Escrow bug drains funds | Minimal contract, OZ libs, 100% coverage, fuzz + invariant tests, external audit, bug bounty, deposit caps at launch (e.g. max 1,000 USDC per task for first month), pause for new deposits (refunds always open) |
| Operator key compromise | Operator can only release/refund/reassign existing milestones (can't redirect to arbitrary addresses — payout comes from registry). KMS-held key, per-day release volume alert, ability for multisig to revoke role instantly |
| Quoter key compromise | Quotes bound to chain, escrow, task, expiry; attacker could only create quotes the client still has to fund themselves. Rotate key via role |
| Malicious agent changes payout address then gets paid | Payout changes have a 48h delay before effective (add to registry) and email/in-app alert |
| Prompt injection via agent output into router/evaluator | Outputs wrapped as data with delimiters; judge instructed to ignore instructions inside; deterministic injection pattern checks; outputs never executed; slashing for detected attempts |
| Prompt injection via client task text | Router can't move money; it only produces a plan validated by Zod and business rules |
| Fake/low-quality agents farming fees | Bond requirement, review test suite, evaluator, client ratings, exploration limited to 10% |
| Sybil wash trading to farm reputation/rewards | Reputation weighted by fees paid, unique client wallets, anomaly detection (same funding source), rewards based on fees not counts |
| Data leaks (client files) | Private bucket, signed URLs (15 min), encryption at rest, agents get only what their subtask needs, 30-day retention policy |
| API abuse | Rate limits per wallet/IP, quote limit per user per hour, CAPTCHA-free but SIWE required |
| Web app supply chain / XSS | Strict CSP, sanitized markdown, lockfile, Dependabot, no inline scripts |
| Dispute abuse by clients | Client must open dispute onchain; history of disputes affects client trust score; arbiter = multisig with evidence log |

## 2. Contract security process

1. Internal: Slither + Aderyn in CI, Foundry tests, invariants, gas snapshot.
2. Testnet: public testnet launch with bug bounty for testnet findings.
3. External audit (at least one firm or a competitive audit like Code4rena/Cantina/Sherlock) before mainnet with real funds.
4. Mainnet guarded launch: deposit caps, allowlisted agents (house + reviewed), monitoring (Forta/Tenderly/OpenZeppelin Defender-style alerts on large releases, role changes, pauses).
5. Immunefi-style bug bounty after mainnet.

## 3. Key management

- Admin: Safe multisig (≥ 3/5, hardware wallets, signers in different locations).
- Backend signers (OPERATOR, QUOTER, REGISTRAR, SLASHER): separate keys, KMS (AWS KMS / GCP KMS with viem custom account) in production. Exception, the guarded launch: the operator and quoter keys may be Railway secret variables while open escrow is capped at ≤ 10,000 USDC (enforced in `apps/worker/src/chain/signers.ts`; runbooks/deploy.md §4).
- Document a key-compromise runbook: revoke role via Safe, rotate, pause new deposits, communicate.

## 4. Legal & compliance checklist (get professional advice — not legal advice)

**Token**
- [ ] Legal opinion on whether $KAZI could be a security in target jurisdictions (fee sharing to stakers increases this risk). Options: structure fee sharing as rewards for active participation (bonding providers), geo-block restricted jurisdictions (e.g. US) from public sale/staking UI, or drop direct fee sharing in favour of buyback-only.
- [ ] Entity: decide where the token-issuing entity sits (e.g. foundation in a crypto-friendly jurisdiction) vs the operating company. Tanzania: check Bank of Tanzania and CMSA positions on crypto assets.
- [ ] Clear disclaimers: no promises of profit; risk warnings on `/token` and `/stake`.
- [ ] Publish tokenomics, vesting, addresses; keep team wallets transparent.

**Marketplace**
- [ ] Terms of Service (clients), Provider Agreement (agents/freelancers), Privacy Policy, Acceptable Use Policy.
- [ ] Prohibited tasks list enforced by router (fraud, malware, impersonation, illegal content, academic dishonesty where flagged, regulated advice presented as final).
- [ ] Tax/legal/financial deliverables labeled as drafts; human professional review option.
- [ ] Data protection: Tanzania Personal Data Protection Act 2022, Kenya DPA, GDPR if EU users. Data processing agreement for agents.
- [ ] KYC/AML: escrow of user funds may trigger money-transmitter or payment-service rules in some places. At minimum: sanctions screening of wallets (Chainalysis/TRM free API or similar), KYC for providers above a payout threshold, KYC for enterprise accounts, transaction monitoring. Later M-Pesa on-ramp → use a licensed partner.
- [ ] Tax: platform revenue accounting in USDC; invoices for clients; providers responsible for their own taxes (state in agreement).

## 5. Incident response

Severity levels, roles, first-15-minutes checklist, message templates, pause procedure, key compromise, dispute handling and the post-mortem template live in [`docs/runbooks/`](runbooks/README.md). A public status page still has to be set up (any hosted status page works; link it from the app footer).

## 6. Phase 7 hardening (2026-10-10)

**Built**
- **Runbooks** (`docs/runbooks/`): deploy, pause, key compromise, dispute handling, incident response, post-mortem template; alert → runbook map.
- **Guardian pause**: `TaskEscrow.PAUSER_ROLE` can pause (not unpause) so an incident is contained in minutes, not after collecting Safe signatures. The payout worker holds releases while paused (refunds continue) and resumes by itself.
- **Signers**: `SIGNER_BACKEND=aws-kms` turns the OPERATOR and QUOTER into KMS-backed viem accounts (`apps/worker/src/chain/kms.ts`: DER parsing, low-s, recovery bit; tested against a local key and on anvil). Plaintext keys are refused on mainnet and in production unless `ALLOW_PLAINTEXT_KEYS=true` (testnet).
- **Monitoring**: Sentry (API, worker) when `SENTRY_DSN` is set; Prometheus metrics (`GET /metrics` on the API behind `METRICS_TOKEN`, worker on `WORKER_METRICS_PORT`); alerts to logs + Sentry + `ALERT_WEBHOOK_URL` with Redis de-duplication: reconciliation mismatch, large release, 24 h release volume, role changes, pause/unpause, admin parameter changes, payout-change requests (the provider owner also gets an in-app notice), queue backlog, new failed jobs, LLM spend per hour, operator gas. Failed release/refund jobs are retried automatically (10 min apart, at most 6 times) before they wait for a human.
- **Guarded launch**: `MAX_TASK_USDC`, `MAX_OPEN_ESCROW_USDC` (checked when quoting), `PROVIDER_ALLOWLIST` (house agents + listed providers only); incident switch `ROUTER_DISABLED` (API answers 503 to new quotes, funded work continues).
- **Sanctions screening**: with `CHAINALYSIS_API_KEY`, sign-in and provider payout addresses are checked against Chainalysis' sanctions API (cached; fails open unless `SANCTIONS_FAIL_CLOSED=true`).
- **Secret rotation**: `pnpm -F @kazi/api rotate-secrets` re-encrypts stored webhook secrets (`NEW_ENCRYPTION_KEY`) and re-derives house-agent secrets (`NEW_HOUSE_AGENTS_SECRET`).
- **Audit prep**: `packages/contracts/AUDIT.md` (scope, roles, invariants, known issues, every external function and its guard).

**Access-control review** — every state-changing function in the six contracts was checked against its intended caller (table in `AUDIT.md` §6). No function lets a backend key move funds to an address it chooses: releases go to the registry's payout (changes delayed 48 h, owner notified), refunds to the client, slashing to the insurance pool within `maxSlashBps`. Admin powers sit with the Safe and are bounded (fee ≤ 20%, cooldowns ≤ 60 days, slash ≤ 50%).

**Findings fixed in this pass**
1. The API trusted `X-Forwarded-For` from any client (`trustProxy: true`), so per-IP limits on sign-in could be bypassed by spoofing the header → `TRUST_PROXY` (default off; set the proxy hop count in production).
2. Pausing needed the multisig → guardian `PAUSER_ROLE`.
3. Release/refund jobs that failed 5 times (e.g. an RPC outage) were never retried → automatic retry with a cap + `JOB_FAILURES` alert.
4. Matured warm-up stake didn't earn until its owner interacted → keeper pokes before each distribution.
5. Token metrics double-counted a wallet holding two allocations (negative circulating supply, page crash) → de-duplicated (found by the browser e2e).

**Remaining risks before mainnet** — see the Phase 7 summary in `docs/HANDOVER.md`.
