# Deploying Kazi — website + guarded Arc mainnet

This is the **guarded launch** (docs/09 §2.4): real USDC on Arc mainnet with unaudited contracts, so the exposure is capped. Each task can be at most `MAX_TASK_USDC` (100), all open escrow together at most `MAX_OPEN_ESCROW_USDC` (2,000). Only Kazi's own house agents are quoted, and provider bonds and staking are off. Raise the limits only after the external audit.

Hosting is Railway, project `kazi`, environment `production`. That environment already holds Postgres and Redis. There are four services built from the one root `Dockerfile`, and `KAZI_SERVICE` picks the role:

| Service        | Public address                           | Talks to                                                                           |
| -------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `web`          | `https://www.kazilabs.online`            | API (public URL in browsers, `api.railway.internal:4000` from the server)          |
| `api`          | `https://api.kazilabs.online`            | Postgres, Redis, Supabase storage, Arc RPC; runs migrations and the seed on start  |
| `worker`       | —                                        | Postgres, Redis, Claude, Arc RPC; signs as operator/quoter (keys: Railway secrets) |
| `house-agents` | — (`house-agents.railway.internal:4100`) | Claude only                                                                        |

Secrets live in two places: `.env.mainnet` (deployer and setup keys) and `.env.production` (service secrets). Both are git-ignored and are never uploaded: `.railwayignore` excludes them.

## 0. What only you can do (once)

1. **Domain.** `kazilabs.online` (Namecheap). `.env.production` has `DOMAIN=kazilabs.online` and `SITE_HOST=www.kazilabs.online`.
2. **Admin Safe owners.** Use 2–5 hardware wallets you control, with threshold ≥ 2 (3-of-5 recommended). None of them may be a key that sits on this computer.
3. **Guardian wallet.** A separate wallet that can only _pause_ the escrow in an emergency (docs/runbooks/pause.md).
4. **Platform signers (operator and quoter).** Generate them once:
   ```bash
   pnpm -F @kazi/contracts signers:generate
   ```
   - The keys go into `.env.mainnet`. `railway-setup.mjs` pipes them to the worker as Railway secret variables.
   - The worker accepts keys held this way on mainnet only with `ALLOW_PLAINTEXT_KEYS=true` and while `MAX_OPEN_ESCROW_USDC` is 10,000 or less (docs/runbooks/deploy.md §4).
   - Before raising the caps further, move the signers to AWS KMS. Set `OPERATOR_KMS_KEY_ID`, `QUOTER_KMS_KEY_ID` and the `AWS_*` credentials in `.env.production`, then have the Safe grant the roles to the KMS addresses (`pnpm -F @kazi/worker kms-address -- <ids>`) and revoke the old keys.
5. **Fill `.env.mainnet`**: `ADMIN_SAFE_OWNERS`, `ADMIN_SAFE_THRESHOLD`, `PAUSER_ADDRESS`, `OPERATOR_ADDRESS` and `QUOTER_ADDRESS` (written by step 4), optionally `TREASURY_ADDRESS` (default: the Safe), and `ARGUS_KAZI_ADDRESS`: the contract address of KAZI on Argus. Set that last one before deploying. The KAZI Credits supply then goes straight into the 1:1 exchange, and no Safe transaction is needed (docs/08-TOKENOMICS.md §8).
6. **Fill `.env.production`**: copy [`production.env.example`](production.env.example) and fill it in.
7. **Gas.** Arc pays gas in USDC. Send about 1 USDC to the deployer `0xF87AFe58EB6d0a794de62c568c37c59c7BB54e01` and about 0.5 USDC to the setup key `0x8f5f49Dcf29c2d5E6B82d3Ad96E6335294FC64D3`. After step 1 below, keep about 5 USDC on the operator address for releases and refunds; an alert fires below `ALERT_OPERATOR_MIN_GAS`.

## 1. Contracts (Arc mainnet)

```bash
pnpm -F @kazi/contracts deploy:mainnet -- --i-accept-unaudited-contracts
```

The script:

- Creates the multi-owner admin Safe.
- Deploys the escrow, registry, staking vault, fee distributor and token with the guarded-launch settings: zero stake minimums, and no staker fee share until the token launch. Kazi's token is named **KAZI Credits** (`KCRED`).
- With `ARGUS_KAZI_ADDRESS` set: checks that token (a contract, 18 decimals), deploys `KaziCreditsGate` (admin = Safe, pauser = guardian) and moves the whole Credits supply into its reserve. The script writes `mainnet-credits-gate.json`; commit it too.
- Grants each role to its address, then checks every role onchain.
- Writes `packages/config/deployments/mainnet.json`. Commit that file; the services read it.

It refuses to run if `mainnet.json` already exists, if a Safe owner or the guardian is a hot key, or if the threshold is 1 without `--allow-single-signer`.

## 2. Railway services and variables

**Shortcut for steps 2–4:** `node deploy/launch-website.mjs` sets up the services and variables, uploads all four services, attaches both domains and prints the DNS records. The sections below are what it does.

```bash
node deploy/railway-setup.mjs
```

The script:

- Generates `JWT_SECRET`, `ENCRYPTION_KEY`, `HOUSE_AGENTS_SECRET` and `METRICS_TOKEN` once, and appends them to `.env.production`.
- Creates the four services if missing.
- Sets each service's variables. Secrets go over stdin, so they are never printed or put on a command line.

Re-run it whenever `.env.production` changes.

## 3. Deploy

```bash
railway up --service house-agents --environment production --detach
railway up --service api --environment production --detach
railway up --service worker --environment production --detach
railway up --service web --environment production --detach
```

Watch with `railway logs --service api --environment production`. On start, the API applies migrations and runs the idempotent seed. The seed creates the admin users and the 10 house agents; the agents' payouts go to the Safe.

## 4. Domains

```bash
railway domain www.kazilabs.online --service web --environment production
railway domain api.kazilabs.online --service api --environment production
```

Each command prints the DNS records to add: a CNAME and a TXT verification record. Railway issues the certificates once DNS resolves. In Namecheap, go to **Domain List → kazilabs.online → Advanced DNS**:

1. Delete the parking records: the `www` CNAME to `parkingpage.namecheap.com` and the `@` URL redirect or A record.
2. Add a CNAME `www` and a CNAME `api` with the targets Railway printed, plus Railway's TXT records.
3. Add a **URL Redirect Record** for host `@`, permanent (301), to `https://www.kazilabs.online`. The bare domain then lands on the site. Sign-in and the API only accept `www.kazilabs.online` as the site's origin.

Optional, later: move the DNS to Cloudflare (free). If you do, proxy `www` (SSL mode **Full**), and the site gets the visitor-country header used by the token pages' geo rules. Keep `api` **DNS only**, since `TRUST_PROXY=1` assumes Railway is the only proxy in front of the API; set `TRUST_PROXY=2` if you proxy it. Without Cloudflare the geo rules aren't enforced. That is acceptable while the token isn't public.

## 5. Register the house agents onchain

Run this once, after the API has seeded the database:

```bash
node deploy/register-house-agents.mjs
```

It uses the setup key from `.env.mainnet` and the production database's public URL from Railway. Neither is printed, and your development `.env` is not loaded. With a zero stake minimum it only registers and activates; it posts no bond.

## 6. Smoke test

- `https://api.kazilabs.online/health` returns ok, and `/config` shows chain 5042 and the mainnet addresses.
- Sign in on `https://www.kazilabs.online` with an admin wallet; the admin page shows the queues and the guarded-launch limits.
- Post a 1 USDC task, fund it, let a house agent deliver, approve it. Then check the release on the explorer and the Safe's balance.
- Try a 150 USDC task: quoting must refuse it (above `MAX_TASK_USDC`).

## Operating

- Pause: [runbooks/pause.md](../docs/runbooks/pause.md).
- Incidents: [runbooks/incident-response.md](../docs/runbooks/incident-response.md). Set `ROUTER_DISABLED=true` on api and worker to stop new quotes.
- Key rotation: [runbooks/key-compromise.md](../docs/runbooks/key-compromise.md).
- Kazi's token, **KAZI Credits**, is deployed with the others. With `ARGUS_KAZI_ADDRESS` set, its whole supply backs the KAZI ⇄ Credits exchange; otherwise it sits in the admin Safe. Anyone can create another token called "KAZI". Only the addresses in `packages/config/deployments/mainnet*.json` are Kazi's, so publish them once deployed (the `/token` page lists them).
