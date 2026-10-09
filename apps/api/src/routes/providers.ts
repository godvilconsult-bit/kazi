import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Prisma } from "@kazi/db";
import {
  createProviderSchema,
  hostedAdviceSchema,
  jobIds,
  listProvidersQuerySchema,
  normalizeWallet,
  PROVIDER_TEST_TTL_SEC,
  providerTestKey,
  providerTestStateSchema,
  sampleTask,
  updateProviderSchema,
} from "@kazi/shared";
import type { AppServices } from "../app";
import { requireAuth } from "../auth/guards";
import { badRequest, notFound, parse } from "../http/errors";
import { generateWebhookSecret } from "@kazi/config/secrets";
import { serializeProviderOwner, serializeProviderPublic } from "./serializers";

const idParams = z.object({ id: z.string().min(1).max(64) });
const slugParams = z.object({ slug: z.string().min(1).max(100) });
const testParams = z.object({ id: z.string().min(1).max(64), testId: z.string().regex(/^[0-9a-f]{24}$/) });
const testSchema = z
  .object({
    capability: z.string().min(1).max(64).optional(),
    instructions: z.string().trim().min(1).max(4_000).optional(),
    text: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict();

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "provider"}-${randomBytes(3).toString("hex")}`;
}

export function providerRoutes(s: AppServices) {
  async function assertCapabilitiesExist(slugs: readonly string[]) {
    const unique = [...new Set(slugs)];
    const found = await s.prisma.capability.count({
      where: { slug: { in: unique }, enabled: true },
    });
    if (found !== unique.length) throw badRequest("unknown or disabled capability");
    return unique;
  }

  async function loadOwnProvider(req: FastifyRequest) {
    const auth = requireAuth(req);
    const { id } = parse(idParams, req.params);
    const provider = await s.prisma.provider.findUnique({ where: { id } });
    if (!provider || (provider.ownerId !== auth.userId && !auth.roles.includes("ADMIN")))
      throw notFound("Provider");
    return { auth, provider };
  }

  return async function routes(app: FastifyInstance) {
    app.post(
      "/providers",
      { preHandler: s.limiter.guard("providers-create", 10, 3600) },
      async (req, reply) => {
        const auth = requireAuth(req);
        const body = parse(createProviderSchema, req.body);
        const capabilities = await assertCapabilitiesExist(body.capabilities);
        const hosted = body.hosting === "KAZI";
        // Self-hosted agents sign their callbacks with a webhook secret; Kazi-hosted agents need none.
        const webhookSecret = body.kind === "AGENT" && !hosted ? generateWebhookSecret() : null;

        const provider = await s.prisma.$transaction(async (tx) => {
          const created = await tx.provider.create({
            data: {
              ownerId: auth.userId,
              kind: body.kind,
              name: body.name,
              slug: slugify(body.name),
              description: body.description,
              capabilities,
              languages: [...new Set(body.languages)],
              endpointUrl: body.kind === "AGENT" && !hosted ? (body.endpointUrl ?? null) : null,
              hosting: hosted ? "KAZI" : "SELF",
              ...(hosted && body.hostedConfig ? { hostedConfig: body.hostedConfig } : {}),
              manifestUrl: body.manifestUrl ?? null,
              pricing: body.pricing,
              payoutAddress: normalizeWallet(body.payoutAddress),
              webhookSecretEnc: webhookSecret ? s.secrets.encrypt(webhookSecret) : null,
            },
          });
          const user = await tx.user.findUniqueOrThrow({ where: { id: auth.userId } });
          if (!user.roles.includes("PROVIDER_OWNER")) {
            await tx.user.update({
              where: { id: user.id },
              data: { roles: { push: "PROVIDER_OWNER" } },
            });
          }
          return created;
        });

        // The webhook secret is shown exactly once; only its encrypted form is stored.
        return reply
          .status(201)
          .send({ provider: serializeProviderOwner(provider), webhookSecret });
      },
    );

    app.patch("/providers/:id", async (req) => {
      const { provider } = await loadOwnProvider(req);
      const body = parse(updateProviderSchema, req.body);
      if (
        body.endpointUrl !== undefined &&
        (provider.kind !== "AGENT" || provider.hosting === "KAZI")
      )
        throw badRequest("only self-hosted agents have endpoints");
      if (body.hostedConfig !== undefined && provider.hosting !== "KAZI")
        throw badRequest("only Kazi-hosted agents have hostedConfig");
      const data: Prisma.ProviderUpdateInput = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.capabilities !== undefined
          ? { capabilities: await assertCapabilitiesExist(body.capabilities) }
          : {}),
        ...(body.languages !== undefined ? { languages: [...new Set(body.languages)] } : {}),
        ...(body.endpointUrl !== undefined ? { endpointUrl: body.endpointUrl } : {}),
        ...(body.manifestUrl !== undefined ? { manifestUrl: body.manifestUrl } : {}),
        ...(body.pricing !== undefined ? { pricing: body.pricing } : {}),
        // New instructions or model invalidate the measured cost: a fresh advice run is required.
        ...(body.hostedConfig !== undefined
          ? { hostedConfig: body.hostedConfig, aiCost: Prisma.DbNull, hostedAdvice: Prisma.DbNull }
          : {}),
      };
      const updated = await s.prisma.provider.update({ where: { id: provider.id }, data });
      return { provider: serializeProviderOwner(updated) };
    });

    /** Advice run for a hosted agent: score + cost per model on its sample tasks (docs/11 §5). */
    app.post(
      "/providers/:id/advise",
      { preHandler: s.limiter.guard("providers-advise", 3, 86_400) },
      async (req, reply) => {
        const { provider } = await loadOwnProvider(req);
        if (provider.hosting !== "KAZI")
          throw badRequest("only Kazi-hosted agents have advice runs");
        const running = hostedAdviceSchema.safeParse(provider.hostedAdvice);
        if (running.success && running.data.status === "RUNNING") {
          return reply
            .status(202)
            .send({ status: "RUNNING", requestedAt: running.data.requestedAt });
        }
        const now = Date.now();
        const requestedAt = new Date(now).toISOString();
        await s.prisma.provider.update({
          where: { id: provider.id },
          data: { hostedAdvice: { status: "RUNNING", requestedAt, rows: [] } },
        });
        await s.jobs.enqueue(
          "executor",
          "advise",
          { providerId: provider.id, requestedAt },
          jobIds.advise(provider.id, now),
        );
        return reply.status(202).send({ status: "RUNNING", requestedAt });
      },
    );

    /**
     * Dry run of a self-hosted agent: Kazi sends one signed sample request (no escrow, no payment)
     * and runs the deterministic checks on the answer. Hosted agents use /advise instead.
     */
    app.post(
      "/providers/:id/test",
      { preHandler: s.limiter.guard("providers-test", 20, 86_400) },
      async (req, reply) => {
        const { provider } = await loadOwnProvider(req);
        if (provider.kind !== "AGENT" || provider.hosting !== "SELF")
          throw badRequest("only self-hosted agents have test runs (hosted agents: /advise)");
        if (!provider.endpointUrl || !provider.webhookSecretEnc) throw badRequest("set an endpoint first");
        const body = parse(testSchema, req.body ?? {});
        const capability = body.capability ?? provider.capabilities[0];
        if (!capability || !provider.capabilities.includes(capability))
          throw badRequest("the agent doesn't offer this capability");
        const sample = sampleTask(capability);
        const testId = randomBytes(12).toString("hex");
        const now = new Date().toISOString();
        const state = providerTestStateSchema.parse({
          testId,
          providerId: provider.id,
          capability,
          status: "QUEUED",
          createdAt: now,
          updatedAt: now,
        });
        await s.redis.set(
          providerTestKey(s.env.REDIS_KEY_PREFIX, testId),
          JSON.stringify(state),
          "EX",
          PROVIDER_TEST_TTL_SEC,
        );
        await s.jobs.enqueue(
          "executor",
          "providerTest",
          {
            providerId: provider.id,
            testId,
            capability,
            instructions: body.instructions ?? sample.instructions,
            text: body.text ?? sample.input,
            rubric: sample.rubric,
          },
          jobIds.providerTest(testId),
        );
        return reply.status(202).send({ test: state });
      },
    );

    app.get("/providers/:id/tests/:testId", async (req) => {
      const { provider } = await loadOwnProvider(req);
      const { testId } = parse(testParams, req.params);
      const raw = await s.redis.get(providerTestKey(s.env.REDIS_KEY_PREFIX, testId));
      const state = raw ? providerTestStateSchema.safeParse(JSON.parse(raw)) : null;
      if (!state?.success || state.data.providerId !== provider.id) throw notFound("Test run");
      return { test: state.data };
    });

    /** The owner's latest submissions with scores and evaluator feedback (dashboard). */
    app.get("/providers/:id/submissions", async (req) => {
      const { provider } = await loadOwnProvider(req);
      const rows = await s.prisma.submission.findMany({
        where: { providerId: provider.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { subtask: { select: { title: true, capability: true, amount: true, status: true } } },
      });
      return {
        submissions: rows.map((r) => ({
          id: r.id,
          attempt: r.attempt,
          step: r.subtask.title,
          capability: r.subtask.capability,
          amount: r.subtask.amount,
          stepStatus: r.subtask.status,
          score: r.score,
          accepted: r.accepted,
          latencyMs: r.latencyMs,
          feedback: (r.evaluation as { feedback?: unknown } | null)?.feedback ?? null,
          createdAt: r.createdAt,
        })),
      };
    });

    /** The caller's own providers (any status), for the provider dashboard. */
    app.get("/me/providers", async (req) => {
      const auth = requireAuth(req);
      const rows = await s.prisma.provider.findMany({
        where: { ownerId: auth.userId },
        orderBy: { createdAt: "desc" },
      });
      return { providers: rows.map(serializeProviderOwner) };
    });

    app.get("/me/providers/:id", async (req) => {
      const { provider } = await loadOwnProvider(req);
      return { provider: serializeProviderOwner(provider) };
    });

    app.post("/providers/:id/rotate-secret", async (req) => {
      const { provider } = await loadOwnProvider(req);
      if (provider.kind !== "AGENT") throw badRequest("only agents have webhook secrets");
      const webhookSecret = generateWebhookSecret();
      await s.prisma.provider.update({
        where: { id: provider.id },
        data: { webhookSecretEnc: s.secrets.encrypt(webhookSecret) },
      });
      return { webhookSecret };
    });

    app.get("/providers/:id/stats", async (req) => {
      const { provider } = await loadOwnProvider(req);
      const released = await s.prisma.subtask.findMany({
        where: { providerId: provider.id, status: "RELEASED" },
        select: { amount: true },
      });
      const earnings = released.reduce((sum, st) => sum + BigInt(st.amount), 0n);
      const total = provider.completedCount + provider.failedCount;
      return {
        stats: {
          completedCount: provider.completedCount,
          failedCount: provider.failedCount,
          successRateBps:
            total === 0 ? null : Math.floor((provider.completedCount * 10_000) / total),
          reputation: provider.reputation,
          avgLatencyMs: provider.avgLatencyMs,
          earningsGross: earnings.toString(), // base units, before the escrow fee
        },
      };
    });

    /** Public directory: ACTIVE providers only. */
    app.get("/providers", async (req) => {
      const q = parse(listProvidersQuerySchema, req.query);
      const rows = await s.prisma.provider.findMany({
        where: {
          status: "ACTIVE",
          ...(q.capability ? { capabilities: { has: q.capability } } : {}),
          ...(q.language ? { languages: { has: q.language } } : {}),
          ...(q.kind ? { kind: q.kind } : {}),
          ...(q.minReputation !== undefined ? { reputation: { gte: q.minReputation } } : {}),
        },
        orderBy:
          q.sort === "newest"
            ? [{ createdAt: "desc" }, { id: "desc" }]
            : [{ reputation: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, q.limit);
      return {
        providers: page.map(serializeProviderPublic),
        nextCursor: rows.length > q.limit ? page.at(-1)?.id : null,
      };
    });

    app.get("/providers/:slug", async (req) => {
      const { slug } = parse(slugParams, req.params);
      const provider = await s.prisma.provider.findUnique({ where: { slug } });
      if (!provider || provider.status !== "ACTIVE") throw notFound("Provider");
      return { provider: serializeProviderPublic(provider) };
    });
  };
}
