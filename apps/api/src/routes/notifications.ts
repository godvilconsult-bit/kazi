import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppServices } from "../app";
import { requireAuth } from "../auth/guards";
import { parse } from "../http/errors";

/** In-app notifications (bell + inbox). Written by the worker (`notify`). */

const listQuery = z.object({
  unread: z.enum(["1", "true"]).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const readSchema = z
  .object({ ids: z.array(z.string().min(1).max(64)).min(1).max(100).optional(), all: z.literal(true).optional() })
  .strict()
  .refine((v) => v.ids !== undefined || v.all === true, "ids or all is required");

export function notificationRoutes(s: AppServices) {
  return async function routes(app: FastifyInstance) {
    app.get("/notifications", async (req) => {
      const auth = requireAuth(req);
      const q = parse(listQuery, req.query);
      const [items, unread] = await Promise.all([
        s.prisma.notification.findMany({
          where: { userId: auth.userId, ...(q.unread ? { readAt: null } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: q.limit + 1,
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
          select: { id: true, type: true, title: true, body: true, link: true, readAt: true, createdAt: true },
        }),
        s.prisma.notification.count({ where: { userId: auth.userId, readAt: null } }),
      ]);
      const more = items.length > q.limit;
      const page = more ? items.slice(0, q.limit) : items;
      return { notifications: page, unread, nextCursor: more ? (page.at(-1)?.id ?? null) : null };
    });

    app.post("/notifications/read", async (req) => {
      const auth = requireAuth(req);
      const body = parse(readSchema, req.body);
      const { count } = await s.prisma.notification.updateMany({
        where: { userId: auth.userId, readAt: null, ...(body.all ? {} : { id: { in: body.ids ?? [] } }) },
        data: { readAt: new Date() },
      });
      return { marked: count };
    });
  };
}
