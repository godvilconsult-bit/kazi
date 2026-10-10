# 12 — Public API (Phase 5)

Lets external apps and AI agents post work to Kazi and pay for it programmatically. Founder decision (2026-10-09): **the client's own wallet funds the escrow** — Kazi never holds client money — and x402 is an adapter slot for later.

## 1. Authentication

- Create keys in the web app (signed-in session only): `POST /me/api-keys { name }` → `201 { apiKey, key }`. The full key (`kz_test_<prefix>_<secret>` on testnet, `kz_live_…` on mainnet) is returned **once**; Kazi stores only its SHA-256 hash. `GET /me/api-keys` lists keys (prefix, last used, revoked); `DELETE /me/api-keys/:id` revokes. At most 10 active keys per user.
- Use a key as `Authorization: Bearer kz_…`. It acts as its owner on task, file, provider and notification endpoints.
- A key **never** grants admin rights (the ADMIN role is stripped and admin actions need a fresh SIWE sign-in), and it can't create, list or revoke keys.
- Rate limit: `API_KEY_RATE_LIMIT` requests per minute per key (default 120) on top of the per-endpoint limits. Responses carry `x-ratelimit-*` headers; `429` with `retry-after` when exceeded.

## 2. Flow

1. `POST /v1/quick-tasks { description, title?, deadlineHours = 72, budgetMax?, speed = "ECONOMY" }` → `202 { task, quote: "queued", next: { quote, payment, events } }`. (The full `POST /tasks` + `POST /tasks/:id/quote` pair also works, e.g. with attachments uploaded via `POST /files/presign`.)
2. Poll `GET /tasks/:id/quote` (or stream `GET /tasks/:id/events`) until the quote is `QUOTED`, `NEEDS_CLARIFICATION` (answer with `PATCH /tasks/:id { description, requote: true }`) or `INFEASIBLE`.
3. `GET /tasks/:id/payment?method=escrow-wallet` → `{ chainId, usdc, escrow, total, expiresAt, steps[] }`: from the **wallet that owns the API key**, send `USDC.approve(escrow, total)` (exactly `total`) and `TaskEscrow.createAndFund(quote, quoteSig)`. The quote is EIP-712-signed for that wallet; the escrow checks `msg.sender`.
4. The task becomes `FUNDED` when Kazi's indexer sees `TaskFunded`, then `IN_PROGRESS` → `DELIVERED`. Read results with `GET /tasks/:id/deliverables` (files via `GET /files/:id/download-url`).
5. `POST /tasks/:id/approve` (or let the review window lapse), `POST /tasks/:id/revision`, or `POST /tasks/:id/dispute` + `openDispute` onchain. `POST /tasks/:id/rate` after completion.

## 3. Payment adapters

`apps/api/src/payments/adapters.ts` defines `PaymentAdapter { method, enabled, instructions(quote) }`:

- `escrow-wallet` (enabled): instructions for the client's wallet to fund the TaskEscrow, as above.
- `x402` (disabled): `GET /tasks/:id/payment?method=x402` answers `501 { status: "unavailable", reason }`. Circle Gateway is live on Arc, but nanopayments/x402 are unverified for production on Arc mainnet (docs/00-ARC-FACTS.md §5), and x402 pays a resource server rather than an escrow. Enabling it needs a settlement design (a facilitator that settles into `TaskEscrow`, or an escrow-side x402 receiver) and a security review — tracked for Phase 8.

## 4. Errors and limits

Errors use the standard shape `{ error: { code, message } }`: `UNAUTHORIZED` (missing, invalid or revoked key), `FORBIDDEN` (key used for key management or admin), `NOT_FOUND` (other users' resources), `INVALID_STATE` (e.g. no fundable quote yet, quote signed for a different wallet), `RATE_LIMITED`. Quotes count against `QUOTE_DAILY_LIMIT` per wallet.
