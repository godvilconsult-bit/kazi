# Kazi contracts — audit preparation

Kazi is a marketplace where AI agents and human freelancers do tasks for clients, paid in USDC from an escrow on **Arc** (Circle's EVM L1; USDC is the gas token). Clients fund a task's milestones in one transaction; Kazi's backend releases each milestone to the provider's registered payout address when the work is accepted, refunds failed work, and a multisig arbitrates disputes. `$KAZI` is used for provider bonds, staking (USDC fee sharing) and, later, governance.

Specs: `docs/03-SMART-CONTRACTS.md` (design + decisions), `docs/08-TOKENOMICS.md`, `docs/09-SECURITY-COMPLIANCE.md` (threat model), `docs/00-ARC-FACTS.md` (chain facts).

## 1. Scope

| File                                                                                      | nSLOC* | Purpose                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/TaskEscrow.sol`                                                                      | ~330   | Milestone escrow: signed quotes, funding (incl. EIP-2612 permit), release, refund, reassign, disputes + arbitration, expiry refunds, pause                                 |
| `src/StakingVault.sol`                                                                    | ~250   | $KAZI staking for holders and provider bonds; warm-up, cooldowns; USDC reward accounting (reward-per-token); slashing                                                      |
| `src/AgentRegistry.sol`                                                                   | ~170   | Provider identities, status (PENDING/ACTIVE/SUSPENDED/DELISTED), payout address with a change delay, minimum bonds                                                         |
| `src/FeeDistributor.sol`                                                                  | ~90    | Splits escrow fees (USDC) to treasury / stakers / buyback; holds slashed $KAZI (insurance pool)                                                                            |
| `src/KaziToken.sol`                                                                       | ~30    | Fixed-supply ERC-20 + Permit + Votes (timestamp clock); no mint after construction                                                                                         |
| `src/KaziAirdrop.sol`                                                                     | ~80    | Merkle airdrop with linear vesting built in; sweep after the claim deadline                                                                                                |
| `src/KaziCreditsGate.sol`                                                                 | ~60    | 1:1 exchange between KAZI (third-party token launched on Argus) and KAZI Credits (KaziToken); the reserve is the Credits supply; guardian can pause `lock`, never `unlock` |
| `src/interfaces/IKazi.sol`                                                                | ~20    | Registry/vault interfaces used across contracts                                                                                                                            |
| `script/Deploy.s.sol`, `script/DeployTokenLaunch.s.sol`, `script/DeployCreditsGate.s.sol` | —      | Deployment and role hand-over (review recommended)                                                                                                                         |

\*approximate, excluding comments and blank lines. Out of scope: `src/mocks/`, `test/`, OpenZeppelin (`@openzeppelin/contracts` 5.6.1, unmodified).

**Build**: Solidity 0.8.28, optimizer 200 runs, `evm_version = cancun`, no via-IR. Foundry: `forge build`, `forge test`, `pnpm -F contracts test:coverage`.

**Commit**: fill in the audited commit hash here before sending: `________`.

## 2. Roles and trust

| Role                   | Contract                    | Holder (mainnet)         | Powers                                                                                                                                                                                          | Bounded by                                                                                                                    |
| ---------------------- | --------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_ADMIN_ROLE`   | all                         | Admin Safe (≥ 3/5)       | roles, fee bps (≤ `MAX_FEE_BPS` 20%), fee distributor, split, cooldowns (≤ 60 d), max slash (≤ 50%), min stakes, payout delay (1–30 d), unpause, `compensate`, airdrop `sweep` (after deadline) | Can't move escrowed USDC or stakers' $KAZI                                                                                    |
| `ARBITER_ROLE`         | TaskEscrow                  | Admin Safe               | `resolveDispute`: split one disputed milestone between client and provider                                                                                                                      | Only DISPUTED tasks, only FUNDED milestones                                                                                   |
| `PAUSER_ROLE`          | TaskEscrow, KaziCreditsGate | Guardian hardware wallet | `pause`                                                                                                                                                                                         | Can't unpause; pause never blocks refunds/disputes                                                                            |
| `OPERATOR_ROLE`        | TaskEscrow                  | Backend (KMS)            | `releaseMilestone`, `refundMilestone`, `reassign`                                                                                                                                               | Releases go only to the provider's registered payout; reassign only to an ACTIVE provider; refunds only to the client         |
| `QUOTER_ROLE`          | TaskEscrow                  | Backend (KMS)            | Signs EIP-712 quotes                                                                                                                                                                            | The client signs/funds the transaction; quote binds chain, escrow, client, task, amounts, fee (≤ published), deadline, expiry |
| `REGISTRAR_ROLE`       | AgentRegistry               | Ops wallet               | `activate` (bond ≥ minimum), `suspend`, `delist`, `cancelPayoutChange`                                                                                                                          | Can't change payout addresses                                                                                                 |
| `SLASHER_ROLE`         | StakingVault                | Ops wallet               | `slash`                                                                                                                                                                                         | ≤ `maxSlashBps` of the provider's stake per call; slashed $KAZI goes to the insurance pool                                    |
| `REWARD_NOTIFIER_ROLE` | StakingVault                | FeeDistributor           | `notifyReward`                                                                                                                                                                                  | Pulls exactly the notified USDC                                                                                               |
| Provider owner         | Registry/Vault              | Provider                 | metadata, payout change (delayed), bond/unbond, claim                                                                                                                                           | Unbond can't drop an ACTIVE provider below its minimum                                                                        |
| Client                 | TaskEscrow                  | User wallet              | fund, release early, open dispute                                                                                                                                                               | —                                                                                                                             |
| Anyone                 | —                           | —                        | `refundExpired` (after deadline + grace), `distribute`, `poke`, airdrop `claim` (with proof)                                                                                                    | —                                                                                                                             |

Every external state-changing function and its guard: see §6.

## 3. Invariants (tested)

TaskEscrow (`test/TaskEscrow.t.sol`, `test/invariant/`):

1. The escrow's USDC balance ≥ the sum of FUNDED milestones (equal when nobody sends USDC directly).
2. For every release: provider amount + fee = milestone amount; fee ≤ amount × `MAX_FEE_BPS`.
3. A milestone moves FUNDED → RELEASED or REFUNDED exactly once.
4. Refunds (`refundMilestone`, `refundExpired`) and dispute flows work while paused.
5. A task can't be funded twice; quotes can't be replayed across tasks, clients, chains or escrows.

StakingVault (`test/StakingVault.t.sol`, invariants): 6. `totalTracked` = Σ(active + pending + unbonding) over all accounts; the vault's $KAZI balance ≥ `totalTracked`. 7. `totalActive` = Σ active; rewards are distributed only to active (post-warm-up) stake; claimed ≤ notified. 8. Rewards notified while nobody is active are queued and distributed later, not lost. 9. An ACTIVE provider's bonded stake never drops below its minimum through unbonding.

FeeDistributor / airdrop: 10. `treasuryBps + stakerBps + buybackBps == 10_000`; `distribute` sends the whole balance (rounding dust to buyback). 11. KaziAirdrop: an account's `claimed` ≤ its allocation; vested amount is monotonic in time; claims stop after the deadline; only the admin can sweep, only after the deadline.

KaziCreditsGate (`test/KaziCreditsGate.t.sol`, `test/invariant/CreditsGateInvariants.t.sol`): 12. The gate's KAZI balance = `totalLocked`. 13. Credits outside the gate = `totalLocked` when the whole supply was deposited (1:1 backing). 14. No sequence of lock, unlock, transfers and pauses creates or destroys value for users. `lock` rejects fee-on-transfer tokens; `unlock` is never paused and is capped at `totalLocked`. The KAZI token itself is third-party (Argus) and out of scope; it is treated as untrusted.

Coverage: `pnpm -F contracts test:coverage` — 100% lines on TaskEscrow and StakingVault (CI-enforced in review).

## 4. Known issues and design decisions (please don't report these as findings unless you see an exploit)

- **Warm-up stake activates lazily.** Pending stake becomes active on the account's next interaction or a `poke`; until then it doesn't earn. Kazi's keeper pokes every matured account before each distribution, and the UI offers "Activate". Matured-but-unpoked stake missing a distribution is accepted.
- **Requesting more unstake restarts the cooldown** for everything already unbonding (one bucket per account). Documented in the UI.
- **Slashing takes from unbonding first**, so providers can't escape a pending slash by unbonding.
- **Operator trust.** A compromised operator can release funded milestones early (to the registered payout only) or reassign to another active provider. Mitigations: KMS key, release-volume alerts, guardian pause, Safe can revoke the role. Releases can't go to arbitrary addresses.
- **USDC blocklist.** If a payout address is blocklisted, `releaseMilestone` reverts; the operator refunds instead (`test_release_blocklistedPayout_refundPathWorks`).
- **Quote fee.** `quote.feeBps` may be below the published fee (staker discount, 2 percentage points), never above.
- **Votes clock** is timestamp-based (Arc has ~0.5 s blocks).
- **No upgradeability.** Fixes require redeploying and migrating; escrowed tasks finish on the old escrow.
- **FeeDistributor rounding dust** goes to the buyback reserve.
- **Airdrop tree** uses OpenZeppelin's leaf encoding and sorted-pair hashing but Kazi's own tree builder (`packages/shared/src/merkle.ts`), tested against the contract on anvil.
- **Arc specifics**: USDC is both the gas token (18 decimals natively) and an ERC-20 (6 decimals) at the same balance; the contracts only use the ERC-20 interface. Transactions below the 20 gwei fee floor are dropped (backend concern).

## 5. Static analysis

Run locally (results triaged in `docs/security/static-analysis.md`):

```bash
cd packages/contracts
slither . --filter-paths "lib|node_modules|test|script|mocks" --exclude-dependencies
```

## 6. External functions and guards

| Contract       | Function                                                                        | Guard                                                                            |
| -------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| TaskEscrow     | `createAndFund`, `createAndFundWithPermit`                                      | `whenNotPaused`, `nonReentrant`; valid QUOTER signature over (quote, msg.sender) |
| TaskEscrow     | `releaseMilestone`                                                              | `whenNotPaused`, `nonReentrant`; client or OPERATOR                              |
| TaskEscrow     | `refundMilestone`                                                               | `nonReentrant`, OPERATOR                                                         |
| TaskEscrow     | `reassign`                                                                      | OPERATOR; new provider must be ACTIVE                                            |
| TaskEscrow     | `openDispute`                                                                   | client; task FUNDED                                                              |
| TaskEscrow     | `resolveDispute`                                                                | `nonReentrant`, ARBITER; task DISPUTED                                           |
| TaskEscrow     | `refundExpired`                                                                 | `nonReentrant`; anyone after deadline + grace; not DISPUTED                      |
| TaskEscrow     | `setFeeBps`, `setFeeDistributor`, `unpause`                                     | admin                                                                            |
| TaskEscrow     | `pause`                                                                         | admin or PAUSER                                                                  |
| AgentRegistry  | `register`                                                                      | anyone (status PENDING)                                                          |
| AgentRegistry  | `updateMetadata`, `requestPayoutChange`, `confirmPayoutChange`                  | provider owner (confirm after the delay)                                         |
| AgentRegistry  | `cancelPayoutChange`, `delist`                                                  | owner or REGISTRAR                                                               |
| AgentRegistry  | `activate`, `suspend`                                                           | REGISTRAR (activate checks the bond)                                             |
| AgentRegistry  | `setMinStake`, `setPayoutDelay`, `setStakingVault`                              | admin                                                                            |
| StakingVault   | `stake`, `requestUnstake`, `withdraw`, `claim`                                  | holder (msg.sender's own account), `nonReentrant`                                |
| StakingVault   | `bond`, `requestUnbond`, `withdrawUnbonded`, `claimProviderRewards`             | provider owner, `nonReentrant`                                                   |
| StakingVault   | `slash`                                                                         | SLASHER, `nonReentrant`, capped                                                  |
| StakingVault   | `notifyReward`                                                                  | REWARD_NOTIFIER, `nonReentrant`                                                  |
| StakingVault   | `poke`                                                                          | anyone (only activates matured stake / settles rewards)                          |
| StakingVault   | `setInsurancePool`, `setCooldowns`, `setMaxSlashBps`                            | admin, bounded                                                                   |
| FeeDistributor | `distribute`                                                                    | anyone, `nonReentrant`                                                           |
| FeeDistributor | `compensate`, `setSplit`, `setTreasury`, `setBuybackReserve`, `setStakingVault` | admin                                                                            |
| KaziAirdrop    | `claim`                                                                         | anyone with a valid proof, `nonReentrant`, between start and deadline            |
| KaziAirdrop    | `sweep`                                                                         | admin, after the deadline                                                        |

## 7. Deployment

`script/Deploy.s.sol` deploys and wires everything, grants backend roles, hands every admin role to the Safe and renounces the deployer (it refuses an `ADMIN_SAFE` without code outside local). `script/DeployTokenLaunch.s.sol` deploys the vesting wallets and the airdrop and distributes the supply. Procedure: `docs/runbooks/deploy.md`.
