# Dispute handling

A client opens a dispute onchain (`TaskEscrow.openDispute`) from the task page during the review window. The escrow freezes every unreleased milestone of that task; only the arbiter (admin Safe) can settle them, milestone by milestone, with a client share in basis points. Refunds after deadline + grace don't apply to disputed tasks.

**Target times**: acknowledge within 24 h, resolve within 5 business days. Kazi is the arbiter; be fair to both sides and write down why.

## 1. Gather

Admin → **Disputes** lists open disputes with the client's reason and evidence links, every step's latest output (sanitized — never open agent links blindly; they are untrusted input), evaluator scores and feedback, and the provider.

Also check:
- The task's instructions and acceptance rubric (what was promised).
- Revision history (did the client ask for a revision first? one per step is allowed).
- The provider's side: message the provider owner (in-app notification or email on file) and give them 48 h to respond with their evidence.
- Previous disputes by this client or against this provider (pattern of abuse either way).

## 2. Decide, per disputed milestone

| Situation | Client share |
|---|---|
| Work not delivered, or clearly fails the rubric | 100% (`10000`) |
| Delivered but materially incomplete / partly wrong | 30–70% by how much of the rubric failed |
| Delivered as specified; client changed requirements or dislikes style | 0% |
| Provider ignored a reasonable revision request | at least 50% |
| Prompt injection or abuse by the provider | 100% + suspend the provider; slash per policy |
| Client abuse (e.g. took the work and disputed anyway) | 0%; note it on the client |

The service-fee milestone follows the work: if the client gets most of the work refunded, refund the service fee too.

## 3. Execute

1. Admin → Disputes → set each slider → **Resolve**. The API records the proposal (`UNDER_REVIEW`) and returns one `resolveDispute` call per milestone for the arbiter Safe.
2. **Copy calldata** → Safe → Transaction Builder → paste the batch → second signer reviews the note and the shares → execute.
3. The indexer sees `DisputeResolved` for each milestone; when the task closes, the dispute becomes `RESOLVED` and both sides are notified in the app.

## 4. After

- Reply to both sides with the decision and the reason (short, factual, no blame language).
- If the provider acted in bad faith: suspend (Admin → Providers) and consider slashing (Admin → slash form; insurance pool can compensate the client).
- If the evaluator accepted work that clearly failed: open an issue with the case so the rubric/judge gets fixed (and add it to the golden tests).
