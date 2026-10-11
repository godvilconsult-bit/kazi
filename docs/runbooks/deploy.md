# Deploy

Never deploy to mainnet without: a completed external audit of the exact commit, legal sign-off (docs/09 §4), the guarded-launch limits set (below), and two people on the call.

**Exception chosen by the owner (2026-10-10): a pre-audit guarded launch.** Limits are 100 USDC per task and 2,000 USDC in open escrow, with Kazi's house agents only. There are no bonds and no staker share. Step by step, with Railway hosting: [`deploy/README.md`](../../deploy/README.md). That launch uses `pnpm -F @kazi/contracts deploy:mainnet -- --i-accept-unaudited-contracts`, which automates §2 below. It was rehearsed on a local fork of Arc mainnet: Safe 2-of-3, all role checks passed, and zero-stake provider registration worked. Raise the limits only after the audit.

## 0. Pre-flight (every deploy)

- [ ] `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` green; `pnpm -F contracts test:coverage` shows 100% lines on `TaskEscrow` and `StakingVault`.
- [ ] The commit is tagged; for mainnet, the audited commit hash matches (`git diff <audited>..HEAD -- packages/contracts/src` is empty).
- [ ] `docs/00-ARC-FACTS.md` re-checked for the target network (chain id, USDC address and decimals, fee floor).
- [ ] Every signer key exists and is funded with native USDC for gas. Production keys live in a KMS (`SIGNER_BACKEND=aws-kms`), or as Railway secrets only during the guarded launch (see §4).
- [ ] The admin Safe exists on the target network with the agreed owners and threshold (mainnet ≥ 3/5).

## 1. Contracts — testnet

```bash
pnpm -F @kazi/contracts deploy:testnet
```

Reads the git-ignored `.env.testnet` (never printed). It creates or reuses the admin Safe, runs `script/Deploy.s.sol`, sends the operator gas and checks every role onchain. Commit the updated `packages/config/deployments/testnet.json`.

## 2. Contracts — mainnet (after audit)

1. Create the admin Safe (≥ 3/5 hardware wallets) in the Safe UI; note its address.
2. Prepare a private env file (never committed) with: `KAZI_NETWORK=mainnet`, `ADMIN_SAFE`, `OPERATOR_ADDRESS`, `QUOTER_ADDRESS`, `REGISTRAR_ADDRESS`, `SLASHER_ADDRESS`, `PAUSER_ADDRESS` (guardian), `TREASURY_ADDRESS` (Safe), `BUYBACK_RESERVE_ADDRESS` (Safe), `TOKEN_DISTRIBUTOR_ADDRESS`, `USDC_ADDRESS` (from docs/00), fee/stake values.
3. Dry run, then broadcast from a fresh deployer wallet holding only gas:
   ```bash
   cd packages/contracts
   forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --private-key <deployer>            # simulate
   forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --private-key <deployer> --broadcast --verify
   ```
   The script refuses an `ADMIN_SAFE` without code and renounces the deployer's admin roles.
4. Verify roles onchain (registry, vault, distributor, escrow): admin = Safe only; operator/quoter/registrar/slasher/pauser as planned; `REWARD_NOTIFIER_ROLE` on the vault = FeeDistributor. Any surprise → stop.
5. Verify sources on the explorer; commit `packages/config/deployments/mainnet.json`.
6. Guarded-launch limits (worker/API env): `MAX_TASK_USDC` (e.g. 1000), `MAX_OPEN_ESCROW_USDC` (e.g. 25000), `PROVIDER_ALLOWLIST` (house agents + reviewed providers). Alerts on (§5).

## 3. Application

Order: database migrations → API → worker → web. Each service reads the same `KAZI_NETWORK` and `DEPLOYMENTS_DIR`.

```bash
pnpm -F @kazi/db db:deploy            # prisma migrate deploy against DATABASE_URL (never `migrate dev` in production)
pnpm -F @kazi/api start               # health: GET /health
pnpm -F @kazi/worker start            # logs "worker started" with the operator and quoter addresses
pnpm -F @kazi/web build && pnpm -F @kazi/web start
pnpm -F @kazi/worker setup-providers  # once per network: register, bond and activate Kazi's providers
```

Smoke test after every deploy: `/config` shows the right chain and contracts; sign in; post a small task (≤ 1 USDC on mainnet with an internal wallet) through quote → fund → deliver → approve → payout; check `/admin` reconciliation is green.

Rollback: redeploy the previous image; migrations are forward-only, so every migration must be backward compatible with the previous release (add columns nullable, backfill, then tighten in a later release).

## 4. Production signers

**KMS (target).** Set `SIGNER_BACKEND=aws-kms` and `OPERATOR_KMS_KEY_ID` / `QUOTER_KMS_KEY_ID`: secp256k1 keys, `ECC_SECG_P256K1`, usage `SIGN_VERIFY`. Use an IAM role that allows only `kms:Sign` and `kms:GetPublicKey` on those keys. The worker logs each signer's address at start; grant the roles to those addresses from the Safe.

**Railway secrets (guarded launch, owner's choice 2026-10-11).**
- `pnpm -F @kazi/contracts signers:generate` writes fresh operator and quoter keys into `.env.mainnet`. `deploy/railway-setup.mjs` sets them on the worker as secret variables, with `SIGNER_BACKEND=env` and `ALLOW_PLAINTEXT_KEYS=true`.
- On mainnet the worker refuses such keys unless `MAX_TASK_USDC` and `MAX_OPEN_ESCROW_USDC` are set and open escrow is capped at **10,000 USDC or less** (`apps/worker/src/chain/signers.ts`). Raising the cap past that forces the move to a KMS.
- The trade-off: anyone with access to the Railway project, or to the worker's container, can copy these keys and sign with them until the Safe revokes the roles.
- What a stolen key can do is limited:
  - The operator can only release, refund or reassign funded milestones, and only to registered payout addresses.
  - The quoter can only sign quotes, which clients still have to fund.
- Protect the Railway account with two-factor authentication, keep the operator's gas balance small, and rotate as in [key-compromise.md](key-compromise.md).

Outside mainnet, plain `*_PRIVATE_KEY` variables are refused when `NODE_ENV=production` unless `ALLOW_PLAINTEXT_KEYS=true`.

## 5. Monitoring on

- Database pool: append `connection_limit=<n>` to `DATABASE_URL` (default 10 per process). Run API and worker in the same region as Postgres and keep the sum of all pools below Postgres `max_connections`.
- `TRUST_PROXY` = the number of proxies in front of the API (e.g. `1` behind Railway or Cloudflare). Without it every request looks like it comes from the proxy and the sign-in rate limits are shared by everyone; `true` would let clients spoof their IP.
- `SENTRY_DSN` set for the API and the worker; `ALERT_WEBHOOK_URL` (Slack/Discord-compatible) set for the worker.
- Prometheus scrapes `GET /metrics` on the API (`METRICS_TOKEN` bearer) and the worker's metrics port.
- Thresholds: `ALERT_LARGE_RELEASE_USDC`, `ALERT_DAILY_RELEASE_USDC`, `ALERT_QUEUE_BACKLOG`, `ALERT_OPERATOR_MIN_GAS`.

## 6. Token launch

Only after 4–8 weeks of real mainnet volume, the audit of `KaziAirdrop` + `DeployTokenLaunch`, and legal sign-off. Follow docs/08-TOKENOMICS.md §7 "Launch order": snapshot → `DeployTokenLaunch` → `AIRDROP_ID` → staker share via the Safe → liquidity from the multisig. Rehearse the whole sequence on anvil first:

```bash
pnpm -F @kazi/worker airdrop:snapshot -- --airdrop-id rehearsal-1 --total 100000000 --write
AIRDROP_MERKLE_ROOT=0x… pnpm -F @kazi/contracts token-launch:local
```
