# Pause the escrow

`TaskEscrow.pause()` stops **new funding and releases**. These keep working while paused, by design: `refundMilestone` (operator), `refundExpired` (anyone, after deadline + grace), `openDispute`, `resolveDispute` (arbiter). Clients can always get unreleased money back.

## When to pause

Pause first, investigate second, if any of these is true:
- `ESCROW_RECONCILIATION_MISMATCH`: the escrow's USDC balance differs from what the database expects and it isn't explained by an in-flight transaction.
- Releases you can't explain (`LARGE_RELEASE` to an unknown provider, many releases without client approval or review expiry).
- The operator or quoter key may be compromised (also follow [key-compromise.md](key-compromise.md)).
- A contract bug is reported with a credible exploit path.

Don't pause for: a stuck queue, an LLM outage, a broken web page. Those don't put escrowed funds at risk.

## How (fastest first)

1. **Guardian wallet** (`PAUSER_ROLE`, hardware wallet held by on-call):
   - Admin → Reconciliation → **Pause escrow** → *Send transaction* from the guardian wallet, or
   - `cast send <escrow> "pause()" --rpc-url $ARC_RPC_URL --ledger` (escrow address in `packages/config/deployments/<network>.json`).
2. **Admin Safe** (if the guardian is unavailable): Admin → Reconciliation → **Pause escrow** → *Copy calldata* → Safe → Transaction Builder → paste → collect signatures.
3. Nothing to do on the worker: the payout worker reads `paused()` and holds releases (refunds continue) until the escrow is unpaused.
4. Confirm: Admin shows "Paused", and the explorer shows the `Paused` event.

## While paused

- Post on the status page within 15 minutes: "Payments are paused while we investigate. Your funds stay in escrow; refunds still work." (see [incident-response.md](incident-response.md) for templates).
- The web app keeps working read-only; funding attempts fail with a clear wallet error.
- Keep refunding steps that failed or that clients cancel — refunds are open.

## Unpause (admin Safe only)

Checklist before collecting signatures:
- [ ] Root cause understood and written down in the incident doc.
- [ ] Fix deployed (or the exposure ruled out), keys rotated if relevant.
- [ ] Reconciliation green on a fresh run: Admin → Reconciliation, or wait for the next `RECONCILE_EVERY_MS` tick.

Then Admin → Reconciliation → **Unpause** → copy calldata → Safe → sign → execute. Watch the first releases go through; update the status page.
