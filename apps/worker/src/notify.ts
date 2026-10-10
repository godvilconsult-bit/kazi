import type { PrismaClient } from "@kazi/db";

/**
 * In-app notifications (bell + inbox), decided 2026-10-09: no email for now. Every notification
 * goes through here, so an email/push channel can be added in one place later.
 */
export interface NotificationInput {
  type: string;
  title: string;
  body: string;
  link?: string;
}

export async function notify(
  prisma: PrismaClient,
  userId: string,
  n: NotificationInput,
): Promise<void> {
  await prisma.notification.create({
    data: {
      userId,
      type: n.type,
      title: n.title.slice(0, 140),
      body: n.body.slice(0, 1_000),
      link: n.link ?? null,
    },
  });
}

export async function notifyTaskClient(
  prisma: PrismaClient,
  taskId: string,
  n: Omit<NotificationInput, "link">,
): Promise<void> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { clientId: true } });
  if (task) await notify(prisma, task.clientId, { ...n, link: `/tasks/${taskId}` });
}
