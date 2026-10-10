# Static analysis — Slither 0.11.3 (2026-10-10)

Command (from `packages/contracts`, Slither in a virtualenv):

```bash
slither . --filter-paths "lib|node_modules|test|script|mocks" --exclude-dependencies
```

48 contracts, 100 detectors, **19 results, none actionable**. Triage:

| # | Detector (impact / confidence) | Where | Verdict |
|---|---|---|---|
| 1 | uninitialized-state (High / High) | `TaskEscrow._milestones` | **False positive.** The mapping is written through storage pointers (`Milestone[] storage ms = _milestones[taskId]; ms.push(...)` in `_createTask`); Slither doesn't follow pointer writes. Covered by every funding/release test and the escrow invariants. |
| 2 | incorrect-equality (Medium / High) | `FeeDistributor.distribute` (`total == 0`), `KaziAirdrop.sweep` (`amount == 0`) | **Accepted.** Both only revert on an empty balance. Anyone donating dust merely makes the call proceed with that dust — no way to block or redirect funds. |
| 3 | uninitialized-local (Medium / Medium) | `StakingVault.notifyReward.distributed`, `TaskEscrow.resolveDispute.payout`, `TaskEscrow.refundExpired.refunded` | **Accepted.** Intentional zero defaults (accumulators / optional amounts), each covered by tests. Left unchanged to keep the audited diff minimal. |
| 4 | timestamp (Low / Medium) ×9 | deadlines, expiry, warm-up, cooldowns, payout delay, airdrop vesting and deadline | **Accepted — by design.** All windows are hours to months long; a few seconds of timestamp drift can't change an outcome materially. |
| 5 | costly-loop (Informational) | `StakingVault.poke` | **Accepted.** Caller-bounded batches (the keeper sends ≤ 100 keys). |
| 6 | naming-convention (Informational) ×2 | `KaziToken.CLOCK_MODE`, `TaskEscrow.DOMAIN_SEPARATOR` | **Accepted.** Names fixed by ERC-6372 and EIP-2612/712 conventions. |
| 7 | unimplemented-functions (Informational) | `AgentRegistry` / `IAgentRegistry.minStake` | **False positive.** Implemented by the `public override` mapping getter. |

Aderyn was not run (no Windows build in this environment); run it in CI on Linux (`cyfrin/aderyn`) before the audit.

The CI workflow runs Slither on every push (`.github/workflows/ci.yml`, job `slither`) with `fail-on: high`; the false positive above is suppressed in the code with a `slither-disable-next-line` comment so new high findings fail the build.
