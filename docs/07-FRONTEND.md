# 07 — Web Frontend (Next.js 15, Tailwind, shadcn/ui, wagmi v2)

## 1. Principles

- Clear money UX: always show amounts in USDC with 2 decimals, exact values on hover; show gas will be paid in USDC.
- Every onchain step shows: what will happen, the amount, and a link to the explorer after sending.
- Mobile-first layouts (most target users are on phones). Light + dark themes.
- i18n ready from day one (`next-intl`): English, Swahili, French, Spanish, German, Swedish, Russian, Chinese and Arabic (right to left).
- Agent output is rendered as sanitized markdown (`rehype-sanitize`), never raw HTML.

## 2. Wallet

- wagmi v2 + viem, Arc chain defined from `packages/config` (custom chain object: id, name, nativeCurrency USDC, rpcUrls, blockExplorers).
- Connectors: injected (MetaMask/Rabby), WalletConnect, Coinbase Wallet. Later: Circle user-controlled wallets / embedded wallet for email users.
- SIWE login after connect. Detect wrong network → prompt switch/add Arc.
- USDC balance display; "Get USDC on Arc" help page (bridge links, later M-Pesa on-ramp).

## 3. Pages

**Public**
- `/` — landing: "Describe a task. Agents do it. Pay in USDC." + live stats (tasks completed, agents, volume) + top agents + how it works + for developers CTA.
- `/agents` — directory with filters (capability, language, kind, price, reputation), sort.
- `/agents/[slug]` — profile: description, capabilities, pricing, reputation chart, recent ratings, stake, onchain ID link.
- `/developers` — why list, how it works, docs links, SDK quickstart.
- `/token` — $KAZI utility, fee-sharing stats (fees distributed, staked %, buybacks), contract addresses. **No price predictions or return promises.**

**Client app**
- `/new` — task composer: textarea with examples, file upload, budget (optional), deadline picker → "Get quote".
- `/tasks/[id]` — single page that changes by status:
  - QUOTED: plan steps, agents, ETA, total; Clarifying questions if any; buttons Approve & Fund / Edit / Cancel. Fund flow: (1) approve USDC (exact amount, not infinite) (2) createAndFund. Stepper with tx states.
  - FUNDED/IN_PROGRESS: live timeline via SSE (step cards with status, progress bar, agent name); outputs appear as steps complete.
  - DELIVERED: deliverables viewer (markdown, file downloads), Approve / Request revision / Dispute; countdown to auto-approve.
  - COMPLETED: receipt, invoice PDF, rating form, explorer links for each payout.
- `/tasks` — list with status filters.

**Provider app**
- `/provider/new` — wizard: kind → details → capabilities → pricing → endpoint + manifest URL (agents) → payout address → stake bond (approve $KAZI + bond tx) → submit for review.
- `/provider/[id]` — dashboard: earnings (chart), tasks, success rate, latency, reputation, recent submissions with evaluator feedback, API secret rotate, test console.
- `/freelancer/offers` — incoming offers, accept/decline; `/freelancer/subtasks/[id]` — instructions, input files, submit form.

**Staking**
- `/stake` — stake/unstake $KAZI, cooldown status, claimable USDC rewards, claim button, APR shown as *trailing 30-day realized* only (never projected).

**Admin** (`/admin`, role-gated)
- Provider review queue, disputes (evidence, outputs, propose resolution → generates Safe tx), slashing form, queue health, reconciliation view, settings.

## 4. Components (shadcn based)

`TaskComposer`, `QuoteCard`, `StepTimeline`, `TxStepper`, `UsdcAmount`, `AddressPill` (with explorer link), `AgentCard`, `ReputationBadge`, `OutputViewer` (sanitized markdown + files), `RatingForm`, `DisputeDialog`, `StakePanel`, `EmptyState`, `ErrorState`.

## 5. Data fetching

- TanStack Query for REST; typed client generated from shared Zod schemas (e.g. `zod-to-ts` types + small fetch wrapper).
- SSE hook `useTaskEvents(taskId)` merges events into the query cache.
- Contract reads via wagmi `useReadContract`; ABIs imported from `packages/contracts/out` via a generated `packages/shared/src/abis.ts` (use `@wagmi/cli` with the Foundry plugin).

## 6. Testing

- Playwright e2e on local stack (anvil + mock USDC): post task → quote (mock LLM) → fund → house echo agent completes → approve → payout visible.
- Component tests for amount formatting and tx stepper error states.

## 7. Implementation notes (Phase 4, 2026-10-10)

- **Versions** (pinned, each ≥ 2 weeks old when added): Next.js 15.5.26 (App Router, webpack dev), React 19.3, wagmi 2.19.5 + viem 2, TanStack Query 5.103, next-intl 4.14.7, Tailwind 4.3.3, react-markdown 10 + remark-gfm + rehype-sanitize, Playwright 1.63 (runs on the installed Microsoft Edge, no browser download). UI kit is hand-written in the shadcn style (`src/components/ui.tsx`, server- and client-safe; `dialog.tsx` is the only client-only primitive).
- **Config**: the root layout reads `GET /config` on the server (chain, public RPC, explorer, contracts, token decimals, display settings) and passes it to the client providers, so nothing chain-specific is hardcoded in the web app. If the API is unreachable the app shows an offline page.
- **Wallets**: injected (EIP-6963 discovery: MetaMask, Rabby, Coinbase extension…), Coinbase Wallet, WalletConnect when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set, and a mock connector only when `NEXT_PUBLIC_E2E_WALLET` is set on a local chain. SIWE via `viem/siwe`; the session is the API's httpOnly cookie, refreshed transparently on 401. Every write applies Arc's fee floor (`minMaxFeePerGasWei`) and switches chain first.
- **Fund flow**: exact `approve(escrow, total)` (skipped when the allowance already covers it) → `createAndFund(quote, sig)`. The task turns FUNDED only when the indexer sees `TaskFunded`; the page listens over SSE.
- **i18n**: nine languages (`src/i18n/locales.ts`: en, sw, fr, es, de, sv, ru, zh, ar) with a cookie-based locale (no URL prefix), set from the header's language menu or else the browser's Accept-Language. Arabic renders right to left (`<html dir>`), so components use logical classes (`ms-`, `pe-`, `text-start`, `start-0`) instead of left/right ones. Message keys are type-checked (`src/global.d.ts`), and a unit test keeps every catalog in key/placeholder parity with `en.json`; English fills any key a catalog misses at runtime. Long-form pages (`/docs`, `/whitepaper`, from `src/content/<kind>/<locale>.md`) are English for now and use a translation as soon as its file is added in `lib/content.ts`; `/roadmap` lives in the message catalogs, so it is translated. next-intl is wired with a webpack alias instead of `next-intl/plugin` (the plugin loads `@swc/core`, whose native binary caches under `%LOCALAPPDATA%`).
- **Security**: CSP headers (no third-party scripts; `unsafe-eval` only in development), agent output rendered as sanitized markdown with images stripped (a remote image would leak the viewer's IP) and links `noopener noreferrer nofollow`, task text never put in URLs (landing → composer uses sessionStorage), uploads go straight to storage with a client-computed sha256.
- **Provider bond**: on since Phase 6 (`NEXT_PUBLIC_FEATURE_BOND=0` shows the pre-launch notice instead). Exact `approve` of what's missing, then `StakingVault.bond`; hidden on networks whose registry minimum is 0 (testnet listings are reviewed and activated by Kazi).
- **Pages**: `/`, `/agents`, `/agents/[slug]`, `/developers`, `/get-usdc`, `/new`, `/tasks`, `/tasks/[id]`, `/provider`, `/provider/new`, `/provider/[id]`, `/freelancer/offers`, `/freelancer/subtasks/[id]`, `/notifications`, `/admin`.
- **Tests**: `pnpm -F @kazi/web test` (money formatting, tx stepper error states, translation parity); `pnpm -F @kazi/web e2e` boots an isolated stack (fresh anvil, `kazi_test_e2e` DB, mock LLM, house agents, API, worker, web on :3100) and runs the client happy path in Edge.
- **Base Account connector**: `wagmi/connectors` re-exports it; its SDK pulls optional x402 packages that aren't installed, so `@base-org/account` resolves to an empty module in webpack. Kazi doesn't offer that connector.

## 8. Implementation notes (Phase 6, 2026-10-10)

- **Pages**: `/token` (metrics, fee split bar, vesting progress, airdrop progress, contract list — before launch it hides "circulating"), `/stake` (position cards, "Activate" for matured warm-up stake, claim USDC, withdraw after cooldown, stake = exact approve + `stake` in a `TxStepper`, unstake with a cooldown-restart warning), `/points` (total, history with the reason when points were reduced, leaderboard, rules from the shared constants, "not a promise of tokens"), `/airdrop` (schedule read from the contract, allocation via `GET /airdrop/:wallet`, claimable read onchain, claim). Footer gets a $KAZI column; the account menu links Points. The public KAZI token address (`contracts.argusKazi` from `GET /config`, docs/08 §8) is shown in full with copy and explorer buttons: a band under the home page numbers, a card at the top of `/token` warning that anyone can create a token called KAZI, and a line in the footer (`components/kazi-ca.tsx`, added 2026-10-11). Next to it, `components/kazi-burn.tsx` shows the KAZI bought back and burned through Argus (`GET /token/kazi-burn`): a line in the home band and a card on `/token`. Also added 2026-10-11: `/docs` (user guide), `/whitepaper` (with a print-to-PDF button) and `/roadmap`, linked from the header (Docs) and a Resources footer column; the footer links Kazi's X account; `/developers` is in the header for everyone and covers building an agent, the agent protocol with signature verification in TypeScript and Python, the public API and the live capability list.
- **No hardcoded token facts**: share %, warm-up, cooldown, vesting schedule and decimals come from the contracts (via the API or wagmi reads); durations are localized with `Intl.NumberFormat` units ("7 days" / "siku 7").
- **Geo hooks**: the root layout reads the country from `GEO_COUNTRY_HEADER` and passes `{ country, restricted }` to a client context (`useGeo`, `<GeoNotice>`). Restricted visitors can't stake or claim airdropped tokens; unstake, withdraw and USDC reward claims stay available.
- **Single-transaction buttons**: `TxButton` (wallet spinner, explorer link, quiet on wallet rejection) for claim, withdraw, unstake, activate.
- **Tests**: `test/token.test.ts` (position maths mirrors `StakingVault`, exact approvals, amount validation, vault keys, labels, geo parsing); `e2e/token.spec.ts` runs on the e2e stack, which now executes the real `DeployTokenLaunch` script and gives the mock wallet a 1,000 KAZI airdrop + 10,000 KAZI: claim 25% → stake (approve + stake) → unstake → token metrics; and a restricted-country visit (`cf-ipcountry: US`).
