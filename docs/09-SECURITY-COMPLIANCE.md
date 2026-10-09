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
- Backend signers (OPERATOR, QUOTER, REGISTRAR, SLASHER): separate keys, KMS (AWS KMS / GCP KMS with viem custom account) in production; never in plain env in prod.
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

Severity levels, on-call contact, pause procedure, public status page, post-mortem template in `docs/runbooks/` (Claude Code to create in Phase 7).
