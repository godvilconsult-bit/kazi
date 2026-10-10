# Load testing

Two tools, for two jobs:

| Tool                               | Where                 | What it exercises                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker/scripts/load-test.ts` | Local, isolated stack | The **whole lifecycle** per simulated client: SIWE sign-in → create → quote (router, mock LLM) → exact USDC approve + `createAndFund` from the client's own wallet (anvil) → agent delivery + evaluation (house agent, mock LLM) → approve → milestone releases (operator) → COMPLETED (indexer). |
| `load/k6-api.js`                   | Any staging API (k6)  | Public read traffic at a constant rate, plus 500 API clients creating quick tasks and polling for quotes. No onchain funding (k6 can't sign transactions).                                                                                                                                        |

## Full lifecycle, locally

```bash
LOAD_TEST=1 pnpm -F @kazi/worker e2e:stack                          # terminal 1: fresh anvil + kazi_test_e2e DB, API, worker, house agents (no web)
pnpm -F @kazi/worker load-test -- --tasks 500 --ramp-sec 60         # terminal 2
```

Options: `--tasks`, `--ramp-sec` (spread client arrivals), `--timeout-min`, `--poll-ms`. Each client gets its own wallet (gas via `anvil_setBalance`, USDC from MockUSDC) and its own `X-Forwarded-For` address; the load stack runs with `TRUST_PROXY=true` so the per-IP sign-in limits apply per simulated client, as they would behind a real proxy. Results (per-phase and per-route latency percentiles, errors, queue depth peaks) go to `D:/KAZI/.tmp/load-results.json`.

## k6 against staging

```bash
KAZI_API=https://api.staging.example KAZI_API_KEYS=kz_test_…,kz_test_… k6 run load/k6-api.js
```

Run staging with `KAZI_LLM_MOCK=e2e` (no LLM spend) and generous `QUOTE_DAILY_LIMIT` / `API_KEY_RATE_LIMIT`. Never against production.

## Results

### 2026-10-10 — 500 full lifecycles, laptop + remote database

Setup: the isolated stack on an 8 GB Windows laptop (anvil, API, worker, house agents with the mock LLM), Postgres and Redis on Railway over the public internet (every query pays the round trip), 40-connection pool per process, 500 clients arriving over 60 s, 75-minute budget. Raw numbers: [`results-2026-10-10.json`](results-2026-10-10.json).

| Phase (per client)                             | n   | p50      | p95      |
| ---------------------------------------------- | --- | -------- | -------- |
| Sign in (SIWE)                                 | 500 | 7.9 s    | 16.5 s   |
| Create task                                    | 500 | 4.3 s    | 7.3 s    |
| Quote (request → QUOTED)                       | 500 | 7.6 min  | 13.9 min |
| Fund (mint + approve + createAndFund → FUNDED) | 500 | 12.9 min | 22.7 min |
| Delivery (FUNDED → DELIVERED)                  | 500 | 36.5 s   | 39.2 s   |
| Approve → COMPLETED (all milestones released)  | 268 | 35.7 min | 51.7 min |

- **All 500 clients were quoted, funded and delivered; 268 completed within the budget** — the other 232 were approved and waiting for their releases when time ran out.
- **No errors:** 179,200 API requests, 0 × 5xx, 0 × 429, no reverted transactions.
- **Bottleneck 1 — router.** Up to 462 quote jobs queued; each quote is an LLM call plus several database round trips, 4 at a time per worker. Now configurable: `ROUTER_CONCURRENCY`; also run more worker replicas for the `router` queue.
- **Bottleneck 2 — payouts.** One operator key settles one milestone at a time and waits for each receipt; the `QUEUE_BACKLOG` alert fired at 453 waiting releases. Before volume grows: send releases nonce-pipelined (don't wait for each receipt), and/or shard tasks across several operator keys, or add a batched `releaseMilestones` to the escrow (contract change → audit).
- **Database distance dominates latency.** Simple reads took 3–9 s at p50 under this load because every query crossed the internet; run API and worker in the same region/private network as Postgres and Redis.
- **Polling is expensive:** 129,590 `GET /tasks/:id` calls came from the simulated clients polling every 3 s; the web app uses the SSE stream instead.
- A first attempt was cut short when this machine's internet connection dropped (`ENOTFOUND` for the database host) and was restarted; this run saw three brief DNS failures (`EAI_AGAIN`) that the services rode out.
