import type { Logger } from "pino";
import { erc20Abi, type Address, type Hex, type PublicClient } from "viem";
import type { Deployment } from "@kazi/config/deployments";
import type { PrismaClient } from "@kazi/db";
import { holderKey, parseUnits, providerKey, stakingVaultAbi } from "@kazi/shared";
import type { EscrowOperator } from "../chain/operator";

/**
 * Fee-sharing keeper (docs/08-TOKENOMICS.md §3): once the FeeDistributor holds at least
 * FEE_DISTRIBUTE_MIN_USDC, call distribute() so the treasury, stakers (USDC rewards in the
 * StakingVault) and the buyback reserve get their split. Anyone may call distribute(); Kazi's
 * operator does it on a schedule so stakers don't depend on someone else paying the gas.
 *
 * The vault activates warm-up stake lazily (on the account's next interaction), so before each
 * distribution the keeper pokes every account whose warm-up has ended: stakers who never come back
 * to click "Activate" still earn their share.
 */

const DAY_MS = 86_400_000;
/** Pending stake older than this would already have been activated by an earlier run. */
const LOOKBACK_DAYS = 90;
const READ_CHUNK = 25;
const POKE_BATCH = 100;

export async function distributeFeesIfDue(deps: {
  prisma: PrismaClient;
  publicClient: PublicClient;
  operator: EscrowOperator;
  deployment: Pick<Deployment, "usdc" | "feeDistributor" | "stakingVault">;
  usdcDecimals: () => Promise<number>;
  minUsdc: string;
  log: Logger;
}): Promise<"distributed" | "below-threshold"> {
  const balance = await deps.publicClient.readContract({
    address: deps.deployment.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [deps.deployment.feeDistributor],
  });
  const min = parseUnits(deps.minUsdc, await deps.usdcDecimals());
  if (balance === 0n || balance < min) return "below-threshold";
  try {
    await activateMaturedStake(deps);
  } catch (err) {
    // Activation is best effort: the distribution itself must not wait on it.
    deps.log.warn({ err }, "activating matured stake failed");
  }
  await deps.operator.distributeFees(deps.deployment.feeDistributor);
  deps.log.info({ amount: balance.toString() }, "fee distribution sent");
  return "distributed";
}

export async function activateMaturedStake(deps: {
  prisma: PrismaClient;
  publicClient: PublicClient;
  operator: EscrowOperator;
  deployment: Pick<Deployment, "stakingVault">;
  log: Logger;
}): Promise<number> {
  const vault = deps.deployment.stakingVault;
  const keys = await maturedStakeKeys({ prisma: deps.prisma, publicClient: deps.publicClient, vault });
  for (let i = 0; i < keys.length; i += POKE_BATCH) {
    await deps.operator.pokeStakes(vault, keys.slice(i, i + POKE_BATCH));
  }
  return keys.length;
}

/** Accounts (holders and provider bonds) with warm-up stake whose warm-up has ended. */
export async function maturedStakeKeys(deps: { prisma: PrismaClient; publicClient: PublicClient; vault: Address; nowSec?: bigint }): Promise<Hex[]> {
  const rows = await deps.prisma.chainEvent.findMany({
    where: {
      contract: deps.vault.toLowerCase(),
      name: { in: ["Staked", "Bonded"] },
      indexedAt: { gte: new Date(Date.now() - LOOKBACK_DAYS * DAY_MS) },
    },
    select: { name: true, args: true },
  });
  const candidates = new Set<Hex>();
  for (const r of rows) {
    const a = r.args as Record<string, unknown>;
    if (r.name === "Staked" && typeof a["holder"] === "string") candidates.add(holderKey(a["holder"] as Address));
    if (r.name === "Bonded" && a["providerId"] !== undefined) candidates.add(providerKey(BigInt(String(a["providerId"]))));
  }
  if (candidates.size === 0) return [];

  const client = deps.publicClient;
  const warmup = await client.readContract({ address: deps.vault, abi: stakingVaultAbi, functionName: "WARMUP" });
  const now = deps.nowSec ?? (await client.getBlock()).timestamp;
  const list = [...candidates];
  const matured: Hex[] = [];
  for (let i = 0; i < list.length; i += READ_CHUNK) {
    const chunk = list.slice(i, i + READ_CHUNK);
    const accounts = await Promise.all(
      chunk.map((key) => client.readContract({ address: deps.vault, abi: stakingVaultAbi, functionName: "getAccount", args: [key] })),
    );
    accounts.forEach((a, j) => {
      const key = chunk[j];
      if (key && a.pending > 0n && now >= a.pendingSince + warmup) matured.push(key);
    });
  }
  return matured;
}
