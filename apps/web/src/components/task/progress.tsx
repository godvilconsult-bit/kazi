"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Bot, Cpu, UserRound } from "lucide-react";
import { relativeTime } from "@/lib/format";
import type { SubtaskView, TaskEventView } from "@/lib/types";
import { cn } from "@/lib/cn";
import { Usdc, TxLink } from "../money";
import { StepStatusBadge } from "../status";

/** One card per step: provider, status, attempts, live progress from SSE, payout tx. */
export function StepTimeline({ steps, events }: { steps: SubtaskView[]; events: TaskEventView[] }) {
  const t = useTranslations("task");
  const work = steps.filter((s) => s.kind === "WORK");
  const progress = new Map<number, number>();
  for (const e of events) {
    if (
      e.type === "SUBTASK_PROGRESS" &&
      typeof e.data["index"] === "number" &&
      typeof e.data["progress"] === "number"
    ) {
      progress.set(e.data["index"], e.data["progress"]);
    }
  }
  return (
    <ol className="relative space-y-3 before:absolute before:top-4 before:bottom-4 before:start-[15px] before:w-px before:bg-line">
      {work.map((s, i) => {
        const p = progress.get(s.index);
        const working =
          s.status === "DISPATCHED" || s.status === "SUBMITTED" || s.status === "EVALUATING";
        const done = s.status === "ACCEPTED" || s.status === "RELEASED";
        return (
          <li key={s.id} className="relative flex gap-3">
            <span
              className={cn(
                "z-10 grid size-8 shrink-0 place-items-center rounded-full border font-mono text-xs font-bold",
                done
                  ? "border-ok bg-ok text-white"
                  : working
                    ? "border-accent bg-accent text-accent-ink"
                    : s.status === "FAILED"
                      ? "border-bad bg-bad-soft text-bad"
                      : "border-line bg-surface text-muted",
              )}
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-semibold">{s.title}</p>
                <StepStatusBadge status={s.status} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                {s.provider ? (
                  <Link
                    href={`/agents/${s.provider.slug}`}
                    className="inline-flex items-center gap-1 hover:text-ink"
                  >
                    {s.provider.kind === "HUMAN" ? (
                      <UserRound className="size-3.5" />
                    ) : s.provider.hosting === "KAZI" ? (
                      <Cpu className="size-3.5" />
                    ) : (
                      <Bot className="size-3.5" />
                    )}
                    {s.provider.name}
                  </Link>
                ) : null}
                <Usdc value={s.amount} className="text-xs" />
                {s.attempts > 1 ? (
                  <span className="font-mono text-xs">{t("attempt", { n: s.attempts })}</span>
                ) : null}
                {s.status === "PENDING" && s.dependsOn.length > 0 ? (
                  <span className="text-xs">
                    {t("waitingFor", { steps: s.dependsOn.map((d) => d + 1).join(", ") })}
                  </span>
                ) : null}
              </div>
              {working && p !== undefined ? (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${Math.round(p * 100)}%` }}
                  />
                </div>
              ) : working ? (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/60" />
                </div>
              ) : null}
              {s.releaseTxHash ? (
                <TxLink hash={s.releaseTxHash} label={t("paid")} className="mt-2" />
              ) : null}
              {s.refundTxHash ? (
                <TxLink hash={s.refundTxHash} label={t("refunded")} className="mt-2" />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The audit log, newest first, in plain language. */
export function Activity({ events }: { events: TaskEventView[] }) {
  const t = useTranslations("task");
  const te = useTranslations("events");
  const locale = useLocale();
  if (events.length === 0) return <p className="text-sm text-muted">{t("noActivity")}</p>;
  const label = (e: TaskEventView) => {
    const index = typeof e.data["index"] === "number" ? e.data["index"] + 1 : "?";
    const percent =
      typeof e.data["progress"] === "number" ? Math.round(e.data["progress"] * 100) : 0;
    return te.has(e.type as never)
      ? te(e.type as never, { index, percent, type: e.type } as never)
      : te("other", { type: e.type });
  };
  return (
    <ol className="space-y-2 text-sm">
      {[...events]
        .reverse()
        .slice(0, 40)
        .map((e) => (
          <li
            key={e.id}
            className="flex items-baseline justify-between gap-3 border-b border-dashed border-line/70 pb-2 last:border-0"
          >
            <span>{label(e)}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted">
              {relativeTime(e.createdAt, locale)}
            </span>
          </li>
        ))}
    </ol>
  );
}
