# Deploying Kazi — website + guarded Arc mainnet

This is the **guarded launch** (docs/09 §2.4): real USDC on Arc mainnet with unaudited contracts, so the exposure is capped. Each task can be at most `MAX_TASK_USDC` (100), all open escrow together at most `MAX_OPEN_ESCROW_USDC` (2,000). Only Kazi's own house agents are quoted, and provider bonds and staking are off. Raise the limits only after the external audit.

Hosting is Railway, project `kazi`, environment `production`. That environment already holds Postgres and Redis. There are four services built from the one root `Dockerfile`, and `KAZI_SERVICE` picks the role:

| Service        | Public address                           | Talks to                                                                          |
| -------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| `web`          | `https://DOMAIN`                         | API (public URL in browsers, `api.railway.internal:4000` from the server)         |
| `api`          | `https://api.DOMAIN`                     | Postgres, Redis, Supabase storage, Arc RPC; runs migrations and the seed on start |
| `worker`       | —                                        | Postgres, Redis, Claude, Arc RPC; signs as operator/quoter through AWS KMS        |
| `house-agents` | — (`house-agents.railway.internal:4100`) | Claude only                                                                       |

Secrets live in two places: `.env.mainnet` (deployer and setup keys) and `.env.production` (service secrets). Both are git-ignored and are never uploaded: `.railwayignore` excludes them.

## 0. What only you can do (once)

1. **Domain.** Pick the name (e.g. `kazi.example`). Put its DNS on Cloudflare if you can: the site then gets the visitor country header (`cf-ipcountry`) used by the geo rules.
2. **Admin Safe owners.** Use 2–5 hardware wallets you control, with threshold ≥ 2 (3-of-5 recommended). None of them may be a key that sits on this computer.
3. **Guardian wallet.** A separate wallet that can only _pause_ the escrow in an emergency (docs/runbooks/pause.md).
4. **AWS KMS signers.** Create two asymmetric keys: key spec `ECC_SECG_P256K1`, usage `SIGN_VERIFY`. One is for the operator and one for the quoter. Then create an IAM user that is allowed only `kms:GetPublicKey` and `kms:Sign` on those two keys. Print their addresses:
   ```bash
   pnpm -F @kazi/worker kms-address -- <operator-key-id> <quoter-key-id>
   ```
   This needs `AWS_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in your shell.
5. **Fill `.env.mainnet`**: `ADMIN_SAFE_OWNERS`, `ADMIN_SAFE_THRESHOLD`, `PAUSER_ADDRESS`, `OPERATOR_ADDRESS`, `QUOTER_ADDRESS` (the KMS addresses), and optionally `TREASURY_ADDRESS` (default: the Safe).
6. **Fill `.env.production`**: copy [`production.env.example`](production.env.example) and fill it in.
7. **Gas.** Arc pays gas in USDC. Send about 1 USDC to the deployer `0xF87AFe58EB6d0a794de62c568c37c59c7BB54e01` and about 0.5 USDC to the setup key `0x8f5f49Dcf29c2d5E6B82d3Ad96E6335294FC64D3`. After step 1 below, keep about 5 USDC on the operator address for releases and refunds; an alert fires below `ALERT_OPERATOR_MIN_GAS`.

## 1. Contracts (Arc mainnet)

```bash
pnpm -F @kazi/contracts deploy:mainnet -- --i-accept-unaudited-contracts
```

The script:

- Creates the multi-owner admin Safe.
- Deploys the escrow, registry, staking vault, fee distributor and token with the guarded-launch settings: zero stake minimums, and no staker fee share until the token launch.
- Grants each role to its address, then checks every role onchain.
- Writes `packages/config/deployments/mainnet.json`. Commit that file; the services read it.

It refuses to run if `mainnet.json` already exists, if a Safe owner or the guardian is a hot key, or if the threshold is 1 without `--allow-single-signer`.

## 2. Railway services and variables

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
railway domain DOMAIN --service web --environment production
railway domain api.DOMAIN --service api --environment production
```

Each command prints the DNS records to add: a CNAME and a TXT verification record. Railway issues the certificates. On Cloudflare:

- Proxy `DOMAIN` (orange cloud, SSL mode **Full**). The site then receives the visitor-country header.
- Set `api.DOMAIN` to **DNS only** (grey cloud). The API then sits behind exactly one proxy (Railway's), which is what `TRUST_PROXY=1` assumes. If you proxy it too, set `TRUST_PROXY=2` on the api service.

## 5. Register the house agents onchain

Run this once, after the API has seeded the database:

```bash
node deploy/register-house-agents.mjs
```

It uses the setup key from `.env.mainnet` and the production database's public URL from Railway. Neither is printed, and your development `.env` is not loaded. With a zero stake minimum it only registers and activates; it posts no bond.

## 6. Smoke test

- `https://api.DOMAIN/health` returns ok, and `/config` shows chain 5042 and the mainnet addresses.
- Sign in on `https://DOMAIN` with an admin wallet; the admin page shows the queues and the guarded-launch limits.
- Post a 1 USDC task, fund it, let a house agent deliver, approve it. Then check the release on the explorer and the Safe's balance.
- Try a 150 USDC task: quoting must refuse it (above `MAX_TASK_USDC`).

## Operating

- Pause: [runbooks/pause.md](../docs/runbooks/pause.md).
- Incidents: [runbooks/incident-response.md](../docs/runbooks/incident-response.md). Set `ROUTER_DISABLED=true` on api and worker to stop new quotes.
- Key rotation: [runbooks/key-compromise.md](../docs/runbooks/key-compromise.md).
