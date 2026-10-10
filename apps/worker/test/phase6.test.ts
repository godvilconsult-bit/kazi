import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createTestClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { createPrismaClient, type PrismaClient } from "@kazi/db";
import { airdropLeaf, holderKey, kaziAirdropAbi, kaziTokenAbi, stakingVaultAbi, taskOnchainId, verifyMerkleProof } from "@kazi/shared";
import { createEscrowOperator } from "../src/chain/operator";
import { maturedStakeKeys } from "../src/payouts/fees";
import { clientFeeBps } from "../src/router/quote";
import { planAirdrop } from "../src/points/airdrop";
import { recomputePoints } from "../src/points/points";
import { artifact, KEYS, sendTx, startLocalChain, type LocalChain } from "./anvil";

/** Phase 6: airdrop plan + Merkle proofs against KaziAirdrop, stake activation keeper, points rules. */

const log = pino({ level: "silent" });
const wallet = (): Address => `0x${randomBytes(20).toString("hex")}`;
const KAZI = 10n ** 18n;
const DAY = 86_400;

describe("airdrop plan", () => {
  it("splits pro rata to points, skips small and excluded wallets, and every proof verifies", () => {
    const [a, b, c, d] = [wallet(), wallet(), wallet(), wallet()];
    const plan = planAirdrop({
      holders: [
        { wallet: a, points: 300n },
        { wallet: b, points: 100n },
        { wallet: c, points: 50n },
        { wallet: d, points: 1_000n },
      ],
      total: 1_000n,
      minPoints: 60n,
      exclude: [d.toUpperCase().replace("0X", "0x") as Address],
    });
    const byWallet = new Map(plan.allocations.map((x) => [x.wallet.toLowerCase(), x.amount]));
    expect(byWallet.get(a)).toBe(750n);
    expect(byWallet.get(b)).toBe(250n);
    expect(byWallet.has(c)).toBe(false);
    expect(byWallet.has(d)).toBe(false);
    expect(plan.allocated + plan.unallocated).toBe(1_000n);
    for (const x of plan.allocations) expect(verifyMerkleProof(x.proof, plan.root, airdropLeaf(x.wallet, x.amount))).toBe(true);
    // A proof doesn't work for another amount.
    const first = plan.allocations[0]!;
    expect(verifyMerkleProof(first.proof, plan.root, airdropLeaf(first.wallet, first.amount + 1n))).toBe(false);
  });

  it("caps each wallet and re-splits the excess; leftover stays unallocated when everyone is capped", () => {
    const [whale, b, c] = [wallet(), wallet(), wallet()];
    const capped = planAirdrop({
      holders: [
        { wallet: whale, points: 9_000n },
        { wallet: b, points: 500n },
        { wallet: c, points: 500n },
      ],
      total: 1_000n,
      maxPerWallet: 400n,
    });
    const amounts = Object.fromEntries(capped.allocations.map((x) => [x.wallet.toLowerCase(), x.amount]));
    expect(amounts).toEqual({ [whale]: 400n, [b]: 300n, [c]: 300n });

    const allCapped = planAirdrop({ holders: [{ wallet: b, points: 10n }, { wallet: c, points: 10n }], total: 1_000n, maxPerWallet: 100n });
    expect(allCapped.allocated).toBe(200n);
    expect(allCapped.unallocated).toBe(800n);
  });

  it("pays fixed allocations first, merges duplicate wallets, and is order-independent", () => {
    const [a, b, e] = [wallet(), wallet(), wallet()];
    const holders = [
      { wallet: a, points: 50n },
      { wallet: a.toUpperCase().replace("0X", "0x") as Address, points: 50n },
      { wallet: b, points: 100n },
    ];
    const plan = planAirdrop({ holders, total: 1_000n, fixed: [{ wallet: e, amount: 200n }] });
    const amounts = Object.fromEntries(plan.allocations.map((x) => [x.wallet.toLowerCase(), x.amount]));
    expect(amounts).toEqual({ [a]: 400n, [b]: 400n, [e]: 200n });
    const again = planAirdrop({ holders: [...holders].reverse(), total: 1_000n, fixed: [{ wallet: e, amount: 200n }] });
    expect(again.root).toBe(plan.root);
  });

  it("rejects impossible plans", () => {
    expect(() => planAirdrop({ holders: [], total: 100n, fixed: [{ wallet: wallet(), amount: 101n }] })).toThrow(/exceed/);
    expect(() => planAirdrop({ holders: [{ wallet: wallet(), points: 5n }], total: 100n, minPoints: 10n })).toThrow(/nobody/);
  });
});

describe("onchain", () => {
  let chain: LocalChain;
  let prisma: PrismaClient;
  const test = () => createTestClient({ chain: foundry, mode: "anvil", transport: http(chain.rpcUrl) });
  const timeTravel = async (seconds: number) => {
    await test().increaseTime({ seconds });
    await test().mine({ blocks: 1 });
  };
  const now = async () => Number((await chain.publicClient.getBlock()).timestamp);
  const balanceOf = (who: Address) =>
    chain.publicClient.readContract({ address: chain.deployment.kaziToken, abi: kaziTokenAbi, functionName: "balanceOf", args: [who] });

  beforeAll(async () => {
    chain = await startLocalChain();
    prisma = createPrismaClient(process.env["DATABASE_URL"]!);
  });
  afterAll(async () => {
    chain?.stop();
    await prisma?.$disconnect();
  });

  it("KaziAirdrop accepts the TypeScript tree's proofs: 25% at start, the rest linearly", async () => {
    const client = privateKeyToAccount(KEYS.client).address;
    const other = privateKeyToAccount(KEYS.providerOwner).address;
    const plan = planAirdrop({
      holders: [],
      total: 10_000n * KAZI,
      fixed: [
        { wallet: client, amount: 1_000n * KAZI },
        { wallet: other, amount: 3_000n * KAZI },
      ],
    });
    const admin = chain.wallet(KEYS.admin);
    const start = BigInt(await now());
    const vesting = BigInt(180 * DAY);
    const hash = await admin.deployContract({
      abi: kaziAirdropAbi,
      bytecode: artifact("KaziAirdrop"),
      args: [admin.account!.address, chain.deployment.kaziToken, plan.root, start, vesting, 2_500, start + vesting + BigInt(365 * DAY)],
      account: admin.account!,
      chain: foundry,
    });
    const airdrop = (await chain.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
    await sendTx(chain, KEYS.admin, chain.deployment.kaziToken, kaziTokenAbi, "transfer", [airdrop, plan.allocated]);

    const mine = plan.allocations.find((x) => x.wallet === client)!;
    const claim = (key: Hex, amount: bigint, proof: Hex[]) => sendTx(chain, key, airdrop, kaziAirdropAbi, "claim", [amount, proof]);

    await claim(KEYS.client, mine.amount, mine.proof);
    const afterFirst = await balanceOf(client);
    expect(afterFirst).toBeGreaterThanOrEqual(250n * KAZI); // 25% at start (+ a few seconds of vesting)
    expect(afterFirst).toBeLessThan(251n * KAZI);

    await expect(claim(KEYS.client, mine.amount + 1n, mine.proof)).rejects.toThrow(); // wrong amount
    await expect(claim(KEYS.providerOwner, mine.amount, mine.proof)).rejects.toThrow(); // someone else's leaf

    await timeTravel(90 * DAY); // half way: 250 + 750 / 2
    await claim(KEYS.client, mine.amount, mine.proof);
    const half = await balanceOf(client);
    expect(half).toBeGreaterThanOrEqual(625n * KAZI);
    expect(half).toBeLessThan(626n * KAZI);

    await timeTravel(91 * DAY);
    await claim(KEYS.client, mine.amount, mine.proof);
    expect(await balanceOf(client)).toBe(1_000n * KAZI);
    expect(await chain.publicClient.readContract({ address: airdrop, abi: kaziAirdropAbi, functionName: "claimed", args: [client] })).toBe(1_000n * KAZI);
    await expect(claim(KEYS.client, mine.amount, mine.proof)).rejects.toThrow(); // nothing left
  });

  it("the keeper finds stake whose warm-up ended and activates it", async () => {
    const d = chain.deployment;
    const holder = privateKeyToAccount(KEYS.client).address;
    const amount = 5_000n * KAZI;
    await sendTx(chain, KEYS.admin, d.kaziToken, kaziTokenAbi, "transfer", [holder, amount]);
    await sendTx(chain, KEYS.client, d.kaziToken, kaziTokenAbi, "approve", [d.stakingVault, amount]);
    const receipt = await sendTx(chain, KEYS.client, d.stakingVault, stakingVaultAbi, "stake", [amount]);
    // anvil is deterministic: a rerun produces the same tx hash, so clear any row from a previous run.
    await prisma.chainEvent.deleteMany({ where: { chainId: foundry.id, txHash: receipt.transactionHash } });
    await prisma.chainEvent.create({
      data: {
        chainId: foundry.id,
        contract: d.stakingVault.toLowerCase(),
        name: "Staked",
        txHash: receipt.transactionHash,
        logIndex: 0,
        blockNumber: receipt.blockNumber,
        args: { holder, amount: amount.toString() },
      },
    });
    const deps = { prisma, publicClient: chain.publicClient, vault: d.stakingVault };
    expect(await maturedStakeKeys(deps)).toEqual([]); // still warming up

    await timeTravel(DAY + 1);
    const keys = await maturedStakeKeys(deps);
    expect(keys).toEqual([holderKey(holder)]);

    const operator = createEscrowOperator({
      publicClient: chain.publicClient,
      rpcUrl: chain.rpcUrl,
      chain: foundry,
      escrow: d.taskEscrow,
      privateKey: KEYS.operator,
      minMaxFeePerGasWei: 0n,
      log,
    });
    await operator.pokeStakes(d.stakingVault, keys);
    const account = await chain.publicClient.readContract({ address: d.stakingVault, abi: stakingVaultAbi, functionName: "getAccount", args: [holderKey(holder)] });
    expect(account.active).toBe(amount);
    expect(account.pending).toBe(0n);
    expect(await maturedStakeKeys(deps)).toEqual([]);
  });
});

describe("points", () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = createPrismaClient(process.env["DATABASE_URL"]!);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("gives clients points for fees paid to house agents, but no provider points to Kazi", async () => {
    const client = await prisma.user.create({ data: { wallet: wallet() } });
    const kazi = await prisma.user.create({ data: { wallet: wallet() } });
    const dev = await prisma.user.create({ data: { wallet: wallet() } });
    const provider = (ownerId: string, isHouse: boolean) =>
      prisma.provider.create({
        data: {
          ownerId,
          kind: "AGENT",
          name: isHouse ? "House writer" : "Indie writer",
          slug: `p-${randomUUID()}`,
          description: "Writes",
          capabilities: ["write.business_plan"],
          pricing: { model: "fixed", price: "10.00", currency: "USDC" },
          payoutAddress: wallet(),
          status: "ACTIVE",
          isHouse,
        },
      });
    const house = await provider(kazi.id, true);
    const indie = await provider(dev.id, false);
    const id = randomUUID();
    await prisma.task.create({
      data: {
        id,
        onchainId: taskOnchainId(id),
        clientId: client.id,
        title: "Plan",
        description: "Two plans",
        deadline: new Date(Date.now() + DAY * 1000),
        status: "COMPLETED",
        feeBps: 1_200,
        subtasks: {
          create: [
            { index: 0, title: "House plan", instructions: "Write", capability: "write.business_plan", dependsOn: [], acceptance: {}, providerId: house.id, amount: "10000000", status: "RELEASED" },
            { index: 1, title: "Indie plan", instructions: "Write", capability: "write.business_plan", dependsOn: [], acceptance: {}, providerId: indie.id, amount: "10000000", status: "RELEASED" },
          ],
        },
      },
    });

    await recomputePoints({ prisma, usdcDecimals: async () => 6, log });
    const entries = await prisma.pointsEntry.findMany({ where: { taskId: id } });
    const of = (userId: string) => entries.find((e) => e.userId === userId);
    expect(of(client.id)).toMatchObject({ role: "CLIENT", points: 240, flag: null }); // 2.4 USDC of fees × 100
    expect(of(dev.id)).toMatchObject({ role: "PROVIDER", points: 60 }); // 1.2 USDC × 50
    expect(of(kazi.id)).toBeUndefined();
  });
});

describe("staker fee discount", () => {
  const chainWith = (stake: bigint | Error) => ({
    chainId: 31337,
    escrow: "0x0000000000000000000000000000000000000001" as Address,
    usdcDecimals: async () => 6,
    publishedFeeBps: async () => 1_200,
    minAgentStake: async () => 0n,
    kaziDecimals: async () => 18,
    earningStake: async () => {
      if (stake instanceof Error) throw stake;
      return stake;
    },
  });
  const fees = { takeRateBps: 1_200, serviceFeeBps: 300, minServiceFee: "0.10" };
  const client = "0x00000000000000000000000000000000000000c1" as Address;

  it("takes 2 points off for clients with at least 5,000 KAZI earning stake", async () => {
    expect(await clientFeeBps({ chain: chainWith(5_000n * KAZI), fees, log }, client)).toBe(1_000);
    expect(await clientFeeBps({ chain: chainWith(4_999n * KAZI), fees, log }, client)).toBe(1_200);
  });

  it("falls back to the standard fee when the chain can't be read or has no token", async () => {
    expect(await clientFeeBps({ chain: chainWith(new Error("rpc down")), fees, log }, client)).toBe(1_200);
    const { earningStake: _e, kaziDecimals: _k, ...noToken } = chainWith(0n);
    expect(await clientFeeBps({ chain: noToken, fees, log }, client)).toBe(1_200);
  });
});
