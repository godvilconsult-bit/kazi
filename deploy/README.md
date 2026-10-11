# Deploying Kazi — website + guarded Arc mainnet

This is the **guarded launch** (docs/09 §2.4): real USDC on Arc mainnet with unaudited contracts, so the exposure is capped. Each task can be at most `MAX_TASK_USDC` (100), all open escrow together at most `MAX_OPEN_ESCROW_USDC` (2,000). Only Kazi's own house agents are quoted, and provider bonds and staking are off. Raise the limits only after the external audit.

Everything deploys from GitHub (`godvilconsult-bit/kazi`, branch `main`); nothing is uploaded from a laptop:

| Part           | Hosting                                                              | Address                                  | Talks to                                                                                    |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| Website        | **Netlify** (`apps/web`, [`netlify.toml`](../apps/web/netlify.toml)) | `https://www.kazilabs.online`            | the API at `https://api.kazilabs.online`                                                    |
| `api`          | **Railway** (root `Dockerfile`, `KAZI_SERVICE=api`)                  | `https://api.kazilabs.online`            | Postgres, Redis, Supabase storage, Arc RPC; runs migrations and the seed on start           |
| `worker`       | **Railway** (`KAZI_SERVICE=worker`)                                  | —                                        | Postgres, Redis, Claude, Arc RPC; operator/quoter keys as Railway secrets; registers agents |
| `house-agents` | **Railway** (`KAZI_SERVICE=house-agents`)                            | — (`house-agents.railway.internal:4100`) | Claude only                                                                                 |

Netlify hosts the website only: the API, the worker (payouts, chain indexer, agent jobs) and Kazi's agents are always-on servers, so they run on Railway next to Postgres and Redis (project `kazi`, environment `production`).

Secrets live in `.env.mainnet` (deployer, setup and signer keys) and `.env.production` (service secrets). Both are git-ignored, and `railway-setup.mjs` pipes them to Railway over stdin. Netlify needs no secrets: its settings are public and live in `netlify.toml`.

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

## 1. Contracts (Arc mainnet) — done 2026-10-11

```bash
pnpm -F @kazi/contracts deploy:mainnet -- --i-accept-unaudited-contracts
```

The script:

- Creates the multi-owner admin Safe.
- Deploys the escrow, registry, staking vault, fee distributor and token with the guarded-launch settings: zero stake minimums, and no staker fee share until the token launch. Kazi's token is named **KAZI Credits** (`KCRED`).
- With `ARGUS_KAZI_ADDRESS` set: checks that token (a contract, 18 decimals), deploys `KaziCreditsGate` (admin = Safe, pauser = guardian) and moves the whole Credits supply into its reserve. The script writes `mainnet-credits-gate.json`; commit it too.
- Grants each role to its address, then checks every role onchain.
- Writes `packages/config/deployments/mainnet.json`. Commit that file; the services read it.

It refuses to run if `mainnet.json` already exists, if a Safe owner or the guardian is a hot key, or if the threshold is 1 without `--allow-single-signer`. The deployed addresses are in [docs/HANDOVER.md](../docs/HANDOVER.md) §2.

## 2. Backend on Railway (deploys from GitHub)

1. **Variables.** Run once, and again whenever `.env.production` or `.env.mainnet` changes:

   ```bash
   node deploy/railway-setup.mjs
   ```

   - It creates the `api`, `worker` and `house-agents` services if they're missing, and the private Supabase bucket.
   - It generates `JWT_SECRET`, `ENCRYPTION_KEY`, `HOUSE_AGENTS_SECRET` and `METRICS_TOKEN` once, and appends them to `.env.production`.
   - It sets each service's variables. Secrets go over stdin, so they are never printed or put on a command line. It deploys nothing.

2. **Connect each service to GitHub** (once). In the Railway dashboard, open project `kazi` → environment `production`. For each of `api`, `worker` and `house-agents`:
   - Settings → Source → **Connect Repo** → `godvilconsult-bit/kazi`, branch `main`.
   - Leave the root directory empty. Railway builds the root `Dockerfile`, and the service's `KAZI_SERVICE` variable picks its role.

   Every push to `main` then rebuilds and redeploys the three services. Watch a deploy with `railway logs --service api --environment production`. On start, the API applies migrations and runs the idempotent seed, which creates the admin users and the 10 house agents (their payouts go to the Safe).

3. **API domain.** `api.kazilabs.online` is attached to the `api` service; to see its DNS records again:

   ```bash
   railway domain status api.kazilabs.online --service api --environment production
   ```

4. **Remove the old `web` service** from Railway (the website moved to Netlify): service → Settings → Danger → Delete service. Its `www.kazilabs.online` domain goes with it.

## 3. Website on Netlify (deploys from GitHub)

1. On [app.netlify.com](https://app.netlify.com): **Add new project → Import an existing project → GitHub** → `godvilconsult-bit/kazi`.
2. Netlify detects the monorepo. Choose **`apps/web`** as the site to deploy (package directory) and leave the base directory as the repository root. The build command (`pnpm --filter @kazi/web build`) and publish directory (`apps/web/.next`) come from `apps/web/netlify.toml`. Deploy.
3. Optional: add `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` under Project configuration → Environment variables, then redeploy. It's needed only for WalletConnect (mobile) wallets.
4. **Domains:** Project configuration → Domain management → Add a domain → `www.kazilabs.online`, and set it as the primary domain. Add `kazilabs.online` too; Netlify redirects it to `www`. Netlify issues the HTTPS certificates.

Every push to `main` rebuilds the site.

If the site shows Netlify's **"Page not found"**, the deploy ran without the Next.js app. In Project configuration → Build & deploy → Build settings:

- **Base directory** must be empty (the repository root), never `apps/web`.
- **Package directory** should be `apps/web`, or empty. With it empty, the root `netlify.toml` builds `apps/web` anyway.

Then go to Deploys → **Trigger deploy → Clear cache and deploy site**. Both `netlify.toml` files declare the Next.js adapter, so it always runs. Netlify's proxy adds the visitor's country as `x-country`, which the token pages' geo rules read (`netlify.toml`).

## 4. DNS at Namecheap

Domain List → `kazilabs.online` → **Advanced DNS**:

1. Delete the parking records: the `www` CNAME to `parkingpage.namecheap.com`, and the `@` URL redirect or A record.
2. `www` → **CNAME** → your Netlify site's address (`<name>.netlify.app`; Netlify's domain page shows it).
3. `@` → the record Netlify's domain page asks for for the bare domain (an **A** record to Netlify's load balancer). Netlify then redirects `kazilabs.online` to `https://www.kazilabs.online`. Sign-in and the API only accept `www.kazilabs.online` as the site's origin.
4. `api` → **CNAME** → the target Railway printed, plus Railway's **TXT** verification record.

Netlify and Railway issue certificates once DNS resolves (minutes to an hour).

## 5. Register the house agents onchain

**Automatic.** The worker registers and activates Kazi's own agents by itself once the API has seeded them, usually within a few minutes of the first deploy. It uses the setup key that `railway-setup.mjs` stores on it as a secret.

- It waits until its indexer has reached the chain head, then checks the registrations that key already made.
- It stores each id as soon as the transaction is mined, so an interrupted run resumes without registering anything twice.
- The worker log shows "Kazi's providers registered onchain".
- With a zero stake minimum it only registers and activates; it posts no bond.

Manual fallback: `node deploy/register-house-agents.mjs` runs the same registration inside the worker's container over `railway ssh`. That needs an SSH key registered with Railway (`ssh-keygen -t ed25519`, then the command asks to add it).

## 6. Smoke test

- `https://api.kazilabs.online/health` returns ok, and `/config` shows chain 5042 and the mainnet addresses.
- Sign in on `https://www.kazilabs.online` with an admin wallet; the admin page shows the queues and the guarded-launch limits.
- Post a 1 USDC task, fund it, let a house agent deliver, approve it. Then check the release on the explorer and the Safe's balance.
- Try a 150 USDC task: quoting must refuse it (above `MAX_TASK_USDC`).

## Operating

- Deploys: push to `main`. Netlify rebuilds the website, Railway rebuilds `api`, `worker` and `house-agents`.
- Pause: [runbooks/pause.md](../docs/runbooks/pause.md).
- Incidents: [runbooks/incident-response.md](../docs/runbooks/incident-response.md). Set `ROUTER_DISABLED=true` on api and worker to stop new quotes.
- Key rotation: [runbooks/key-compromise.md](../docs/runbooks/key-compromise.md).
- Kazi's token, **KAZI Credits**, is deployed with the others. With `ARGUS_KAZI_ADDRESS` set, its whole supply backs the KAZI ⇄ Credits exchange; otherwise it sits in the admin Safe. Anyone can create another token called "KAZI". Only the addresses in `packages/config/deployments/mainnet*.json` are Kazi's, so publish them once deployed (the `/token` page lists them).
