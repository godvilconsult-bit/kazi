import { useTranslations } from "next-intl";
import type { SubtaskStatus, TaskStatus } from "@kazi/shared";
import { Badge } from "./ui";

/** Task / step status chips. Usable from server and client components. */

const TASK_TONE: Record<TaskStatus, "neutral" | "accent" | "ok" | "warn" | "bad" | "info"> = {
  DRAFT: "neutral",
  QUOTED: "info",
  FUNDED: "accent",
  IN_PROGRESS: "accent",
  DELIVERED: "warn",
  COMPLETED: "ok",
  DISPUTED: "bad",
  RESOLVED: "ok",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  REFUNDED: "info",
  PARTIALLY_REFUNDED: "info",
};

const STEP_TONE: Record<SubtaskStatus, "neutral" | "accent" | "ok" | "warn" | "bad" | "info"> = {
  PENDING: "neutral",
  DISPATCHED: "accent",
  SUBMITTED: "info",
  EVALUATING: "info",
  ACCEPTED: "ok",
  REJECTED: "warn",
  FAILED: "bad",
  RELEASED: "ok",
  REFUNDED: "info",
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const t = useTranslations("status.task");
  return <Badge tone={TASK_TONE[status]}>{t(status)}</Badge>;
}

export function StepStatusBadge({ status }: { status: SubtaskStatus }) {
  const t = useTranslations("status.step");
  return <Badge tone={STEP_TONE[status]}>{t(status)}</Badge>;
}
