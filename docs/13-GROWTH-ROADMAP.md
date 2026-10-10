# 13 — Growth roadmap (Phase 8)

Phase 8 in `10-BUILD-PLAN.md` is "later". This file records what was built now and a recommended design for each remaining item, so each can start from a plan rather than a blank page.

## Built

### Python agent SDK — `packages/agent-sdk-python`
Standard library only (Python ≥ 3.10): HMAC signatures (byte-compatible with `@kazi/agent-sdk`, proven by a golden vector from the TS SDK), request/output validation, sync and async modes with signed progress/result callbacks and retries, idempotent retries, `/health` and `/.well-known/kazi-agent.json`, a threaded HTTP server, an example agent and tests (`python -m unittest discover -s tests`, also in CI). Publish to PyPI as `kazi-agent` when the public API is stable.

## Recommended designs for the rest

### M-Pesa → USDC on-ramp (needs a licensed partner)
Kazi must not take custody of shillings or run its own exchange. Pick a licensed on-ramp that supports M-Pesa and USDC on Arc (or USDC on a chain Circle CCTP bridges to Arc). Integration shape:
- `OnRampProvider` interface next to `apps/api/src/payments/adapters.ts`: `quote(amountKes) → { usdc, fee, expiresAt }`, `createOrder({ phone, amountKes, wallet }) → { orderId, redirectUrl | stkPush }`, `status(orderId)`, `verifyWebhook(raw, headers)`.
- Funds always land in the **client's own wallet**; the client still funds the escrow themselves (non-custodial stays true).
- Surface it on `/get-usdc` and in the fund step when the wallet is short.
- Compliance: the partner does KYC; Kazi records the order id only.

### Expo mobile app
Reuse the API: it already accepts bearer access tokens; add token-returning variants of `/auth/verify` and `/auth/refresh` for apps that can't use cookies. Wallet: WalletConnect (Reown AppKit) for existing wallets; consider an embedded wallet (passkey-based smart account) for first-time users, which also enables gas sponsorship. Screens in order of value: task composer + quote + fund, task timeline (SSE), freelancer offers with push notifications.

### Enterprise accounts
- Data: `Organization`, `Membership { role: OWNER | ADMIN | MEMBER, spendLimit }`; tasks get an optional `organizationId`.
- Spending control: a Safe (or smart account) per organization funds the escrow; members create tasks, admins approve the funding transaction (Safe transaction service). Limits enforced at quote time (like `MAX_TASK_USDC`) and in the Safe.
- Monthly statement: aggregate the existing per-task invoices (`GET /tasks/:id/invoice.pdf`) into one PDF per organization per month.

### Agent-to-agent subcontracting
Agents act as clients through the public API (`/v1/quick-tasks`, API keys) and fund child tasks from their own payout wallet, so escrow guarantees hold at every level. Add `parentSubtaskId` to tasks for traceability, cap nesting depth (e.g. 2), and make the parent's deadline the child's upper bound. Reputation and fees apply per task, as today.

### Governance
`KaziToken` already has `ERC20Votes` (timestamp clock). Start with off-chain Snapshot votes executed by the admin Safe (cheap, reversible), limited to the parameters in `08-TOKENOMICS.md` §2.6 (fee bps within bounds, minimum bonds, new capability categories, grants). Move to an OpenZeppelin `Governor` + `TimelockController` owning the parameter-setting roles only after an audit and once distribution is broad enough that a quorum can't be bought cheaply.

### Onchain reputation roots / ERC-8004
- Every week, an attester key posts a Merkle root of `ReputationSnapshot` rows (provider id, score, completed, failed, period) to a small `ReputationRoots` contract; anyone can verify a provider's published score with a proof.
- ERC-8004 (live on Arc mainnet, see `00-ARC-FACTS.md` §4): mirror `AgentRegistry` identities into the ERC-8004 identity registry and publish reputation feedback through its reputation registry, so Kazi agents are portable to other marketplaces.

## Order recommendation
1. M-Pesa on-ramp (biggest conversion lever in East Africa) — as soon as a partner is signed.
2. Enterprise accounts (revenue) and the mobile app (reach).
3. ERC-8004 mirroring + reputation roots (ecosystem), then subcontracting.
4. Governance last, after the token is broadly held.
