import type { Logger } from "pino";
import type { Hex } from "viem";
import type { PrismaClient } from "@kazi/db";
import type { EscrowOperator } from "../chain/operator";
import { notify } from "../notify";
import { recordFailedAttempt } from "./results";

/**
 * Human freelancer offers (docs/05-AGENT-SPEC.md §8, 06-ROUTER §4):
 * wave 1 → the router's pick, 2 h to accept; wave 2 → every qualified freelancer, 2 h more;
 * nobody → the attempt fails (NO_TAKER) and the normal retry/refund path takes over.
 */

export const OFFER_WINDOW_MS = 2 * 3_600_000;
/** A freelancer working on a step is reminded once per attempt when this little time is left. */
export const DUE_SOON_MS = 2 * 3_600_000;

export async function createDirectOffer(
  prisma: PrismaClient,
  st: { id: string; attempts: number; title: string; timeoutAt: Date | null; providerId: string },
  now: Date,
): Promise<void> {
  const expiresAt = new Date(
    Math.min(now.getTime() + OFFER_WINDOW_MS, (st.timeoutAt ?? now).getTime()),
  );
  const offer = await prisma.offer.upsert({
    where: {
      subtaskId_attempt_providerId: {
        subtaskId: st.id,
        attempt: st.attempts,
        providerId: st.providerId,
      },
    },
    update: {},
    create: {
      subtaskId: st.id,
      attempt: st.attempts,
      providerId: st.providerId,
      wave: 1,
      expiresAt,
    },
    include: { provider: { select: { ownerId: true } } },
  });
  await notify(prisma, offer.provider.ownerId, {
    type: "OFFER",
    title: "New work offer",
    body: `"${st.title}" — accept within 2 hours.`,
    link: "/freelancer/offers",
  });
}

/** Expire, widen or fail offers for human subtasks that are waiting for a taker. */
export async function offersTick(deps: {
  prisma: PrismaClient;
  log: Logger;
  now?: () => Date;
}): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const waiting = await deps.prisma.subtask.findMany({
    where: { status: "DISPATCHED", provider: { kind: "HUMAN" } },
    include: { offers: true },
  });
  let changed = 0;
  for (const st of waiting) {
    const current = st.offers.filter((o) => o.attempt === st.attempts);
    const accepted = current.find((o) => o.status === "ACCEPTED");
    if (accepted) {
      // Someone is working on it: remind them once when the deadline gets close.
      if (
        st.timeoutAt &&
        st.timeoutAt.getTime() - now.getTime() < DUE_SOON_MS &&
        st.timeoutAt > now
      ) {
        if (await remindOnce(deps.prisma, st, accepted.providerId)) changed++;
      }
      continue;
    }
    const open = current.filter((o) => o.status === "OFFERED" && o.expiresAt > now);
    if (open.length > 0) continue;

    await deps.prisma.offer.updateMany({
      where: { subtaskId: st.id, attempt: st.attempts, status: "OFFERED" },
      data: { status: "EXPIRED" },
    });
    const wave = Math.max(0, ...current.map((o) => o.wave));
    if (wave < 2) {
      // Widen to every qualified freelancer who hasn't seen this attempt yet.
      const seen = new Set(current.map((o) => o.providerId));
      const others = await deps.prisma.provider.findMany({
        where: {
          kind: "HUMAN",
          status: "ACTIVE",
          capabilities: { has: st.capability },
          onchainId: { not: null },
        },
        select: { id: true, ownerId: true },
      });
      const fresh = others.filter((p) => !seen.has(p.id));
      if (fresh.length > 0) {
        const expiresAt = new Date(
          Math.min(now.getTime() + OFFER_WINDOW_MS, (st.timeoutAt ?? now).getTime()),
        );
        if (expiresAt > now) {
          await deps.prisma.offer.createMany({
            data: fresh.map((p) => ({
              subtaskId: st.id,
              attempt: st.attempts,
              providerId: p.id,
              wave: 2,
              expiresAt,
            })),
            skipDuplicates: true,
          });
          for (const p of fresh) {
            await notify(deps.prisma, p.ownerId, {
              type: "OFFER",
              title: "New work offer",
              body: `"${st.title}" is open to qualified freelancers — first to accept gets it.`,
              link: "/freelancer/offers",
            });
          }
          await deps.prisma.taskEvent.create({
            data: {
              taskId: st.taskId,
              type: "OFFER_WIDENED",
              data: { subtaskId: st.id, freelancers: fresh.length },
            },
          });
          changed++;
          continue;
        }
      }
    }
    await recordFailedAttempt(
      deps,
      st.id,
      st.attempts,
      "AGENT_ERROR",
      {
        code: "NO_TAKER",
        message: "No freelancer accepted this work in time.",
      },
      null,
    );
    changed++;
  }
  return changed;
}

async function remindOnce(
  prisma: PrismaClient,
  st: { id: string; taskId: string; attempts: number; title: string; timeoutAt: Date | null },
  providerId: string,
): Promise<boolean> {
  const already = await prisma.taskEvent.findFirst({
    where: {
      taskId: st.taskId,
      type: "FREELANCER_REMINDED",
      data: { path: ["subtaskId"], equals: st.id },
    },
    select: { data: true },
    orderBy: { createdAt: "desc" },
  });
  if ((already?.data as { attempt?: number } | null)?.attempt === st.attempts) return false;
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { ownerId: true },
  });
  if (!provider) return false;
  await prisma.taskEvent.create({
    data: {
      taskId: st.taskId,
      type: "FREELANCER_REMINDED",
      data: { subtaskId: st.id, attempt: st.attempts },
    },
  });
  await notify(prisma, provider.ownerId, {
    type: "DUE_SOON",
    title: "Work due soon",
    body: `"${st.title}" is due ${st.timeoutAt?.toUTCString() ?? "soon"}. Submit before then or it goes to someone else.`,
    link: `/freelancer/subtasks/${st.id}`,
  });
  return true;
}

/**
 * A freelancer accepted (API already marked the offer ACCEPTED and withdrew the others). If they
 * aren't the milestone's current provider, move the milestone onchain first, then the subtask.
 */
export async function applyAcceptedOffer(
  deps: { prisma: PrismaClient; operator: EscrowOperator; log: Logger },
  offerId: string,
): Promise<"reassigned" | "unchanged" | "stale"> {
  const offer = await deps.prisma.offer.findUnique({
    where: { id: offerId },
    include: { provider: true, subtask: { include: { task: true } } },
  });
  if (!offer || offer.status !== "ACCEPTED") return "stale";
  const st = offer.subtask;
  if (st.providerId === offer.providerId) return "unchanged";
  if (offer.provider.onchainId === null)
    throw new Error(`provider ${offer.providerId} is not registered onchain`);
  const taskId = st.task.onchainId as Hex;
  const onchain = await deps.operator.milestone(taskId, st.index);
  if (onchain.providerId !== offer.provider.onchainId) {
    await deps.operator.reassign(taskId, st.index, offer.provider.onchainId);
  }
  await deps.prisma.subtask.update({
    where: { id: st.id },
    data: { providerId: offer.providerId },
  });
  deps.log.info(
    { subtaskId: st.id, providerId: offer.providerId },
    "subtask reassigned to accepting freelancer",
  );
  return "reassigned";
}
