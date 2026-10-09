import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Prisma } from "@kazi/db";
import { type Task } from "@kazi/db";
import {
  capabilityOutputSchema,
  createTaskSchema,
  jobIds,
  listTasksQuerySchema,
  rateTaskSchema,
  storedQuoteSchema,
  TASK_SPEEDS,
  taskOnchainId,
  transition,
  IllegalTransitionError,
  type TaskEvent as TaskTransitionEvent,
  type TaskStatus,
} from "@kazi/shared";
import type { AppServices } from "../app";
import { requireAuth } from "../auth/guards";
import { badRequest, invalidState, notFound, parse } from "../http/errors";
import { renderInvoice } from "../invoice";
import { serializeTask, serializeTaskEvent } from "./serializers";

const MIN_DEADLINE_MS = 60 * 60 * 1000; // 1 hour
const MAX_DEADLINE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const SSE_POLL_MS = 2_000;
const SSE_HEARTBEAT_MS = 15_000;
const idParams = z.object({ id: z.string().min(1).max(64) });
const revisionSchema = z.object({
  subtaskIndex: z.number().int().min(0),
  note: z.string().trim().min(10).max(2_000),
}).strict();
const disputeSchema = z.object({
  reason: z.string().trim().min(10).max(4_000),
  evidence: z.array(z.string().max(2_000)).max(10).default([]),
}).strict();
/** Optional: switch Economy/Express before (re-)quoting (docs/11-HOSTED-AGENTS.md §3). */
const quoteRequestSchema = z.object({ speed: z.enum(TASK_SPEEDS).optional() }).strict();

export function taskRoutes(s: AppServices) {

  /** Load a task the caller may see (its client, or an admin). 404 otherwise — don't leak existence. */
  async function loadOwnTask(req: FastifyRequest, withSubtasks = false) {
    const auth = requireAuth(req);
    const { id } = parse(idParams, req.params);
    const task = await s.prisma.task.findUnique({
      where: { id },
      include: { subtasks: withSubtasks ? { orderBy: { index: "asc" } } : false },
    });
    if (!task || (task.clientId !== auth.userId && !auth.roles.includes("ADMIN")))
      throw notFound("Task");
    return { auth, task };
  }

  /** All status changes go through the shared state machine + an audit TaskEvent, atomically. */
  async function applyTransition(
    task: Task,
    event: TaskTransitionEvent,
    data: Prisma.TaskUpdateInput = {},
  ) {
    let next: TaskStatus;
    try {
      next = transition("task", task.status, event);
    } catch (err) {
      if (err instanceof IllegalTransitionError)
        throw invalidState(`Cannot ${event.toLowerCase()} a ${task.status} task`);
      throw err;
    }
    // Optimistic concurrency: only update if the status is still what we read.
    const [updated] = await s.prisma.$transaction([
      s.prisma.task.updateMany({
        where: { id: task.id, status: task.status },
        data: { ...data, status: next },
      }),
      s.prisma.taskEvent.create({
        data: { taskId: task.id, type: `STATUS_${next}`, data: { from: task.status, event } },
      }),
    ]);
    if (updated.count === 0) throw invalidState("Task changed concurrently, retry");
    return next;
  }

  return async function routes(app: FastifyInstance) {
    app.post(
      "/tasks",
      { preHandler: s.limiter.guard("tasks-create", 30, 60) },
      async (req, reply) => {
        const auth = requireAuth(req);
        const body = parse(createTaskSchema, req.body);

        const deadline = new Date(body.deadline);
        const delta = deadline.getTime() - Date.now();
        if (delta < MIN_DEADLINE_MS || delta > MAX_DEADLINE_MS) {
          throw badRequest("deadline must be between 1 hour and 90 days from now");
        }

        if (body.attachments.length > 0) {
          const owned = await s.prisma.fileObject.count({
            where: { id: { in: body.attachments }, ownerId: auth.userId, status: "UPLOADED" },
          });
          if (owned !== new Set(body.attachments).size) {
            throw badRequest("attachments must be your own uploaded files");
          }
        }

        const id = randomUUID();
        const task = await s.prisma.task.create({
          data: {
            id,
            onchainId: taskOnchainId(id),
            clientId: auth.userId,
            title: body.title,
            description: body.description,
            attachments: [...new Set(body.attachments)],
            budgetMax: body.budgetMax ?? null,
            deadline,
            speed: body.speed,
            events: { create: { type: "CREATED", data: {} } },
          },
        });
        return reply.status(201).send({ task: serializeTask(task) });
      },
    );

    app.get("/tasks", async (req) => {
      const auth = requireAuth(req);
      const q = parse(listTasksQuerySchema, req.query);
      const rows = await s.prisma.task.findMany({
        where: { clientId: auth.userId, ...(q.status ? { status: q.status } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, q.limit);
      return {
        tasks: page.map((t) => serializeTask(t)),
        nextCursor: rows.length > q.limit ? page.at(-1)?.id : null,
      };
    });

    app.get("/tasks/:id", async (req) => {
      const { task } = await loadOwnTask(req, true);
      return { task: serializeTask(task) };
    });

    /** Ask the router for a quote (06-ROUTER). Returns at once; poll GET /tasks/:id/quote or the SSE stream. */
    app.post(
      "/tasks/:id/quote",
      {
        preHandler: [
          s.limiter.guard("tasks-quote", 20, 60),
          s.limiter.guard("tasks-quote-daily", s.env.QUOTE_DAILY_LIMIT, 86_400),
        ],
      },
      async (req, reply) => {
        const { task } = await loadOwnTask(req);
        const { speed } = parse(quoteRequestSchema, req.body ?? {});
        const current = task.quote ? storedQuoteSchema.safeParse(task.quote) : undefined;
        const speedChange = speed !== undefined && speed !== task.speed;
        const live =
          !speedChange &&
          task.status === "QUOTED" &&
          current?.success &&
          current.data.outcome === "QUOTED" &&
          new Date(current.data.expiresAt) > new Date();
        if (live) return reply.status(200).send({ status: "quoted", version: task.quoteVersion });
        if (!["DRAFT", "QUOTED", "EXPIRED"].includes(task.status)) {
          throw invalidState(`A ${task.status} task can't be re-quoted`);
        }
        if (speedChange) {
          const changed = await s.prisma.task.updateMany({
            where: { id: task.id, status: task.status, quoteVersion: task.quoteVersion },
            data: { speed },
          });
          if (changed.count === 0) throw invalidState("Task changed concurrently, retry");
        }
        const version = task.quoteVersion + 1;
        await s.jobs.enqueue(
          "router",
          "quote",
          { taskId: task.id },
          jobIds.quote(task.id, version),
        );
        return reply.status(202).send({ status: "queued", version });
      },
    );

    /** The latest quote, as the client sees it (router-internal fallbacks removed). */
    app.get("/tasks/:id/quote", async (req) => {
      const { task } = await loadOwnTask(req);
      const parsed = task.quote ? storedQuoteSchema.safeParse(task.quote) : undefined;
      if (!parsed?.success) return { quote: null, status: task.status };
      const q = parsed.data;
      if (q.outcome !== "QUOTED") return { quote: q, status: task.status };
      return {
        status: task.status,
        quote: {
          ...q,
          steps: q.steps.map(({ fallbackProviderIds: _hidden, ...step }) => step),
          expired: new Date(q.expiresAt) <= new Date(),
        },
      };
    });

    /** Everything the wallet needs for `createAndFund` (04-BACKEND-API §5). Only for the wallet the quote was signed for. */
    app.get("/tasks/:id/fund-params", async (req) => {
      const { auth, task } = await loadOwnTask(req);
      const parsed = task.quote ? storedQuoteSchema.safeParse(task.quote) : undefined;
      if (task.status !== "QUOTED" || !parsed?.success || parsed.data.outcome !== "QUOTED") {
        throw invalidState("This task has no fundable quote");
      }
      const q = parsed.data;
      if (new Date(q.expiresAt) <= new Date())
        throw invalidState("The quote expired; request a new one");
      if (q.client.toLowerCase() !== auth.wallet.toLowerCase())
        throw invalidState("The quote was signed for a different wallet");
      if (!s.escrowAddress) throw invalidState("Escrow is not deployed on this network");
      return {
        escrowAddress: s.escrowAddress,
        usdcAddress: s.chain.usdcAddress,
        quote: q.onchain,
        quoteSig: q.signature,
        total: q.total,
        expiresAt: q.expiresAt,
      };
    });

    /** Client accepts the delivery; the payout worker then releases the milestones onchain. */
    app.post("/tasks/:id/approve", async (req) => {
      const { task } = await loadOwnTask(req);
      if (task.status !== "DELIVERED")
        throw invalidState(`Only a delivered task can be approved (this one is ${task.status})`);
      const updated = await s.prisma.task.updateMany({
        where: { id: task.id, status: "DELIVERED", approvedAt: null },
        data: { approvedAt: new Date() },
      });
      if (updated.count === 1) {
        await s.prisma.taskEvent.create({
          data: { taskId: task.id, type: "CLIENT_APPROVED", data: {} },
        });
      }
      return { ok: true };
    });

    /** Accepted outputs per step (sanitized client-side; agent output is untrusted, CLAUDE.md rule 7). */
    app.get("/tasks/:id/deliverables", async (req) => {
      const { task } = await loadOwnTask(req);
      const subtasks = await s.prisma.subtask.findMany({
        where: { taskId: task.id, kind: "WORK" },
        orderBy: { index: "asc" },
        include: {
          provider: { select: { name: true, slug: true } },
          submissions: { where: { accepted: true }, orderBy: { attempt: "desc" }, take: 1 },
        },
      });
      return {
        steps: subtasks.map((st) => {
          const sub = st.submissions[0];
          const out = sub ? capabilityOutputSchema.safeParse(sub.output) : undefined;
          return {
            index: st.index,
            title: st.title,
            status: st.status,
            provider: st.provider,
            revisions: st.revisions,
            score: sub?.score ?? null,
            output: out?.success
              ? {
                  text: out.data.text ?? null,
                  // Kazi-stored files are downloaded via GET /files/:id/download-url.
                  files: (out.data.files ?? []).map((f) => ({
                    fileId: /^kazi:\/\/files\/(.+)$/.exec(f.url)?.[1] ?? null,
                    mime: f.mime,
                    sha256: f.sha256,
                  })),
                }
              : null,
          };
        }),
      };
    });

    /** During review, send one accepted step back with the client's note (one free revision per step). */
    app.post("/tasks/:id/revision", async (req) => {
      const { task } = await loadOwnTask(req);
      const body = parse(revisionSchema, req.body);
      if (task.status !== "DELIVERED") throw invalidState("Revisions can only be requested during review");
      if (task.deadline <= new Date()) throw invalidState("The deadline has passed; approve or dispute instead");
      const st = await s.prisma.subtask.findUnique({
        where: { taskId_index: { taskId: task.id, index: body.subtaskIndex } },
        include: { submissions: { where: { accepted: true }, orderBy: { attempt: "desc" }, take: 1 } },
      });
      if (!st || st.kind !== "WORK") throw notFound("Step");
      if (st.status !== "ACCEPTED") throw invalidState("Only an accepted, unpaid step can be revised");
      if (st.revisions >= 1) throw invalidState("This step has already been revised once");
      const accepted = st.submissions[0];
      await s.prisma.$transaction(async (tx) => {
        const moved = await tx.task.updateMany({
          where: { id: task.id, status: "DELIVERED" },
          data: { status: transition("task", "DELIVERED", "REQUEST_REVISION"), reviewUntil: null },
        });
        if (moved.count !== 1) throw invalidState("Task changed concurrently, retry");
        await tx.subtask.update({
          where: { id: st.id },
          data: { status: transition("subtask", "ACCEPTED", "REVISE"), revisions: { increment: 1 } },
        });
        if (accepted) {
          // The next attempt reads this as its feedback (executor: previous attempt's evaluation).
          const prev = (accepted.evaluation ?? {}) as Record<string, unknown>;
          await tx.submission.update({
            where: { id: accepted.id },
            data: { evaluation: { ...prev, feedback: `The client asked for a revision: ${body.note}` } },
          });
        }
        await tx.taskEvent.create({
          data: { taskId: task.id, type: "REVISION_REQUESTED", data: { index: st.index } },
        });
      });
      return { status: "IN_PROGRESS" };
    });

    /**
     * Record why the client disputes the work. The dispute itself is opened onchain by the client's
     * wallet (TaskEscrow.openDispute); the indexer moves the task to DISPUTED.
     */
    app.post("/tasks/:id/dispute", async (req) => {
      const { task } = await loadOwnTask(req);
      const body = parse(disputeSchema, req.body);
      if (!["FUNDED", "IN_PROGRESS", "DELIVERED", "DISPUTED"].includes(task.status)) {
        throw invalidState(`A ${task.status} task can't be disputed`);
      }
      const dispute = await s.prisma.dispute.upsert({
        where: { taskId: task.id },
        update: { reason: body.reason, evidence: body.evidence },
        create: { taskId: task.id, reason: body.reason, evidence: body.evidence },
      });
      await s.prisma.taskEvent.create({ data: { taskId: task.id, type: "DISPUTE_REASON", data: {} } });
      return { dispute: { id: dispute.id, status: dispute.status } };
    });

    /** Invoice/receipt PDF for a funded task. */
    app.get("/tasks/:id/invoice.pdf", async (req, reply) => {
      const { task } = await loadOwnTask(req);
      if (!task.fundTxHash) throw invalidState("The task hasn't been funded yet");
      const client = await s.prisma.user.findUniqueOrThrow({ where: { id: task.clientId }, select: { wallet: true } });
      const subtasks = await s.prisma.subtask.findMany({
        where: { taskId: task.id },
        orderBy: { index: "asc" },
        include: { provider: { select: { name: true } } },
      });
      const pdf = await renderInvoice({
        task,
        clientWallet: client.wallet,
        subtasks,
        explorerUrl: s.chain.explorerUrl ?? null,
        decimals: await s.usdcDecimals(),
      });
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `attachment; filename="kazi-invoice-${task.id.slice(0, 8)}.pdf"`)
        .send(Buffer.from(pdf));
    });

    app.post("/tasks/:id/cancel", async (req) => {
      const { task } = await loadOwnTask(req);
      const status = await applyTransition(task, "CANCEL");
      return { status };
    });

    app.post("/tasks/:id/rate", async (req) => {
      const { task } = await loadOwnTask(req);
      const body = parse(rateTaskSchema, req.body);
      if (task.status !== "COMPLETED") throw invalidState("Only completed tasks can be rated");
      const updated = await s.prisma.task.updateMany({
        where: { id: task.id, rating: null },
        data: { rating: body.rating, ratingComment: body.comment ?? null },
      });
      if (updated.count === 0) throw invalidState("Task already rated");
      await s.prisma.taskEvent.create({
        data: { taskId: task.id, type: "RATED", data: { rating: body.rating } },
      });
      // Client ratings are 30% of each provider's reputation (06-ROUTER §6).
      const providers = await s.prisma.subtask.findMany({
        where: { taskId: task.id, kind: "WORK", providerId: { not: null } },
        select: { providerId: true },
        distinct: ["providerId"],
      });
      for (const p of providers) {
        if (!p.providerId) continue;
        await s.jobs.enqueue(
          "executor",
          "reputation",
          { providerId: p.providerId },
          jobIds.reputation(p.providerId, Date.now()),
        );
      }
      return { ok: true };
    });

    /** Server-Sent Events: replays the audit log, then streams new events. */
    app.get("/tasks/:id/events", async (req, reply) => {
      const { task } = await loadOwnTask(req);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        ...(reply.getHeader("access-control-allow-origin")
          ? {
              "access-control-allow-origin": String(reply.getHeader("access-control-allow-origin")),
              "access-control-allow-credentials": "true",
            }
          : {}),
      });

      let lastSeen = new Date(0);
      let lastId = "";
      let closed = false;
      const send = async () => {
        const events = await s.prisma.taskEvent.findMany({
          where: {
            taskId: task.id,
            OR: [{ createdAt: { gt: lastSeen } }, { createdAt: lastSeen, id: { gt: lastId } }],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 100,
        });
        for (const e of events) {
          if (closed) return;
          res.write(`id: ${e.id}\nevent: task\ndata: ${JSON.stringify(serializeTaskEvent(e))}\n\n`);
          lastSeen = e.createdAt;
          lastId = e.id;
        }
      };

      await send();
      const poll = setInterval(() => {
        send().catch((err: unknown) => req.log.warn({ err, taskId: task.id }, "sse poll failed"));
      }, SSE_POLL_MS);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
      req.raw.on("close", () => {
        closed = true;
        clearInterval(poll);
        clearInterval(heartbeat);
      });
    });
  };
}
