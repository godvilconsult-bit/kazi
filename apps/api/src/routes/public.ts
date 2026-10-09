import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppServices } from "../app";
import { notFound, parse } from "../http/errors";
import { settingsKey, settingsSchema } from "./admin";

/** Unauthenticated read endpoints for the web app (docs/07-FRONTEND.md §3 public pages). */

const slugParams = z.object({ slug: z.string().min(1).max(80) });
const STATS_CACHE_MS = 60_000;

export function publicRoutes(s: AppServices) {
  let statsCache: { at: number; body: unknown } | null = null;
  /** Admin display settings (announcement banner etc.); never authoritative for money. */
  const displaySettings = async () => {
    const raw = await s.redis.get(settingsKey(s.env.REDIS_KEY_PREFIX));
    const parsed = raw ? settingsSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : {};
  };

  return async function routes(app: FastifyInstance) {
    /** Chain and contract addresses the web app needs (wallet, explorer links, fund flow). */
    app.get("/config", async () => ({
      usdcDecimals: await s.usdcDecimals(),
      settings: await displaySettings(),
      chain: {
        id: s.chain.chainId,
        name: s.chain.name,
        rpcUrl: s.chain.rpcUrl,
        explorerUrl: s.chain.explorerUrl ?? null,
        nativeCurrency: s.chain.nativeCurrency,
      },
      contracts: { usdc: s.chain.usdcAddress, escrow: s.escrowAddress ?? null, ...(s.contracts ?? {}) },
    }));

    /** Landing-page numbers. Cached for a minute. */
    app.get("/stats", async () => {
      if (statsCache && Date.now() - statsCache.at < STATS_CACHE_MS) return statsCache.body;
      const [completed, agents, volume, topAgents] = await Promise.all([
        s.prisma.task.count({ where: { status: "COMPLETED" } }),
        s.prisma.provider.count({ where: { status: "ACTIVE", kind: "AGENT", slug: { not: "kazi-service-fee" } } }),
        s.prisma.task.findMany({
          where: { status: { in: ["COMPLETED", "PARTIALLY_REFUNDED", "RESOLVED"] } },
          select: { totalAmount: true },
        }),
        s.prisma.provider.findMany({
          where: { status: "ACTIVE", slug: { not: "kazi-service-fee" } },
          orderBy: [{ reputation: "desc" }, { completedCount: "desc" }],
          take: 6,
          select: {
            slug: true,
            name: true,
            kind: true,
            hosting: true,
            capabilities: true,
            pricing: true,
            reputation: true,
            completedCount: true,
            isHouse: true,
          },
        }),
      ]);
      const volumeBaseUnits = volume.reduce((a, t) => a + BigInt(t.totalAmount ?? "0"), 0n);
      const body = {
        tasksCompleted: completed,
        activeAgents: agents,
        volume: volumeBaseUnits.toString(),
        topAgents,
      };
      statsCache = { at: Date.now(), body };
      return body;
    });

    /** Reputation history for the profile chart (06-ROUTER §6). */
    app.get("/providers/:slug/reputation", async (req) => {
      const { slug } = parse(slugParams, req.params);
      const p = await s.prisma.provider.findUnique({ where: { slug }, select: { id: true, status: true } });
      if (!p || p.status === "PENDING") throw notFound("Provider");
      const since = new Date(Date.now() - 180 * 86_400_000);
      const points = await s.prisma.reputationSnapshot.findMany({
        where: { providerId: p.id, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        select: { value: true, createdAt: true },
        take: 500,
      });
      return { points };
    });

    /** Recent client ratings of tasks this provider worked on (no client identities). */
    app.get("/providers/:slug/reviews", async (req) => {
      const { slug } = parse(slugParams, req.params);
      const p = await s.prisma.provider.findUnique({ where: { slug }, select: { id: true, status: true } });
      if (!p || p.status === "PENDING") throw notFound("Provider");
      const tasks = await s.prisma.task.findMany({
        where: { rating: { not: null }, subtasks: { some: { providerId: p.id, kind: "WORK" } } },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: { rating: true, ratingComment: true, updatedAt: true },
      });
      return {
        reviews: tasks.map((t) => ({ rating: t.rating, comment: t.ratingComment, at: t.updatedAt })),
      };
    });
  };
}
