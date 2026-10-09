import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { pino } from "pino";
import { privateKeyToAccount } from "viem/accounts";
import { createPrismaClient, type PrismaClient } from "@kazi/db";
import {
  agentRegistryAbi,
  kaziTokenAbi,
  mockUsdcAbi,
  stakingVaultAbi,
  taskEscrowAbi,
  taskOnchainId,
} from "@kazi/shared";
import { ChainIndexer } from "../src/indexer/indexer";
import { reconcileEscrow } from "../src/jobs/reconcile";
import { KEYS, sendTx, startLocalChain, type LocalChain } from "./anvil";

const log = pino({ level: "silent" });
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

let chain: LocalChain;
let prisma: PrismaClient;
let redis: Redis;
const prefix = process.env["REDIS_KEY_PREFIX"]!;

const client = privateKeyToAccount(KEYS.client);
const providerOwner = privateKeyToAccount(KEYS.providerOwner);
const amounts = [70_000_000n, 30_000_000n] as const; // 70 + 30 USDC (6 decimals)

function newIndexer() {
  return new ChainIndexer(
    prisma,
    chain.publicClient,
    chain.deployment,
    { chainId: 31337, confirmations: 1, batchSize: 2_000n, reorgDepth: 5n },
    log,
  );
}
async function index(indexer = newIndexer()) {
  while ((await indexer.pollOnce()) !== null) {
    /* drain */
  }
  return indexer.processPending();
}

beforeAll(async () => {
  chain = await startLocalChain();
  prisma = createPrismaClient(process.env["DATABASE_URL"]!);
  redis = new Redis(process.env["REDIS_URL"]!, { maxRetriesPerRequest: 3 });
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  chain?.stop();
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
  await prisma.$disconnect();
});

describe("chain indexer (local anvil)", () => {
  let taskId: string;
  let onchainTaskId: `0x${string}`;
  let dbProviderId: string;

  it("indexes registry activation + bond, and a funded task becomes FUNDED", async () => {
    const d = chain.deployment;
    const owner = await prisma.user.create({
      data: { wallet: providerOwner.address.toLowerCase(), roles: ["PROVIDER_OWNER"] },
    });
    const clientUser = await prisma.user.create({ data: { wallet: client.address.toLowerCase() } });

    // Provider registers onchain (id 1), bonds the minimum, gets activated by the registrar.
    await sendTx(chain, KEYS.providerOwner, d.agentRegistry, agentRegistryAbi, "register", [
      0,
      providerOwner.address,
      "ipfs://manifest",
      `0x${"11".repeat(32)}`,
    ]);
    await sendTx(chain, KEYS.admin, d.kaziToken, kaziTokenAbi, "transfer", [
      providerOwner.address,
      chain.minAgentStake,
    ]);
    await sendTx(chain, KEYS.providerOwner, d.kaziToken, kaziTokenAbi, "approve", [
      d.stakingVault,
      chain.minAgentStake,
    ]);
    await sendTx(chain, KEYS.providerOwner, d.stakingVault, stakingVaultAbi, "bond", [
      1n,
      chain.minAgentStake,
    ]);
    await sendTx(chain, KEYS.admin, d.agentRegistry, agentRegistryAbi, "activate", [1n]);
    const provider = await prisma.provider.create({
      data: {
        onchainId: 1n,
        ownerId: owner.id,
        kind: "AGENT",
        name: "Test Agent",
        slug: "test-agent",
        description: "Indexer test agent",
        pricing: { model: "fixed", price: "1.00", currency: "USDC" },
        payoutAddress: providerOwner.address.toLowerCase(),
      },
    });
    dbProviderId = provider.id;

    // A QUOTED task in the DB; the quoter signs in TypeScript (viem) — must match the contract's EIP-712.
    taskId = randomUUID();
    onchainTaskId = taskOnchainId(taskId);
    await prisma.task.create({
      data: {
        id: taskId,
        onchainId: onchainTaskId,
        clientId: clientUser.id,
        title: "Indexer test",
        description: "Fund me",
        deadline: new Date(Date.now() + 86_400_000),
        status: "QUOTED",
      },
    });
    const block = await chain.publicClient.getBlock();
    const quote = {
      taskId: onchainTaskId,
      providerIds: [1n, 1n],
      amounts: [...amounts],
      deadline: block.timestamp + 3n * 86_400n,
      feeBps: 1_200,
      expiry: block.timestamp + 1_800n,
    };
    const quoteSig = await chain.wallet(KEYS.quoter).signTypedData({
      account: privateKeyToAccount(KEYS.quoter),
      domain: { name: "KaziEscrow", version: "1", chainId: 31337, verifyingContract: d.taskEscrow },
      types: {
        Quote: [
          { name: "taskId", type: "bytes32" },
          { name: "client", type: "address" },
          { name: "providerIds", type: "uint256[]" },
          { name: "amounts", type: "uint128[]" },
          { name: "deadline", type: "uint64" },
          { name: "feeBps", type: "uint16" },
          { name: "expiry", type: "uint64" },
        ],
      },
      primaryType: "Quote",
      message: { ...quote, client: client.address },
    });
    const total = amounts[0] + amounts[1];
    await sendTx(chain, KEYS.admin, d.usdc, mockUsdcAbi, "mint", [client.address, total]);
    await sendTx(chain, KEYS.client, d.usdc, mockUsdcAbi, "approve", [d.taskEscrow, total]);
    const fundReceipt = await sendTx(
      chain,
      KEYS.client,
      d.taskEscrow,
      taskEscrowAbi,
      "createAndFund",
      [quote, quoteSig],
    );

    await index();

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("FUNDED");
    expect(task.totalAmount).toBe(total.toString());
    expect(task.feeBps).toBe(1_200);
    expect(task.fundTxHash).toBe(fundReceipt.transactionHash);
    const p = await prisma.provider.findUniqueOrThrow({ where: { id: dbProviderId } });
    expect(p.status).toBe("ACTIVE");
    expect(p.stakeAmount).toBe(chain.minAgentStake.toString());
    const events = await prisma.taskEvent.findMany({ where: { taskId } });
    expect(events.map((e) => e.type)).toContain("STATUS_FUNDED");
  });

  it("reconciliation matches the escrow balance", async () => {
    const result = await reconcileEscrow(
      prisma,
      chain.publicClient,
      chain.deployment,
      31337,
      redis,
      prefix,
      log,
    );
    expect(result?.ok).toBe(true);
    expect(result?.onchainBalance).toBe((amounts[0] + amounts[1]).toString());
    expect(JSON.parse((await redis.get(`${prefix}:reconciliation:last`))!)).toMatchObject({
      ok: true,
    });
  });

  it("is idempotent: re-indexing (with reorg re-scan) creates no duplicates", async () => {
    const chainEvents = await prisma.chainEvent.count();
    const taskEvents = await prisma.taskEvent.count();
    await prisma.indexerCursor.updateMany({ data: { lastBlock: { decrement: 3n } } }); // force overlap
    await index(newIndexer());
    expect(await prisma.chainEvent.count()).toBe(chainEvents);
    expect(await prisma.taskEvent.count()).toBe(taskEvents);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("FUNDED");
  });

  it("releasing every milestone closes the task as COMPLETED", async () => {
    const d = chain.deployment;
    await sendTx(chain, KEYS.operator, d.taskEscrow, taskEscrowAbi, "releaseMilestone", [
      onchainTaskId,
      0n,
    ]);
    await sendTx(chain, KEYS.operator, d.taskEscrow, taskEscrowAbi, "releaseMilestone", [
      onchainTaskId,
      1n,
    ]);
    await index();

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("COMPLETED");
    const types = (
      await prisma.taskEvent.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } })
    ).map((e) => e.type);
    expect(types.filter((t) => t === "MILESTONE_RELEASED")).toHaveLength(2);
    expect(types).toContain("STATUS_COMPLETED");

    const result = await reconcileEscrow(
      prisma,
      chain.publicClient,
      chain.deployment,
      31337,
      redis,
      prefix,
      log,
    );
    expect(result).toMatchObject({ ok: true, onchainBalance: "0", expectedBalance: "0" });
  });

  it("flags a mismatch when USDC reaches the escrow outside the protocol", async () => {
    const d = chain.deployment;
    await sendTx(chain, KEYS.admin, d.usdc, mockUsdcAbi, "mint", [d.taskEscrow, 5n]);
    await index();
    const result = await reconcileEscrow(
      prisma,
      chain.publicClient,
      chain.deployment,
      31337,
      redis,
      prefix,
      log,
    );
    expect(result).toMatchObject({ ok: false, difference: "5" });
  });
});
