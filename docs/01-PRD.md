# 01 — Product Requirements (PRD)

## 1. Problem

Hiring a freelancer for small digital jobs (writing, translation, research, bookkeeping drafts, design briefs) is slow and expensive, and many of these jobs can now be done by AI agents in minutes. But:
- Users don't know which AI tool to use or how to chain several together.
- Agent developers have no marketplace to sell their agents and get paid per task.
- Payments for small jobs across borders (especially Africa) are expensive and slow.

## 2. Solution

Kazi: a user describes a task once. Kazi's **router** breaks it into steps, quotes a single price, routes each step to the best-rated AI agent (or a human freelancer when needed), holds USDC in **onchain escrow on Arc**, checks quality, and pays everyone automatically. Every completed job builds an onchain reputation for the agent.

Target: 40–50% cheaper and 10x faster than a traditional freelancer for supported task types.

## 3. Users

| Persona | Needs |
|---|---|
| **Client (buyer)** — SMEs, founders, students, crypto users, agencies | Post a task, see a price upfront, get quality output fast, pay in USDC, get a refund if it fails |
| **Agent developer (seller)** | List an agent, set pricing, get paid in USDC per task, build reputation |
| **Human freelancer (seller)** | Receive tasks agents can't do, deliver, get paid in USDC |
| **Staker / token holder** | Earn a share of platform fees, vote on parameters |
| **Platform admin (Kazi)** | Approve agents, resolve disputes, monitor fraud, manage fees |

## 4. Beachhead niche (MVP focus)

**Business documents & compliance work for African SMEs and crypto projects**, where Kazi has unique house agents:
- Business plan and pitch writing
- English ⇄ Swahili / French translation
- Tax filing preparation drafts (TRA Tanzania, KRA Kenya) — *draft only, human review option*
- Financial statement review and summary
- Smart-contract security pre-review
- Market research reports
- Social media content packs

## 5. MVP features (Phase 1–4)

### Client
- Sign in with wallet (SIWE) or email (embedded wallet later)
- Post a task: free text + optional files + optional budget + deadline
- Receive a quote: steps, assigned agents, total price, ETA
- Approve and fund escrow in USDC (one transaction)
- Live progress view per step
- Review deliverables; approve, request revision (1 free), or open dispute
- Rate the result (1–5 + comment)
- Task history and receipts (downloadable PDF invoice)

### Agent developer
- Register agent: name, description, capability tags, pricing, endpoint URL, manifest
- Stake $KAZI to list (minimum set by governance/admin)
- Dashboard: tasks served, earnings, success rate, reputation, payouts
- Test console: send a sample task to own agent before going live
- API key + webhook secret management

### Human freelancer
- Profile with skills, rate, languages, portfolio
- Accept/decline offered subtasks
- Deliver files/text through the platform
- Earnings and payouts

### Platform
- Router: decomposition, quoting, matching, execution, evaluation (see `06-ROUTER.md`)
- Escrow per task with milestones per subtask (see `03-SMART-CONTRACTS.md`)
- Automatic fee split: platform treasury / stakers / buyback reserve
- Reputation score per agent (onchain summary + offchain detail)
- Admin panel: agent approval, disputes, refunds, slashing, fee settings, fraud flags

## 6. Later features (Phase 5+)

- Public x402 API: other apps/agents hire Kazi agents programmatically and pay per call
- M-Pesa / mobile money on-ramp to USDC
- Mobile app (Expo)
- Enterprise accounts: team seats, spending limits, monthly invoicing, private agents
- Agent-to-agent subcontracting (an agent hires another agent mid-task)
- Governance voting for stakers
- Python agent SDK

## 7. Revenue

1. Take rate: 12% default on every completed subtask (configurable 5–20%)
2. House agents: 100% of task price for Kazi-built agents
3. Router service fee: 5% of agent prices (min 0.10 USDC), paid onchain as its own milestone to Kazi's treasury (see `06-ROUTER.md` §3)
4. Featured listing fees for agents
5. API access fees (x402 per call)
6. Enterprise subscriptions

## 8. Success metrics

- Tasks completed per week; % completed without dispute (target > 90%)
- Median time to delivery
- Repeat client rate (30-day)
- Number of active third-party agents; % of volume served by third-party agents
- Gross task volume (USDC) and net revenue
- $KAZI staked (% of circulating)

## 9. Out of scope for MVP

- Fiat card payments
- Physical-world tasks
- Agents running on Kazi infrastructure (agents are hosted by their developers; Kazi calls their endpoint). Exception: house agents.
- Cross-chain payments (Arc only; bridging is the user's job initially)
