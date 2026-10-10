import Anthropic from "@anthropic-ai/sdk";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { createPublicClient, defineChain, http, type Hex } from "viem";
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
  signerEnvSchema,
  storageEnvSchema,
  urlEnvSchema,
} from "@kazi/config";
import { SupabaseStorage } from "@kazi/config/storage";
import { loadDeployment } from "@kazi/config/deployments";
import { SecretBox } from "@kazi/config/secrets";
import { createPrismaClient } from "@kazi/db";
import { jobSchemas } from "@kazi/shared";
import { createEscrowOperator } from "./chain/operator";
import { executorEnvSchema, feeEnvSchema, llmModelsEnvSchema } from "./env";
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
import { recomputeAllReputations, recomputeReputation } from "./reputation/reputation";
import { createQueues } from "./queues";
import { runProviderTest } from "./executor/provider-test";
import { redisPlanCache } from "./router/cache";
import { quoteTask } from "./router/quote";
import { createQuoteSigner, createRouterChain } from "./router/signer";

const env = loadEnv(
  runtimeEnvSchema
    .extend(dbEnvSchema.shape)
    .extend(redisEnvSchema.shape)
    .extend(redisPrefixEnvSchema.shape)
    .extend(chainEnvSchema.shape)
    .extend(llmEnvSchema.shape)
    .extend(llmModelsEnvSchema.shape)
    .extend(signerEnvSchema.shape)
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
if (env.KAZI_LLM_MOCK && env.NODE_ENV === "production") throw new Error("KAZI_LLM_MOCK is not allowed in production");
const log = pino({
  level: "info",
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

const llm: LlmClient = env.KAZI_LLM_MOCK
  ? createE2eMockLlm()
  : new AnthropicLlm({
      apiKey: env.ANTHROPIC_API_KEY,
      log: log.child({ component: "llm" }),
    });
if (env.KAZI_LLM_MOCK) log.warn("KAZI_LLM_MOCK=e2e: Claude is replaced by a scripted mock");
const routerChain = createRouterChain(client, chain.chainId, deployment);
const signer = createQuoteSigner(
  env.QUOTER_PRIVATE_KEY as Hex,
  chain.chainId,
  deployment.taskEscrow,
);
const operator = createEscrowOperator({
  publicClient: client,
  rpcUrl: chain.rpcUrl,
  chain: viemChain,
  escrow: deployment.taskEscrow,
  privateKey: env.OPERATOR_PRIVATE_KEY as Hex,
  minMaxFeePerGasWei: chain.minMaxFeePerGasWei,
  log: log.child({ component: "operator" }),
});
const secrets = new SecretBox(env.ENCRYPTION_KEY);
const storage = new SupabaseStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.STORAGE_BUCKET);
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

function handler(queue: string, routes: Record<string, (job: Job) => Promise<unknown>>) {
  return async (job: Job) => {
    const route = routes[job.name];
    if (!route) throw new Error(`unknown ${queue} job ${job.name}`);
    return route(job);
  };
}

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
      reconcile: () =>
        reconcileEscrow(
          prisma,
          client,
          deployment,
          chain.chainId,
          redis,
          env.REDIS_KEY_PREFIX,
          log.child({ component: "reconcile" }),
        ),
    }),
    { ...workerOpts, concurrency: 1 },
  ),
  new Worker(
    "router",
    handler("router", {
      quote: async (job) => {
        const { taskId } = jobSchemas.router.quote.parse(job.data);
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
          },
          taskId,
        );
        return { outcome: quote.outcome, version: quote.version };
      },
    }),
    { ...workerOpts, concurrency: 4 },
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
        return applyAcceptedOffer({ prisma, operator, log: log.child({ component: "offers" }) }, offerId);
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
      release: async (job) =>
        settleMilestone(
          { prisma, jobs, operator, log: log.child({ component: "payouts" }) },
          jobSchemas.payouts.release.parse(job.data).subtaskId,
          "release",
        ),
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
  w.on("failed", (job, err) =>
    log.error({ err, queue: w.name, jobId: job?.id, name: job?.name }, "job failed"),
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
