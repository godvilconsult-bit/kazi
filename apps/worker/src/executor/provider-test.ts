import type { Logger } from "pino";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@kazi/db";
import type { SecretBox } from "@kazi/config/secrets";
import { signPayload } from "@kazi/agent-sdk";
import {
  IDEMPOTENCY_HEADER,
  PROVIDER_TEST_TTL_SEC,
  SIGNATURE_HEADER,
  SUBTASK_ID_HEADER,
  agentResponseSchema,
  providerTestCallbackPath,
  providerTestKey,
  providerTestStateSchema,
  runChecks,
  type AgentRequest,
  type ProviderTestState,
  type jobSchemas,
} from "@kazi/shared";
import type { z } from "zod";
import { privateHostReason } from "../files/files";

/** Dry run of a self-hosted agent: one signed sample request, no escrow (docs/04 §3 providers). */

export type ProviderTestJob = z.infer<typeof jobSchemas.executor.providerTest>;

export interface ProviderTestDeps {
  prisma: PrismaClient;
  secrets: SecretBox;
  redis: Redis;
  keyPrefix: string;
  config: { apiUrl: string; syncResponseTimeoutMs: number; allowPrivateEndpoints?: boolean | undefined };
  log: Logger;
  fetch?: typeof fetch;
  now?: () => Date;
}

const TEST_DEADLINE_MS = 15 * 60_000;

export async function saveProviderTest(
  redis: Redis,
  keyPrefix: string,
  testId: string,
  patch: Partial<ProviderTestState>,
  onlyIf?: readonly ProviderTestState["status"][],
): Promise<ProviderTestState | null> {
  const key = providerTestKey(keyPrefix, testId);
  const raw = await redis.get(key);
  const prev = raw ? providerTestStateSchema.safeParse(JSON.parse(raw)) : null;
  if (!prev?.success) return null;
  if (onlyIf && !onlyIf.includes(prev.data.status)) return prev.data;
  const next = { ...prev.data, ...patch, updatedAt: new Date().toISOString() };
  await redis.set(key, JSON.stringify(next), "EX", PROVIDER_TEST_TTL_SEC);
  return next;
}

export async function runProviderTest(deps: ProviderTestDeps, job: ProviderTestJob): Promise<ProviderTestState["status"]> {
  const save = (patch: Partial<ProviderTestState>) => saveProviderTest(deps.redis, deps.keyPrefix, job.testId, patch);
  const fail = async (code: string, message: string, extra: Partial<ProviderTestState> = {}) => {
    await save({ status: "FAILED", error: { code, message }, ...extra });
    return "FAILED" as const;
  };
  const provider = await deps.prisma.provider.findUnique({ where: { id: job.providerId } });
  if (!provider?.endpointUrl || !provider.webhookSecretEnc || provider.hosting !== "SELF") {
    return fail("NO_ENDPOINT", "This agent has no endpoint or webhook secret.");
  }
  if (!provider.isHouse && !deps.config.allowPrivateEndpoints) {
    const reason = await privateHostReason(new URL(provider.endpointUrl));
    if (reason) return fail("BAD_ENDPOINT", `The agent endpoint host ${reason}.`);
  }

  const now = deps.now?.() ?? new Date();
  const subtaskId = `test_${job.testId}`;
  const request: AgentRequest = {
    subtaskId,
    attempt: 1,
    capability: job.capability,
    instructions: job.instructions,
    input: { text: job.text },
    acceptance: { rubric: job.rubric, format: "markdown" },
    deadline: new Date(now.getTime() + TEST_DEADLINE_MS).toISOString(),
    callbackUrl: `${deps.config.apiUrl.replace(/\/$/, "")}${providerTestCallbackPath(job.testId)}`,
    budget: "0",
  };
  const rawBody = JSON.stringify(request);
  const started = Date.now();
  let res: Response;
  try {
    res = await (deps.fetch ?? globalThis.fetch)(provider.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signPayload(rawBody, deps.secrets.decrypt(provider.webhookSecretEnc)),
        [SUBTASK_ID_HEADER]: subtaskId,
        [IDEMPOTENCY_HEADER]: `${subtaskId}:1`,
      },
      body: rawBody,
      redirect: "error",
      signal: AbortSignal.timeout(deps.config.syncResponseTimeoutMs),
    });
  } catch (err) {
    return fail("UNREACHABLE", `Kazi couldn't reach the endpoint: ${(err as Error).message}`.slice(0, 500));
  }
  const timing = { http: res.status, latencyMs: Date.now() - started };
  const body = agentResponseSchema.safeParse(await res.json().catch(() => null));
  if (!res.ok || !body.success) {
    return fail("BAD_RESPONSE", `HTTP ${res.status} with ${body.success ? "an error status" : "an invalid body"}`, timing);
  }
  deps.log.info({ providerId: provider.id, testId: job.testId, status: body.data.status, ...timing }, "provider test response");
  if (body.data.status === "completed") {
    const checks = runChecks({ output: body.data.output, acceptance: request.acceptance });
    await save({ status: "COMPLETED", output: body.data.output, checks, ...timing });
    return "COMPLETED";
  }
  if (body.data.status === "failed") return fail(body.data.error.code, body.data.error.message, timing);
  // Async agent: the result arrives at the test callback, which may already have answered.
  await saveProviderTest(deps.redis, deps.keyPrefix, job.testId, { status: "SENT", ...timing }, ["QUEUED"]);
  return "SENT";
}
