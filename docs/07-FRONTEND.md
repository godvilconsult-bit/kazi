# 07 — Web Frontend (Next.js 15, Tailwind, shadcn/ui, wagmi v2)

## 1. Principles

- Clear money UX: always show amounts in USDC with 2 decimals, exact values on hover; show gas will be paid in USDC.
- Every onchain step shows: what will happen, the amount, and a link to the explorer after sending.
- Mobile-first layouts (most target users are on phones). Light + dark themes.
- i18n ready from day one (`next-intl`): English + Swahili first, French later.
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
