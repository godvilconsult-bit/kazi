import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import type { Prisma } from "@kazi/db";
import { type PrismaClient } from "@kazi/db";
import {
  CAPABILITY_DEFINITIONS,
  ECONOMY_MIN_HEADROOM_MS,
  QUOTE_TTL_SECONDS,
  SERVICE_FEE_PROVIDER_SLUG,
  aiCostEstimateSchema,
  formatUnits,
  nanoUsdToUnits,
  parseUnits,
  pricingSchema,
  priceQuote,
  providerPayout,
  storedQuoteSchema,
  transition,
  type Plan,
  type QuoteStep,
  type StoredQuote,
  type TaskStatus,
} from "@kazi/shared";
import type { ObjectStorage } from "@kazi/config/storage";
import { attachmentSummaries } from "../files/files";
import { notifyTaskClient } from "../notify";
import { PLAN_CACHE_TTL_SEC, planCacheKey, type PlanCache } from "./cache";
import { checkLlmCostAlert, recordLlmCost, type LlmClient } from "../llm";
import { decompose, type AttachmentInfo, type CapabilityInfo } from "./decompose";
import { applyExploration, rankCandidates, type Candidate, type ScoredCandidate } from "./match";
import type { QuoteSigner, RouterChain } from "./signer";

/** Router steps 1–3 end to end (docs/06-ROUTER.md): decompose → match → price → sign → persist. */

export interface FeeConfig {
  /** Take rate applied by the escrow (12% default). */
  takeRateBps: number;
  serviceFeeBps: number;
  /** Decimal USDC string, e.g. "0.10"; converted with the token's decimals. */
  minServiceFee: string;
}

export interface QuoteDeps {
  prisma: PrismaClient;
  llm: LlmClient;
  routerModel: string;
  chain: RouterChain;
  signer: QuoteSigner;
  fees: FeeConfig;
  log: Logger;
  now?: () => Date;
  /** Randomness for the exploration boost (tests inject a fixed value). */
  random?: () => number;
  /** Reuses plans for identical inputs for an hour (06-ROUTER §8). */
  planCache?: PlanCache;
  /** Reads client attachments (text, DOCX, PDF) for the planner; metadata only when absent. */
  files?: { storage: ObjectStorage; fastModel: string };
}

export class QuoteError extends Error {
  override readonly name = "QuoteError";
}

const QUOTABLE: ReadonlySet<TaskStatus> = new Set(["DRAFT", "QUOTED", "EXPIRED"]);
/** Quotes must leave time to do the work after funding. */
const MIN_DEADLINE_HEADROOM_MS = 2 * 3_600_000;

export async function quoteTask(deps: QuoteDeps, taskId: string): Promise<StoredQuote> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log.child({ taskId });
  const task = await deps.prisma.task.findUnique({
    where: { id: taskId },
    include: { client: true },
  });
  if (!task) throw new QuoteError(`task ${taskId} not found`);
  if (!QUOTABLE.has(task.status))
    throw new QuoteError(
      `task ${taskId} is ${task.status}; only DRAFT/QUOTED/EXPIRED can be quoted`,
    );

  // Idempotent: a still-valid quote is returned as is (an old signed quote stays fundable until expiry).
  const existing = task.quote ? storedQuoteSchema.safeParse(task.quote) : undefined;
  if (task.status === "QUOTED" && existing?.success && existing.data.outcome === "QUOTED") {
    // …unless the client switched speed since (the API updates Task.speed first).
    const sameSpeed = (existing.data.speed ?? task.speed) === task.speed;
    if (sameSpeed && new Date(existing.data.expiresAt) > now) return existing.data;
  }

  const version = task.quoteVersion + 1;
  const decimals = await deps.chain.usdcDecimals();
  const capabilities = await loadCapabilities(deps.prisma);
  const attachmentIds = Array.isArray(task.attachments)
    ? task.attachments.filter((v): v is string => typeof v === "string")
    : [];
  const attachments = deps.files
    ? await attachmentSummaries(
        { prisma: deps.prisma, llm: deps.llm, log, ...deps.files },
        task.clientId,
        attachmentIds,
        taskId,
      )
    : await loadAttachments(deps.prisma, task.clientId, attachmentIds);

  const decomposeInput = {
    title: task.title,
    description: task.description,
    attachments,
    budget: task.budgetMax ? `${formatUnits(BigInt(task.budgetMax), decimals)} USDC` : undefined,
    deadline: task.deadline,
    now,
  };
  const cacheKey = deps.planCache
    ? planCacheKey({ ...decomposeInput, capabilities: capabilities.map((c) => c.slug) })
    : null;
  let plan = cacheKey && deps.planCache ? await deps.planCache.get(cacheKey) : null;
  if (plan) {
    log.info({ cacheKey }, "plan reused from cache");
  } else {
    const res = await decompose(
      { llm: deps.llm, model: deps.routerModel, capabilities, taskId },
      decomposeInput,
    );
    plan = res.plan;
    await recordLlmCost(deps.prisma, taskId, res.usage);
    if (cacheKey && deps.planCache) await deps.planCache.set(cacheKey, plan, PLAN_CACHE_TTL_SEC);
  }

  const reject = (reason: string, p: Plan | null): Promise<StoredQuote> =>
    persistUnsigned(deps, task.id, task.status, task.quoteVersion, {
      outcome: "INFEASIBLE",
      version,
      createdAt: now.toISOString(),
      reason,
      plan: p,
    });

  if (!plan.feasible)
    return reject(plan.infeasibleReason ?? "This request can't be done on Kazi.", plan);
  if (plan.clarifyingQuestions.length > 0) {
    return persistUnsigned(deps, task.id, task.status, task.quoteVersion, {
      outcome: "NEEDS_CLARIFICATION",
      version,
      createdAt: now.toISOString(),
      questions: plan.clarifyingQuestions,
      plan,
    });
  }
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000);
  if (task.deadline.getTime() - expiresAt.getTime() < MIN_DEADLINE_HEADROOM_MS) {
    return reject(
      "The deadline is too close to complete this work. Choose a later deadline.",
      plan,
    );
  }

  // ── Match ──
  const providers = await loadCandidates(deps.prisma, decimals);
  // Economy needs room for a worst-case 24 h batch (docs/11-HOSTED-AGENTS.md §3).
  const speed =
    task.speed === "ECONOMY" && task.deadline.getTime() - now.getTime() >= ECONOMY_MIN_HEADROOM_MS
      ? "ECONOMY"
      : "EXPRESS";
  const ctx = {
    decimals,
    minStake: await deps.chain.minAgentStake(),
    headroomMs: task.deadline.getTime() - now.getTime(),
  };
  const ranked: ScoredCandidate[][] = [];
  for (const st of plan.subtasks) {
    // A hosted agent whose price doesn't cover its AI cost with a 10% margin isn't quoted.
    const r = applyExploration(
      rankCandidates(st, providers, ctx).filter(
        (c) => !c.provider.hosted || c.cost - c.provider.hosted.economy >= c.cost / 10n,
      ),
      deps.random ?? Math.random,
    );
    if (r.length === 0)
      return reject(`No provider is available for "${st.capability}" right now.`, plan);
    ranked.push(r);
  }

  // ── Price ── best-scored first; if over budget, fall back to the cheapest candidates.
  const fees = {
    feeBps: deps.fees.takeRateBps, // TODO(phase 6): 10% for clients staking ≥ 5,000 $KAZI (08-TOKENOMICS §26)
    publishedFeeBps: await deps.chain.publishedFeeBps(),
    serviceFeeBps: deps.fees.serviceFeeBps,
    minServiceFee: parseUnits(deps.fees.minServiceFee, decimals),
  };
  // Hosted steps: the developer nets price − Economy AI cost; the AI cost at the chosen speed
  // rides in Kazi's milestone (docs/11-HOSTED-AGENTS.md §3).
  const split = (picks: ScoredCandidate[]) =>
    picks.map((c) => {
      const h = c.provider.hosted;
      return h
        ? { net: c.cost - h.economy, ai: speed === "ECONOMY" ? h.economy : h.express }
        : { net: c.cost, ai: 0n };
    });
  const price = (picks: ScoredCandidate[]) => {
    const parts = split(picks);
    return {
      parts,
      pricing: priceQuote({
        ...fees,
        costs: parts.map((p) => p.net),
        aiCost: parts.reduce((a, p) => a + p.ai, 0n),
      }),
    };
  };
  let chosen = ranked.map((r) => at(r, 0));
  let { parts, pricing } = price(chosen);
  const budget = task.budgetMax ? BigInt(task.budgetMax) : undefined;
  if (budget !== undefined && pricing.total > budget) {
    chosen = ranked.map((r) => r.reduce((min, c) => (c.cost < min.cost ? c : min)));
    ({ parts, pricing } = price(chosen));
  }
  const overBudget = budget !== undefined && pricing.total > budget;

  // ── Service-fee milestone (paid to Kazi's treasury via its registered provider) ──
  let service: { id: string; name: string; onchainId: bigint } | null = null;
  if (pricing.serviceMilestone !== null) {
    const sp = await deps.prisma.provider.findUnique({
      where: { slug: SERVICE_FEE_PROVIDER_SLUG },
    });
    if (!sp?.onchainId) {
      throw new QuoteError(
        `service-fee provider "${SERVICE_FEE_PROVIDER_SLUG}" is not registered onchain`,
      );
    }
    service = { id: sp.id, name: sp.name, onchainId: sp.onchainId };
  }

  const steps: QuoteStep[] = plan.subtasks.map((st, i) => {
    const pick = at(chosen, i).provider;
    const milestone = at(pricing.milestones, i);
    return {
      index: st.index,
      kind: "WORK",
      title: st.title,
      capability: st.capability,
      providerId: pick.id,
      providerName: pick.name,
      amount: milestone.toString(),
      cost: providerPayout(milestone, pricing.feeBps).toString(),
      ...(at(parts, i).ai > 0n ? { aiCost: at(parts, i).ai.toString() } : {}),
      fallbackProviderIds: at(ranked, i)
        .filter((c) => c.provider.id !== pick.id)
        .slice(0, 2)
        .map((c) => c.provider.id),
    };
  });
  if (service && pricing.serviceMilestone !== null) {
    steps.push({
      index: plan.subtasks.length,
      kind: "SERVICE_FEE",
      title: pricing.aiCost > 0n ? "Kazi service fee and AI cost" : "Kazi service fee",
      capability: null,
      providerId: service.id,
      providerName: service.name,
      amount: pricing.serviceMilestone.toString(),
      cost: providerPayout(pricing.serviceMilestone, pricing.feeBps).toString(),
      fallbackProviderIds: [],
    });
  }

  // ── Sign ──
  const onchain = {
    taskId: task.onchainId as Hex,
    providerIds: [
      ...chosen.map((c) => c.provider.onchainId),
      ...(service ? [service.onchainId] : []),
    ],
    amounts: steps.map((s) => BigInt(s.amount)),
    deadline: BigInt(Math.floor(task.deadline.getTime() / 1000)),
    feeBps: pricing.feeBps,
    expiry: BigInt(Math.floor(expiresAt.getTime() / 1000)),
  };
  const client = task.client.wallet as Address;
  const signature = await deps.signer.sign(onchain, client);

  const quote: StoredQuote = {
    outcome: "QUOTED",
    version,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    client,
    onchain: {
      taskId: onchain.taskId,
      providerIds: onchain.providerIds.map(String),
      amounts: onchain.amounts.map(String),
      deadline: onchain.deadline.toString(),
      feeBps: onchain.feeBps,
      expiry: onchain.expiry.toString(),
    },
    signature,
    subtotal: pricing.subtotal.toString(),
    serviceFee: pricing.serviceFee.toString(),
    ...(pricing.aiCost > 0n ? { aiCost: pricing.aiCost.toString() } : {}),
    speed,
    total: pricing.total.toString(),
    overBudget,
    steps,
    plan,
  };

  await deps.prisma.$transaction(async (tx) => {
    const moved = await tx.task.updateMany({
      where: { id: task.id, status: task.status, quoteVersion: task.quoteVersion },
      data: {
        status: transition("task", task.status, "QUOTE"),
        quote: quote as unknown as Prisma.InputJsonValue,
        quoteVersion: version,
        totalAmount: quote.total,
        feeBps: quote.onchain.feeBps,
        // The quoted speed is what runs: an Economy request too close to the deadline is Express.
        speed,
      },
    });
    if (moved.count !== 1) throw new QuoteError(`task ${task.id} changed while quoting`);
    await tx.subtask.deleteMany({ where: { taskId: task.id } });
    await tx.subtask.createMany({
      data: steps.map((s) => {
        const st = s.kind === "WORK" ? at(plan.subtasks, s.index) : null;
        return {
          taskId: task.id,
          index: s.index,
          kind: s.kind,
          title: s.title,
          instructions: st?.instructions ?? "",
          capability: st?.capability ?? SERVICE_FEE_PROVIDER_SLUG,
          dependsOn: st?.dependsOn ?? [],
          acceptance: (st?.acceptance ?? {}) as Prisma.InputJsonValue,
          providerId: s.providerId,
          amount: s.amount,
          aiCost: s.aiCost ?? null,
        };
      }),
    });
    await tx.taskEvent.create({
      data: {
        taskId: task.id,
        type: "QUOTED",
        data: { version, total: quote.total, steps: steps.length, overBudget, speed },
      },
    });
  });
  log.info({ version, total: quote.total, steps: steps.length, overBudget }, "task quoted");
  await checkLlmCostAlert(deps.prisma, task.id, decimals, log);
  await notifyTaskClient(deps.prisma, task.id, {
    type: "QUOTED",
    title: "Your quote is ready",
    body: `"${task.title}": ${steps.filter((x) => x.kind === "WORK").length} step(s). The quote is valid for 30 minutes.`,
  });
  return quote;
}

/** Store a quote the client must act on (questions / infeasible). No signature, no subtasks. */
async function persistUnsigned(
  deps: QuoteDeps,
  taskId: string,
  status: TaskStatus,
  prevVersion: number,
  quote: Extract<StoredQuote, { outcome: "INFEASIBLE" | "NEEDS_CLARIFICATION" }>,
): Promise<StoredQuote> {
  await deps.prisma.$transaction(async (tx) => {
    // A replaced QUOTED quote is no longer fundable from the DB's point of view.
    const nextStatus = status === "QUOTED" ? transition("task", "QUOTED", "EXPIRE_QUOTE") : status;
    const moved = await tx.task.updateMany({
      where: { id: taskId, status, quoteVersion: prevVersion },
      data: {
        status: nextStatus,
        quote: quote as unknown as Prisma.InputJsonValue,
        quoteVersion: quote.version,
        totalAmount: null,
        feeBps: null,
      },
    });
    if (moved.count !== 1) throw new QuoteError(`task ${taskId} changed while quoting`);
    await tx.subtask.deleteMany({ where: { taskId } });
    await tx.taskEvent.create({
      data: {
        taskId,
        type: quote.outcome === "INFEASIBLE" ? "QUOTE_INFEASIBLE" : "QUOTE_NEEDS_CLARIFICATION",
        data:
          quote.outcome === "INFEASIBLE"
            ? { version: quote.version, reason: quote.reason }
            : { version: quote.version, questions: quote.questions },
      },
    });
  });
  deps.log.info({ taskId, outcome: quote.outcome }, "task not quoted");
  await notifyTaskClient(deps.prisma, taskId, {
    type: quote.outcome,
    title: quote.outcome === "INFEASIBLE" ? "We can't quote this task" : "A few questions before we quote",
    body: quote.outcome === "INFEASIBLE" ? quote.reason : quote.questions.join(" "),
  });
  return quote;
}

async function loadCapabilities(prisma: PrismaClient): Promise<CapabilityInfo[]> {
  const units = new Map(CAPABILITY_DEFINITIONS.map((c) => [c.slug, c.unit]));
  const rows = await prisma.capability.findMany({
    where: { enabled: true },
    orderBy: { slug: "asc" },
  });
  return rows.map((r) => ({
    slug: r.slug,
    description: r.description,
    unit: units.get(r.slug) ?? "task",
  }));
}

/** Without storage access (tests): file metadata only. */
async function loadAttachments(
  prisma: PrismaClient,
  ownerId: string,
  ids: string[],
): Promise<AttachmentInfo[]> {
  if (ids.length === 0) return [];
  const files = await prisma.fileObject.findMany({
    where: { id: { in: ids }, ownerId, status: "UPLOADED" },
  });
  return files.map((f) => ({ filename: f.filename, mime: f.mime, size: f.size }));
}

async function loadCandidates(prisma: PrismaClient, decimals: number): Promise<Candidate[]> {
  const rows = await prisma.provider.findMany({
    where: {
      status: "ACTIVE",
      onchainId: { not: null },
      slug: { not: SERVICE_FEE_PROVIDER_SLUG },
    },
  });
  return rows.flatMap((r) => {
    const pricing = pricingSchema.safeParse(r.pricing);
    if (!pricing.success || r.onchainId === null) return [];
    let hosted: Candidate["hosted"];
    if (r.hosting === "KAZI") {
      // Not quotable until an advice run (or real runs) produced a cost estimate.
      const est = aiCostEstimateSchema.safeParse(r.aiCost);
      if (!est.success) return [];
      hosted = {
        economy: nanoUsdToUnits(BigInt(est.data.economyNano), decimals),
        express: nanoUsdToUnits(BigInt(est.data.expressNano), decimals),
      };
    }
    return [
      {
        id: r.id,
        name: r.name,
        capabilities: r.capabilities,
        pricing: pricing.data,
        reputation: r.reputation,
        completedCount: r.completedCount,
        failedCount: r.failedCount,
        avgLatencyMs: r.avgLatencyMs,
        stake: BigInt(r.stakeAmount),
        onchainId: r.onchainId,
        reviewScore: r.reviewScore,
        ...(hosted ? { hosted } : {}),
      },
    ];
  });
}

/** Index into arrays the code built in lockstep; a miss is a bug, so fail loudly. */
function at<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new QuoteError(`internal: missing item ${i}`);
  return item;
}
