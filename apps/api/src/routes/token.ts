import type { FastifyInstance } from "fastify";
import { erc20Abi, getAddress, type Address } from "viem";
import { z } from "zod";
import type { ArgusLaunch, CreditsGate, TokenLaunch } from "@kazi/config/deployments";
import {
  argusBurnShareBps,
  argusHookAbi,
  argusSplitterAbi,
  feeDistributorAbi,
  kaziCreditsGateAbi,
  kaziTokenAbi,
  stakingVaultAbi,
} from "@kazi/shared";
import type { AppServices } from "../app";
import { requireAuth } from "../auth/guards";
import { notFound, parse } from "../http/errors";

/**
 * $KAZI pages (docs/08-TOKENOMICS.md §6): token metrics, realized staking rewards, points and
 * airdrop proofs. Only realized numbers — never projections or prices.
 */

const METRICS_CACHE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const vestingAbi = [
  {
    type: "function",
    name: "start",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "duration",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "released",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "vestedAmount",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "timestamp", type: "uint64" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
const airdropAbi = [
  {
    type: "function",
    name: "totalClaimed",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimDeadline",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
] as const;
const walletParams = z.object({ wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });

export interface TokenDeps {
  tokenLaunch?: TokenLaunch | null | undefined;
  creditsGate?: CreditsGate | null | undefined;
  argusLaunch?: ArgusLaunch | null | undefined;
  /** Identifies the published airdrop allocation set (AirdropAllocation.airdropId). */
  airdropId?: string | undefined;
}

export function tokenRoutes(s: AppServices & TokenDeps) {
  let metricsCache: { at: number; body: unknown } | null = null;
  let burnCache: { at: number; body: unknown } | null = null;

  /** Current fee split (FeeDistributor), or null before it is deployed. */
  const feeSplit = async () => {
    const distributor = s.contracts?.["feeDistributor"];
    const client = s.publicClient;
    if (!distributor || !client) return null;
    const [treasuryBps, stakerBps, buybackBps] = await Promise.all(
      (["treasuryBps", "stakerBps", "buybackBps"] as const).map((functionName) =>
        client.readContract({ address: distributor, abi: feeDistributorAbi, functionName }),
      ),
    );
    return {
      treasuryBps: Number(treasuryBps),
      stakerBps: Number(stakerBps),
      buybackBps: Number(buybackBps),
    };
  };

  const sumArgs = async (
    contract: Address | undefined,
    name: string,
    field: string,
    since?: Date,
  ) => {
    if (!contract) return 0n;
    const rows = await s.prisma.chainEvent.findMany({
      where: {
        contract: contract.toLowerCase(),
        name,
        ...(since ? { indexedAt: { gte: since } } : {}),
      },
      select: { args: true },
    });
    return rows.reduce(
      (a, r) => a + BigInt(String((r.args as Record<string, unknown>)[field] ?? "0")),
      0n,
    );
  };

  return async function routes(app: FastifyInstance) {
    app.get("/token/metrics", async () => {
      if (metricsCache && Date.now() - metricsCache.at < METRICS_CACHE_MS) return metricsCache.body;
      const token = s.contracts?.["kaziToken"];
      const vault = s.contracts?.["stakingVault"];
      const distributor = s.contracts?.["feeDistributor"];
      const client = s.publicClient;
      if (!token || !vault || !client) return { deployed: false, launched: false };
      const launch = s.tokenLaunch ?? null;
      const read = <T>(
        address: Address,
        abi: readonly unknown[],
        functionName: string,
        args: readonly unknown[] = [],
      ) =>
        client.readContract({
          address,
          abi: abi as never,
          functionName: functionName as never,
          args: args as never,
        }) as Promise<T>;
      const bal = (holder: Address) => read<bigint>(token, erc20Abi, "balanceOf", [holder]);

      const [supply, staked, active, notified, claimed] = await Promise.all([
        read<bigint>(token, kaziTokenAbi, "totalSupply"),
        read<bigint>(vault, stakingVaultAbi, "totalTracked"),
        read<bigint>(vault, stakingVaultAbi, "totalActive"),
        read<bigint>(vault, stakingVaultAbi, "totalRewardsNotified"),
        read<bigint>(vault, stakingVaultAbi, "totalRewardsClaimed"),
      ]);
      const since30 = new Date(Date.now() - 30 * DAY_MS);
      const [stakers30d, distributedAll, buybackAll, split] = await Promise.all([
        sumArgs(vault, "RewardNotified", "amount", since30),
        sumArgs(distributor, "Distributed", "total"),
        sumArgs(distributor, "Distributed", "toBuyback"),
        feeSplit(),
      ]);

      // Each non-circulating wallet counts once, even when one wallet plays two roles
      // (e.g. liquidity and community held by the same multisig).
      const locked = new Map<string, bigint>();
      const lock = (holder: Address, balance: bigint) => locked.set(holder.toLowerCase(), balance);
      const vesting: {
        name: string;
        address: Address;
        total: string;
        vested: string;
        released: string;
        start: number;
        end: number;
      }[] = [];
      let airdrop: { address: Address; balance: string; claimed: string; deadline: number } | null =
        null;
      let treasuryUsdc: string | null = null;
      if (launch) {
        const now = BigInt(Math.floor(Date.now() / 1000));
        for (const [name, address] of [
          ["team", launch.teamVesting],
          ["ecosystem", launch.ecosystemVesting],
        ] as const) {
          const [balance, released, vested, start, duration] = await Promise.all([
            bal(address),
            read<bigint>(address, vestingAbi, "released", [token]),
            read<bigint>(address, vestingAbi, "vestedAmount", [token, now]),
            read<bigint>(address, vestingAbi, "start"),
            read<bigint>(address, vestingAbi, "duration"),
          ]);
          lock(address, balance);
          vesting.push({
            name,
            address,
            total: (balance + released).toString(),
            vested: vested.toString(),
            released: released.toString(),
            start: Number(start),
            end: Number(start + duration),
          });
        }
        const [airdropBal, airdropClaimed, deadline] = await Promise.all([
          bal(launch.airdrop),
          read<bigint>(launch.airdrop, airdropAbi, "totalClaimed"),
          read<bigint>(launch.airdrop, airdropAbi, "claimDeadline"),
        ]);
        lock(launch.airdrop, airdropBal);
        airdrop = {
          address: launch.airdrop,
          balance: airdropBal.toString(),
          claimed: airdropClaimed.toString(),
          deadline: Number(deadline),
        };
        for (const holder of [launch.treasury, launch.community, launch.liquidity]) {
          if (!locked.has(holder.toLowerCase())) lock(holder, await bal(holder));
        }
        treasuryUsdc = (
          await read<bigint>(s.chain.usdcAddress, erc20Abi, "balanceOf", [launch.treasury])
        ).toString();
      }
      // KAZI (Argus) ⇄ KAZI Credits gate: its unissued reserve is not in circulation.
      let creditsGate: {
        address: Address;
        kazi: Address;
        totalLocked: string;
        reserve: string;
        fullyBacked: boolean;
        paused: boolean;
      } | null = null;
      const gate = s.creditsGate ?? null;
      if (gate) {
        const [totalLocked, reserve, fullyBacked, paused] = await Promise.all([
          read<bigint>(gate.gate, kaziCreditsGateAbi, "totalLocked"),
          read<bigint>(gate.gate, kaziCreditsGateAbi, "reserve"),
          read<boolean>(gate.gate, kaziCreditsGateAbi, "fullyBacked"),
          read<boolean>(gate.gate, kaziCreditsGateAbi, "paused"),
        ]);
        lock(gate.gate, reserve);
        creditsGate = {
          address: gate.gate,
          kazi: gate.kazi,
          totalLocked: totalLocked.toString(),
          reserve: reserve.toString(),
          fullyBacked,
          paused,
        };
      }
      const nonCirculating = [...locked.values()].reduce((a, b) => a + b, 0n);
      const circulating = supply > nonCirculating ? supply - nonCirculating : 0n;
      const body = {
        deployed: true,
        launched: Boolean(launch),
        tge: launch?.tge ?? null,
        totalSupply: supply.toString(),
        circulating: circulating.toString(),
        staked: staked.toString(),
        stakedActive: active.toString(),
        stakedBps: circulating > 0n ? Number((staked * 10_000n) / circulating) : 0,
        stakerRewards: {
          allTime: notified.toString(),
          last30d: stakers30d.toString(),
          claimed: claimed.toString(),
        },
        feesDistributed: distributedAll.toString(),
        split,
        buybackReserved: buybackAll.toString(),
        treasuryUsdc,
        vesting,
        airdrop,
        creditsGate,
        contracts: {
          kaziToken: getAddress(token),
          stakingVault: getAddress(vault),
          feeDistributor: distributor ? getAddress(distributor) : null,
          ...(gate ? { creditsGate: gate.gate, argusKazi: gate.kazi } : {}),
          ...(launch
            ? {
                teamVesting: launch.teamVesting,
                ecosystemVesting: launch.ecosystemVesting,
                airdrop: launch.airdrop,
                treasury: launch.treasury,
              }
            : {}),
        },
      };
      metricsCache = { at: Date.now(), body };
      return body;
    });

    /**
     * KAZI bought back and burned through its Argus launch (docs/08-TOKENOMICS.md §8): the KAZI held
     * by the burn address, the quote asset (USDC) the burn executor has spent, and what is waiting
     * for the next buyback. Realized onchain figures only; decimals are read from the tokens.
     */
    app.get("/token/kazi-burn", async () => {
      if (burnCache && Date.now() - burnCache.at < METRICS_CACHE_MS) return burnCache.body;
      const argus = s.argusLaunch ?? null;
      const client = s.publicClient;
      if (!argus || !client) return { available: false };
      const splitter = (
        functionName: Exclude<(typeof argusSplitterAbi)[number]["name"], "quoteAsset">,
      ) =>
        client.readContract({
          address: argus.splitter,
          abi: argusSplitterAbi,
          functionName,
        }) as Promise<bigint>;
      const hook = (functionName: (typeof argusHookAbi)[number]["name"]) =>
        client.readContract({
          address: argus.hook,
          abi: argusHookAbi,
          functionName,
        }) as Promise<bigint>;
      const [burned, supply, kaziDecimals, quote] = await Promise.all([
        client.readContract({
          address: argus.token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [argus.burnAddress],
        }),
        client.readContract({ address: argus.token, abi: erc20Abi, functionName: "totalSupply" }),
        client.readContract({ address: argus.token, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({
          address: argus.splitter,
          abi: argusSplitterAbi,
          functionName: "quoteAsset",
        }),
      ]);
      const [budget, spent, received, creatorBps, burnBps, buyTax, sellTax, quoteDecimals] =
        await Promise.all([
          splitter("budgetBurn"),
          splitter("burnDrawn"),
          splitter("totalReceived"),
          splitter("creatorBps"),
          splitter("burnBps"),
          hook("buyTaxBps"),
          hook("sellTaxBps"),
          client.readContract({ address: quote, abi: erc20Abi, functionName: "decimals" }),
        ]);
      const body = {
        available: true,
        token: argus.token,
        burnAddress: argus.burnAddress,
        kaziDecimals: Number(kaziDecimals),
        totalSupply: supply.toString(),
        burned: burned.toString(),
        burnedBps: supply > 0n ? Number((burned * 10_000n) / supply) : 0,
        quoteAsset: getAddress(quote),
        quoteDecimals: Number(quoteDecimals),
        buybackSpent: spent.toString(),
        buybackPending: (budget > spent ? budget - spent : 0n).toString(),
        taxCollected: received.toString(),
        burnShareBps: argusBurnShareBps(creatorBps, burnBps),
        buyTaxBps: Number(buyTax),
        sellTaxBps: Number(sellTax),
      };
      burnCache = { at: Date.now(), body };
      return body;
    });

    /**
     * Realized staker rewards over the last 30 days, per 1,000 KAZI of earning stake (no APR
     * projections), plus the vault's warm-up and cooldown so the page never hardcodes them.
     */
    app.get("/token/staking", async () => {
      const vault = s.contracts?.["stakingVault"];
      if (!vault || !s.publicClient) return { deployed: false };
      const client = s.publicClient;
      const [rewards30d, totalActive, warmup, cooldown, split, decimals] = await Promise.all([
        sumArgs(vault, "RewardNotified", "distributed", new Date(Date.now() - 30 * DAY_MS)),
        client.readContract({ address: vault, abi: stakingVaultAbi, functionName: "totalActive" }),
        client.readContract({ address: vault, abi: stakingVaultAbi, functionName: "WARMUP" }),
        client.readContract({
          address: vault,
          abi: stakingVaultAbi,
          functionName: "holderCooldown",
        }),
        feeSplit(),
        kaziDecimalsOf(s),
      ]);
      const kaziUnit = 10n ** BigInt(decimals ?? 18);
      const per1000 = totalActive > 0n ? (rewards30d * 1_000n * kaziUnit) / totalActive : 0n;
      return {
        deployed: true,
        rewards30d: rewards30d.toString(),
        per1000Kazi30d: per1000.toString(),
        totalActive: totalActive.toString(),
        warmupSeconds: Number(warmup),
        cooldownSeconds: Number(cooldown),
        stakerBps: split?.stakerBps ?? 0,
      };
    });

    // ─── Points ──────────────────────────────────────────────────────────────
    app.get("/points/me", async (req) => {
      const auth = requireAuth(req);
      const entries = await s.prisma.pointsEntry.findMany({
        where: { userId: auth.userId },
        orderBy: { updatedAt: "desc" },
        take: 200,
      });
      const total = entries.reduce((a, e) => a + e.points, 0);
      const taskIds = [...new Set(entries.map((e) => e.taskId))];
      const tasks = await s.prisma.task.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, title: true },
      });
      const title = new Map(tasks.map((t) => [t.id, t.title]));
      return {
        total,
        entries: entries.map((e) => ({
          taskId: e.taskId,
          title: title.get(e.taskId) ?? null,
          role: e.role,
          points: e.points,
          flag: e.flag,
          feeUnits: e.feeUnits,
          at: e.updatedAt,
        })),
      };
    });

    app.get("/points/leaderboard", async () => {
      const rows = await s.prisma.pointsEntry.groupBy({
        by: ["userId"],
        _sum: { points: true },
        orderBy: { _sum: { points: "desc" } },
        take: 50,
      });
      const users = await s.prisma.user.findMany({
        where: { id: { in: rows.map((r) => r.userId) } },
        select: { id: true, wallet: true },
      });
      const wallet = new Map(users.map((u) => [u.id, u.wallet]));
      return {
        leaders: rows
          .filter((r) => (r._sum.points ?? 0) > 0)
          .map((r, i) => {
            const raw = wallet.get(r.userId);
            const w = raw ? getAddress(raw) : "";
            return {
              rank: i + 1,
              wallet: `${w.slice(0, 6)}…${w.slice(-4)}`,
              points: r._sum.points ?? 0,
            };
          }),
      };
    });

    // ─── Airdrop ─────────────────────────────────────────────────────────────
    app.get("/airdrop/:wallet", async (req) => {
      const { wallet } = parse(walletParams, req.params);
      if (!s.airdropId || !s.tokenLaunch) throw notFound("Airdrop");
      const row = await s.prisma.airdropAllocation.findUnique({
        where: { airdropId_wallet: { airdropId: s.airdropId, wallet: wallet.toLowerCase() } },
      });
      if (!row) throw notFound("Allocation");
      return {
        airdropId: row.airdropId,
        contract: s.tokenLaunch.airdrop,
        amount: row.amount,
        proof: row.proof,
      };
    });
  };
}

async function kaziDecimalsOf(s: AppServices): Promise<number | null> {
  const token = s.contracts?.["kaziToken"];
  if (!token || !s.publicClient) return null;
  return Number(
    await s.publicClient.readContract({
      address: token,
      abi: kaziTokenAbi,
      functionName: "decimals",
    }),
  );
}
