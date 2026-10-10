# Runbooks

Operational procedures for Kazi. Written for the person on call at 3 a.m.: short steps, exact commands, no theory. Keep them current — every incident review asks "did the runbook work?".

| Runbook | Use it when |
|---|---|
| [deploy.md](deploy.md) | Deploying contracts or the app (testnet, mainnet), and the token launch |
| [pause.md](pause.md) | Something is wrong with the escrow or money flow and new funding/releases must stop |
| [key-compromise.md](key-compromise.md) | Any key or secret may be exposed |
| [dispute-handling.md](dispute-handling.md) | A client opened a dispute |
| [incident-response.md](incident-response.md) | Anything user-facing is broken, or an alert fired |
| [post-mortem-template.md](post-mortem-template.md) | After every SEV1/SEV2 incident |

## Who holds what

| Power | Holder (mainnet) | What it can do | What it can't |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` on every contract | Admin Safe (≥ 3/5, hardware wallets) | Grant/revoke roles, fees, split, cooldowns, unpause | Move escrowed funds |
| `ARBITER_ROLE` (escrow) | Admin Safe | Resolve disputes (split a disputed milestone) | Touch undisputed milestones |
| `PAUSER_ROLE` (escrow) | Guardian wallet (hardware, on-call) | Pause funding and releases | Unpause, move funds |
| `OPERATOR_ROLE` (escrow) | Worker hot key (KMS) | Release/refund/reassign funded milestones to registered payouts | Send funds anywhere else |
| `QUOTER_ROLE` (escrow) | Worker hot key (KMS) | Sign quotes | Fund anything (clients fund) |
| `REGISTRAR_ROLE` (registry) | Ops wallet (+ setup key) | Activate/suspend providers | Change payouts (owner-only, 48 h delay) |
| `SLASHER_ROLE` (vault) | Ops wallet | Slash bonds (capped by `maxSlashBps`) | Take more than the cap |
| `REWARD_NOTIFIER_ROLE` (vault) | FeeDistributor contract | Notify staker rewards | — |

Addresses for each network: `packages/config/deployments/<network>.json` (+ `<network>-token-launch.json`). The on-call sheet (private) lists people, phone numbers and which Safe signers they hold — keep it outside this repo.

## Alerts → runbook

| Alert (worker log `alert`, Sentry, webhook) | First runbook |
|---|---|
| `ESCROW_RECONCILIATION_MISMATCH` | [pause.md](pause.md) → [incident-response.md](incident-response.md) |
| `LARGE_RELEASE`, `DAILY_RELEASE_VOLUME` | [incident-response.md](incident-response.md) (check it's legitimate) |
| `ROLE_CHANGED`, `ESCROW_PAUSED`, `ESCROW_UNPAUSED`, `ADMIN_SETTING_CHANGED` | [key-compromise.md](key-compromise.md) if nobody planned it |
| `PAYOUT_CHANGE_REQUESTED` | Confirm with the provider owner; cancel via registrar if not them |
| `QUEUE_BACKLOG`, `JOB_FAILURES` | [incident-response.md](incident-response.md) |
| `LLM_COST_HIGH`, `LLM_COST_SPIKE` | [incident-response.md](incident-response.md) (cost section) |
| `OPERATOR_GAS_LOW` | Top up the operator (native USDC on Arc) |
