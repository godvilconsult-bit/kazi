import type { Logger } from "pino";
import type { PrismaClient } from "@kazi/db";
import type { SecretBox } from "@kazi/config/secrets";
import type { ObjectStorage } from "@kazi/config/storage";
import { signPayload } from "@kazi/agent-sdk";
import {
  ECONOMY_ATTEMPT_MS,
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  SUBTASK_ID_HEADER,
  agentResponseSchema,
  capabilityOutputSchema,
  jobIds,
  formatUnits,
  hostedRunMode,
  providerPayout,
  storedQuoteSchema,
  transition,
  type AgentRequest,
  type SubtaskStatus,
} from "@kazi/shared";
import type { EscrowOperator } from "../chain/operator";
import type { JobSink } from "../jobs/sink";
import { buildAgentInput } from "./input";
import { createDirectOffer } from "./offers";
import { privateHostReason } from "../files/files";
import { applyAgentResult } from "./results";

/** Executor step (docs/06-ROUTER.md §4): send one attempt of one subtask to its provider. */

export interface ExecutorConfig {
  maxAttempts: number;
  /** Per-attempt time limit when the provider's manifest gives none (capped at the task deadline). */
  attemptTimeoutSec: number;
  /** How long to wait for a sync agent's HTTP response. */
  syncResponseTimeoutMs: number;
  /** Public API base URL, for callback URLs. */
  apiUrl: string;
  /** Local development only: let third-party agents run on localhost / private networks. */
  allowPrivateEndpoints?: boolean;
}

export interface DispatchDeps {
  prisma: PrismaClient;
  secrets: SecretBox;
  jobs: JobSink;
  /** Needed only to move a milestone to a fallback provider on the last attempt. */
  operator?: EscrowOperator;
  usdcDecimals: () => Promise<number>;
  config: ExecutorConfig;
  log: Logger;
  /** Signs URLs to client attachments / earlier outputs for the agent, and imports returned files. */
  storage?: ObjectStorage;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class DispatchError extends Error {
  override readonly name = "DispatchError";
}

const ACTIVE_TASK = new Set(["FUNDED", "IN_PROGRESS"]);

export async function dispatchSubtask(
  deps: DispatchDeps,
  subtaskId: string,
  attempt: number,
): Promise<"sent" | "stale" | "human" | "hosted"> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log.child({ subtaskId, attempt });
  const st = await deps.prisma.subtask.findUnique({
    where: { id: subtaskId },
    include: { task: true },
  });
  if (!st || st.kind !== "WORK" || !ACTIVE_TASK.has(st.task.status)) return "stale";

  // ── Claim the attempt (exactly one transition per attempt; a re-run job just re-sends) ──
  const resend = st.status === "DISPATCHED" && st.attempts === attempt;
  if (!resend) {
    const event =
      st.status === "PENDING" && attempt === 1
        ? "DISPATCH"
        : st.status === "REJECTED" &&
            attempt === st.attempts + 1 &&
            attempt <= deps.config.maxAttempts + st.revisions // each client revision allows one more
          ? "RETRY"
          : null;
    if (!event) return "stale";

    let providerId = st.providerId;
    // A client revision goes back to the provider who did the work, never to a fallback.
    if (event === "RETRY" && st.revisions === 0 && attempt === deps.config.maxAttempts) {
      providerId = await switchToFallback(deps, st, log);
    }
    // Kazi-hosted agents on Economy run as a batch, which may take up to 24 h (docs/11 §4).
    const hosting = providerId
      ? (
          await deps.prisma.provider.findUnique({
            where: { id: providerId },
            select: { hosting: true },
          })
        )?.hosting
      : undefined;
    const attemptMs =
      hosting === "KAZI" && hostedRunMode(st.task.speed, st.task.deadline, now) === "BATCH"
        ? ECONOMY_ATTEMPT_MS
        : deps.config.attemptTimeoutSec * 1000;
    const timeoutAt = new Date(Math.min(st.task.deadline.getTime(), now.getTime() + attemptMs));
    const moved = await deps.prisma.subtask.updateMany({
      where: { id: st.id, status: st.status, attempts: st.attempts },
      data: {
        status: transition("subtask", st.status as SubtaskStatus, event),
        attempts: attempt,
        providerId,
        dispatchedAt: now,
        timeoutAt,
      },
    });
    if (moved.count !== 1) return "stale";
    if (st.task.status === "FUNDED") {
      const started = await deps.prisma.task.updateMany({
        where: { id: st.taskId, status: "FUNDED" },
        data: { status: transition("task", "FUNDED", "START") },
      });
      if (started.count === 1) {
        await deps.prisma.taskEvent.create({
          data: { taskId: st.taskId, type: "STATUS_IN_PROGRESS", data: {} },
        });
      }
    }
    await deps.prisma.taskEvent.create({
      data: {
        taskId: st.taskId,
        type: "SUBTASK_DISPATCHED",
        data: { subtaskId, index: st.index, attempt, providerId },
      },
    });
  }

  const fresh = await deps.prisma.subtask.findUniqueOrThrow({
    where: { id: subtaskId },
    include: { task: true, provider: true },
  });
  const provider = fresh.provider;
  if (!provider) throw new DispatchError(`subtask ${subtaskId} has no provider`);
  if (provider.kind === "HUMAN") {
    // Delivered through the freelancer dashboard; widened or failed by `offersTick`.
    await createDirectOffer(
      deps.prisma,
      {
        id: fresh.id,
        attempts: fresh.attempts,
        title: fresh.title,
        timeoutAt: fresh.timeoutAt,
        providerId: provider.id,
      },
      now,
    );
    await deps.prisma.taskEvent.create({
      data: {
        taskId: fresh.taskId,
        type: "HUMAN_OFFER_CREATED",
        data: { subtaskId, providerId: provider.id, attempt },
      },
    });
    return "human";
  }
  if (provider.hosting === "KAZI") {
    // Kazi runs this agent itself (docs/11-HOSTED-AGENTS.md); no HTTP call.
    await deps.jobs.add(
      "executor",
      "hostedRun",
      { subtaskId, attempt },
      jobIds.hostedRun(subtaskId, attempt),
    );
    return "hosted";
  }
  if (!provider.endpointUrl || !provider.webhookSecretEnc) {
    throw new DispatchError(`provider ${provider.id} has no endpoint or webhook secret`);
  }

  // Third-party endpoints must be public hosts (SSRF); house agents may run on the private network.
  if (!provider.isHouse && !deps.config.allowPrivateEndpoints) {
    const reason = await privateHostReason(new URL(provider.endpointUrl));
    if (reason) {
      await applyAgentResult(
        {
          prisma: deps.prisma,
          jobs: deps.jobs,
          log,
          now: deps.now,
          storage: deps.storage,
          fetch: deps.fetch,
        },
        subtaskId,
        attempt,
        {
          status: "failed",
          error: { code: "BAD_ENDPOINT", message: `The agent endpoint host ${reason}.` },
        },
      );
      return "sent";
    }
  }

  const request = await buildAgentRequest(deps, fresh, attempt);
  const rawBody = JSON.stringify(request);
  const secret = deps.secrets.decrypt(provider.webhookSecretEnc);
  const doFetch = deps.fetch ?? globalThis.fetch;
  const started = Date.now();
  // Network errors and 5xx/429 throw: BullMQ retries this job with backoff; the agent dedups by key.
  const res = await doFetch(provider.endpointUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signPayload(rawBody, secret),
      [SUBTASK_ID_HEADER]: subtaskId,
      [IDEMPOTENCY_HEADER]: `${subtaskId}:${attempt}`,
    },
    body: rawBody,
    signal: AbortSignal.timeout(deps.config.syncResponseTimeoutMs),
  });
  if (res.status === 429 || res.status >= 500) throw new DispatchError(`agent HTTP ${res.status}`);
  if (res.status === 409) return "sent"; // already running from an earlier delivery; wait for its result

  const body = agentResponseSchema.safeParse(await res.json().catch(() => null));
  const resultDeps = {
    prisma: deps.prisma,
    jobs: deps.jobs,
    log,
    now: deps.now,
    storage: deps.storage,
    fetch: deps.fetch,
  };
  if (!body.success) {
    await applyAgentResult(resultDeps, subtaskId, attempt, {
      status: "failed",
      error: { code: "BAD_RESPONSE", message: `HTTP ${res.status} with an invalid body` },
    });
    return "sent";
  }
  log.info(
    { status: body.data.status, http: res.status, ms: Date.now() - started },
    "agent responded",
  );
  if (body.data.status === "completed") {
    const output = capabilityOutputSchema.parse(body.data.output);
    await applyAgentResult(resultDeps, subtaskId, attempt, { status: "completed", output });
  } else if (body.data.status === "failed") {
    await applyAgentResult(resultDeps, subtaskId, attempt, {
      status: "failed",
      error: body.data.error,
    });
  }
  return "sent";
}

/** The request body (docs/05-AGENT-SPEC.md §3); hosted agents get the same request. */
export async function buildAgentRequest(
  deps: Pick<DispatchDeps, "prisma" | "usdcDecimals" | "config" | "storage">,
  st: {
    id: string;
    taskId: string;
    index: number;
    capability: string;
    instructions: string;
    dependsOn: number[];
    acceptance: unknown;
    amount: string;
    timeoutAt: Date | null;
    task: {
      title: string;
      description: string;
      deadline: Date;
      feeBps: number | null;
      attachments: unknown;
      clientId: string;
    };
  },
  attempt: number,
): Promise<AgentRequest> {
  const input = await buildAgentInput(deps, st);

  const previous =
    attempt > 1
      ? await deps.prisma.submission.findUnique({
          where: { subtaskId_attempt: { subtaskId: st.id, attempt: attempt - 1 } },
        })
      : null;
  const feedback = (previous?.evaluation as { feedback?: unknown } | null)?.feedback;
  const decimals = await deps.usdcDecimals();
  const budget = providerPayout(BigInt(st.amount), st.task.feeBps ?? 0);
  return {
    subtaskId: st.id,
    attempt,
    capability: st.capability,
    instructions: st.instructions,
    input,
    acceptance: st.acceptance as AgentRequest["acceptance"],
    deadline: (st.timeoutAt ?? st.task.deadline).toISOString(),
    callbackUrl: `${deps.config.apiUrl.replace(/\/$/, "")}/agent/callback/${st.id}?attempt=${attempt}`,
    budget: formatUnits(budget, decimals),
    ...(typeof feedback === "string" ? { feedback: feedback.slice(0, 4_000) } : {}),
  };
}

/** Last attempt goes to the best fallback from the quote; the milestone is reassigned onchain first. */
async function switchToFallback(
  deps: DispatchDeps,
  st: {
    id: string;
    index: number;
    providerId: string | null;
    task: { onchainId: string; quote: unknown };
  },
  log: Logger,
): Promise<string | null> {
  const quote = storedQuoteSchema.safeParse(st.task.quote);
  if (!quote.success || quote.data.outcome !== "QUOTED" || !deps.operator) return st.providerId;
  const fallbackIds = quote.data.steps.find((s) => s.index === st.index)?.fallbackProviderIds ?? [];
  for (const id of fallbackIds) {
    const p = await deps.prisma.provider.findUnique({ where: { id } });
    if (!p || p.status !== "ACTIVE" || p.onchainId === null) continue;
    const onchain = await deps.operator.milestone(st.task.onchainId as `0x${string}`, st.index);
    if (onchain.providerId !== p.onchainId) {
      await deps.operator.reassign(st.task.onchainId as `0x${string}`, st.index, p.onchainId);
    }
    log.info({ from: st.providerId, to: p.id }, "subtask reassigned to fallback provider");
    return p.id;
  }
  return st.providerId;
}
