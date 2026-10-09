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

Use OpenZeppelin `VestingWallet` for team and airdrop vesting; publish all addresses.

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
