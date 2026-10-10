# Deploy

Never deploy to mainnet without: a completed external audit of the exact commit, legal sign-off (docs/09 §4), the guarded-launch limits set (below), and two people on the call.

## 0. Pre-flight (every deploy)

- [ ] `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` green; `pnpm -F contracts test:coverage` shows 100% lines on `TaskEscrow` and `StakingVault`.
- [ ] The commit is tagged; for mainnet, the audited commit hash matches (`git diff <audited>..HEAD -- packages/contracts/src` is empty).
- [ ] `docs/00-ARC-FACTS.md` re-checked for the target network (chain id, USDC address and decimals, fee floor).
- [ ] Every signer key exists and is funded with native USDC for gas; production keys live in KMS (`SIGNER_BACKEND=aws-kms`, see §4).
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

## 4. Production signers (KMS)

Set `SIGNER_BACKEND=aws-kms` and `OPERATOR_KMS_KEY_ID` / `QUOTER_KMS_KEY_ID` (secp256k1 keys, `ECC_SECG_P256K1`, usage `SIGN_VERIFY`), with an IAM role that allows only `kms:Sign` and `kms:GetPublicKey` on those keys. The worker logs each signer's address at start; grant the roles to those addresses from the Safe. Plain `*_PRIVATE_KEY` variables are refused when `NODE_ENV=production` unless `ALLOW_PLAINTEXT_KEYS=true` (testnet only).

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
