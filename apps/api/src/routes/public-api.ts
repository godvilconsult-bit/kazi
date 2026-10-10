import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { baseUnitsSchema, jobIds, storedQuoteSchema, taskOnchainId, TASK_SPEEDS } from "@kazi/shared";
import type { AppServices } from "../app";
import { generateApiKey, MAX_ACTIVE_KEYS } from "../auth/api-keys";
import { requireAuth } from "../auth/guards";
import { forbidden, invalidState, notFound, parse } from "../http/errors";
import { PAYMENT_ADAPTERS } from "../payments/adapters";
import { serializeTask } from "./serializers";

/**
 * Programmatic access (docs/12-PUBLIC-API.md): API key management (web session only), a one-call
 * "quick task" for apps and agents, and per-method payment instructions. Every other task endpoint
 * also accepts `Authorization: Bearer kz_…`.
 */

const idParams = z.object({ id: z.string().min(1).max(64) });
const createKeySchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();
const quickTaskSchema = z
  .object({
    description: z.string().trim().min(10).max(20_000),
    title: z.string().trim().min(3).max(120).optional(),
    /** Hours from now; default 72 (1–2160). */
    deadlineHours: z.number().int().min(1).max(2_160).default(72),
    budgetMax: baseUnitsSchema.optional(),
    speed: z.enum(TASK_SPEEDS).default("ECONOMY"),
  })
  .strict();
const paymentQuery = z.object({ method: z.enum(["escrow-wallet", "x402"]).default("escrow-wallet") });

export function publicApiRoutes(s: AppServices) {
  return async function routes(app: FastifyInstance) {
    // ─── Key management: only from a signed-in web session ─────────────────
    app.post("/me/api-keys", async (req, reply) => {
      const auth = requireAuth(req);
      if (auth.apiKeyId) throw forbidden("Manage API keys from the Kazi web app");
      const body = parse(createKeySchema, req.body);
      const active = await s.prisma.apiKey.count({ where: { userId: auth.userId, revokedAt: null } });
      if (active >= MAX_ACTIVE_KEYS) throw invalidState(`You can have at most ${MAX_ACTIVE_KEYS} active keys; revoke one first`);
      const { key, prefix, hash } = generateApiKey(s.chain.network === "mainnet");
      const row = await s.prisma.apiKey.create({ data: { userId: auth.userId, name: body.name, prefix, keyHash: hash } });
      // The full key is returned exactly once.
      return reply.status(201).send({ apiKey: { id: row.id, name: row.name, prefix, createdAt: row.createdAt }, key });
    });

    app.get("/me/api-keys", async (req) => {
      const auth = requireAuth(req);
      if (auth.apiKeyId) throw forbidden("Manage API keys from the Kazi web app");
      const rows = await s.prisma.apiKey.findMany({ where: { userId: auth.userId }, orderBy: { createdAt: "desc" } });
      return {
        apiKeys: rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt })),
      };
    });

    app.delete("/me/api-keys/:id", async (req) => {
      const auth = requireAuth(req);
      if (auth.apiKeyId) throw forbidden("Manage API keys from the Kazi web app");
      const { id } = parse(idParams, req.params);
      const moved = await s.prisma.apiKey.updateMany({ where: { id, userId: auth.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (moved.count === 0) throw notFound("API key");
      return { ok: true };
    });

    // ─── Quick task: create + quote in one call ──────────────────────────────
    app.post("/v1/quick-tasks", { preHandler: s.limiter.guard("quick-tasks", 30, 60) }, async (req, reply) => {
      const auth = requireAuth(req);
      const body = parse(quickTaskSchema, req.body);
      const id = randomUUID();
      const title = body.title ?? (body.description.split(/\n|(?<=[.!?])\s/)[0] ?? body.description).slice(0, 120);
      const task = await s.prisma.task.create({
        data: {
          id,
          onchainId: taskOnchainId(id),
          clientId: auth.userId,
          title: title.length >= 3 ? title : body.description.slice(0, 60),
          description: body.description,
          attachments: [],
          budgetMax: body.budgetMax ?? null,
          deadline: new Date(Date.now() + body.deadlineHours * 3_600_000),
          speed: body.speed,
          events: { create: { type: "CREATED", data: { via: auth.apiKeyId ? "api_key" : "session" } } },
        },
      });
      await s.jobs.enqueue("router", "quote", { taskId: task.id }, jobIds.quote(task.id, task.quoteVersion + 1));
      return reply.status(202).send({
        task: serializeTask(task),
        quote: "queued",
        next: {
          quote: `/tasks/${task.id}/quote`,
          payment: `/tasks/${task.id}/payment`,
          events: `/tasks/${task.id}/events`,
        },
      });
    });

    // ─── Payment instructions per method ─────────────────────────────────────
    app.get("/tasks/:id/payment", async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = parse(idParams, req.params);
      const { method } = parse(paymentQuery, req.query);
      const task = await s.prisma.task.findUnique({ where: { id } });
      if (!task || task.clientId !== auth.userId) throw notFound("Task");
      const adapter = PAYMENT_ADAPTERS[method];
      if (!adapter.enabled) return reply.status(501).send(adapter.instructions({} as never));
      const parsed = task.quote ? storedQuoteSchema.safeParse(task.quote) : undefined;
      if (task.status !== "QUOTED" || !parsed?.success || parsed.data.outcome !== "QUOTED") {
        throw invalidState("This task has no fundable quote yet; poll GET /tasks/:id/quote");
      }
      if (new Date(parsed.data.expiresAt) <= new Date()) throw invalidState("The quote expired; request a new one");
      if (parsed.data.client.toLowerCase() !== auth.wallet.toLowerCase()) throw invalidState("The quote was signed for a different wallet");
      if (!s.escrowAddress) throw invalidState("Escrow is not deployed on this network");
      return adapter.instructions({ quote: parsed.data, chainId: s.chain.chainId, usdc: s.chain.usdcAddress, escrow: s.escrowAddress });
    });
  };
}
