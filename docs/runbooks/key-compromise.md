# Key or secret compromise

Assume compromise if a key was pasted anywhere public, a laptop holding it was lost, a dependency was malicious, or an alert shows an action nobody planned (`ROLE_CHANGED`, unexplained releases, an unexpected pause).

**Order of operations: contain → rotate → verify → communicate.** Write every step with a timestamp in the incident doc as you go.

## Onchain roles (revoke from the admin Safe)

| Key | Damage it can do | Contain | Rotate |
|---|---|---|---|
| **OPERATOR** (worker) | Release funded milestones early to the registered payout, refund, reassign to another *active* provider | Pause the escrow ([pause.md](pause.md)) → Safe: `TaskEscrow.revokeRole(OPERATOR_ROLE, old)` | New KMS key → Safe: `grantRole(OPERATOR_ROLE, new)` → update `OPERATOR_KMS_KEY_ID` → restart worker → unpause |
| **QUOTER** (worker) | Sign quotes — clients still fund them themselves, so no direct theft | Safe: `revokeRole(QUOTER_ROLE, old)` (pending quotes stop working) | New key → `grantRole(QUOTER_ROLE, new)` → `QUOTER_KMS_KEY_ID` → restart worker; clients re-quote |
| **REGISTRAR** | Activate bad providers, suspend good ones | Safe: `AgentRegistry.revokeRole(REGISTRAR_ROLE, old)`; review providers activated in the window, suspend any you didn't approve | New key → `grantRole` |
| **SLASHER** | Slash bonds up to `maxSlashBps` per call | Safe: `StakingVault.revokeRole(SLASHER_ROLE, old)`; slashed $KAZI sits in the insurance pool — compensate wrongly slashed providers from it (`FeeDistributor.compensate`) | New key → `grantRole` |
| **PAUSER** (guardian) | Pause (DoS on funding/releases) | Safe: `revokeRole(PAUSER_ROLE, old)`; unpause if needed | New hardware wallet → `grantRole` |
| **Safe signer** | One signature toward the threshold | Remaining signers: Safe → Settings → remove owner, keep threshold; review queued transactions and reject unknown ones | Add the replacement owner |

Calldata: Admin → (provider / dispute / token / escrow actions) produce calldata; for `revokeRole`/`grantRole`, use the Safe Transaction Builder with the contract's ABI (`packages/shared/src/abis.ts`) or:

```bash
cast calldata "revokeRole(bytes32,address)" $(cast keccak "OPERATOR_ROLE") <old address>
```

Verify with `cast call <contract> "hasRole(bytes32,address)(bool)" <role> <address>` for old (false) and new (true).

## Off-chain secrets

| Secret | Impact | Rotate |
|---|---|---|
| `JWT_SECRET` | Forge sessions for any wallet (incl. admin UI access — onchain actions still need keys) | New value → restart API; every session is logged out |
| `ENCRYPTION_KEY` | Decrypt stored agent webhook secrets | `NEW_ENCRYPTION_KEY=… pnpm -F @kazi/api rotate-secrets` (decrypts with the current `ENCRYPTION_KEY`, re-encrypts every stored secret) → set `ENCRYPTION_KEY` to the new value → restart API + worker. If the database leaked too, the webhook secrets themselves are exposed: ask provider owners to rotate from their dashboard |
| `HOUSE_AGENTS_SECRET` | Impersonate Kazi to house agents / forge their callbacks | `NEW_HOUSE_AGENTS_SECRET=… pnpm -F @kazi/api rotate-secrets` (re-derives and stores each house agent's webhook secret) → set `HOUSE_AGENTS_SECRET` → restart house agents + worker |
| `ANTHROPIC_API_KEY` | LLM spend on our account | Revoke in the Anthropic console → new key → restart worker + house agents; check usage for the window |
| `SUPABASE_SERVICE_ROLE_KEY` | Read/write every stored file | Rotate in Supabase → update API/worker; review storage access logs; if client files were read, this is a data breach (notify per DPA rules within the legal deadline) |
| Database / Redis credentials | Full data access | Rotate in Railway → update services; review access logs |
| User API keys (`kz_live_…`) | Act as that user via the public API | Revoke the key (user or admin), tell the user |

## Verify

- Alerts quiet for 24 h; reconciliation green.
- `ROLE_CHANGED` alerts for exactly the grants/revokes you made.
- Run the smoke test from [deploy.md](deploy.md) §3.

## Communicate

Within 24 h of containment publish what happened, what was at risk, what users need to do (usually nothing; re-sign-in if `JWT_SECRET` rotated; re-quote if the quoter rotated). Then the [post-mortem](post-mortem-template.md).
