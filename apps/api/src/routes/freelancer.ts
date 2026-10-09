import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Prisma } from "@kazi/db";
import { capabilityOutputSchema, jobIds, providerPayout } from "@kazi/shared";
import type { AppServices } from "../app";
import { requireAuth } from "../auth/guards";
import { badRequest, invalidState, notFound, parse } from "../http/errors";

/**
 * Human freelancer flow (docs/05-AGENT-SPEC.md §8): offers → accept/decline → work view → submit.
 * The worker creates and widens offers (executor/offers.ts) and reassigns the milestone onchain when
 * someone other than the router's pick accepts. A submission goes through the same evaluator as
 * agent output.
 */

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;
const KAZI_FILE = /^kazi:\/\/files\/([A-Za-z0-9_-]+)$/;
const subtaskParams = z.object({ subtaskId: z.string().min(1).max(64) });
const idParams = z.object({ id: z.string().min(1).max(64) });
const fileParams = z.object({ id: z.string().min(1).max(64), fileId: z.string().min(1).max(64) });
const submitSchema = z
  .object({
    text: z.string().max(500_000).optional(),
    files: z.array(z.string().min(1).max(64)).max(20).default([]),
  })
  .strict()
  .refine((v) => (v.text?.trim().length ?? 0) > 0 || v.files.length > 0, "text or files is required");

export function freelancerRoutes(s: AppServices) {
  /** The caller's accepted offer on this subtask's current attempt, or 404. */
  async function loadAssignment(req: FastifyRequest) {
    const auth = requireAuth(req);
    const { id } = parse(idParams, req.params);
    const st = await s.prisma.subtask.findUnique({
      where: { id },
      include: {
        task: true,
        offers: { where: { status: "ACCEPTED", provider: { ownerId: auth.userId } } },
      },
    });
    const offer = st?.offers.find((o) => o.attempt === st.attempts);
    if (!st || !offer) throw notFound("Assignment");
    return { auth, st, offer };
  }

  /** Files a freelancer may open for a step: the client's attachments + outputs of the steps it depends on. */
  async function workFiles(st: { taskId: string; dependsOn: number[]; task: { attachments: Prisma.JsonValue } }) {
    const ids = Array.isArray(st.task.attachments)
      ? st.task.attachments.filter((v): v is string => typeof v === "string")
      : [];
    const deps = st.dependsOn.length
      ? await s.prisma.submission.findMany({
          where: { accepted: true, subtask: { taskId: st.taskId, index: { in: st.dependsOn } } },
          include: { subtask: { select: { index: true, title: true } } },
          orderBy: { subtask: { index: "asc" } },
        })
      : [];
    const sections: { title: string; text: string }[] = [];
    for (const d of deps) {
      const out = capabilityOutputSchema.safeParse(d.output);
      if (!out.success) continue;
      if (out.data.text) sections.push({ title: `Step ${d.subtask.index + 1}: ${d.subtask.title}`, text: out.data.text });
      for (const f of out.data.files ?? []) {
        const m = KAZI_FILE.exec(f.url);
        if (m?.[1]) ids.push(m[1]);
      }
    }
    const files = await s.prisma.fileObject.findMany({
      where: { id: { in: ids }, status: "UPLOADED" },
      select: { id: true, filename: true, mime: true, size: true },
    });
    return { sections, files };
  }

  return async function routes(app: FastifyInstance) {
    /** Open offers and current assignments for the caller's freelancer profiles. */
    app.get("/freelancer/offers", async (req) => {
      const auth = requireAuth(req);
      const now = new Date();
      const offers = await s.prisma.offer.findMany({
        where: {
          provider: { ownerId: auth.userId, kind: "HUMAN" },
          OR: [
            { status: "OFFERED", expiresAt: { gt: now } },
            { status: "ACCEPTED", subtask: { status: { in: ["DISPATCHED", "SUBMITTED", "EVALUATING"] } } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { subtask: { include: { task: { select: { title: true, deadline: true, feeBps: true } } } } },
      });
      return {
        offers: offers
          .filter((o) => o.attempt === o.subtask.attempts)
          .map((o) => ({
            id: o.id,
            subtaskId: o.subtaskId,
            status: o.status,
            wave: o.wave,
            expiresAt: o.expiresAt,
            taskTitle: o.subtask.task.title,
            title: o.subtask.title,
            capability: o.subtask.capability,
            instructions: o.subtask.instructions,
            acceptance: o.subtask.acceptance,
            payout: providerPayout(BigInt(o.subtask.amount), o.subtask.task.feeBps ?? 0).toString(),
            dueAt: o.subtask.timeoutAt ?? o.subtask.task.deadline,
            subtaskStatus: o.subtask.status,
          })),
      };
    });

    /** First qualified freelancer to accept gets the work (rows are locked per subtask). */
    app.post("/freelancer/offers/:subtaskId/accept", async (req) => {
      const auth = requireAuth(req);
      const { subtaskId } = parse(subtaskParams, req.params);
      const now = new Date();
      const offerId = await s.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Subtask" WHERE id = ${subtaskId} FOR UPDATE`;
        const st = await tx.subtask.findUnique({ where: { id: subtaskId } });
        const offer = st
          ? await tx.offer.findFirst({
              where: { subtaskId, attempt: st.attempts, provider: { ownerId: auth.userId } },
              orderBy: { createdAt: "desc" },
            })
          : null;
        if (!st || !offer) throw notFound("Offer");
        if (offer.status === "ACCEPTED") return offer.id; // idempotent
        if (offer.status !== "OFFERED" || st.status !== "DISPATCHED") throw invalidState("This offer is no longer open");
        if (offer.expiresAt <= now) throw invalidState("This offer has expired");
        const taken = await tx.offer.count({ where: { subtaskId, attempt: st.attempts, status: "ACCEPTED" } });
        if (taken > 0) throw invalidState("Someone else accepted this work first");
        await tx.offer.update({ where: { id: offer.id }, data: { status: "ACCEPTED", respondedAt: now } });
        await tx.offer.updateMany({
          where: { subtaskId, attempt: st.attempts, status: "OFFERED" },
          data: { status: "WITHDRAWN" },
        });
        await tx.taskEvent.create({
          data: { taskId: st.taskId, type: "OFFER_ACCEPTED", data: { subtaskId, wave: offer.wave } },
        });
        return offer.id;
      });
      // The worker moves the milestone onchain if the router picked someone else.
      await s.jobs.enqueue("executor", "offerAccepted", { offerId }, jobIds.offerAccepted(offerId));
      return { status: "ACCEPTED" };
    });

    app.post("/freelancer/offers/:subtaskId/decline", async (req) => {
      const auth = requireAuth(req);
      const { subtaskId } = parse(subtaskParams, req.params);
      const moved = await s.prisma.offer.updateMany({
        where: { subtaskId, status: "OFFERED", provider: { ownerId: auth.userId } },
        data: { status: "DECLINED", respondedAt: new Date() },
      });
      if (moved.count === 0) throw notFound("Offer");
      return { status: "DECLINED" };
    });

    /** Everything needed to do the work. Only after accepting. */
    app.get("/freelancer/subtasks/:id", async (req) => {
      const { st, offer } = await loadAssignment(req);
      const { sections, files } = await workFiles(st);
      const prev =
        st.attempts > 1
          ? await s.prisma.submission.findUnique({
              where: { subtaskId_attempt: { subtaskId: st.id, attempt: st.attempts - 1 } },
              select: { evaluation: true },
            })
          : null;
      const feedback = (prev?.evaluation as { feedback?: unknown } | null)?.feedback;
      return {
        subtask: {
          id: st.id,
          status: st.status,
          attempt: st.attempts,
          title: st.title,
          capability: st.capability,
          instructions: st.instructions,
          acceptance: st.acceptance,
          dueAt: st.timeoutAt ?? st.task.deadline,
          assigned: st.providerId === offer.providerId,
          feedback: typeof feedback === "string" ? feedback : null,
        },
        request: { title: st.task.title, description: st.task.description },
        previousSteps: sections,
        files,
      };
    });

    app.get("/freelancer/subtasks/:id/files/:fileId/download-url", async (req) => {
      const { fileId } = parse(fileParams, req.params);
      const { st } = await loadAssignment(req);
      const { files } = await workFiles(st);
      if (!files.some((f) => f.id === fileId)) throw notFound("File");
      const file = await s.prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } });
      return {
        url: await s.storage.createDownloadUrl(file.key, DOWNLOAD_URL_TTL_SECONDS),
        expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      };
    });

    /**
     * Hand in the work. Files are the freelancer's own uploads (POST /files/presign); they become
     * the client's files, then the submission is evaluated like agent output.
     */
    app.post(
      "/freelancer/subtasks/:id/submit",
      { preHandler: s.limiter.guard("freelancer-submit", 10, 60) },
      async (req) => {
        const { auth, st, offer } = await loadAssignment(req);
        const body = parse(submitSchema, req.body);
        if (st.status !== "DISPATCHED") throw invalidState("This step isn't waiting for work");
        if (st.providerId !== offer.providerId) {
          throw invalidState("Your assignment is still being confirmed onchain — try again in a minute");
        }
        const rows = await s.prisma.fileObject.findMany({ where: { id: { in: body.files } } });
        if (rows.length !== new Set(body.files).size) throw badRequest("unknown file");
        const files: { url: string; sha256: string; mime: string }[] = [];
        for (const f of rows) {
          if (f.ownerId !== auth.userId) throw badRequest("unknown file");
          if (f.status !== "UPLOADED") throw badRequest(`${f.filename} hasn't finished uploading`);
          let sha256 = f.sha256 && /^[0-9a-f]{64}$/.test(f.sha256) ? f.sha256 : null;
          if (!sha256) {
            sha256 = createHash("sha256").update(await s.storage.download(f.key, MAX_FILE_BYTES)).digest("hex");
          }
          files.push({ url: `kazi://files/${f.id}`, sha256, mime: f.mime });
        }
        // Deliverables belong to the client (they download them via /files/:id/download-url).
        await s.prisma.$transaction(
          rows.map((f) =>
            s.prisma.fileObject.update({
              where: { id: f.id },
              data: {
                ownerId: st.task.clientId,
                source: "freelancer",
                sha256: files.find((x) => x.url.endsWith(f.id))?.sha256 ?? null,
              },
            }),
          ),
        );
        const text = body.text?.trim();
        const output = { ...(text ? { text } : {}), ...(files.length ? { files } : {}) };
        const receivedAt = new Date();
        await s.jobs.enqueue(
          "executor",
          "agentResult",
          { subtaskId: st.id, attempt: st.attempts, callback: { status: "completed", output }, receivedAt: receivedAt.toISOString() },
          jobIds.agentResult(st.id, st.attempts, "completed", receivedAt.getTime()),
        );
        return { status: "SUBMITTED" };
      },
    );
  };
}
