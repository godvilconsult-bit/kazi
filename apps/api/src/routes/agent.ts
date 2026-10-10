import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifySignature } from "@kazi/agent-sdk";
import {
  PROVIDER_TEST_TTL_SEC,
  SIGNATURE_HEADER,
  agentCallbackSchema,
  jobIds,
  providerTestKey,
  providerTestStateSchema,
  runChecks,
} from "@kazi/shared";
import type { AppServices } from "../app";
import { badRequest, notFound, parse } from "../http/errors";

/**
 * Agent callbacks (docs/04-BACKEND-API.md "Agent callbacks", 05-AGENT-SPEC §4). Authenticated by
 * HMAC over the raw body with the agent's webhook secret. The API only verifies and enqueues; the
 * worker applies the result, so all subtask state changes happen in one place.
 */

const params = z.object({ subtaskId: z.string().min(1).max(64) });
const query = z.object({ attempt: z.coerce.number().int().min(1).max(10) });
const testParams = z.object({ testId: z.string().regex(/^[0-9a-f]{24}$/) });
/** Test runs check format, emptiness and injection only (no rubric judge). */
const TEST_ACCEPTANCE = { rubric: ["Sample deliverable"], format: "markdown" as const };

export function agentRoutes(s: AppServices) {
  return async function routes(app: FastifyInstance) {
    // Encapsulated: only these routes see the raw JSON string (needed for the HMAC).
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
      done(null, body),
    );

    app.post(
      "/agent/callback/:subtaskId",
      { preHandler: s.limiter.guard("agent-callback", 600, 60) },
      async (req, reply) => {
        const { subtaskId } = parse(params, req.params);
        const { attempt } = parse(query, req.query);
        const rawBody = typeof req.body === "string" ? req.body : "";

        const subtask = await s.prisma.subtask.findUnique({
          where: { id: subtaskId },
          include: { provider: true },
        });
        if (!subtask?.provider?.webhookSecretEnc || subtask.kind !== "WORK")
          throw notFound("Subtask");
        if (attempt > subtask.attempts) throw notFound("Subtask attempt");

        const header = req.headers[SIGNATURE_HEADER];
        const sig = verifySignature(
          rawBody,
          Array.isArray(header) ? header[0] : header,
          s.secrets.decrypt(subtask.provider.webhookSecretEnc),
        );
        if (!sig.ok) {
          return reply.status(401).send({
            error: { code: "UNAUTHORIZED", message: `signature ${sig.reason.toLowerCase()}` },
          });
        }

        let json: unknown;
        try {
          json = JSON.parse(rawBody);
        } catch {
          throw badRequest("body is not JSON");
        }
        const callback = parse(agentCallbackSchema, json);
        const now = Date.now();
        await s.jobs.enqueue(
          "executor",
          "agentResult",
          { subtaskId, attempt, callback, receivedAt: new Date(now).toISOString() },
          jobIds.agentResult(subtaskId, attempt, callback.status, now),
        );
        return reply.status(202).send({ ok: true });
      },
    );

    /** Async result of a dry run (POST /providers/:id/test). Same HMAC as real callbacks. */
    app.post(
      "/agent/test-callback/:testId",
      { preHandler: s.limiter.guard("agent-test-callback", 60, 60) },
      async (req, reply) => {
        const { testId } = parse(testParams, req.params);
        const key = providerTestKey(s.env.REDIS_KEY_PREFIX, testId);
        const raw = await s.redis.get(key);
        const state = raw ? providerTestStateSchema.safeParse(JSON.parse(raw)) : null;
        if (!state?.success) throw notFound("Test run");
        const provider = await s.prisma.provider.findUnique({
          where: { id: state.data.providerId },
        });
        if (!provider?.webhookSecretEnc) throw notFound("Test run");
        const rawBody = typeof req.body === "string" ? req.body : "";
        const header = req.headers[SIGNATURE_HEADER];
        const sig = verifySignature(
          rawBody,
          Array.isArray(header) ? header[0] : header,
          s.secrets.decrypt(provider.webhookSecretEnc),
        );
        if (!sig.ok) {
          return reply.status(401).send({
            error: { code: "UNAUTHORIZED", message: `signature ${sig.reason.toLowerCase()}` },
          });
        }
        let json: unknown;
        try {
          json = JSON.parse(rawBody);
        } catch {
          throw badRequest("body is not JSON");
        }
        const callback = parse(agentCallbackSchema, json);
        if (state.data.status === "COMPLETED" || state.data.status === "FAILED") {
          return reply.status(202).send({ ok: true }); // already final
        }
        const patch =
          callback.status === "progress"
            ? { progress: callback.progress }
            : callback.status === "failed"
              ? { status: "FAILED" as const, error: callback.error }
              : {
                  status: "COMPLETED" as const,
                  output: callback.output,
                  checks: runChecks({ output: callback.output, acceptance: TEST_ACCEPTANCE }),
                };
        const next = { ...state.data, ...patch, updatedAt: new Date().toISOString() };
        await s.redis.set(key, JSON.stringify(next), "EX", PROVIDER_TEST_TTL_SEC);
        return reply.status(202).send({ ok: true });
      },
    );
  };
}
