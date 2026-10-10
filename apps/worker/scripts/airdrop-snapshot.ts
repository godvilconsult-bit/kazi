/**
 * Airdrop snapshot (docs/08-TOKENOMICS.md §5): points → $KAZI allocations → Merkle root.
 *
 *   pnpm -F @kazi/worker airdrop:snapshot -- --airdrop-id early-users-1 --total 100000000 \
 *     [--min-points 100] [--max-share-bps 100] [--fixed arcdex.csv] [--exclude 0xabc,0xdef] \
 *     [--out airdrop.json] [--no-recompute] [--write [--replace]]
 *
 * --total is in KAZI (decimals read from the token). Points are recomputed first unless
 * --no-recompute. Kazi's own wallets (admins, ADMIN_WALLETS, owners of house agents) and --exclude
 * never qualify. --fixed is a CSV of `wallet,amount`
 * (KAZI) paid before the points split. The plan (root, every allocation and proof) is written to
 * --out; pass the root to DeployTokenLaunch as AIRDROP_MERKLE_ROOT. --write stores the allocations
 * for GET /airdrop/:wallet (set AIRDROP_ID on the API); it refuses to overwrite a published
 * airdrop unless --replace.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pino } from "pino";
import { createPublicClient, erc20Abi, http, isAddress, type Address } from "viem";
import {
  chainEnvSchema,
  dbEnvSchema,
  getChainConfig,
  loadEnv,
  runtimeEnvSchema,
} from "@kazi/config";
import { loadDeployment } from "@kazi/config/deployments";
import { createPrismaClient } from "@kazi/db";
import { formatUnits, parseUnits } from "@kazi/shared";
import { planAirdrop, type FixedAllocation } from "../src/points/airdrop";
import { recomputePoints } from "../src/points/points";

const { values } = parseArgs({
  options: {
    "airdrop-id": { type: "string" },
    total: { type: "string" },
    "min-points": { type: "string", default: "100" },
    "max-share-bps": { type: "string", default: "100" },
    fixed: { type: "string" },
    exclude: { type: "string" },
    out: { type: "string" },
    "no-recompute": { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    replace: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const airdropId = values["airdrop-id"];
if (!airdropId || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(airdropId))
  throw new Error("--airdrop-id is required (lowercase letters, digits, dashes)");
if (!values.total) throw new Error("--total (KAZI) is required");

const env = loadEnv(runtimeEnvSchema.extend(dbEnvSchema.shape).extend(chainEnvSchema.shape));
const log = pino({ level: "info" });
const deployment = loadDeployment(env.KAZI_NETWORK, process.env["DEPLOYMENTS_DIR"] || undefined);
const chain = getChainConfig(env.KAZI_NETWORK, {
  rpcUrl: env.ARC_RPC_URL,
  usdcAddress: env.USDC_ADDRESS ?? deployment.usdc,
  expectedChainId: env.ARC_CHAIN_ID,
  confirmations: env.CONFIRMATIONS,
});
const client = createPublicClient({ transport: http(chain.rpcUrl) });
const prisma = createPrismaClient(env.DATABASE_URL);

try {
  const decimals = Number(
    await client.readContract({
      address: deployment.kaziToken,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  );
  const total = parseUnits(values.total, decimals);
  const maxShareBps = BigInt(values["max-share-bps"]);
  if (maxShareBps < 0n || maxShareBps > 10_000n)
    throw new Error("--max-share-bps must be 0..10000 (0 = no cap)");

  if (!values["no-recompute"]) {
    const usdcDecimals = Number(
      await client.readContract({
        address: deployment.usdc,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    );
    await recomputePoints({ prisma, usdcDecimals: async () => usdcDecimals, log });
  }

  const sums = await prisma.pointsEntry.groupBy({ by: ["userId"], _sum: { points: true } });
  const users = await prisma.user.findMany({
    where: { id: { in: sums.map((s) => s.userId) } },
    select: { id: true, wallet: true, roles: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const holders = sums.flatMap((s) => {
    const u = byId.get(s.userId);
    return u && (s._sum.points ?? 0) > 0
      ? [{ wallet: u.wallet as Address, points: BigInt(s._sum.points ?? 0) }]
      : [];
  });
  // Kazi's own wallets: admins (by role and ADMIN_WALLETS) and whoever owns the house agents.
  const houseOwners = await prisma.provider.findMany({
    where: { OR: [{ isHouse: true }, { slug: "kazi-service-fee" }] },
    select: { owner: { select: { wallet: true } } },
  });
  const admins = [
    ...users.filter((u) => u.roles.includes("ADMIN")).map((u) => u.wallet),
    ...(process.env["ADMIN_WALLETS"] ?? "")
      .split(",")
      .map((w) => w.trim())
      .filter((w) => isAddress(w)),
    ...houseOwners.map((p) => p.owner.wallet),
  ] as Address[];
  const extraExcluded = (values.exclude ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  for (const w of extraExcluded)
    if (!isAddress(w)) throw new Error(`--exclude: not an address: ${w}`);

  const plan = planAirdrop({
    holders,
    total,
    minPoints: BigInt(values["min-points"]),
    maxPerWallet: maxShareBps === 0n ? null : (total * maxShareBps) / 10_000n,
    fixed: values.fixed ? readFixed(values.fixed, decimals) : [],
    exclude: [...admins, ...(extraExcluded as Address[])],
  });

  const out = resolve(values.out ?? `airdrop-${airdropId}.json`);
  writeFileSync(
    out,
    JSON.stringify(
      {
        airdropId,
        network: env.KAZI_NETWORK,
        createdAt: new Date().toISOString(),
        root: plan.root,
        decimals,
        total: plan.total.toString(),
        allocated: plan.allocated.toString(),
        unallocated: plan.unallocated.toString(),
        rules: {
          minPoints: values["min-points"],
          maxShareBps: values["max-share-bps"],
          fixed: values.fixed ?? null,
          excluded: admins.length + extraExcluded.length,
        },
        allocations: plan.allocations.map((a) => ({
          wallet: a.wallet,
          amount: a.amount.toString(),
          points: a.points.toString(),
          proof: a.proof,
        })),
      },
      null,
      2,
    ) + "\n",
  );

  if (values.write) {
    const existing = await prisma.airdropAllocation.count({ where: { airdropId } });
    if (existing > 0 && !values.replace)
      throw new Error(
        `airdrop ${airdropId} already has ${existing} allocations; pass --replace to overwrite`,
      );
    await prisma.$transaction([
      prisma.airdropAllocation.deleteMany({ where: { airdropId } }),
      prisma.airdropAllocation.createMany({
        data: plan.allocations.map((a) => ({
          airdropId,
          wallet: a.wallet.toLowerCase(),
          amount: a.amount.toString(),
          proof: a.proof,
        })),
      }),
    ]);
  }

  console.log(`Airdrop ${airdropId}: ${plan.allocations.length} wallets`);
  console.log(
    `  allocated   ${formatUnits(plan.allocated, decimals)} KAZI of ${formatUnits(plan.total, decimals)}`,
  );
  console.log(
    `  unallocated ${formatUnits(plan.unallocated, decimals)} KAZI (swept to the treasury after the claim deadline)`,
  );
  console.log(`  root        ${plan.root}   → AIRDROP_MERKLE_ROOT`);
  console.log(`  plan        ${out}`);
  console.log(
    values.write
      ? `  stored in the database; set AIRDROP_ID=${airdropId} on the API`
      : "  not stored (pass --write)",
  );
} finally {
  await prisma.$disconnect();
}

function readFixed(path: string, decimals: number): FixedAllocation[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !/^wallet\s*,/i.test(line))
    .map((line, i) => {
      const [wallet = "", amount = ""] = line.split(",").map((c) => c.trim());
      if (!isAddress(wallet)) throw new Error(`${path}:${i + 1}: not an address: ${wallet}`);
      return { wallet, amount: parseUnits(amount, decimals) };
    });
}
