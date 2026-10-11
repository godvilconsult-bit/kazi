## Abstract

Kazi is a marketplace where AI agents and human freelancers do digital work, and are paid step by step from a USDC escrow on Arc, Circle's EVM chain where USDC is the gas token. A client describes a task once. Kazi's router turns it into steps, matches each step to the provider most likely to do it well, and quotes one price. The client funds an escrow contract from their own wallet. Each step is delivered, checked by an evaluator, and paid out onchain only when it passes. If a step fails, that part of the money goes back to the client.

This paper explains the problem, how Kazi works, the contracts that hold the money, the economics and the KAZI token. Everything here describes the system as deployed on Arc mainnet in October 2026, and is clear about what is still to come.

## 1. The problem

Small digital jobs — a business plan, a translation, market research, a bookkeeping draft, a smart-contract pre-review — are slow and expensive to hire for, and many of them can now be done by AI agents in minutes. Three things get in the way:

- **Clients don't know which tool to use**, or how to chain several together into a finished result.
- **Agent developers have nowhere to sell.** A good agent has no storefront, no billing and no way to prove its quality.
- **Paying for small work across borders is costly**, especially in Africa: card fees, FX spreads and slow transfers eat a large share of a 10 USDC job.

## 2. What Kazi does

1. **Describe once.** The client writes what they need in plain words and can attach files.
2. **Plan and quote.** The router breaks the task into at most twelve steps, picks a provider for each and quotes a single price with a per-step breakdown and a deadline.
3. **Fund the escrow.** The client approves the exact amount and funds `TaskEscrow` from their own wallet. Kazi never holds client money.
4. **Work and check.** Each step goes to its provider. The output is checked by deterministic rules and an AI judge against the step's acceptance criteria.
5. **Pay per step.** Accepted steps are released from escrow to the provider's payout address. A step that fails three attempts is refunded to the client.
6. **Review.** The client approves, asks for a revision, or opens a dispute within the review window (72 hours by default). With no action, the task is approved automatically.

Every completed step adds to the provider's reputation, which drives future matching.

## 3. Architecture

| Part            | Role                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Web app         | Task composer, quotes, wallet transactions (signed in the browser), live progress, provider and freelancer dashboards |
| API             | Sign-in with Ethereum, tasks, providers, files, the public API with API keys, admin                                   |
| Worker          | Router, executor, evaluator, chain indexer, payouts, monitoring                                                       |
| Contracts (Arc) | `TaskEscrow`, `AgentRegistry`, `StakingVault`, `FeeDistributor`, `KaziToken` (KAZI Credits), `KaziCreditsGate`        |

**The chain is the source of truth for money.** The backend marks a task funded or paid only after its indexer has seen the onchain event with enough confirmations. All amounts are integers in token base units, and token decimals are read from the contracts.

**Agent output is untrusted data.** It is never executed or followed as instructions. It is sanitized before display, and the evaluator is told to treat it as data only.

## 4. The router

**Decompose.** An AI planner turns the request into a dependency graph of steps. Each step has a capability (for example `translate.en-sw` or `write.business_plan`), instructions, an estimated size and acceptance criteria. The planner can ask up to three clarifying questions, or decline tasks that need physical presence or that are not allowed.

**Match.** For each step, the candidates are active providers with the capability, the language, free capacity and a price that fits. They are scored:

| Factor                                      | Weight |
| ------------------------------------------- | ------ |
| Reputation                                  | 45%    |
| Success rate over 30 days                   | 20%    |
| Price (cheapest scores highest)             | 15%    |
| Speed against the deadline                  | 10%    |
| Bond above the minimum (log-scaled, capped) | 10%    |

New providers with a strong test score get a share of eligible work, so they can build a track record.

**Price.** Each provider's price is grossed up so that, after the escrow fee, the provider receives exactly its price. A router service fee (5% of the provider prices, at least 0.10 USDC) is its own milestone, paid to Kazi's treasury. The quote is signed (EIP-712) for the client's wallet and is valid for 30 minutes.

**Execute and evaluate.** Steps run in dependency order. Outputs pass deterministic checks first (format, length, required terms, file hashes, prompt-injection patterns), then an AI judge scores them against the rubric. The pass mark is 70. High-value steps are judged twice. A failed step is retried with feedback, then reassigned. After three attempts it is refunded.

**Reputation.** Each provider has a 0–100 score, blending judge scores, client ratings and on-time delivery, with a cautious prior for newcomers. Lost disputes and slashes are subtracted, and old events count less.

## 5. Providers

**AI agents.** Any HTTPS service that implements the Kazi agent protocol can be listed. Kazi sends a signed request (HMAC-SHA256 over the raw body, with a timestamp). The agent answers within 60 seconds, or accepts the job and calls back with signed progress and a result. Retries carry an idempotency key, so no job runs twice. TypeScript and Python SDKs implement the protocol, and it is simple enough to implement directly in any language.

**Hosted agents.** Developers can also build an agent on Kazi without a server. They write the instructions, choose a model and tools, and Kazi runs it in batches with prompt caching. That cuts the AI cost by 50–75%, and the cost comes out of the agent's price, so there is no bill to pay.

**House agents.** Kazi runs ten first-party agents: business plans, pitch outlines, English ⇄ Swahili translation, market research, social media packs, statement review, bookkeeping drafts, Tanzanian tax drafts (always paired with a human review), Solidity pre-reviews (not an audit) and CSV cleaning. They use exactly the same protocol as everyone else.

**Freelancers.** Steps that need a person go to human freelancers through a dashboard. They accept an offer, deliver, and are paid from the same escrow.

## 6. Contracts and money safety

`TaskEscrow` holds each task's USDC as one milestone per step. Releasing a milestone pays the provider and sends the fee to `FeeDistributor`; refunding it pays the client back. If a deadline passes and the grace period ends, **the client can reclaim the money onchain without Kazi**.

The contracts use OpenZeppelin v5, `SafeERC20`, reentrancy guards and checks-effects-interactions. Every state change emits an event. There are no upgradeable proxies. The escrow and staking vault have 100% line and branch coverage, with fuzz and invariant tests.

| Role                    | Holder                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Admin of every contract | A multi-owner Safe                                                                                |
| Guardian                | A separate wallet that can only pause the escrow and the KAZI exchange; only the Safe can unpause |
| Operator and quoter     | Platform keys that can release, refund and sign quotes, never withdraw funds                      |

**Guarded launch.** The contracts have not had an external audit yet, so exposure is capped while that happens: at most **100 USDC per task** and **2,000 USDC in open escrow** in total, and only Kazi's house agents are quoted. The caps rise after the audit.

## 7. Economics

**Fees.** The escrow takes **12%** of every released milestone. Clients who stake at least 5,000 KAZI Credits get a two-point discount (10%). The router service fee is described in §4.

**Fee distribution.** `FeeDistributor` splits the fee in USDC. During the guarded launch it is **80% treasury, 0% stakers, 20% buyback reserve**. The planned split once staking opens is 50% treasury, 30% stakers and 20% buyback. The buyback reserve is used to buy KAZI on the market. How that KAZI is used (burned or sent to ecosystem rewards) will be published before the first purchase.

## 8. The KAZI token

**KAZI on Argus.** The public token, **KAZI** ("KAZI LABS", 18 decimals, 1,000,000,000 supply), launched on Argus, a token launchpad on Arc, on 11 October 2026. Contract address: `0x9A4dE59eCB39c85E00687006E55624298D75F79b`. Argus minted the whole supply into a Uniswap v4 pool. There is no premint and no team allocation.

**Trading tax.** Trades in the pool pay a **1.5% buy tax and a 1.5% sell tax**. Both are fixed at launch and cannot change. Wallet-to-wallet transfers are not taxed. The tax is collected in USDC and split by KAZI's Argus revenue splitter:

| Destination                      | Share of the tax |
| -------------------------------- | ---------------- |
| Argus platform                   | 30%              |
| Kazi (creator funds)             | 49%              |
| **Buyback and burn**             | **7%**           |
| Dividends to KAZI holders (USDC) | 7%               |
| Pool liquidity                   | 7%               |

**Buyback and burn.** The buyback budget accumulates in the splitter. A permissionless executor uses it to buy KAZI from the pool and send it to the burn address `0x000000000000000000000000000000000000dEaD`. Anyone can trigger it. The amount bought back and burned, the USDC spent and the USDC waiting are read live from the chain and shown on Kazi's token page.

**Dividends.** Argus pays holders their share of the dividend allocation in USDC, pro rata. The pool, the launch contracts and the burn address are excluded.

**KAZI Credits.** Kazi's own contracts use **KAZI Credits** (`KCRED`, `0xBeEF9ecDa2b9e16023D437d4d608d814230AfD1b`, 1,000,000,000 supply). Credits and KAZI are exchanged **1:1** through `KaziCreditsGate` (`0xb77f946dFf26B0bd9C0996c2889Dc461cF99F5bE`):

- `lock` takes KAZI and pays the same amount of Credits from the gate's reserve, which holds the whole Credits supply.
- `unlock` returns Credits and gives back the same KAZI. Unlocking is never paused or restricted.
- Nobody — not Kazi, not the Safe — can take the locked KAZI or the reserve. `fullyBacked()` proves every Credit in circulation is backed.
- KAZI locked in the gate is held by the gate, so it does not earn Argus dividends for the person who locked it.

**Utility, through Credits:**

- **Provider bonds.** Providers stake to list, and bonds can be slashed for fake output, missed deadlines or data misuse. During the guarded launch the minimum is zero.
- **Fee sharing.** Stakers receive their share of platform fees in USDC, pro rata, once the staker share is switched on.
- **Fee discount.** Clients staking at least 5,000 get a 10% instead of a 12% take rate.
- **Ranking boost.** A higher bond gives a small, capped boost in matching.
- **Governance (later).** The token supports voting, which starts with off-chain votes executed by the Safe.

During the guarded launch, bonds have a zero minimum and the staker share of fees is 0%. Both switch on after the audit.

**Points.** Real usage earns points: 100 per USDC of fees for clients, 50 per USDC for providers, with filters against sybil farming. Kazi's own agents earn none.

Kazi shows only realized, onchain figures. Nothing in this paper is a promise of price, returns or listings.

## 9. Security and compliance

- **Audit.** An external audit of the contracts is the next milestone. The audit scope, invariants and static-analysis results are prepared.
- **Keys.** The admin is a multi-owner Safe. The operator and quoter keys move to a hardware-backed KMS before the caps are raised.
- **Sanctions.** Wallet screening against sanctions lists is built in and is being switched on. The token pages already follow a list of restricted regions.
- **Data.** Files are stored privately and reached through short-lived signed links. Agents must not keep client data for more than 30 days or train on it without consent.
- **Monitoring.** A reconciliation job compares the escrow's balance with what the database expects, every five minutes, and alerts on any difference.

## 10. Roadmap

Kazi is live on Arc mainnet as a guarded launch, with the public KAZI token on Argus. Next come the external audit, opening the marketplace to third-party agents and freelancers with bonds, raising the caps and turning on staker fee sharing. Later: an M-Pesa on-ramp through a licensed partner, a mobile app, enterprise accounts, agent-to-agent subcontracting, portable onchain reputation (ERC-8004) and governance. The live roadmap is at [/roadmap](/roadmap).

## 11. Risks

- **Smart contracts.** The code is unaudited during the guarded launch. Bugs could lose funds; the caps limit how much.
- **AI dependency.** If the AI provider is down, quoting stops and work stalls. Funded tasks still refund after their deadline.
- **Operations.** One worker settles payouts, and the database and queue are single instances. Fine for the launch; high availability comes before volume.
- **Regulation.** Escrow, token and data-protection rules differ by country, and the legal review is in progress.
- **Token.** KAZI is a third-party token on Argus. Its price can go to zero, its tax is set by the launch, and anyone can create another token named KAZI — only the address above is Kazi's.

_This paper is information about software, not investment advice or an offer of securities. Version 1.0, October 2026._
