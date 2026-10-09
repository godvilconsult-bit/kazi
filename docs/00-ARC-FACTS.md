# 00 — Arc Facts (verified 2026-10-09)

Source of truth for chain values used in `packages/config`. Every value below was read from the official Arc docs (now at **docs.arc.io**; `docs.arc.network` 301-redirects there) and, where possible, checked directly onchain with `cast` against the public RPC on 2026-10-09. Anything not confirmed is marked **UNVERIFIED**. Re-check before each mainnet deploy.

## 1. Networks

|                      | Arc Mainnet                                                                                                                                 | Arc Testnet                                                                                 | Source                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Network name         | `Arc`                                                                                                                                       | `Arc Testnet`                                                                               | [connect-to-arc](https://docs.arc.io/arc/references/connect-to-arc) |
| Chain ID             | **5042** (`0x13b2`)                                                                                                                         | **5042002** (`0x4cef52`)                                                                    | same; confirmed onchain via `cast chain-id`                         |
| Primary RPC (HTTP)   | `https://rpc.mainnet.arc.io`                                                                                                                | `https://rpc.testnet.arc.io`                                                                | same                                                                |
| Alternate RPC (HTTP) | `rpc.blockdaemon.mainnet.arc.io`, `rpc.drpc.mainnet.arc.io`, `rpc.quicknode.mainnet.arc.io`, Alchemy (`arc-mainnet.g.alchemy.com/v2/<key>`) | `rpc.blockdaemon.testnet.arc.io`, `rpc.drpc.testnet.arc.io`, `rpc.quicknode.testnet.arc.io` | same                                                                |
| WebSocket            | No primary listed. Alternates: `wss://rpc.blockdaemon.mainnet.arc.io/websocket`, `wss://rpc.quicknode.mainnet.arc.io`, Alchemy              | `wss://rpc.testnet.arc.io` (+ provider alternates)                                          | same                                                                |
| Explorer             | `https://explorer.arc.io`                                                                                                                   | `https://explorer.testnet.arc.io`                                                           | same                                                                |
| Native currency      | USDC, **18 decimals**                                                                                                                       | USDC, **18 decimals**                                                                       | same                                                                |
| Faucet               | none                                                                                                                                        | `https://faucet.circle.com`                                                                 | same                                                                |
| Status               | **Live**: block 25,041,803 at time of check                                                                                                 | Live: block 66,277,214                                                                      | onchain `cast block-number`                                         |

## 2. USDC

|                                      | Mainnet                                                           | Testnet                                      | Source                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ERC-20 address                       | `0x3600000000000000000000000000000000000000`                      | `0x3600000000000000000000000000000000000000` | [contract-addresses](https://docs.arc.io/arc/references/contract-addresses)                                         |
| ERC-20 `decimals()`                  | **6** (onchain)                                                   | **6** (onchain)                              | `cast call … "decimals()(uint8)"`                                                                                   |
| `name()` / `symbol()` / `version()`  | `USDC` / `USDC` / `2`                                             | same                                         | onchain                                                                                                             |
| EIP-2612 `permit`                    | **Supported**: `DOMAIN_SEPARATOR()` and `nonces(address)` respond | same                                         | onchain probe. The docs don't mention it.                                                                           |
| EIP-3009 `transferWithAuthorization` | **Supported**: `authorizationState(address,bytes32)` responds     | same                                         | onchain probe + [EIP-3009 relayer guide](https://docs.arc.io/integrate/relayers-and-paymasters/eip-3009-relayer.md) |

**Native vs ERC-20 decimals.** Per [evm-differences](https://docs.arc.io/arc/references/evm-differences): native USDC (gas, `msg.value`, `eth_getBalance`) uses 18 decimals, and the ERC-20 interface uses 6. Both read one shared balance, so there's no wrapping. `balanceOf` truncates sub-micro-USDC dust, so "a zero `balanceOf` doesn't mean the native balance is zero." **Kazi rule:** escrow and all money logic use the ERC-20 interface only. Never mix `msg.value`/native balances with `balanceOf` math (off by 10¹²). Read `decimals()` at startup, as `CLAUDE.md` already requires.

**Blocklist.** Transfers to or from blocklisted addresses revert (evm-differences, plus a blocklisted test address on testnet: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`). **Design impact for Phase 1:** a `releaseMilestone` to a blocklisted provider payout would revert and the milestone would be stuck, so escrow needs a path for this (e.g. arbiter refund). Flag in the Phase 1 summary.

## 3. Gas, finality, blocks

From [gas-and-fees](https://docs.arc.io/arc/references/gas-and-fees.md) and [evm-differences](https://docs.arc.io/arc/references/evm-differences):

- Gas is paid in native USDC. Base-fee **floor 20 Gwei**. Transactions with `maxFeePerGas` below 20 Gwei "are silently dropped by the mempool" (no receipt). Ceiling 20,000 Gwei. Target ≈ $0.001 per ERC-20 transfer.
- `maxPriorityFeePerGas` 0 is accepted. A ~1 Gwei tip helps under load.
- Block time **0.5 s**, 30M gas per block. Timestamps have 1-second granularity, so several blocks can share a `block.timestamp`.
- **Finality is deterministic and instant.** "Offchain systems can act after a single confirmation." The Kazi `CONFIRMATIONS` default of 2 is conservative and fine.
- The gas page notes that its values "reflect Testnet and may change". Re-check periodically.
- EVM differences relevant to us: `PREVRANDAO` = 0 (never use for randomness). No blob transactions. `CREATE2` and EIP-7702 behave as on Ethereum. Value transfers to `0x0` revert.

## 4. System contracts we may use

All from [contract-addresses](https://docs.arc.io/arc/references/contract-addresses). They're the same on both networks unless noted.

| Contract                             | Mainnet                                      | Testnet                                                     |
| ------------------------------------ | -------------------------------------------- | ----------------------------------------------------------- |
| Multicall3                           | `0xcA11bde05977b3631167028862bE2a173976CA11` | same                                                        |
| Permit2                              | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same                                                        |
| CREATE2 factory (Arachnid)           | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | same                                                        |
| GatewayWallet                        | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`                |
| GatewayMinter                        | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`                |
| CCTP TokenMessengerV2 (domain 26)    | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`                |
| ERC-8004 IdentityRegistry            | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e`                |
| ERC-8004 ReputationRegistry          | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713`                |
| ERC-8004 ValidationRegistry          | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272`                |
| ERC-8183 AgenticCommerce (reference) | —                                            | `0x0747EEf0706327138c69792bF28Cd525089e4583` (testnet only) |

## 5. Circle Gateway, Nanopayments / x402, "Agent Stack"

| Item                                                            | Status                                                                                                                                                                                                                                                                                                                        | Source                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Circle Gateway**                                              | **Supported on Arc mainnet and testnet** (domain 26, chain keys `arc` / `arcTestnet`, ~1 block confirmation). Contracts deployed (table above).                                                                                                                                                                               | [Gateway supported blockchains](https://developers.circle.com/gateway/references/supported-blockchains), contract-addresses             |
| **Nanopayments** (Gateway-based, used for x402 pay-per-request) | Gateway "supports nanopayments on all blockchains except Solana", which implies Arc. A Quicknode launch post described Arc testnet as supported for prototyping, with mainnet coverage rolling out. **Arc mainnet nanopayments: UNVERIFIED.**                                                                                 | Gateway page above, [Quicknode blog](https://blog.quicknode.com/nanopayments-powered-by-circle-gateway-live-on-mainnet-with-quicknode/) |
| **x402**                                                        | Arc docs list a sample app: "Autonomous AI agent pays for premium API endpoints in USDC fractions using Circle Nanopayments and the x402 protocol" ([circlefin/arc-nanopayments](https://github.com/circlefin/arc-nanopayments)). No official per-network support statement found. **UNVERIFIED for mainnet production use.** | [agentic-economy](https://docs.arc.io/build/agentic-economy.md)                                                                         |
| **"Circle Agent Stack"**                                        | No page by that name in Arc or Circle docs. **UNVERIFIED / possibly renamed.** The closest current pieces are ERC-8004 registries, ERC-8183 jobs, Gateway Nanopayments + x402, and Circle Wallets.                                                                                                                            | searches above                                                                                                                          |

## 6. Open design questions raised by these facts (not decided, not acted on)

These came up while verifying. Per `CLAUDE.md`, nothing in the docs has been changed for them. Decide before or during Phase 1:

1. **ERC-8004 is live on Arc mainnet.** `03-SMART-CONTRACTS.md` §2 says "optional later: align with ERC-8004". Options: (a) keep our own `AgentRegistry` as specced and mirror identities into ERC-8004 later, or (b) register providers in the ERC-8004 IdentityRegistry and keep only bond/payout/status logic in `AgentRegistry`.
2. **ERC-8183 (agentic job escrow) has a reference implementation on testnet.** It overlaps with `TaskEscrow`. Our milestone/dispute/quote-signature design is richer, so the recommendation is to keep `TaskEscrow` and revisit interoperability later.
3. **USDC supports EIP-2612 permit**, so `createAndFundWithPermit` (spec §4) is feasible and saves the client a transaction. It's worth including in Phase 1.
4. **Blocklisted payout addresses** (see §2): escrow needs a release-failure path.
