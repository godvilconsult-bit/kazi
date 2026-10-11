import Anthropic from "@anthropic-ai/sdk";
import { DelayedError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { createPublicClient, defineChain, http } from "viem";
import { z } from "zod";
import {
  authEnvSchema,
  chainEnvSchema,
  dbEnvSchema,
  getChainConfig,
  llmEnvSchema,
  loadEnv,
  redisEnvSchema,
  redisPrefixEnvSchema,
  runtimeEnvSchema,
  storageEnvSchema,
  urlEnvSchema,
} from "@kazi/config";
import { SupabaseStorage } from "@kazi/config/storage";
import { loadDeployment } from "@kazi/config/deployments";
import { SecretBox } from "@kazi/config/secrets";
import { createPrismaClient } from "@kazi/db";
import { formatUnits, jobSchemas } from "@kazi/shared";
import { createEscrowOperator } from "./chain/operator";
import { loadSigners } from "./chain/signers";
import {
  executorEnvSchema,
  feeEnvSchema,
  guardEnvSchema,
  llmModelsEnvSchema,
  monitoringEnvSchema,
  signerBackendEnvSchema,
} from "./env";
import { evaluateSubmission } from "./evaluator/evaluate";
import { dispatchSubtask } from "./executor/dispatch";
import { applyAgentResult } from "./executor/results";
import { applyAcceptedOffer } from "./executor/offers";
import { executorTick } from "./executor/tick";
import { adviseProvider } from "./hosted/advise";
import { pollHostedRuns, runHosted } from "./hosted/run";
import { ChainIndexer } from "./indexer/indexer";
import { bullmqSink } from "./jobs/sink";
import { reconcileEscrow } from "./jobs/reconcile";
import { AnthropicLlm, anthropicBatchApi, createE2eMockLlm, type LlmClient } from "./llm";
import { payoutsTick, settleMilestone } from "./payouts/payouts";
import { distributeFeesIfDue } from "./payouts/fees";
import { recomputePoints } from "./points/points";
import { recomputeAllReputations, recomputeReputation } from "./reputation/reputation";
import { createQueues } from "./queues";
import { runProviderTest } from "./executor/provider-test";
import { redisPlanCache } from "./router/cache";
import { quoteTask } from "./router/quote";
import { createQuoteSigner, createRouterChain } from "./router/signer";
import { createAlerter } from "./monitoring/alerts";
import { chainEventAlerts } from "./monitoring/chain-alerts";
import { redisSpendRecorder, trackLlmSpend } from "./monitoring/llm-spend";
import { createWorkerMetrics, startMetricsServer } from "./monitoring/metrics";
import { monitorTick } from "./monitoring/monitor";
import { initSentry } from "./monitoring/sentry";

const env = loadEnv(
  runtimeEnvSchema
    .extend(dbEnvSchema.shape)
    .extend(redisEnvSchema.shape)
    .extend(redisPrefixEnvSchema.shape)
    .extend(chainEnvSchema.shape)
    .extend(llmEnvSchema.shape)
    .extend(llmModelsEnvSchema.shape)
    .extend(signerBackendEnvSchema.shape)
    .extend(guardEnvSchema.shape)
    .extend(monitoringEnvSchema.shape)
    .extend(feeEnvSchema.shape)
    .extend(executorEnvSchema.shape)
    .extend(storageEnvSchema.shape)
    .extend({
      ENCRYPTION_KEY: authEnvSchema.shape.ENCRYPTION_KEY,
      API_URL: urlEnvSchema.shape.API_URL,
    })
    .extend({
      INDEXER_POLL_MS: z.coerce.number().int().min(250).default(2_000),
      INDEXER_BATCH_BLOCKS: z.coerce.number().int().min(1).max(10_000).default(2_000),
      INDEXER_REORG_DEPTH: z.coerce.number().int().min(0).default(20),
      RECONCILE_EVERY_MS: z.coerce
        .number()
        .int()
        .min(10_000)
        .default(5 * 60_000),
      /** Browser e2e only: a deterministic stand-in for Claude (llm/e2e-mock.ts). */
      KAZI_LLM_MOCK: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["e2e"]).optional()),
      /** Read contract addresses from this directory instead of packages/config/deployments. */
      DEPLOYMENTS_DIR: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    }),
);
if (env.KAZI_LLM_MOCK && env.NODE_ENV === "production")
  throw new Error("KAZI_LLM_MOCK is not allowed in production");
const log = pino({
  level: process.env["LOG_LEVEL"] || "info",
  ...(env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
});

const deployment = loadDeployment(env.KAZI_NETWORK, env.DEPLOYMENTS_DIR);
const chain = getChainConfig(env.KAZI_NETWORK, {
  rpcUrl: env.ARC_RPC_URL,
  usdcAddress: env.USDC_ADDRESS ?? deployment.usdc,
  expectedChainId: env.ARC_CHAIN_ID,
  confirmations: env.CONFIRMATIONS,
});
if (deployment.chainId !== chain.chainId) {
  throw new Error(
    `Deployment chainId ${deployment.chainId} does not match ${env.KAZI_NETWORK} (${chain.chainId})`,
  );
}
const viemChain = defineChain({
  id: chain.chainId,
  name: chain.name,
  nativeCurrency: chain.nativeCurrency,
  rpcUrls: { default: { http: [chain.rpcUrl] } },
});

const prisma = createPrismaClient(env.DATABASE_URL);
const client = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) });
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }); // required by BullMQ workers
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
const queues = createQueues(connection, env.REDIS_KEY_PREFIX);
const jobs = bullmqSink(queues);

// ── Monitoring: Sentry, Prometheus metrics, alerts (docs/runbooks/) ──
const reporter = initSentry({
  dsn: env.SENTRY_DSN,
  environment: `${env.KAZI_NETWORK}-${env.NODE_ENV}`,
  service: "worker",
});
const metrics = createWorkerMetrics();
if (env.WORKER_METRICS_PORT)
  startMetricsServer(metrics.registry, env.WORKER_METRICS_PORT, env.METRICS_TOKEN);
const alerter = createAlerter({
  log: log.child({ component: "alerts" }),
  redis,
  prefix: env.REDIS_KEY_PREFIX,
  webhookUrl: env.ALERT_WEBHOOK_URL,
  report: (message, severity, details) => reporter.message(message, severity, details),
  onSent: (kind, severity) => metrics.alerts.inc({ kind, severity }),
});

const baseLlm: LlmClient = env.KAZI_LLM_MOCK
  ? createE2eMockLlm()
  : new AnthropicLlm({
      apiKey: env.ANTHROPIC_API_KEY,
      log: log.child({ component: "llm" }),
    });
// Every call's cost feeds the hourly LLM_COST_SPIKE check and the metrics.
const llm = trackLlmSpend(
  baseLlm,
  redisSpendRecorder(redis, env.REDIS_KEY_PREFIX, (usd) => metrics.llmCostUsd.inc(usd)),
);
if (env.KAZI_LLM_MOCK) log.warn("KAZI_LLM_MOCK=e2e: Claude is replaced by a scripted mock");
const routerChain = createRouterChain(client, chain.chainId, deployment);
// OPERATOR + QUOTER: a KMS, or env keys (local, testnet, and mainnet only under the guarded-launch caps;
// chain/signers.ts enforces it).
const accounts = await loadSigners(env);
const signer = createQuoteSigner(accounts.quoter, chain.chainId, deployment.taskEscrow);
const operator = createEscrowOperator({
  publicClient: client,
  rpcUrl: chain.rpcUrl,
  chain: viemChain,
  escrow: deployment.taskEscrow,
  account: accounts.operator,
  minMaxFeePerGasWei: chain.minMaxFeePerGasWei,
  log: log.child({ component: "operator" }),
});
const secrets = new SecretBox(env.ENCRYPTION_KEY);
const storage = new SupabaseStorage(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  env.STORAGE_BUCKET,
);
const planCache = redisPlanCache(redis, env.REDIS_KEY_PREFIX);
// Economy runs of Kazi-hosted agents go through the Batch API (docs/11-HOSTED-AGENTS.md).
const batchApi = anthropicBatchApi(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }));
const usdcDecimals = () => routerChain.usdcDecimals();

const indexer = new ChainIndexer(
  prisma,
  client,
  deployment,
  {
    chainId: chain.chainId,
    confirmations: chain.confirmations,
    batchSize: BigInt(env.INDEXER_BATCH_BLOCKS),
    reorgDepth: BigInt(env.INDEXER_REORG_DEPTH),
    onEvent: chainEventAlerts({
      alerter,
      prisma,
      usdcDecimals: () => routerChain.usdcDecimals(),
      largeReleaseUsdc: env.ALERT_LARGE_RELEASE_USDC ?? null,
    }),
  },
  log.child({ component: "indexer" }),
);

// Repeatable jobs (job schedulers are idempotent: re-running main.ts doesn't duplicate them).
await queues.indexer.upsertJobScheduler(
  "poll-blocks",
  { every: env.INDEXER_POLL_MS },
  { name: "pollBlocks" },
);
await queues.indexer.upsertJobScheduler(
  "reconcile-escrow",
  { every: env.RECONCILE_EVERY_MS },
  { name: "reconcile" },
);
await queues.executor.upsertJobScheduler(
  "executor-tick",
  { every: env.EXECUTOR_TICK_MS },
  { name: "tick" },
);
await queues.executor.upsertJobScheduler(
  "hosted-poll",
  { every: env.HOSTED_POLL_MS },
  { name: "hostedPoll" },
);
await queues.executor.upsertJobScheduler(
  "reputation-daily",
  { every: 24 * 3_600_000 },
  { name: "reputationAll" },
);
await queues.payouts.upsertJobScheduler(
  "payouts-tick",
  { every: env.PAYOUTS_TICK_MS },
  { name: "tick" },
);
await queues.payouts.upsertJobScheduler(
  "distribute-fees",
  { every: env.FEE_DISTRIBUTE_EVERY_MS },
  { name: "distributeFees" },
);
await queues.executor.upsertJobScheduler(
  "points-daily",
  { every: 24 * 3_600_000 },
  { name: "points" },
);
await queues.indexer.upsertJobScheduler(
  "monitor",
  { every: env.MONITOR_EVERY_MS },
  { name: "monitor" },
);

const workerOpts = { connection, prefix: env.REDIS_KEY_PREFIX };
const executorConfig = {
  maxAttempts: env.EXECUTOR_MAX_ATTEMPTS,
  attemptTimeoutSec: env.EXECUTOR_ATTEMPT_TIMEOUT_SEC,
  syncResponseTimeoutMs: env.EXECUTOR_SYNC_RESPONSE_MS,
  allowPrivateEndpoints: env.EXECUTOR_ALLOW_PRIVATE_ENDPOINTS,
  apiUrl: env.API_URL,
};

const hostedDeps = {
  prisma,
  llm,
  batch: batchApi,
  jobs,
  usdcDecimals,
  config: executorConfig,
  log: log.child({ component: "hosted" }),
  storage,
};

function handler(
  queue: string,
  routes: Record<string, (job: Job, token?: string) => Promise<unknown>>,
) {
  return async (job: Job, token?: string) => {
    const route = routes[job.name];
    if (!route) throw new Error(`unknown ${queue} job ${job.name}`);
    return route(job, token);
  };
}

/** A release while the escrow is paused: check again in a minute without using up an attempt. */
const RELEASE_PAUSED_RETRY_MS = 60_000;

const workers = [
  new Worker(
    "indexer",
    handler("indexer", {
      pollBlocks: async () => {
        // Drain: keep indexing batches until caught up, then apply events in order.
        while ((await indexer.pollOnce()) !== null) {
          /* next batch */
        }
        return { processed: await indexer.processPending() };
      },
      reconcile: async () => {
        const result = await reconcileEscrow(
          prisma,
          client,
          deployment,
          chain.chainId,
          redis,
          env.REDIS_KEY_PREFIX,
          log.child({ component: "reconcile" }),
        );
        if (result) {
          const decimals = await usdcDecimals();
          metrics.reconciliationOk.set(result.ok ? 1 : 0);
          metrics.escrowBalanceUsdc.set(
            Number(formatUnits(BigInt(result.onchainBalance), decimals)),
          );
          if (!result.ok) {
            await alerter.send(
              "ESCROW_RECONCILIATION_MISMATCH",
              `escrow holds ${formatUnits(BigInt(result.onchainBalance), decimals)} USDC, the database expects ${formatUnits(BigInt(result.expectedBalance), decimals)}`,
              { ...result },
              { dedupeSec: 30 * 60 },
            );
          }
        }
        return result;
      },
      monitor: () =>
        monitorTick({
          prisma,
          redis,
          prefix: env.REDIS_KEY_PREFIX,
          queues,
          publicClient: client,
          operator: operator.address,
          escrow: deployment.taskEscrow,
          nativeDecimals: chain.nativeCurrency.decimals,
          usdcDecimals,
          alerter,
          metrics,
          thresholds: {
            queueBacklog: env.ALERT_QUEUE_BACKLOG,
            operatorMinGas: env.ALERT_OPERATOR_MIN_GAS,
            dailyReleaseUsdc: env.ALERT_DAILY_RELEASE_USDC ?? null,
            llmHourlyUsd: env.ALERT_LLM_HOURLY_USD ?? null,
          },
          log: log.child({ component: "monitor" }),
        }),
    }),
    { ...workerOpts, concurrency: 1 },
  ),
  new Worker(
    "router",
    handler("router", {
      quote: async (job) => {
        const { taskId } = jobSchemas.router.quote.parse(job.data);
        if (env.ROUTER_DISABLED) {
          log.warn({ taskId }, "ROUTER_DISABLED: quote skipped");
          return { outcome: "skipped" };
        }
        const quote = await quoteTask(
          {
            prisma,
            llm,
            routerModel: env.LLM_MODEL_ROUTER,
            chain: routerChain,
            signer,
            fees: {
              takeRateBps: env.TAKE_RATE_BPS,
              serviceFeeBps: env.SERVICE_FEE_BPS,
              minServiceFee: env.MIN_SERVICE_FEE,
            },
            log: log.child({ component: "router" }),
            planCache,
            files: { storage, fastModel: env.LLM_MODEL_FAST },
            limits: {
              maxTaskUsdc: env.MAX_TASK_USDC ?? null,
              maxOpenEscrowUsdc: env.MAX_OPEN_ESCROW_USDC ?? null,
              providerAllowlist: env.PROVIDER_ALLOWLIST,
            },
          },
          taskId,
        );
        return { outcome: quote.outcome, version: quote.version };
      },
    }),
    { ...workerOpts, concurrency: env.ROUTER_CONCURRENCY },
  ),
  new Worker(
    "executor",
    handler("executor", {
      tick: () =>
        executorTick({
          prisma,
          jobs,
          config: {
            maxAttempts: env.EXECUTOR_MAX_ATTEMPTS,
            reviewWindowHours: env.REVIEW_WINDOW_HOURS,
          },
          log: log.child({ component: "executor" }),
        }),
      dispatch: async (job) => {
        const { subtaskId, attempt } = jobSchemas.executor.dispatch.parse(job.data);
        return dispatchSubtask(
          {
            prisma,
            secrets,
            jobs,
            operator,
            usdcDecimals,
            config: executorConfig,
            log: log.child({ component: "executor" }),
            storage,
          },
          subtaskId,
          attempt,
        );
      },
      hostedRun: async (job) => {
        const { subtaskId, attempt } = jobSchemas.executor.hostedRun.parse(job.data);
        return runHosted(hostedDeps, subtaskId, attempt);
      },
      hostedPoll: () => pollHostedRuns(hostedDeps),
      reputation: async (job) => {
        const { providerId } = jobSchemas.executor.reputation.parse(job.data);
        return recomputeReputation(prisma, providerId, log.child({ component: "reputation" }));
      },
      reputationAll: () => recomputeAllReputations(prisma, log.child({ component: "reputation" })),
      points: () =>
        recomputePoints({ prisma, usdcDecimals, log: log.child({ component: "points" }) }),
      providerTest: async (job) =>
        runProviderTest(
          {
            prisma,
            secrets,
            redis,
            keyPrefix: env.REDIS_KEY_PREFIX,
            config: executorConfig,
            log: log.child({ component: "provider-test" }),
          },
          jobSchemas.executor.providerTest.parse(job.data),
        ),
      offerAccepted: async (job) => {
        const { offerId } = jobSchemas.executor.offerAccepted.parse(job.data);
        return applyAcceptedOffer(
          { prisma, operator, log: log.child({ component: "offers" }) },
          offerId,
        );
      },
      advise: async (job) => {
        const { providerId, requestedAt } = jobSchemas.executor.advise.parse(job.data);
        const result = await adviseProvider(
          { prisma, llm, judgeModel: env.LLM_MODEL_JUDGE, log: log.child({ component: "advice" }) },
          providerId,
          requestedAt,
        );
        return result === "stale" ? "stale" : result.status;
      },
      agentResult: async (job) => {
        const { subtaskId, attempt, callback } = jobSchemas.executor.agentResult.parse(job.data);
        return applyAgentResult(
          { prisma, jobs, log: log.child({ component: "executor" }), storage },
          subtaskId,
          attempt,
          callback,
        );
      },
    }),
    { ...workerOpts, concurrency: 8 },
  ),
  new Worker(
    "evaluator",
    handler("evaluator", {
      evaluate: async (job) => {
        const { submissionId } = jobSchemas.evaluator.evaluate.parse(job.data);
        return evaluateSubmission(
          {
            prisma,
            llm,
            judgeModel: env.LLM_MODEL_JUDGE,
            usdcDecimals,
            config: {
              passThreshold: env.EVAL_PASS_THRESHOLD,
              doubleJudgeAbove: env.EVAL_DOUBLE_JUDGE_ABOVE,
            },
            log: log.child({ component: "evaluator" }),
            jobs,
          },
          submissionId,
        );
      },
    }),
    { ...workerOpts, concurrency: 4 },
  ),
  new Worker(
    "payouts",
    handler("payouts", {
      tick: () => payoutsTick({ prisma, jobs, operator, log: log.child({ component: "payouts" }) }),
      distributeFees: () =>
        distributeFeesIfDue({
          prisma,
          publicClient: client,
          operator,
          deployment,
          usdcDecimals,
          minUsdc: env.FEE_DISTRIBUTE_MIN_USDC,
          log: log.child({ component: "fees" }),
        }),
      release: async (job, token) => {
        const result = await settleMilestone(
          { prisma, jobs, operator, log: log.child({ component: "payouts" }) },
          jobSchemas.payouts.release.parse(job.data).subtaskId,
          "release",
        );
        if (result === "paused" && token) {
          await job.moveToDelayed(Date.now() + RELEASE_PAUSED_RETRY_MS, token);
          throw new DelayedError();
        }
        return result;
      },
      refund: async (job) =>
        settleMilestone(
          { prisma, jobs, operator, log: log.child({ component: "payouts" }) },
          jobSchemas.payouts.refund.parse(job.data).subtaskId,
          "refund",
        ),
    }),
    // One operator key: settle one milestone at a time.
    { ...workerOpts, concurrency: 1 },
  ),
];
for (const w of workers) {
  w.on("failed", (job, err) => {
    log.error({ err, queue: w.name, jobId: job?.id, name: job?.name }, "job failed");
    metrics.jobs.inc({ queue: w.name, name: job?.name ?? "unknown", result: "failed" });
    // Only the final failure is an incident; earlier attempts are retried with backoff.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1))
      reporter.exception(err, { queue: w.name, jobId: job.id, name: job.name });
  });
  w.on("completed", (job) =>
    metrics.jobs.inc({ queue: w.name, name: job.name, result: "completed" }),
  );
}

log.info(
  {
    network: env.KAZI_NETWORK,
    chainId: chain.chainId,
    escrow: deployment.taskEscrow,
    quoter: signer.address,
    operator: operator.address,
  },
  "worker started",
);

const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(Object.values(queues).map((q) => q.close()));
  connection.disconnect();
  redis.disconnect();
  await prisma.$disconnect();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
