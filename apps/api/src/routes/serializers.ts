import type { FileObject, Provider, Subtask, Task, TaskEvent, User } from "@kazi/db";
import { aiCostEstimateSchema, nanoToUsd } from "@kazi/shared";

/** Explicit allow-lists of fields that leave the API. Secrets and internal costs never do. */

export function serializeUser(u: User) {
  return {
    id: u.id,
    wallet: u.wallet,
    displayName: u.displayName,
    roles: u.roles,
    createdAt: u.createdAt,
  };
}

type SubtaskView = Subtask & {
  provider?: { name: string; slug: string; kind: string; hosting: string } | null;
};

export function serializeTask(t: Task & { subtasks?: SubtaskView[] }) {
  return {
    id: t.id,
    onchainId: t.onchainId,
    title: t.title,
    description: t.description,
    attachments: t.attachments,
    budgetMax: t.budgetMax,
    deadline: t.deadline,
    speed: t.speed,
    status: t.status,
    quoteVersion: t.quoteVersion,
    totalAmount: t.totalAmount,
    feeBps: t.feeBps,
    fundTxHash: t.fundTxHash,
    deliveredAt: t.deliveredAt,
    reviewUntil: t.reviewUntil,
    rating: t.rating,
    ratingComment: t.ratingComment,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    subtasks: t.subtasks?.map(serializeSubtask),
  };
}

export function serializeSubtask(st: SubtaskView) {
  return {
    id: st.id,
    index: st.index,
    kind: st.kind,
    title: st.title,
    capability: st.capability,
    dependsOn: st.dependsOn,
    providerId: st.providerId,
    amount: st.amount,
    status: st.status,
    attempts: st.attempts,
    revisions: st.revisions,
    provider: st.provider ?? null,
    releaseTxHash: st.releaseTxHash,
    refundTxHash: st.refundTxHash,
  };
}

export function serializeTaskEvent(e: TaskEvent) {
  return { id: e.id, type: e.type, data: e.data, createdAt: e.createdAt };
}

/** Public directory view. */
export function serializeProviderPublic(p: Provider) {
  return {
    id: p.id,
    onchainId: p.onchainId?.toString() ?? null,
    kind: p.kind,
    name: p.name,
    slug: p.slug,
    description: p.description,
    capabilities: p.capabilities,
    languages: p.languages,
    pricing: p.pricing,
    status: p.status,
    isHouse: p.isHouse,
    hosting: p.hosting,
    stakeAmount: p.stakeAmount,
    reputation: p.reputation,
    completedCount: p.completedCount,
    avgLatencyMs: p.avgLatencyMs,
    createdAt: p.createdAt,
  };
}

/** Owner view: adds operational fields, still never the secret material. */
export function serializeProviderOwner(p: Provider) {
  return {
    ...serializeProviderPublic(p),
    endpointUrl: p.endpointUrl,
    manifestUrl: p.manifestUrl,
    manifestHash: p.manifestHash,
    payoutAddress: p.payoutAddress,
    failedCount: p.failedCount,
    hasWebhookSecret: p.webhookSecretEnc !== null,
    // Hosted agents: the developer's own settings, cost estimate (USD) and last advice run.
    hostedConfig: p.hostedConfig,
    aiCostUsd: aiCostUsd(p.aiCost),
    hostedAdvice: p.hostedAdvice,
  };
}

function aiCostUsd(raw: unknown) {
  const est = aiCostEstimateSchema.safeParse(raw);
  if (!est.success) return null;
  return {
    economy: nanoToUsd(BigInt(est.data.economyNano)),
    express: nanoToUsd(BigInt(est.data.expressNano)),
    samples: est.data.samples,
    updatedAt: est.data.updatedAt,
  };
}

export function serializeFile(f: FileObject) {
  return {
    id: f.id,
    filename: f.filename,
    mime: f.mime,
    size: f.size,
    sha256: f.sha256,
    status: f.status,
    createdAt: f.createdAt,
  };
}
