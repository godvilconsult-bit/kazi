import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import type { Address, Hex } from "viem";
import { verifySignature } from "@kazi/agent-sdk";
import { SecretBox, deriveHouseAgentSecret } from "@kazi/config/secrets";
import { createPrismaClient, type PrismaClient } from "@kazi/db";
import { buildHouseAgents, createHouseServer } from "@kazi/house-agents";
import {
  CAPABILITY_DEFINITIONS,
  HOUSE_AGENT_LISTINGS,
  SERVICE_FEE_PROVIDER,
  agentCallbackSchema,
  agentRegistryAbi,
  aiCostEstimateSchema,
  nanoUsdToUnits,
  jobSchemas,
  kaziTokenAbi,
  mockUsdcAbi,
  providerPayout,
  stakingVaultAbi,
  taskEscrowAbi,
  taskOnchainId,
  type Plan,
} from "@kazi/shared";
import type Anthropic from "@anthropic-ai/sdk";
import { createEscrowOperator } from "../src/chain/operator";
import { pollHostedRuns, runHosted, type HostedDeps } from "../src/hosted/run";
import { evaluateSubmission } from "../src/evaluator/evaluate";
import { dispatchSubtask } from "../src/executor/dispatch";
import { applyAgentResult } from "../src/executor/results";
import { executorTick } from "../src/executor/tick";
import { ChainIndexer } from "../src/indexer/indexer";
import { MemorySink } from "../src/jobs/sink";
import {
  AnthropicLlm,
  LlmError,
  MockLlm,
  type BatchApi,
  type BatchItem,
  type LlmClient,
  type LlmPurpose,
} from "../src/llm";
import { payoutsTick, settleMilestone } from "../src/payouts/payouts";
import { quoteTask } from "../src/router/quote";
import { createQuoteSigner, createRouterChain } from "../src/router/signer";
import { KEYS, sendTx, startLocalChain, type LocalChain } from "./anvil";

/**
 * Phase 3 end to end on a local stack (docs/10-BUILD-PLAN.md): create task → quote → fund (anvil)
 * → house agent completes (async, signed callbacks) → evaluator passes → client approves →
 * milestones released → provider and treasury paid, fees reach the FeeDistributor.
 * The LLM is the deterministic mock; everything else is real (DB, chain, HTTP, HMAC).
 * With E2E_LIVE_LLM=1 the happy path uses real Claude (router, house agent, judge) and prints
 * the measured LLM cost per step; it spends real API credit.
 */

const log = pino({ level: process.env["E2E_LOG"] ?? "silent" });
const TABLES = [
  "Submission",
  "Subtask",
  "Dispute",
  "TaskEvent",
  "Task",
  "FreelancerProfile",
  "Provider",
  "RefreshToken",
  "FileObject",
  "User",
  "Capability",
  "ChainEvent",
  "IndexerCursor",
  "IdempotencyKey",
];
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const MASTER = "e2e-house-agents-master-secret-0123456789";
const TRANSLATOR = HOUSE_AGENT_LISTINGS.find((l) => l.slug === "house-translator-en-sw")!;
const LIVE = process.env["E2E_LIVE_LLM"] === "1";
const SOURCE = LIVE
  ? "Jua Bora Ltd installs rooftop solar systems for homes and small shops in Arusha, Tanzania. " +
    "Since we started in 2021 we have completed 340 installations and trained 12 local technicians. " +
    "Our customers save on average 40 percent on their monthly electricity bills, and every system " +
    "comes with a two-year maintenance plan. We now want to open a second branch in Moshi, where " +
    "demand from small hotels and shops is growing quickly. We are asking for a loan of TZS 80 million " +
    "to buy stock, rent a showroom and hire four more technicians. We expect the Moshi branch to " +
    "break even within 14 months."
  : "Our company installs rooftop solar systems in Arusha. ".repeat(20).trim(); // 160 words

let chain: LocalChain;
let prisma: PrismaClient;
let house: Server;
let fakeApi: Server;
let apiUrl: string;
const sink = new MemorySink();
const secrets = new SecretBox(ENCRYPTION_KEY);
const treasury = privateKeyToAccount(generatePrivateKey()).address;
const providerOwner = privateKeyToAccount(KEYS.providerOwner);
const clientAccount = privateKeyToAccount(KEYS.client);

const plan: Plan = {
  feasible: true,
  clarifyingQuestions: [],
  subtasks: [
    {
      index: 0,
      title: "Translate the summary into Swahili",
      capability: "translate.en-sw",
      instructions: "Translate the client's summary into formal Swahili.",
      dependsOn: [],
      estimatedUnits: 0.16,
      acceptance: {
        rubric: ["Complete translation", "Formal register"],
        format: "markdown",
        mustInclude: ["Arusha"],
      },
      needsHuman: false,
    },
  ],
};
/** Plan for the hosted-agent scenario: one blog post, which only the hosted agent offers. */
const hostedPlan: Plan = {
  feasible: true,
  clarifyingQuestions: [],
  subtasks: [
    {
      index: 0,
      title: "Write the launch blog post",
      capability: "write.blog_post",
      instructions: "Write a short blog post announcing the Moshi branch.",
      dependsOn: [],
      estimatedUnits: 1,
      acceptance: { rubric: ["Announces the branch"], format: "markdown", mustInclude: ["Moshi"] },
      needsHuman: false,
    },
  ],
};
const mock = new MockLlm()
  .on("decompose", (req) => (req.user.includes("HOSTED-BLOG") ? hostedPlan : plan))
  // 9 words × 18 = 162 words: within ±30% of the 160-word source (the evaluator's length check).
  // A request containing FAIL-ME is declined, so the agent reports failure on every attempt.
  .on("agent", (req) =>
    req.user.includes("FAIL-ME")
      ? new LlmError("declined", "REFUSED")
      : "Kampuni yetu inaweka mifumo ya umeme wa jua Arusha. ".repeat(18).trim(),
  )
  .on("judge", () => ({
    score: 88,
    passed: true,
    rubric: [
      { item: "Complete translation", met: true, note: "All text translated" },
      { item: "Formal register", met: true, note: "Formal throughout" },
    ],
    feedback: "No changes needed.",
  }));

/** Fake Message Batches API (the real one is exercised by scripts/cost-experiment.ts). */
const batchSubmissions: Anthropic.MessageCreateParamsNonStreaming[] = [];
const fakeBatch: BatchApi = {
  async submit(requests) {
    batchSubmissions.push(...requests.map((r) => r.params));
    return `batch_${batchSubmissions.length}:${requests.map((r) => r.customId).join(",")}`;
  },
  async status() {
    return "ended";
  },
  async results(batchId) {
    const ids = (batchId.split(":")[1] ?? "").split(",");
    return new Map<string, BatchItem>(
      ids.map((id) => [
        id,
        {
          type: "succeeded",
          message: {
            id: `msg_${id}`,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [
              {
                type: "text",
                text: "# Jua Bora opens in Moshi\n\nOur second branch opens in Moshi this March.",
                citations: null,
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 2_000,
              output_tokens: 1_000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation: null,
              server_tool_use: null,
            },
          } as unknown as Anthropic.Message,
        },
      ]),
    );
  },
  async cancel() {},
};

/** Live mode: real Claude everywhere except the scripted failure (FAIL-ME), with cost per purpose. */
const liveCost = new Map<LlmPurpose, number>();
const real = LIVE
  ? new AnthropicLlm({
      apiKey: process.env["ANTHROPIC_API_KEY"] ?? "",
      log,
      timeoutMs: 10 * 60_000,
    })
  : undefined;
/** Real model ids in live mode (same defaults as the worker env); the mock ignores them. */
const MODEL = LIVE ? "claude-opus-5-5" : "mock";
const track = (purpose: LlmPurpose, usd: number) =>
  liveCost.set(purpose, (liveCost.get(purpose) ?? 0) + usd);
const llm: LlmClient = real
  ? {
      structured: async (req) => {
        const r = await real.structured(req);
        track(req.purpose, r.usage.costUsd);
        return r;
      },
      text: async (req) => {
        if (req.user.includes("FAIL-ME")) return mock.text(req);
        const r = await real.text(req);
        track(req.purpose, r.usage.costUsd);
        return r;
      },
    }
  : mock;

async function registerProvider(ownerKey: Hex, payout: Address): Promise<bigint> {
  const d = chain.deployment;
  const id = (await chain.publicClient.readContract({
    address: d.agentRegistry,
    abi: agentRegistryAbi,
    functionName: "nextProviderId",
  })) as bigint;
  const owner = privateKeyToAccount(ownerKey).address;
  await sendTx(chain, ownerKey, d.agentRegistry, agentRegistryAbi, "register", [
    0,
    payout,
    "ipfs://m",
    `0x${"22".repeat(32)}`,
  ]);
  if (ownerKey !== KEYS.admin) {
    await sendTx(chain, KEYS.admin, d.kaziToken, kaziTokenAbi, "transfer", [
      owner,
      chain.minAgentStake,
    ]);
  }
  await sendTx(chain, ownerKey, d.kaziToken, kaziTokenAbi, "approve", [
    d.stakingVault,
    chain.minAgentStake,
  ]);
  await sendTx(chain, ownerKey, d.stakingVault, stakingVaultAbi, "bond", [id, chain.minAgentStake]);
  await sendTx(chain, KEYS.admin, d.agentRegistry, agentRegistryAbi, "activate", [id]);
  return id;
}

const usdcBalance = (who: Address) =>
  chain.publicClient.readContract({
    address: chain.deployment.usdc,
    abi: mockUsdcAbi,
    functionName: "balanceOf",
    args: [who],
  }) as Promise<bigint>;

async function index() {
  const indexer = new ChainIndexer(
    prisma,
    chain.publicClient,
    chain.deployment,
    { chainId: 31337, confirmations: 1, batchSize: 2_000n, reorgDepth: 5n },
    log,
  );
  while ((await indexer.pollOnce()) !== null) {
    /* drain */
  }
  await indexer.processPending();
}

beforeAll(async () => {
  chain = await startLocalChain();
  prisma = createPrismaClient(process.env["DATABASE_URL"]!);
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );

  // The Kazi API's callback route, reduced to what it does: verify the HMAC, enqueue the result.
  fakeApi = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = new URL(req.url!, "http://api");
      const subtaskId = url.pathname.split("/").pop()!;
      const attempt = Number(url.searchParams.get("attempt"));
      const st = await prisma.subtask.findUnique({
        where: { id: subtaskId },
        include: { provider: true },
      });
      const ok = st?.provider?.webhookSecretEnc
        ? verifySignature(
            raw,
            req.headers["x-kazi-signature"] as string,
            secrets.decrypt(st.provider.webhookSecretEnc),
          ).ok
        : false;
      if (!ok) return void res.writeHead(401).end();
      const callback = agentCallbackSchema.parse(JSON.parse(raw));
      await sink.add(
        "executor",
        "agentResult",
        { subtaskId, attempt, callback, receivedAt: new Date().toISOString() },
        `r-${randomUUID()}`,
      );
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => fakeApi.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(fakeApi.address() as AddressInfo).port}`;

  const agents = buildHouseAgents({
    llm,
    model: MODEL,
    baseUrl: "http://127.0.0.1",
    masterSecret: MASTER,
  });
  house = createHouseServer(agents);
  await new Promise<void>((r) => house.listen(0, "127.0.0.1", r));
});

afterAll(async () => {
  house?.close();
  fakeApi?.close();
  chain?.stop();
  await prisma?.$disconnect();
});

const fees = { takeRateBps: 1_200, serviceFeeBps: 500, minServiceFee: "0.10" };
type Quoted = Extract<Awaited<ReturnType<typeof quoteTask>>, { outcome: "QUOTED" }>;
// Set by the first scenario, reused by the second (tests in a file run in order).
let runJobs: () => Promise<void>;
let createQuotedTask: (description: string) => Promise<{ taskId: string; quote: Quoted }>;
let fund: (quote: Quoted) => Promise<void>;
let statusOf: (taskId: string) => Promise<string>;
let hostedDeps: HostedDeps;

describe("Phase 3 end to end (local anvil, mock LLM)", () => {
  // Long: dozens of round trips to the (remote) test database plus anvil transactions.
  it(
    "quotes, funds, executes, evaluates, approves and pays out",
    { timeout: 600_000 },
    async () => {
      const d = chain.deployment;
      const housePort = (house.address() as AddressInfo).port;

      // ── Setup: capabilities, users, two onchain providers (house translator + Kazi service fee) ──
      await prisma.capability.createMany({
        data: CAPABILITY_DEFINITIONS.map((c) => ({ slug: c.slug, description: c.description })),
      });
      const admin = await prisma.user.create({
        data: { wallet: privateKeyToAccount(KEYS.admin).address.toLowerCase(), roles: ["ADMIN"] },
      });
      const clientUser = await prisma.user.create({
        data: { wallet: clientAccount.address.toLowerCase(), roles: ["CLIENT"] },
      });
      const translatorOnchain = await registerProvider(KEYS.providerOwner, providerOwner.address);
      const serviceOnchain = await registerProvider(KEYS.admin, treasury);
      await prisma.provider.create({
        data: {
          onchainId: translatorOnchain,
          ownerId: admin.id,
          kind: "AGENT",
          name: TRANSLATOR.name,
          slug: TRANSLATOR.slug,
          description: TRANSLATOR.description,
          capabilities: [...TRANSLATOR.capabilities],
          languages: [...TRANSLATOR.languages],
          endpointUrl: `http://127.0.0.1:${housePort}/${TRANSLATOR.slug}/run`,
          webhookSecretEnc: secrets.encrypt(deriveHouseAgentSecret(MASTER, TRANSLATOR.slug)),
          pricing: { ...TRANSLATOR.pricing },
          payoutAddress: providerOwner.address.toLowerCase(),
          status: "ACTIVE",
          isHouse: true,
          stakeAmount: chain.minAgentStake.toString(),
        },
      });
      await prisma.provider.create({
        data: {
          onchainId: serviceOnchain,
          ownerId: admin.id,
          kind: "AGENT",
          name: SERVICE_FEE_PROVIDER.name,
          slug: SERVICE_FEE_PROVIDER.slug,
          description: SERVICE_FEE_PROVIDER.description,
          pricing: { ...SERVICE_FEE_PROVIDER.pricing },
          payoutAddress: treasury.toLowerCase(),
          status: "ACTIVE",
          isHouse: true,
        },
      });

      // ── Client creates a task; the router quotes it ──
      const routerChain = createRouterChain(chain.publicClient, 31337, d);
      createQuotedTask = async (description) => {
        const id = randomUUID();
        await prisma.task.create({
          data: {
            id,
            onchainId: taskOnchainId(id),
            clientId: clientUser.id,
            title: "Translate my business summary to Swahili",
            description,
            deadline: new Date(Date.now() + 3 * 86_400_000),
          },
        });
        const q = await quoteTask(
          {
            prisma,
            llm,
            routerModel: MODEL,
            chain: routerChain,
            signer: createQuoteSigner(KEYS.quoter, 31337, d.taskEscrow),
            fees,
            log,
          },
          id,
        );
        if (q.outcome !== "QUOTED") throw new Error(`expected a quote, got ${q.outcome}`);
        return { taskId: id, quote: q };
      };
      const { taskId, quote } = await createQuotedTask(SOURCE);
      expect(quote.steps.map((s) => s.kind)).toEqual(["WORK", "SERVICE_FEE"]);
      // 0.16 × 1000 words at 0.80/1000 = 0.128 → below the 0.20 minimum; service fee hits its 0.10 minimum.
      expect(BigInt(quote.steps[0]!.cost)).toBeGreaterThanOrEqual(200_000n);
      expect(quote.serviceFee).toBe("100000");
      expect(quote.onchain.providerIds).toEqual([
        translatorOnchain.toString(),
        serviceOnchain.toString(),
      ]);

      // ── Client funds the signed quote onchain ──
      const total = BigInt(quote.total);
      fund = async (q) => {
        await sendTx(chain, KEYS.admin, d.usdc, mockUsdcAbi, "mint", [
          clientAccount.address,
          BigInt(q.total),
        ]);
        await sendTx(chain, KEYS.client, d.usdc, mockUsdcAbi, "approve", [
          d.taskEscrow,
          BigInt(q.total),
        ]);
        await sendTx(chain, KEYS.client, d.taskEscrow, taskEscrowAbi, "createAndFund", [
          {
            taskId: q.onchain.taskId as Hex,
            providerIds: q.onchain.providerIds.map(BigInt),
            amounts: q.onchain.amounts.map(BigInt),
            deadline: BigInt(q.onchain.deadline),
            feeBps: q.onchain.feeBps,
            expiry: BigInt(q.onchain.expiry),
          },
          q.signature as Hex,
        ]);
        await index();
      };
      await fund(quote);
      expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        "FUNDED",
      );

      // ── Run the worker loop by hand until the task is delivered ──
      const operator = createEscrowOperator({
        publicClient: chain.publicClient,
        rpcUrl: chain.rpcUrl,
        chain: foundry,
        escrow: d.taskEscrow,
        privateKey: KEYS.operator,
        minMaxFeePerGasWei: 0n,
        log,
      });
      const usdcDecimals = () => routerChain.usdcDecimals();
      hostedDeps = {
        prisma,
        llm,
        batch: fakeBatch,
        jobs: sink,
        usdcDecimals,
        config: { maxAttempts: 3, attemptTimeoutSec: 600, syncResponseTimeoutMs: 10_000, apiUrl },
        log,
      };
      runJobs = async () => {
        for (const job of sink.drain()) {
          if (job.queue === "executor" && job.name === "dispatch") {
            const j = jobSchemas.executor.dispatch.parse(job.data);
            await dispatchSubtask(
              {
                prisma,
                secrets,
                jobs: sink,
                operator,
                usdcDecimals,
                log,
                config: {
                  maxAttempts: 3,
                  attemptTimeoutSec: 600,
                  syncResponseTimeoutMs: 10_000,
                  apiUrl,
                },
              },
              j.subtaskId,
              j.attempt,
            );
          } else if (job.queue === "executor" && job.name === "hostedRun") {
            const j = jobSchemas.executor.hostedRun.parse(job.data);
            await runHosted(hostedDeps, j.subtaskId, j.attempt);
          } else if (job.queue === "executor" && job.name === "agentResult") {
            const j = jobSchemas.executor.agentResult.parse(job.data);
            await applyAgentResult({ prisma, jobs: sink, log }, j.subtaskId, j.attempt, j.callback);
          } else if (job.queue === "evaluator") {
            const j = jobSchemas.evaluator.evaluate.parse(job.data);
            await evaluateSubmission(
              {
                prisma,
                llm,
                judgeModel: MODEL,
                usdcDecimals,
                log,
                config: { passThreshold: 70, doubleJudgeAbove: "50" },
              },
              j.submissionId,
            );
          } else if (job.queue === "payouts") {
            const j = jobSchemas.payouts.release.parse(job.data);
            await settleMilestone(
              { prisma, jobs: sink, operator, log },
              j.subtaskId,
              job.name === "release" ? "release" : "refund",
            );
          }
        }
      };
      statusOf = async (id) => (await prisma.task.findUniqueOrThrow({ where: { id } })).status;
      for (let i = 0; i < 20 && (await statusOf(taskId)) !== "DELIVERED"; i++) {
        await executorTick({
          prisma,
          jobs: sink,
          log,
          config: { maxAttempts: 3, reviewWindowHours: 72 },
        });
        await runJobs();
        await new Promise((r) => setTimeout(r, 100)); // let the async agent post its callbacks
      }
      expect(await statusOf(taskId)).toBe("DELIVERED");
      const work = await prisma.subtask.findFirstOrThrow({
        where: { taskId, kind: "WORK" },
        include: { submissions: { orderBy: { attempt: "asc" } } },
      });
      expect(work.status).toBe("ACCEPTED");
      const accepted = work.submissions.at(-1);
      expect(accepted?.accepted).toBe(true);
      if (LIVE) {
        const out = accepted?.output as { text?: string } | undefined;
        console.log(
          `\n[live] translation (attempt ${accepted?.attempt}, score ${accepted?.score}):\n${out?.text ?? ""}\n`,
        );
      } else {
        expect(accepted?.score).toBe(88);
      }
      const events = (await prisma.taskEvent.findMany({ where: { taskId } })).map((e) => e.type);
      expect(events).toEqual(
        expect.arrayContaining([
          "QUOTED",
          "STATUS_FUNDED",
          "SUBTASK_DISPATCHED",
          "SUBTASK_PROGRESS",
          "SUBTASK_SUBMITTED",
          "SUBTASK_ACCEPTED",
          "STATUS_DELIVERED",
        ]),
      );

      // ── Client approves; the payout worker releases both milestones onchain ──
      await prisma.task.update({ where: { id: taskId }, data: { approvedAt: new Date() } });
      const before = {
        provider: await usdcBalance(providerOwner.address),
        treasury: await usdcBalance(treasury),
        distributor: await usdcBalance(d.feeDistributor),
      };
      await payoutsTick({ prisma, jobs: sink, operator, log });
      await runJobs();
      await index();

      const done = await prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { subtasks: { orderBy: { index: "asc" } } },
      });
      expect(done.status).toBe("COMPLETED");
      expect(done.subtasks.map((s) => s.status)).toEqual(["RELEASED", "RELEASED"]);
      const [workAmount, serviceAmount] = quote.onchain.amounts.map(BigInt) as [bigint, bigint];
      const providerGot = (await usdcBalance(providerOwner.address)) - before.provider;
      const treasuryGot = (await usdcBalance(treasury)) - before.treasury;
      const feesGot = (await usdcBalance(d.feeDistributor)) - before.distributor;
      expect(providerGot).toBe(providerPayout(workAmount, 1_200));
      expect(providerGot).toBeGreaterThanOrEqual(BigInt(quote.steps[0]!.cost));
      expect(treasuryGot).toBeGreaterThanOrEqual(100_000n); // Kazi nets the full service fee
      expect(providerGot + treasuryGot + feesGot).toBe(total); // every base unit accounted for
      expect(feesGot).toBe(workAmount + serviceAmount - providerGot - treasuryGot);
      expect(Number(done.llmCostUsd)).toBeGreaterThan(0); // router + judge calls were charged to the task
      if (LIVE) {
        const agentUsd = liveCost.get("agent") ?? 0;
        console.log(
          `[live] LLM cost for this task: router $${(liveCost.get("decompose") ?? 0).toFixed(4)}, ` +
            `house agent $${agentUsd.toFixed(4)}, judge $${(liveCost.get("judge") ?? 0).toFixed(4)}; ` +
            `Kazi-side (router + judge) recorded on the task: $${Number(done.llmCostUsd).toFixed(4)}; ` +
            `task total ${quote.total} base units (${Number(quote.total) / 1e6} USDC)`,
        );
      }
    },
  );

  it(
    "refunds the client in full when the agent fails every attempt",
    { timeout: 600_000 },
    async () => {
      const d = chain.deployment;
      const { taskId, quote } = await createQuotedTask(`${SOURCE} FAIL-ME`);
      await fund(quote);
      const clientBefore = await usdcBalance(clientAccount.address);

      const operator = createEscrowOperator({
        publicClient: chain.publicClient,
        rpcUrl: chain.rpcUrl,
        chain: foundry,
        escrow: d.taskEscrow,
        privateKey: KEYS.operator,
        minMaxFeePerGasWei: 0n,
        log,
      });
      for (let i = 0; i < 20; i++) {
        const st = await prisma.subtask.findFirstOrThrow({ where: { taskId, kind: "WORK" } });
        if (st.status === "FAILED") break;
        await executorTick({
          prisma,
          jobs: sink,
          log,
          config: { maxAttempts: 3, reviewWindowHours: 72 },
        });
        await runJobs();
        await new Promise((r) => setTimeout(r, 100));
      }
      const work = await prisma.subtask.findFirstOrThrow({
        where: { taskId, kind: "WORK" },
        include: { submissions: { orderBy: { attempt: "asc" } } },
      });
      expect(work.status).toBe("FAILED");
      expect(work.attempts).toBe(3);
      expect(
        work.submissions.map((x) => (x.output as { error?: { code: string } }).error?.code),
      ).toEqual(["DECLINED", "DECLINED", "DECLINED"]);

      // The payout worker refunds the failed step and, since nothing was delivered, the service fee too.
      await payoutsTick({ prisma, jobs: sink, operator, log });
      await runJobs();
      await index();
      const done = await prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { subtasks: { orderBy: { index: "asc" } } },
      });
      expect(done.subtasks.map((x) => x.status)).toEqual(["REFUNDED", "REFUNDED"]);
      expect(await statusOf(taskId)).toBe("REFUNDED");
      expect((await usdcBalance(clientAccount.address)) - clientBefore).toBe(BigInt(quote.total)); // every base unit back
    },
  );

  it(
    "Kazi-hosted agent on Economy: batch run, AI cost in Kazi's milestone, developer nets price − AI cost",
    { timeout: 600_000 },
    async () => {
      const d = chain.deployment;
      const owner = await prisma.user.findFirstOrThrow({ where: { roles: { has: "ADMIN" } } });
      const developer = privateKeyToAccount(generatePrivateKey()).address;
      const onchainId = await registerProvider(KEYS.providerOwner, developer);
      // $0.03 per task on batch prices, $0.06 on standard prices (from an advice run).
      const hosted = await prisma.provider.create({
        data: {
          onchainId,
          ownerId: owner.id,
          kind: "AGENT",
          name: "Hosted Blogger",
          slug: "hosted-blogger",
          description: "A Kazi-hosted blog writer",
          capabilities: ["write.blog_post"],
          languages: ["en"],
          pricing: { model: "fixed", price: "1.00", currency: "USDC" },
          payoutAddress: developer.toLowerCase(),
          status: "ACTIVE",
          stakeAmount: chain.minAgentStake.toString(),
          hosting: "KAZI",
          hostedConfig: {
            instructions:
              "You write short, friendly launch blog posts for small East African businesses.",
            model: "claude-sonnet-5-5",
            effort: "medium",
            webSearch: null,
            maxOutputTokens: 16_000,
            samples: [],
          },
          aiCost: {
            economyNano: "30000000",
            expressNano: "60000000",
            samples: 1,
            updatedAt: new Date().toISOString(),
          },
        },
      });

      const { taskId, quote } = await createQuotedTask(
        "HOSTED-BLOG Announce our new Moshi branch.",
      );
      expect(quote.speed).toBe("ECONOMY");
      expect(quote.aiCost).toBe("30000"); // $0.03 at 6 decimals
      const workStep = quote.steps[0]!;
      expect(workStep.providerId).toBe(hosted.id);
      expect(workStep.aiCost).toBe("30000");
      expect(BigInt(workStep.cost)).toBeGreaterThanOrEqual(970_000n); // developer nets $1.00 − $0.03

      // Express on the same work costs the client exactly the extra AI cost (+ fees), nothing else.
      const express = await createQuotedTask("HOSTED-BLOG Announce our new Moshi branch, quickly.");
      await prisma.task.update({
        where: { id: express.taskId },
        data: { speed: "EXPRESS", status: "EXPIRED" },
      });
      const expressQuote = await quoteTask(
        {
          prisma,
          llm,
          routerModel: MODEL,
          chain: createRouterChain(chain.publicClient, 31337, d),
          signer: createQuoteSigner(KEYS.quoter, 31337, d.taskEscrow),
          fees,
          log,
        },
        express.taskId,
      );
      if (expressQuote.outcome !== "QUOTED") throw new Error("expected a quote");
      expect(expressQuote.speed).toBe("EXPRESS");
      expect(expressQuote.aiCost).toBe("60000");
      expect(expressQuote.steps[0]!.amount).toBe(workStep.amount); // developer's milestone unchanged
      expect(BigInt(expressQuote.total)).toBeGreaterThan(BigInt(quote.total));

      // Fund the Economy quote and run it: the hosted step goes through the (fake) Batch API.
      await fund(quote);
      const operator = createEscrowOperator({
        publicClient: chain.publicClient,
        rpcUrl: chain.rpcUrl,
        chain: foundry,
        escrow: d.taskEscrow,
        privateKey: KEYS.operator,
        minMaxFeePerGasWei: 0n,
        log,
      });
      const before = batchSubmissions.length;
      for (let i = 0; i < 20 && (await statusOf(taskId)) !== "DELIVERED"; i++) {
        await executorTick({
          prisma,
          jobs: sink,
          log,
          config: { maxAttempts: 3, reviewWindowHours: 72 },
        });
        await runJobs();
        await pollHostedRuns(hostedDeps);
        await runJobs();
      }
      expect(await statusOf(taskId)).toBe("DELIVERED");
      expect(batchSubmissions.length).toBe(before + 1);
      const sent = batchSubmissions.at(-1)!;
      expect(sent.model).toBe("claude-sonnet-5-5");
      expect(JSON.stringify(sent.system)).toContain("short, friendly launch blog posts"); // developer instructions
      expect(JSON.stringify(sent.system)).toContain("<agent_instructions>"); // inside Kazi's rules

      const run = await prisma.hostedRun.findFirstOrThrow({ where: { subtask: { taskId } } });
      expect(run).toMatchObject({ mode: "BATCH", status: "SUCCEEDED" });
      // Sonnet batch: 2,000 in × $1/M + 1,000 out × $5/M = $0.007
      expect(run.costNano).toBe("7000000");
      const est = aiCostEstimateSchema.parse(
        (await prisma.provider.findUniqueOrThrow({ where: { id: hosted.id } })).aiCost,
      );
      expect(est.samples).toBe(2);
      expect(BigInt(est.economyNano)).toBeLessThan(30_000_000n); // the estimate moved toward the measured $0.007

      // Approve → both milestones released; the developer gets their net, Kazi's treasury gets fee + AI cost.
      await prisma.task.update({ where: { id: taskId }, data: { approvedAt: new Date() } });
      const devBefore = await usdcBalance(developer);
      const treasuryBefore = await usdcBalance(treasury);
      await payoutsTick({ prisma, jobs: sink, operator, log });
      await runJobs();
      await index();
      expect(await statusOf(taskId)).toBe("COMPLETED");
      const [workAmount, kaziAmount] = quote.onchain.amounts.map(BigInt) as [bigint, bigint];
      expect((await usdcBalance(developer)) - devBefore).toBe(providerPayout(workAmount, 1_200));
      const treasuryGot = (await usdcBalance(treasury)) - treasuryBefore;
      expect(treasuryGot).toBe(providerPayout(kaziAmount, 1_200));
      expect(treasuryGot).toBeGreaterThanOrEqual(
        BigInt(quote.serviceFee) + nanoUsdToUnits(30_000_000n, 6),
      );
    },
  );
});
