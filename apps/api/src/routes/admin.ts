import type { FastifyInstance } from "fastify";
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from "viem";
import { z } from "zod";
import {
  agentRegistryAbi,
  feeDistributorAbi,
  kaziTokenAbi,
  parseUnits,
  stakingVaultAbi,
  taskEscrowAbi,
  decimalAmountSchema,
} from "@kazi/shared";
import type { AppServices } from "../app";
import { requireAdmin } from "../auth/guards";
import { invalidState, notFound, parse } from "../http/errors";
import { serializeProviderOwner } from "./serializers";

/** Redis key written by the worker's reconciliation job (apps/worker/src/jobs/reconcile.ts). */
export const reconciliationKey = (prefix: string) => `${prefix}:reconciliation:last`;
/** Display-only settings (docs/04 §3 Admin). Onchain values stay authoritative. */
export const settingsKey = (prefix: string) => `${prefix}:settings`;

/**
 * Admin endpoints. Onchain actions (activate, suspend, slash, resolve) are returned as calldata for
 * the registrar wallet / arbiter Safe to sign — the backend never holds those keys. The indexer
 * mirrors the resulting events into the DB.
 */

const idParams = z.object({ id: z.string().min(1).max(64) });
const providerListQuery = z.object({
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "DELISTED"]).default("PENDING"),
});
const reviewSchema = z
  .object({ reviewScore: z.number().int().min(0).max(100).optional(), note: z.string().max(2_000).optional() })
  .strict();
const slashSchema = z.object({ amount: decimalAmountSchema, reason: z.string().trim().min(10).max(2_000) }).strict();
const disputeListQuery = z.object({ status: z.enum(["OPEN", "UNDER_REVIEW", "RESOLVED"]).optional() });
const resolveSchema = z
  .object({
    resolutions: z
      .array(z.object({ index: z.number().int().min(0), clientShareBps: z.number().int().min(0).max(10_000) }))
      .min(1)
      .max(32),
    note: z.string().max(4_000).optional(),
  })
  .strict()
  .refine((v) => new Set(v.resolutions.map((r) => r.index)).size === v.resolutions.length, "duplicate index");
const feeSplitSchema = z
  .object({
    treasuryBps: z.number().int().min(0).max(10_000),
    stakerBps: z.number().int().min(0).max(10_000),
    buybackBps: z.number().int().min(0).max(10_000),
  })
  .strict()
  .refine((v) => v.treasuryBps + v.stakerBps + v.buybackBps === 10_000, "The split must add up to 10,000 bps");
export const settingsSchema = z
  .object({
    announcement: z.string().max(500).nullable().optional(),
    feeDisplayBps: z.number().int().min(0).max(10_000).optional(),
    minStakeDisplay: z.string().max(64).optional(),
  })
  .strict();

export function adminRoutes(s: AppServices) {
  const contract = (name: string): Address => {
    const a = name === "taskEscrow" ? s.escrowAddress : s.contracts?.[name];
    if (!a) throw invalidState(`${name} is not deployed on this network`);
    return a;
  };
  const tx = (to: Address, data: Hex) => ({ to, data, value: "0" });

  return async function routes(app: FastifyInstance) {
    /** Latest escrow reconciliation: onchain USDC balance vs what the DB expects. */
    app.get("/admin/reconciliation", async (req) => {
      requireAdmin(req, s.adminWallets);
      const raw = await s.redis.get(reconciliationKey(s.env.REDIS_KEY_PREFIX));
      return { reconciliation: raw ? (JSON.parse(raw) as unknown) : null };
    });

    app.get("/admin/queues", async (req) => {
      requireAdmin(req, s.adminWallets);
      return { queues: await s.jobs.counts() };
    });

    // ─── Provider review ────────────────────────────────────────────────────

    app.get("/admin/providers", async (req) => {
      requireAdmin(req, s.adminWallets);
      const q = parse(providerListQuery, req.query);
      const rows = await s.prisma.provider.findMany({
        where: { status: q.status, slug: { not: "kazi-service-fee" } },
        orderBy: { createdAt: "asc" },
        take: 200,
        include: { owner: { select: { wallet: true } } },
      });
      return {
        providers: rows.map((p) => ({
          ...serializeProviderOwner(p),
          ownerWallet: p.owner.wallet,
          onchainId: p.onchainId?.toString() ?? null,
          reviewScore: p.reviewScore,
          stakeAmount: p.stakeAmount,
        })),
      };
    });

    /** Record the reviewer's score (feeds exploration for newcomers, 06-ROUTER §6). */
    app.post("/admin/providers/:id/review", async (req) => {
      requireAdmin(req, s.adminWallets);
      const { id } = parse(idParams, req.params);
      const body = parse(reviewSchema, req.body ?? {});
      const p = await s.prisma.provider.findUnique({ where: { id } });
      if (!p) throw notFound("Provider");
      if (body.reviewScore !== undefined) {
        await s.prisma.provider.update({ where: { id }, data: { reviewScore: body.reviewScore } });
      }
      return { ok: true };
    });

    for (const action of ["activate", "suspend"] as const) {
      app.post(`/admin/providers/:id/${action}`, async (req) => {
        requireAdmin(req, s.adminWallets);
        const { id } = parse(idParams, req.params);
        const p = await s.prisma.provider.findUnique({ where: { id } });
        if (!p) throw notFound("Provider");
        if (p.onchainId === null) throw invalidState("The owner hasn't registered this provider onchain yet");
        return {
          tx: tx(
            contract("agentRegistry"),
            encodeFunctionData({ abi: agentRegistryAbi, functionName: action, args: [BigInt(p.onchainId)] }),
          ),
          signer: "registrar",
        };
      });
    }

    app.post("/admin/providers/:id/slash", async (req) => {
      requireAdmin(req, s.adminWallets);
      const { id } = parse(idParams, req.params);
      const body = parse(slashSchema, req.body);
      const p = await s.prisma.provider.findUnique({ where: { id } });
      if (!p) throw notFound("Provider");
      if (p.onchainId === null) throw invalidState("This provider isn't registered onchain");
      if (!s.publicClient) throw invalidState("No RPC configured");
      const tokenDecimals = Number(
        await s.publicClient.readContract({ address: contract("kaziToken"), abi: kaziTokenAbi, functionName: "decimals" }),
      );
      const amount = parseUnits(body.amount, tokenDecimals);
      return {
        tx: tx(
          contract("stakingVault"),
          encodeFunctionData({
            abi: stakingVaultAbi,
            functionName: "slash",
            args: [BigInt(p.onchainId), amount, keccak256(toBytes(body.reason))],
          }),
        ),
        signer: "slasher",
        reasonHash: keccak256(toBytes(body.reason)),
      };
    });

    // ─── Disputes ───────────────────────────────────────────────────────────

    app.get("/admin/disputes", async (req) => {
      requireAdmin(req, s.adminWallets);
      const q = parse(disputeListQuery, req.query);
      const rows = await s.prisma.dispute.findMany({
        where: q.status ? { status: q.status } : { status: { not: "RESOLVED" } },
        orderBy: { createdAt: "asc" },
        take: 100,
        include: {
          task: {
            include: {
              client: { select: { wallet: true } },
              subtasks: {
                orderBy: { index: "asc" },
                include: {
                  provider: { select: { name: true, slug: true } },
                  submissions: { orderBy: { attempt: "desc" }, take: 1 },
                },
              },
            },
          },
        },
      });
      return {
        disputes: rows.map((d) => ({
          id: d.id,
          status: d.status,
          reason: d.reason,
          evidence: d.evidence,
          resolution: d.resolution,
          createdAt: d.createdAt,
          task: {
            id: d.task.id,
            title: d.task.title,
            description: d.task.description,
            status: d.task.status,
            clientWallet: d.task.client.wallet,
            totalAmount: d.task.totalAmount,
            steps: d.task.subtasks.map((st) => ({
              index: st.index,
              kind: st.kind,
              title: st.title,
              status: st.status,
              amount: st.amount,
              provider: st.provider,
              // Untrusted agent output: the admin UI renders it sanitized (CLAUDE.md rule 7).
              latest: st.submissions[0]
                ? { output: st.submissions[0].output, score: st.submissions[0].score, evaluation: st.submissions[0].evaluation }
                : null,
            })),
          },
        })),
      };
    });

    /** Calldata for the arbiter Safe: one resolveDispute per disputed milestone. */
    app.post("/admin/disputes/:id/resolve", async (req) => {
      const auth = requireAdmin(req, s.adminWallets);
      const { id } = parse(idParams, req.params);
      const body = parse(resolveSchema, req.body);
      const d = await s.prisma.dispute.findUnique({
        where: { id },
        include: { task: { include: { subtasks: true } } },
      });
      if (!d) throw notFound("Dispute");
      if (d.status === "RESOLVED") throw invalidState("This dispute is already resolved");
      if (d.task.status !== "DISPUTED") throw invalidState("The task isn't disputed onchain yet");
      const open = new Map(
        d.task.subtasks
          .filter((st) => !["RELEASED", "REFUNDED"].includes(st.status))
          .map((st) => [st.index, st]),
      );
      for (const r of body.resolutions) {
        if (!open.has(r.index)) throw invalidState(`Milestone ${r.index} is already settled or doesn't exist`);
      }
      const escrow = contract("taskEscrow");
      const txs = body.resolutions.map((r) =>
        tx(
          escrow,
          encodeFunctionData({
            abi: taskEscrowAbi,
            functionName: "resolveDispute",
            args: [d.task.onchainId as Hex, BigInt(r.index), r.clientShareBps],
          }),
        ),
      );
      await s.prisma.dispute.update({
        where: { id },
        data: {
          status: "UNDER_REVIEW",
          resolution: { resolutions: body.resolutions, note: body.note ?? null, proposedAt: new Date().toISOString() },
          resolvedBy: auth.wallet,
        },
      });
      return { txs, signer: "arbiterSafe" };
    });

    // ─── Escrow pause (docs/runbooks/pause.md) ──────────────────────────────

    app.get("/admin/escrow", async (req) => {
      requireAdmin(req, s.adminWallets);
      if (!s.publicClient) throw invalidState("No RPC configured");
      const escrow = contract("taskEscrow");
      const [paused, feeBps] = await Promise.all([
        s.publicClient.readContract({ address: escrow, abi: taskEscrowAbi, functionName: "paused" }),
        s.publicClient.readContract({ address: escrow, abi: taskEscrowAbi, functionName: "feeBps" }),
      ]);
      return { escrow, paused, feeBps: Number(feeBps) };
    });

    /** Pause: the guardian (PAUSER_ROLE) or the admin Safe. Unpause: the admin Safe only. */
    for (const action of ["pause", "unpause"] as const) {
      app.post(`/admin/escrow/${action}`, async (req) => {
        requireAdmin(req, s.adminWallets);
        return {
          tx: tx(contract("taskEscrow"), encodeFunctionData({ abi: taskEscrowAbi, functionName: action })),
          signer: action === "pause" ? "guardian" : "adminSafe",
        };
      });
    }

    // ─── Fee split (FeeDistributor) ─────────────────────────────────────────

    app.get("/admin/fee-split", async (req) => {
      requireAdmin(req, s.adminWallets);
      if (!s.publicClient) throw invalidState("No RPC configured");
      const distributor = contract("feeDistributor");
      const [treasuryBps, stakerBps, buybackBps, stakingVault] = await Promise.all([
        s.publicClient.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "treasuryBps" }),
        s.publicClient.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "stakerBps" }),
        s.publicClient.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "buybackBps" }),
        s.publicClient.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "stakingVault" }),
      ]);
      return { split: { treasuryBps: Number(treasuryBps), stakerBps: Number(stakerBps), buybackBps: Number(buybackBps) }, stakingVault };
    });

    /** Calldata for the admin Safe: FeeDistributor.setSplit (e.g. switch the staker share on at launch). */
    app.post("/admin/fee-split", async (req) => {
      requireAdmin(req, s.adminWallets);
      const body = parse(feeSplitSchema, req.body);
      return {
        tx: tx(
          contract("feeDistributor"),
          encodeFunctionData({ abi: feeDistributorAbi, functionName: "setSplit", args: [body.treasuryBps, body.stakerBps, body.buybackBps] }),
        ),
        signer: "adminSafe",
      };
    });

    // ─── Display settings ───────────────────────────────────────────────────

    app.get("/admin/settings", async (req) => {
      requireAdmin(req, s.adminWallets);
      const raw = await s.redis.get(settingsKey(s.env.REDIS_KEY_PREFIX));
      return { settings: raw ? (JSON.parse(raw) as unknown) : {} };
    });

    app.patch("/admin/settings", async (req) => {
      requireAdmin(req, s.adminWallets);
      const body = parse(settingsSchema, req.body);
      const key = settingsKey(s.env.REDIS_KEY_PREFIX);
      const raw = await s.redis.get(key);
      const prev = raw ? settingsSchema.safeParse(JSON.parse(raw)) : null;
      const next = { ...(prev?.success ? prev.data : {}), ...body };
      await s.redis.set(key, JSON.stringify(next));
      return { settings: next };
    });
  };
}
