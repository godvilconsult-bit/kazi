# 08 — Tokenomics ($KAZI)

> Design goal: the token's value should come from **platform usage**, not hype. Users pay for tasks in USDC; $KAZI is for staking, quality bonds, fee sharing and governance.
> All numbers below are defaults to discuss — change them before deploying, and get legal review (see `09-SECURITY-COMPLIANCE.md`).

## 1. Supply

- **Fixed total supply: 1,000,000,000 $KAZI.** Minted once at deploy. No mint function. No transfer tax.

| Allocation | % | Vesting |
|---|---|---|
| Ecosystem & agent rewards (new-agent bonuses, task-volume rewards, grants) | 30% | Released by multisig over 48 months, monthly, published schedule |
| Liquidity (DEX pool on Arc, paired with USDC) | 15% | Pool LP tokens locked ≥ 12 months (public lock link) |
| Community launch / public sale or fair launch | 20% | Unlocked at launch |
| Team & founders | 15% | 12-month cliff, then 24-month linear (onchain vesting contract) |
| Treasury (operations, audits, partnerships) | 10% | Multisig; spending reported publicly |
| Early users & arcdex community airdrop | 10% | 25% at TGE, rest linear 6 months; based on real usage snapshot |

Use OpenZeppelin `VestingWallet` for team (and ecosystem) vesting; the airdrop's vesting is built into the Merkle distributor `KaziAirdrop` (one `VestingWallet` per recipient doesn't scale to thousands of wallets — see §7). Publish all addresses.

## 2. Utility

1. **Provider bond (required):** stake to list. Defaults: AGENT 10,000 $KAZI; HUMAN 2,000 $KAZI (lower barrier for freelancers). Admin can adjust; consider pegging the requirement to a USD value later so it doesn't become too expensive if price rises.
2. **Fee sharing:** stakers receive 30% of platform fees **in USDC**, pro rata to stake (incl. provider bonds).
3. **Buyback:** 20% of fees reserved to buy $KAZI from the market; bought tokens are burned or sent to the ecosystem rewards pool (decide and publish).
4. **Fee discount:** clients staking ≥ 5,000 $KAZI get 2 percentage points lower take rate (10% vs 12%).
5. **Ranking boost:** higher bond → small ranking boost (capped at 10% of match score, see `06-ROUTER.md`).
6. **Governance (phase 6+):** vote on fee bps, min bonds, new capability categories, ecosystem grants. Uses `ERC20Votes`.

## 3. Fee flow

```
Client pays milestone (USDC) ──► TaskEscrow
   on release: 88% ──► Provider payout
               12% ──► FeeDistributor
                         ├─ 50% Treasury (ops, audits, salaries)
                         ├─ 30% Stakers (USDC rewards)
                         └─ 20% Buyback reserve ($KAZI buy & burn/rewards)
```

Example: 100,000 USDC monthly task volume → 12,000 USDC fees → 3,600 USDC/month to stakers, 2,400 USDC/month buybacks.

## 4. What NOT to do (lessons from the arcdex coin)

- No buy/sell tax. Traders avoid taxed tokens; revenue must come from the product.
- No unlocked team tokens. No hidden wallets. Publish every allocation address.
- No promises of price, returns or "100x". Show only realized metrics (fees distributed, volume).
- Don't launch the token before the product has real usage. Suggested order: product live on mainnet with USDC payments → 4–8 weeks of real volume → token launch with fee sharing turned on from day one.

## 5. Launch mechanics (options)

- **Fair launch on own DEX/arcdex:** seed USDC/$KAZI pool, lock LP, open trading.
- **Small public sale:** fixed price, per-wallet cap, raises USDC for liquidity + audit. Higher legal risk — get advice.
- **Points → airdrop:** run a points program for clients/agents during the pre-token period; convert to the 10% airdrop allocation. Rewards real usage (anti-sybil: points weighted by USDC fees paid, not task count).
- Consider giving arcdex coin holders a portion of the airdrop to rebuild community trust.

## 6. Metrics page (`/token`) shows

Circulating supply, staked %, fees distributed to stakers (all-time, 30d), buybacks executed, treasury balance, vesting progress, contract addresses. All read from chain/indexer.

## 7. Implementation (Phase 6, 2026-10-10)

Everything below is built and tested on local anvil; nothing is deployed to mainnet (that waits for the audit and legal review).

**Contracts**
- `KaziAirdrop.sol`: Merkle airdrop with vesting built in — each allocation unlocks `immediateBps` (25%) at `start` and the rest linearly over `vestingDuration` (180 days); recipients claim what has vested, as often as they like. Leaves use the OpenZeppelin encoding `keccak256(bytes.concat(keccak256(abi.encode(account, amount))))` with sorted-pair hashing. After `claimDeadline` the admin Safe can `sweep` the unclaimed rest to the treasury. `totalClaimed` is public for the metrics page.
- `script/DeployTokenLaunch.s.sol` (run by the wallet holding the supply): team `VestingWallet` (12-month cliff, then 24 months linear), ecosystem `VestingWallet` (48 months linear), `KaziAirdrop`, then transfers 15/30/10/10/15/20% to team vesting, ecosystem vesting, airdrop, treasury, liquidity and community wallets. On mainnet it refuses to run unless the broadcaster holds the whole supply. Writes `packages/config/deployments/<network>-token-launch.json`, which the API loads (`loadTokenLaunch`).
- Airdrop vesting lives in `KaziAirdrop` instead of one `VestingWallet` per recipient. Team and ecosystem use OpenZeppelin `VestingWallet`; the team wallet's beneficiary should be a Safe (several founders), not an EOA.

**Points (pre-token)** — `apps/worker/src/points/points.ts`, rules in `packages/shared/src/points.ts`
- Clients earn 100 points per 1 USDC of fees their released milestones paid; providers 50 per 1 USDC of fees their accepted work generated. Service-fee milestones count in full for the client.
- Sybil heuristics: self-dealing (client = provider owner or payout address) → 0; tasks under 1 USDC → 0; more than 5 tasks between the same client and provider owner in 30 days → 20%; at most 50,000 points per user per day. Kazi's own house agents earn no provider points (their clients still do).
- Recomputed daily (`points-daily` job) and idempotent (one row per user, task and role, rewritten each run). `/points` shows the total, each entry with the reason when it was reduced, the leaderboard (shortened wallets) and the rules, with "points are not a promise of tokens".

**Airdrop snapshot** — `pnpm -F @kazi/worker airdrop:snapshot -- --airdrop-id <id> --total <KAZI> [--fixed list.csv] [--min-points 100] [--max-share-bps 100] [--write]`
- Recomputes points, drops Kazi's own wallets (admins, `ADMIN_WALLETS`, house-agent owners) and `--exclude`, pays `--fixed` allocations first (e.g. a published arcdex community list), then splits the rest pro rata to points among wallets with at least `--min-points`, capping any wallet at `--max-share-bps` of the total and re-splitting the excess. Rounding dust and anything left unallocated stays in the contract and is swept to the treasury after the deadline.
- Writes the plan (root, every allocation and proof) to a JSON file; `--write` stores the allocations (`AirdropAllocation`) so `GET /airdrop/:wallet` can serve proofs. The same inputs always produce the same root.

**Launch order (runbook)**
1. Freeze the snapshot: `airdrop:snapshot … --write`; publish the plan file.
2. Run `DeployTokenLaunch` with `AIRDROP_MERKLE_ROOT` = the root (and the multisig addresses); publish every address.
3. Set `AIRDROP_ID` on the API and restart it; `/airdrop` goes live.
4. Turn on the stakers' share: Admin → Token → "Turn on the stakers' share (50 / 30 / 20)" produces `FeeDistributor.setSplit` calldata for the admin Safe.
5. Seed the DEX pool from the liquidity multisig and lock the LP tokens (outside this repo).

**Staking (`/stake`)** — exact approval + `stake`, `requestUnstake` (takes warm-up stake first; restarts the cooldown for everything already unstaking, and the page says so), `withdraw` after the cooldown, `claim` USDC. Warm-up (1 day) and cooldown (7 days) are read from the vault. Rewards are shown only as *realized*: USDC distributed to stakers over the last 30 days per 1,000 KAZI of earning stake — never an APR. The vault activates matured warm-up stake lazily, so the fee keeper pokes every matured account before each `distribute()` and the page offers an "Activate" button.

**Staker fee discount** — clients with at least 5,000 KAZI of *earning* stake (warm-up excluded) are quoted a 10% take rate instead of 12% (`clientFeeBps` in the router; the signed quote carries the fee, which the escrow caps at its published fee).

**Provider bond** — on by default in the web app (`NEXT_PUBLIC_FEATURE_BOND=0` restores the pre-launch notice). Networks whose registry minimum is 0 show no bond step.

**Geo restriction hooks** — `GEO_RESTRICTED_COUNTRIES` (comma-separated ISO codes, read by the web server) and `GEO_COUNTRY_HEADER` (the header your CDN sets: Cloudflare `cf-ipcountry`, Vercel `x-vercel-ip-country`, CloudFront `cloudfront-viewer-country`). Visitors from a listed country can't stake or claim airdropped tokens; unstaking, withdrawing and claiming earned USDC always stay available. The contracts remain permissionless — this only changes the UI. Bonds are not restricted (they're required to list). The country list is a legal decision; `.env.example` suggests a starting point.

**Not built (deliberately)**: a public sale page (higher legal risk; if added, gate it with the same geo hook), automated buybacks (the buyback reserve is spent by the multisig), governance voting UI (`ERC20Votes` is in the token; Phase 8), and a USD-pegged bond minimum.

## 8. KAZI on Argus ⇄ KAZI Credits (owner decision, 2026-10-11)

The owner will launch the public **KAZI** token on Argus, a third-party launchpad on Arc. Argus puts the whole supply into a Uniswap v4 pool, so the creator gets no tokens; the creator earns from the trading tax and pool fees. Kazi's own token, `KaziToken`, becomes **KAZI Credits** (symbol `KCRED` on mainnet). Every Kazi contract keeps using it unchanged: staking, provider bonds, the fee discount and the airdrop. The two are joined 1:1 by `KaziCreditsGate`:

- **`lock(amount)`**: take KAZI, pay the same amount of Credits from the gate's reserve.
- **`unlock(amount)`**: take Credits back, return the same amount of KAZI. Anyone holding Credits can exit, up to the KAZI locked. Unlock is never paused or geo-restricted.
- **The reserve is the whole Credits supply** on mainnet. When `ARGUS_KAZI_ADDRESS` is set in `.env.mainnet`, `deploy-mainnet.ts` moves the supply straight into the gate. Every Credit in circulation then came out of the gate against locked KAZI. `fullyBacked()` checks this, and `/token` shows it.
- **Nobody can take the locked KAZI or the reserve**, not the Safe and not Kazi. The guardian can pause `lock` if the Argus token is ever compromised, for example by a minting bug; only the Safe unpauses.
- **Fee-on-transfer tokens are refused**: `lock` checks what actually arrived. The decimals of the two tokens must match (18).
- **Rehearsed** on a local fork of Arc mainnet with a stand-in token: all 24 role, supply and gate checks passed, then lock → stake → unlock. Tests: 18 unit and fuzz tests, plus 3 invariants (locked KAZI is held, Credits are backed 1:1, no value is created or lost), with 100% line and branch coverage.

**In the app**
- `/stake` gains a "Get KAZI Credits" card (lock and unlock) above the staking position.
- Wherever the gate exists, the UI calls Kazi's token "KAZI Credits" (`lib/token-name.ts`).
- `/token` shows the KAZI locked, the Credits outside the exchange, whether they are fully backed, and both contract addresses. The gate's unissued reserve doesn't count as circulating.

**Consequences**
- The allocations in §1 (team, ecosystem, airdrop, treasury) no longer come from minted supply: the whole Credits supply backs the gate. Fund them by locking KAZI the project holds, or pay them in KAZI directly. `DeployTokenLaunch` still works for any Credits a wallet holds.
- The staker USDC share stays 0 during the guarded launch (§3, docs/09).
- Only the address in `<network>-credits-gate.json` is the real KAZI. Others can launch tokens with the same name.
- The legal review in docs/09 §4 covers selling KAZI. Argus's buy/sell tax goes against §4 ("no buy/sell tax"); this is the owner's call.

**If the Argus KAZI comes after the mainnet deploy**: run `DeployCreditsGate.s.sol` with `FUND_RESERVE_AMOUNT=0`. Then the Safe moves its Credits into the gate with one `transfer` in the Safe app's Transaction Builder (Safe{Wallet} supports Arc).

**KAZI on Argus — facts (checked onchain 2026-10-11)**
- `0x9A4dE59eCB39c85E00687006E55624298D75F79b`, "KAZI LABS" (KAZI), 18 decimals, 1,000,000,000 supply, created at Arc mainnet block 25,355,364. Argus minted the supply to its portal, which put it into the Uniswap v4 pool.
- Argus pays holders dividends in USDC through its escrow `0x9119…8155` (10% of routed revenue; the creator gets 70%). The pool, the portal and the burn address are excluded; exclusions are frozen.
- **Locked KAZI stops earning Argus dividends for the person who locked it.** The gate holds that KAZI, so Argus counts the gate as the holder. Anyone can call Argus's `claimDividendsFor(gate)`, and the gate has no way to pass that USDC on. Owner's decision (2026-10-11): leave dividends to Argus. The exchange card says so.
- **Rehearsal** with the real token and the owner's real Safe owners and guardian, on a fork of Arc mainnet: all 24 deploy checks passed. Lock 1,000 → 1,000 Credits, with exactly 1,000 KAZI arriving (no transfer fee). Return 400 → 400 KAZI back. Fully backed throughout.
