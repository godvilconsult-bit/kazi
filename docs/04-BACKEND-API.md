# 04 — Backend: API, Database, Jobs

## 1. Auth

- **SIWE (EIP-4361)**: `GET /auth/nonce` → client signs → `POST /auth/verify` → httpOnly JWT cookie (15 min) + refresh token (7 days, rotating, stored hashed in DB).
- Roles on `User`: `CLIENT` (default), `PROVIDER_OWNER`, `FREELANCER`, `ADMIN`. A user can hold several.
- Agent-to-Kazi calls (callbacks): HMAC-SHA256 over raw body with the agent's webhook secret, header `X-Kazi-Signature: t=<unix>,v1=<hex>`; reject if |now − t| > 300s.
- Admin endpoints additionally require the wallet to be in `ADMIN_WALLETS` env and a fresh SIWE (≤ 10 min).

## 2. Prisma schema (`packages/db/prisma/schema.prisma`) — starting point

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

model User {
  id            String   @id @default(cuid())
  wallet        String   @unique   // lowercase checksum-normalized
  email         String?  @unique
  displayName   String?
  roles         Role[]   @default([CLIENT])
  createdAt     DateTime @default(now())
  tasks         Task[]
  providers     Provider[]
  freelancer    FreelancerProfile?
}

enum Role { CLIENT PROVIDER_OWNER FREELANCER ADMIN }

model Provider {
  id              String   @id @default(cuid())
  onchainId       BigInt?  @unique
  ownerId         String
  owner           User     @relation(fields: [ownerId], references: [id])
  kind            ProviderKind
  name            String
  slug            String   @unique
  description     String
  capabilities    String[]           // capability tags, see 05-AGENT-SPEC
  languages       String[]
  endpointUrl     String?            // agents only
  manifestUrl     String?
  manifestHash    String?
  pricing         Json               // validated by shared Zod schema
  payoutAddress   String
  apiKeyHash      String?            // Kazi→agent auth is HMAC; this is for agent→Kazi API
  webhookSecretEnc String?           // encrypted at rest (AES-GCM, key from env/KMS)
  status          ProviderStatus @default(PENDING)
  isHouse         Boolean  @default(false)
  stakeAmount     String   @default("0")  // bigint as string, mirrored from chain
  reputation      Float    @default(0)    // 0..100, see 06-ROUTER
  completedCount  Int      @default(0)
  failedCount     Int      @default(0)
  avgLatencyMs    Int?
  createdAt       DateTime @default(now())
  subtasks        Subtask[]
  @@index([status, kind])
}

enum ProviderKind { AGENT HUMAN }
enum ProviderStatus { PENDING ACTIVE SUSPENDED DELISTED }

model FreelancerProfile {
  id        String @id @default(cuid())
  userId    String @unique
  user      User   @relation(fields: [userId], references: [id])
  providerId String @unique
  skills    String[]
  hourlyRateUsdc String
  portfolio Json?
  availability Boolean @default(true)
}

model Task {
  id            String   @id @default(cuid())
  onchainId     String   @unique         // bytes32 hex = keccak256(id)
  clientId      String
  client        User     @relation(fields: [clientId], references: [id])
  title         String
  description   String
  attachments   Json     @default("[]")
  budgetMax     String?                 // bigint string, base units
  deadline      DateTime
  status        TaskStatus @default(DRAFT)
  quoteVersion  Int      @default(0)
  quote         Json?                   // full plan + prices + signature + expiry
  totalAmount   String?
  feeBps        Int?
  fundTxHash    String?
  deliveredAt   DateTime?
  reviewUntil   DateTime?
  rating        Int?
  ratingComment String?
  llmCostUsd    Decimal  @default(0) @db.Decimal(12, 6) // internal cost tracking, not money movement
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  subtasks      Subtask[]
  dispute       Dispute?
  events        TaskEvent[]
  @@index([clientId, status])
}

enum TaskStatus { DRAFT QUOTED FUNDED IN_PROGRESS DELIVERED COMPLETED DISPUTED RESOLVED CANCELLED EXPIRED REFUNDED PARTIALLY_REFUNDED }

model Subtask {
  id            String   @id @default(cuid())
  taskId        String
  task          Task     @relation(fields: [taskId], references: [id])
  index         Int                     // milestone index in escrow
  title         String
  instructions  String
  capability    String
  dependsOn     Int[]                   // indexes of prerequisite subtasks
  acceptance    Json                    // rubric, see 06-ROUTER
  providerId    String?
  provider      Provider? @relation(fields: [providerId], references: [id])
  amount        String                  // bigint string
  status        SubtaskStatus @default(PENDING)
  attempts      Int      @default(0)
  releaseTxHash String?
  refundTxHash  String?
  submissions   Submission[]
  @@unique([taskId, index])
}

enum SubtaskStatus { PENDING DISPATCHED SUBMITTED EVALUATING ACCEPTED REJECTED FAILED RELEASED REFUNDED }

model Submission {
  id          String   @id @default(cuid())
  subtaskId   String
  subtask     Subtask  @relation(fields: [subtaskId], references: [id])
  providerId  String
  attempt     Int
  output      Json                     // { text?, files?: [{url, sha256, mime}], meta? }
  score       Float?
  evaluation  Json?                    // evaluator details
  accepted    Boolean?
  latencyMs   Int?
  createdAt   DateTime @default(now())
  @@unique([subtaskId, attempt])
}

model Dispute {
  id          String @id @default(cuid())
  taskId      String @unique
  task        Task   @relation(fields: [taskId], references: [id])
  reason      String
  evidence    Json   @default("[]")
  status      DisputeStatus @default(OPEN)
  resolution  Json?              // per-subtask clientShareBps
  resolvedBy  String?
  createdAt   DateTime @default(now())
  resolvedAt  DateTime?
}
enum DisputeStatus { OPEN UNDER_REVIEW RESOLVED }

model TaskEvent {             // audit log, append-only
  id        String   @id @default(cuid())
  taskId    String
  task      Task     @relation(fields: [taskId], references: [id])
  type      String
  data      Json
  createdAt DateTime @default(now())
  @@index([taskId, createdAt])
}

model ChainEvent {           // raw indexed contract events
  id          String @id @default(cuid())
  chainId     Int
  contract    String
  name        String
  txHash      String
  logIndex    Int
  blockNumber BigInt
  args        Json
  processed   Boolean @default(false)
  @@unique([chainId, txHash, logIndex])
}

model IndexerCursor { id String @id; lastBlock BigInt }

model IdempotencyKey {
  key       String   @id
  result    Json?
  createdAt DateTime @default(now())
}
```

## 3. REST endpoints (Fastify, all bodies validated with Zod from `packages/shared`)

### Auth
- `GET /auth/nonce`
- `POST /auth/verify` `{ message, signature }`
- `POST /auth/refresh`, `POST /auth/logout`
- `GET /me`

### Tasks (client)
- `POST /tasks` `{ title, description, attachments[], budgetMax?, deadline }` → `Task`
- `POST /tasks/:id/quote` → enqueues `router.quote`; returns `202` + poll/SSE
- `GET /tasks/:id` → task with subtasks, latest submissions (sanitized), status
- `GET /tasks/:id/events` → **SSE** stream of TaskEvents
- `GET /tasks/:id/fund-params` → `{ escrowAddress, taskId(bytes32), providerIds[], amounts[], deadline, quoteSig, usdcAddress }` for the wallet tx
- `POST /tasks/:id/approve` → client approves delivery (backend releases remaining milestones; client may also release directly onchain)
- `POST /tasks/:id/revision` `{ subtaskIndex, note }` (1 free per subtask)
- `POST /tasks/:id/dispute` `{ reason, evidence[] }` (client must also call `openDispute` onchain; UI does both)
- `POST /tasks/:id/rate` `{ rating 1-5, comment? }`
- `POST /tasks/:id/cancel` (only DRAFT/QUOTED)
- `GET /tasks?status=&cursor=` (own tasks)
- `GET /tasks/:id/invoice.pdf`

### Providers (agent devs / freelancers)
- `POST /providers` `{ kind, name, description, capabilities[], languages[], endpointUrl?, manifestUrl?, pricing, payoutAddress }`
- `PATCH /providers/:id`
- `POST /providers/:id/test` `{ sampleInput }` → dry-run dispatch (no money), returns output + evaluator score
- `POST /providers/:id/rotate-secret` → returns new webhook secret once
- `GET /providers/:id/stats` → earnings, tasks, success rate, latency, reputation history
- `GET /providers` (public directory: filter by capability, language, kind, min reputation; sort)
- `GET /providers/:slug` (public profile)

### Agent callbacks (HMAC auth)
- `POST /agent/callback/:subtaskId` `{ status: "completed"|"failed"|"progress", output?, progress?, error? }`
- `GET /agent/subtask/:subtaskId/input` → fetch large inputs (signed URL list)

### Freelancer
- `GET /freelancer/offers`, `POST /freelancer/offers/:subtaskId/accept|decline`
- `POST /freelancer/subtasks/:id/submit` `{ text?, files[] }`

### Files
- `POST /files/presign` `{ filename, mime, size }` → presigned PUT URL (S3/R2). Max 50 MB. Store sha256.

### Admin
- `GET /admin/providers?status=PENDING`, `POST /admin/providers/:id/activate|suspend`
- `GET /admin/disputes`, `POST /admin/disputes/:id/resolve` `{ resolutions: [{ index, clientShareBps }] }` (prepares Safe tx data; arbiter = multisig)
- `POST /admin/providers/:id/slash` `{ amount, reason }`
- `GET /admin/queues` (BullMQ dashboard via bull-board, admin-only)
- `GET /admin/reconciliation` (escrow onchain balance vs DB expected)
- `PATCH /admin/settings` (default fee display, min stake display — onchain values remain authoritative)

## 4. Indexer (worker)

- Poll `eth_getLogs` for all Kazi contracts from `IndexerCursor.lastBlock + 1` to `latest − confirmations`, batch size configurable (default 2000 blocks).
- Upsert into `ChainEvent` (unique on chain/tx/logIndex) → enqueue processors per event name.
- Processors update Task/Subtask/Provider state via the state machine; write `TaskEvent`.
- Handle reorgs defensively: confirmations config + re-scan last N blocks on startup.
- If Arc offers websocket subscriptions, use them as a hint to poll sooner, never as the only source.

## 5. Payout worker

Before sending any tx: read onchain milestone status; if already RELEASED/REFUNDED, mark DB and exit (idempotent). Use a nonce manager for the operator signer; one in-flight tx per signer, or a small pool of operator keys. Wait for receipt; on failure, retry with backoff; alert after 3 failures.

## 6. Quote signing

`QUOTER` key signs EIP-712 typed data:
```
Quote(bytes32 taskId,address client,uint256[] providerIds,uint128[] amounts,uint64 deadline,uint16 feeBps,uint64 expiry)
```
Domain: `{ name: "KaziEscrow", version: "1", chainId, verifyingContract: escrow }`. Escrow verifies with OZ `EIP712` + `ECDSA`. `client` is the wallet that will fund (the escrow recovers against `msg.sender`), so the quoter signs per client. `feeBps` must be ≤ the escrow's onchain `feeBps` (use a lower value for staker discounts). Encoding is verified against the EIP-712 standard in `TaskEscrow.t.sol::test_quoteDigest_matchesEip712Standard`; `TaskEscrow.quoteDigest(quote, client)` returns the digest for backend tests.

## 7. Env (`.env.example`)

```
NODE_ENV=
DATABASE_URL=
REDIS_URL=
JWT_SECRET=
ENCRYPTION_KEY=               # 32 bytes base64, for webhook secrets at rest
ANTHROPIC_API_KEY=
KAZI_NETWORK=local|testnet|mainnet
ARC_RPC_URL=
ARC_CHAIN_ID=
CONFIRMATIONS=2
OPERATOR_PRIVATE_KEY=         # dev only; KMS in prod
QUOTER_PRIVATE_KEY=           # dev only; KMS in prod
ADMIN_WALLETS=0x...,0x...
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=
APP_URL=
API_URL=
SENTRY_DSN=
```

## 8. Phase 2 implementation decisions (2026-10-09)

Approved by the founder where noted; everything else is an implementation choice within this spec.

**Infrastructure** (approved): Postgres 18 + Redis on Railway (`development` / `production` environments), file storage in the repurposed Supabase project (private bucket `kazi-files`). See `02-ARCHITECTURE.md` §7. Postgres over Railway's public TCP proxy uses a self-signed certificate; `sslmode=require` is applied with libpq semantics (encrypted, certificate not verified) via `packages/db/src/pg-config.ts`. Production uses the private network.

**Dependencies** (rule 10): only `jose` (JWT) was approved. So:
- **SIWE** uses viem's built-in `viem/siwe` (already in the stack). EOAs are verified locally (ecrecover); smart-contract wallets fall back to ERC-1271/6492 via the chain RPC.
- **Cookies**: small in-house serializer/parser (`apps/api/src/http/cookies.ts`), no `@fastify/cookie`.
- **Rate limiting**: in-house fixed-window limiter on Redis (`apps/api/src/security/rate-limit.ts`), keyed by wallet when signed in, else IP. No `@fastify/rate-limit`.
- **Uploads**: Supabase Storage's signed-URL API over `fetch` behind an `ObjectStorage` interface (`apps/api/src/storage/storage.ts`), no AWS SDK. Swapping to S3/R2 later means one new implementation of that interface.

**Auth (§1) details**
- Cookies: `kazi_access` (JWT, 15 min, `Path=/`) and `kazi_refresh` (opaque, 7 days, `Path=/auth`), both `HttpOnly; SameSite=Lax` and `Secure` on https. Web and API must be same-site (e.g. `app.kazi.app` + `api.kazi.app`, `COOKIE_DOMAIN=.kazi.app`).
- Non-browser clients may send `Authorization: Bearer <access token>`.
- SIWE: nonce in Redis, single use (`GETDEL`), 10-min TTL. The message must match `APP_URL`'s host, the configured chain id, version 1, and be ≤ 10 min old.
- Refresh rotation stores only SHA-256 hashes. Reusing a rotated token revokes the whole token family (theft detection). `authTime` (the original SIWE login) is carried through rotations, so the 10-minute admin freshness check can't be bypassed by refreshing.
- `ADMIN` role follows `ADMIN_WALLETS` on every login (added or removed). Admin endpoints check role + wallet list + fresh login.
- CORS: only `APP_URL`'s origin, with credentials.

**Schema additions to §2**
- `RefreshToken` (hash, family, `authTime`, expiry, revocation, `replacedBy`).
- `Capability` (slug, description, enabled), seeded from `packages/shared/src/capabilities.ts`. Admin-added capabilities live here too.
- `FileObject` (owner, key, filename, mime, size ≤ 50 MB, optional client-declared sha256, `PENDING`/`UPLOADED`).
- `FreelancerProfile.provider` relation and indexes on `RefreshToken`, `ChainEvent.processed`.

**Endpoints implemented in Phase 2** (the rest need the router, Phases 3–4): `GET /auth/nonce`, `POST /auth/verify|refresh|logout`, `GET /me`; `POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `GET /tasks/:id/events` (SSE), `POST /tasks/:id/cancel|rate`; `POST /providers`, `PATCH /providers/:id`, `POST /providers/:id/rotate-secret`, `GET /providers/:id/stats`, `GET /providers`, `GET /providers/:slug`; files: `POST /files/presign` → client `PUT`s to the returned URL → `POST /files/:id/complete` (server checks the object exists with the declared size) → `GET /files/:id/download-url` (15 min); `GET /admin/reconciliation`. Other users' tasks/files/providers return 404 (not 403), so existence isn't leaked. Payout address is not editable via the API (it changes onchain with the 48 h delay).

**Indexer (§4) details**
- `CONFIRMATIONS` counts the inclusion block: 1 = act on inclusion (Arc has instant finality), 2 = one block on top.
- The cursor is per chain + escrow address. On process start the last `INDEXER_REORG_DEPTH` blocks are re-scanned. `ChainEvent` is unique on (chain, tx, logIndex) and `TaskEvent`s written by the indexer are keyed by the chain event, so replays create no duplicates.
- Processors go through the shared state machine. Chain-driven events are allowed from every state the chain can reach (e.g. funding honoured after a DB-side quote expiry or cancel). A `TaskFunded` for a task in an unexpected state is recorded as `CHAIN_ANOMALY` rather than blocking indexing.
- `TaskClosed` maps to: disputed → `RESOLVED`, all released → `COMPLETED`, all refunded → `REFUNDED`, mixed → `PARTIALLY_REFUNDED`. Provider status and bonded stake are mirrored from registry/vault events.
- Reconciliation (every 5 min): escrow USDC balance at the cursor block vs Σ funded − Σ settled from indexed events, stored in Redis for `GET /admin/reconciliation`, logged loudly on mismatch.
- viem's 4-second block-number cache is disabled for the indexer (it stalled on fast chains).

**Testing**: integration tests use dedicated databases `kazi_test_api` / `kazi_test_worker` (created and migrated by `pnpm db:test:prepare`) and a random Redis key prefix, and refuse to run against any non-`kazi_test*` database. The indexer test runs against a real local anvil chain and signs the EIP-712 quote in TypeScript with viem, which proves the backend's signatures match `TaskEscrow`. CI uses throwaway Postgres 18 + Redis service containers (no Railway credentials in CI).

## 9. Phase 3 implementation decisions (2026-10-09)

**Service fee** (approved by the founder): the router service fee is its own milestone paid to the `kazi-service-fee` provider (payout = treasury), not spread across work milestones. See `06-ROUTER.md` §3.

**Schema additions**: `Subtask.kind` (`WORK` | `SERVICE_FEE`), `Subtask.dispatchedAt` / `timeoutAt` (current attempt), `Task.approvedAt` (client approval; the payout worker releases after it, or after `reviewUntil`).

**Endpoints implemented in Phase 3**
- `POST /tasks/:id/quote` → enqueues `router.quote` (job id `quote-<taskId>-<version>`), `202 { status: "queued", version }`; `200 { status: "quoted" }` if a quote is still valid. Allowed from `DRAFT`, `EXPIRED`, or `QUOTED` with an expired quote.
- `GET /tasks/:id/quote` → the stored quote (`Task.quote`, schema `storedQuoteSchema` in `@kazi/shared`): `QUOTED` (signed), `NEEDS_CLARIFICATION` (questions for the client) or `INFEASIBLE` (reason). Router-internal fallback providers are stripped.
- `GET /tasks/:id/fund-params` → `{ escrowAddress, usdcAddress, quote, quoteSig, total, expiresAt }`, only while the quote is valid and only for the wallet it was signed for.
- `POST /tasks/:id/approve` → sets `approvedAt` on a `DELIVERED` task (idempotent). Status becomes `COMPLETED` when the indexer sees the releases.
- `POST /agent/callback/:subtaskId?attempt=N` → HMAC-verified over the raw body with the provider's webhook secret, then enqueued as `executor.agentResult`; the worker applies it (stale attempts are ignored). The `attempt` query parameter is part of the `callbackUrl` Kazi sends, so late results from an earlier attempt can't be credited to the current one.

**Queues**: the API produces BullMQ jobs (shared names and payload schemas in `packages/shared/src/jobs.ts`); the worker consumes them. Custom job ids never contain `:` (BullMQ rejects it).

**Secrets**: `SecretBox` moved to `@kazi/config/secrets` (Node-only entry) so the worker can decrypt webhook secrets to sign requests. House agents' secrets are derived from `HOUSE_AGENTS_SECRET` per slug (`deriveHouseAgentSecret`).

## 10. Kazi-hosted agents (2026-10-09, founder-approved; design in `11-HOSTED-AGENTS.md`)

**Schema**: `Provider.hosting` (`SELF` | `KAZI`), `hostedConfig`, `aiCost` (per-task estimates, nano-USD), `hostedAdvice`; `Task.speed` (`ECONOMY` default | `EXPRESS`); `Subtask.aiCost`; `HostedRun` (one row per hosted attempt: mode, batch id, usage, actual cost).

**Endpoints**
- `POST /providers` accepts `hosting: "KAZI"` + `hostedConfig` (instructions, model ∈ Opus 5.5 / Sonnet 5.5 / Haiku 5.5, effort, optional web search, output cap, up to 3 samples). No endpoint and no webhook secret. The public directory shows `hosting` but never the instructions.
- `PATCH /providers/:id` may change `hostedConfig`; that clears the cost estimate and advice (a new advice run is needed before the agent is quoted again).
- `POST /providers/:id/advise` (owner, 3/day) → `202`, enqueues `executor.advise`; results appear in `hostedAdvice` on the owner's provider view (score, pass rate and Economy/Express cost per model).
- `POST /tasks` takes `speed`; `POST /tasks/:id/quote` takes an optional `{ speed }` to switch before quoting. The stored quote carries the effective `speed` and `aiCost`.

