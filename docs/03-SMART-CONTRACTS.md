# 03 — Smart Contracts (Arc, Solidity ^0.8.24, Foundry, OpenZeppelin v5)

Location: `packages/contracts/src/`. Keep contracts small and boring. No upgradeable proxies in v1. Owner = admin multisig (Safe). Use `AccessControl` roles where a backend signer needs limited powers.

## 0. Arc specifics to handle

- USDC is the gas token. Users need a little USDC for gas on every tx.
- Payments use the **USDC ERC-20 interface** on Arc. Read `decimals()` from it; do not assume. Confirm the address in Arc docs and put it in `packages/config`.
- EVM-compatible; standard Foundry tooling works. Confirm chain ID and RPC from docs.
- Fast finality: indexer can use a small confirmation count (configurable, default 2).

## 1. `KaziToken.sol`

- OpenZeppelin `ERC20`, `ERC20Permit`, `ERC20Votes` (for future governance).
- Fixed supply minted once in constructor to a distribution address (see `08-TOKENOMICS.md`). **No mint function after deploy. No transfer tax. No blacklist.** (Taxes kill trading; we earn from product fees instead.)
- Name/symbol from constructor args.

## 2. `AgentRegistry.sol`

Onchain identity for agents and freelancers (“providers”).

```solidity
struct Provider {
    address owner;          // controls the listing
    address payout;         // receives USDC
    bytes32 metadataHash;   // keccak256 of offchain manifest JSON (see 05-AGENT-SPEC)
    string  metadataURI;    // https:// or ipfs:// to manifest
    ProviderKind kind;      // AGENT | HUMAN
    Status status;          // PENDING | ACTIVE | SUSPENDED | DELISTED
    uint64 registeredAt;
}
```

- `register(kind, payout, metadataURI, metadataHash) → providerId` — requires `StakingVault.stakedOf(msg.sender-provider) >= minStake(kind)` at activation time. Starts `PENDING`.
- `activate(providerId)` — `REGISTRAR_ROLE` (admin/backend) after review.
- `updateMetadata` — owner only; emits event.
- `requestPayoutChange(providerId, newPayout)` → effective after `payoutDelay` (default 48h) via `confirmPayoutChange`; protects against a stolen owner key redirecting earnings instantly. Escrow reads the *effective* payout.
- `suspend(providerId)`, `delist` — `REGISTRAR_ROLE` or owner (owner can only delist self).
- Events: `ProviderRegistered`, `ProviderActivated`, `ProviderUpdated`, `ProviderSuspended`, `ProviderDelisted`.
- Optional later: align with ERC-8004 agent identity if it is supported on Arc — keep the interface adaptable.

## 3. `StakingVault.sol`

Two kinds of staking, separate accounting:

**a) Provider bonds** (per providerId)
- `bond(providerId, amount)` — transfer $KAZI in.
- `requestUnbond(providerId, amount)` → starts cooldown (default 14 days); provider cannot drop below min stake while ACTIVE.
- `withdrawUnbonded(providerId)` after cooldown.
- `slash(providerId, amount, reasonHash)` — `SLASHER_ROLE` only; capped per call at `maxSlashBps` of bond (default 20%); slashed tokens go to `FeeDistributor` insurance pool, part used to compensate harmed clients (offchain decision, onchain transfer).
- Slashing applies also to amounts in cooldown (prevents unbond-then-rug).

**b) Holder staking** (fee sharing)
- `stake(amount)`, `unstake(amount)` with 7-day cooldown.
- Rewards in **USDC**, distributed via a standard reward-per-token accumulator (Synthetix `StakingRewards`-style, but rewards pushed by `FeeDistributor.notifyReward(amount)`, no fixed duration needed — instant distribution to current stakers is fine; protect against flash staking via the cooldown + rewards accrue only after a 1-day warm-up, or use time-weighted checkpoints).
- `claim()` → USDC to staker.
- Provider bonds also earn holder rewards (incentive to bond more than minimum).

Events for all state changes. Invariant tests: total tracked stake == token balance minus pending slashed transfers; rewards claimed ≤ rewards notified.

## 4. `TaskEscrow.sol` (most critical)

One escrow contract holding USDC for all tasks, with per-task milestones (one per subtask).

```solidity
struct Milestone {
    uint256 providerId;   // 0 = unassigned (router may reassign before release)
    uint128 amount;       // USDC base units, gross (includes fee)
    MilestoneStatus status; // FUNDED | RELEASED | REFUNDED
}
struct Task {
    address client;
    uint64  deadline;       // after this, client can self-refund unreleased milestones
    uint16  feeBps;         // snapshot of fee at funding time
    TaskStatus status;      // FUNDED | DISPUTED | CLOSED
    uint256 totalAmount;
    uint256 releasedOrRefunded;
}
mapping(bytes32 taskId => Task) tasks;
mapping(bytes32 taskId => Milestone[]) milestones;
```

Functions:
- `createAndFund(Quote quote, bytes quoteSig)` with `Quote = (taskId, providerIds[], amounts[], deadline, feeBps, expiry)` — client calls; `quoteSig` is an EIP-712 signature from a `QUOTER` key over the quote **plus the funding client's address** (domain binds chainId + escrow address) so clients can't fund made-up quotes and nobody can fund (front-run) another client's quote. `quote.feeBps` must be ≤ the escrow's published `feeBps` (discounts allowed, surcharges impossible even with a compromised quoter). 1–20 milestones. Pulls USDC with `safeTransferFrom`. `createAndFundWithPermit(quote, quoteSig, permitDeadline, v, r, s)` is implemented — Arc USDC supports EIP-2612 (verified onchain, see `00-ARC-FACTS.md`); the permit call is try/catch'd so a front-run permit can't block funding.
- `reassign(taskId, index, newProviderId)` — `OPERATOR_ROLE`; only while milestone FUNDED and amount unchanged.
- `releaseMilestone(taskId, index)` — `OPERATOR_ROLE` (backend after acceptance) **or** client. Splits: `fee = amount * feeBps / 10_000` → FeeDistributor; rest → provider payout address (read from AgentRegistry at release time). Provider must be ACTIVE or SUSPENDED (suspended still gets paid for completed work unless disputed).
- `refundMilestone(taskId, index)` — `OPERATOR_ROLE` → USDC back to client (no fee).
- `openDispute(taskId)` — client only, before all milestones released → status DISPUTED; blocks operator releases.
- `resolveDispute(taskId, index, uint16 clientShareBps)` — `ARBITER_ROLE` (admin multisig in v1). Splits milestone between client refund and provider release (fee only on provider part).
- `refundExpired(taskId)` — **anyone** after `deadline + gracePeriod` (default 7 days) and not disputed → refunds all FUNDED milestones to client. Guarantees clients never depend on Kazi being online.
- Admin: `setFeeBps` (cap 2000 = 20%), `setFeeDistributor`, `pause/unpause` (pause blocks create/release but **never blocks refundExpired**).

Events: `TaskFunded`, `MilestoneReassigned`, `MilestoneReleased(taskId, index, providerId, providerAmount, fee)`, `MilestoneRefunded`, `DisputeOpened`, `DisputeResolved`, `FeeUpdated`.

Rules: `nonReentrant` on every external that moves funds; CEI ordering; custom errors; no `transfer` of native token; USDC only (address immutable).

Invariants (Foundry invariant tests):
- `USDC.balanceOf(escrow) == Σ over tasks (totalAmount − releasedOrRefunded)`
- A milestone pays out at most once.
- Fee ≤ amount × maxFee.
- Client funds are always recoverable after deadline + grace if not disputed.

## 5. `FeeDistributor.sol`

Receives USDC fees from escrow. On `distribute()` (anyone can call, or keeper):
- `treasuryBps` (default 50%) → treasury multisig
- `stakerBps` (default 30%) → `StakingVault.notifyReward`
- `buybackBps` (default 20%) → buyback reserve address (buy $KAZI on a DEX and either burn or send to rewards; executed by multisig in v1, automated later)
- Also holds the insurance pool (slashed $KAZI) with `compensate(to, amount)` by multisig.
- Bps must sum to 10_000; admin-settable within bounds; events for every change.

## 6. Deployment

- `script/Deploy.s.sol`: deploy Token → Registry → FeeDistributor → StakingVault → TaskEscrow (FeeDistributor before StakingVault because the vault takes the insurance pool address in its constructor); wire addresses; grant roles (`OPERATOR`, `QUOTER`, `REGISTRAR`, `SLASHER` to backend signer addresses; `REWARD_NOTIFIER` on the vault to FeeDistributor; `ARBITER` and `DEFAULT_ADMIN` to Safe); renounce deployer admin. Outside `local`, the script refuses an `ADMIN_SAFE` with no contract code (protects against handing admin to an EOA by mistake) and requires `USDC_ADDRESS`. All inputs come from env (list in the script header).
- Write deployed addresses to `packages/config/deployments/<network>.json`.
- Verify on Arc explorer.
- Local: `MockUSDC` with configurable decimals (test both 6 and 18).

## 7. Testing requirements

- Unit tests for every function and revert path.
- Fuzz: amounts, fee bps, milestone counts (1–20), decimals 6 and 18.
- Invariants listed above.
- Fork test against Arc testnet USDC before mainnet.
- Gas snapshot (`forge snapshot`).
- External audit before mainnet with real funds (see `09-SECURITY-COMPLIANCE.md`).

## 8. Phase 1 implementation decisions (2026-10-09)

Decisions made while implementing that the sections above didn't fully specify. Approved where marked.

**Agreed with the founder**
- **ERC-8004:** keep our own `AgentRegistry` as specified. ERC-8004 registries are live on Arc mainnet (`00-ARC-FACTS.md` §4); mirror identities into them in a later phase.
- **ERC-8183:** keep `TaskEscrow` (milestones, disputes, signed quotes go beyond the reference job escrow). Revisit interoperability later.
- **Permit funding:** `createAndFundWithPermit` included (§4).
- **Blocklisted payout addresses:** USDC reverts transfers to blocklisted addresses, so `releaseMilestone` to such a payout reverts. Recovery path: the OPERATOR calls `refundMilestone` (refunds are never blocked by pause or dispute). Tested in `test_release_blocklistedPayout_refundPathWorks`.

**Implementation choices**
- **Token:** `ERC20Votes` uses a **timestamp clock** (`CLOCK_MODE = mode=timestamp`) — Arc's 0.5 s blocks make block-number voting periods awkward.
- **Registry:** status enum has a leading `NONE` sentinel (unknown id); `statusOf` returns `NONE` instead of reverting so escrow can branch on it. `cancelPayoutChange` (owner or REGISTRAR) added so a registrar can stop a malicious payout change during the 48 h delay. `payoutDelay` admin-settable within 1–30 days. `activate` also re-activates a SUSPENDED provider (stake re-checked).
- **StakingVault warm-up:** new stake/bond enters a `pending` bucket. It counts as bonded (for registry min-stake and slashing) but earns nothing until it is ≥ 1 day old **and** the account is touched again (any interaction, or anyone/keeper calling `poke(keys)`). Topping up restarts the warm-up of the pending bucket. Unbonding/unstaking stake never earns. `requestUnstake/Unbond` takes from pending first, then active; a new request restarts the cooldown of the whole unbonding bucket.
- **Rewards math:** reward-per-token accumulator with `1e36` precision (6-dec USDC per 18-dec KAZI would otherwise round to zero at large stake). If no stake is active, notified rewards are queued and added to the next notification. Per-account flooring means a few base units of dust can remain in the vault (`claimed ≤ notified` invariant holds).
- **Slashing:** cap is `maxSlashBps` (default 20%, admin-settable up to 50%) of the provider's **total** stake including pending and unbonding; taken from unbonding first, then pending, then active. Bond withdrawals and provider rewards go to the provider's current owner.
- **Cooldowns:** holder 7 d / provider 14 d, admin-settable within 1 s–60 d; changes apply to new requests only.
- **Escrow:** `gracePeriod` is **immutable** (set at deploy, default 7 days) so clients' self-refund guarantee can't be changed under them. While DISPUTED only the client may release (operator releases blocked); operator refunds stay allowed. `resolveDispute` and `refundMilestone` work while paused; `createAndFund*` and `releaseMilestone` don't. Provider amount rounds down, dust goes to the fee. A disputed task depends on the ARBITER to settle (no dispute timeout in v1 — revisit before mainnet).
- **FeeDistributor:** rounding dust goes to the buyback reserve. `distribute()` requires the vault to be set when `stakerBps > 0`. Default split 50/30/20 per §5; `08-TOKENOMICS.md` Phase 6 can deploy with `STAKER_BPS=0` and enable later via `setSplit`.
- **Testing:** 100% line and branch coverage on `TaskEscrow` and `StakingVault`; full escrow suite re-run with an 18-decimal USDC; invariants from §4 and §3 run as Foundry invariant tests.

## 9. Phase 6 additions (2026-10-10)

- **`KaziAirdrop.sol`**: Merkle distributor with vesting built in (`immediateBps` at `start`, the rest linear over `vestingDuration`), OpenZeppelin leaf encoding (`keccak256(bytes.concat(keccak256(abi.encode(account, amount))))`, sorted pairs), repeated claims of whatever has vested, `claimDeadline` after which the admin can `sweep` the remainder. `AccessControl` + `ReentrancyGuard` + `SafeERC20`, custom errors, events for claims and sweeps; the constructor rejects `immediateBps > 10_000` and deadlines inside the vesting period.
- **`script/DeployTokenLaunch.s.sol`**: team/ecosystem `VestingWallet`s, the airdrop, and the 15/30/10/10/15/20% transfers; mainnet requires the broadcaster to hold the whole supply. Output `deployments/<network>-token-launch.json` (`total` as a string — uint256 overflows JSON numbers).
- **Tests**: `test/TokenLaunch.t.sol` (allocations, vesting schedule, claims at start / midway / end, wrong proofs and amounts, deadline + sweep, fuzzed vesting maths); the worker's `test/phase6.test.ts` deploys `KaziAirdrop` on anvil with a root built by the TypeScript tree (`packages/shared/src/merkle.ts`) and claims through it, so the off-chain proofs and the contract can't drift apart.
- **Staker share**: `FeeDistributor.setSplit` is prepared from Admin → Token for the admin Safe (default 50/30/20 per §5).
