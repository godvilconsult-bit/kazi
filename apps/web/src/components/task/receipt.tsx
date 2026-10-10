"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileDown, Star } from "lucide-react";
import { api, apiUrl, errorMessage } from "@/lib/api";
import type { TaskView } from "@/lib/types";
import { cn } from "@/lib/cn";
import { TxLink, Usdc } from "../money";
import { StepStatusBadge } from "../status";
import { Button, Notice, Textarea, buttonClass } from "../ui";

/** COMPLETED / closed tasks: what was paid or refunded, with explorer links and the invoice. */
export function Receipt({ task }: { task: TaskView }) {
  const t = useTranslations("task");
  const steps = task.subtasks ?? [];
  return (
    <div className="overflow-hidden rounded-xl border border-ink bg-surface shadow-stamp">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-line px-5 py-4">
        <h2 className="font-display text-xl font-bold">{t("receiptTitle")}</h2>
        {task.fundTxHash ? (
          <a href={apiUrl(`/tasks/${task.id}/invoice.pdf`)} target="_blank" rel="noopener noreferrer" className={buttonClass("outline", "sm")}>
            <FileDown className="size-4" />
            {t("invoice")}
          </a>
        ) : null}
      </div>
      <ol className="divide-y divide-dashed divide-line">
        {steps.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
            <div className="min-w-0">
              <p className="font-semibold">{s.kind === "SERVICE_FEE" ? t("serviceFee") : s.title}</p>
              {s.provider && s.kind === "WORK" ? <p className="text-muted">{s.provider.name}</p> : null}
            </div>
            <div className="flex items-center gap-3">
              {s.releaseTxHash ? <TxLink hash={s.releaseTxHash} label={t("paid")} /> : null}
              {s.refundTxHash ? <TxLink hash={s.refundTxHash} label={t("refunded")} /> : null}
              {!s.releaseTxHash && !s.refundTxHash ? <StepStatusBadge status={s.status} /> : null}
              <Usdc value={s.amount} />
            </div>
          </li>
        ))}
      </ol>
      <div className="flex items-baseline justify-between border-t-2 border-ink px-5 py-4">
        <span className="font-display font-bold">{t("total")}</span>
        <Usdc value={task.totalAmount} strong className="text-xl" />
      </div>
      {task.fundTxHash ? (
        <div className="border-t border-dashed border-line px-5 py-3 text-sm text-muted">
          {t("fundTx")}: <TxLink hash={task.fundTxHash} />
        </div>
      ) : null}
    </div>
  );
}

export function RatingForm({ task }: { task: TaskView }) {
  const t = useTranslations("task");
  const qc = useQueryClient();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const send = useMutation({
    mutationFn: () => api(`/tasks/${task.id}/rate`, { method: "POST", body: { rating, ...(comment.trim() ? { comment: comment.trim() } : {}) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["task", task.id] }),
  });
  if (task.rating) {
    return (
      <div className="rounded-xl border border-line bg-surface p-5">
        <p className="text-sm font-semibold">{t("yourRating")}</p>
        <Stars value={task.rating} />
        {task.ratingComment ? <p className="mt-2 text-sm text-muted">{task.ratingComment}</p> : null}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-ink bg-surface p-5 shadow-stamp-sm">
      <h3 className="font-display text-lg font-bold">{t("rateTitle")}</h3>
      <div className="mt-2 flex gap-1" role="radiogroup" aria-label={t("rateTitle")}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n}/5`}
            className="rounded p-1 text-accent hover:scale-110"
            onClick={() => setRating(n)}
          >
            <Star className="size-7" fill={n <= rating ? "currentColor" : "none"} />
          </button>
        ))}
      </div>
      <Textarea className="mt-3" rows={3} maxLength={2_000} placeholder={t("rateComment")} value={comment} onChange={(e) => setComment(e.target.value)} />
      {send.error ? <Notice tone="bad" className="mt-3">{errorMessage(send.error)}</Notice> : null}
      <Button className="mt-3" disabled={rating === 0} loading={send.isPending} onClick={() => send.mutate()}>
        {t("rateSend")}
      </Button>
    </div>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <span className="mt-1 flex text-accent" aria-label={`${value}/5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={cn("size-5")} fill={n <= value ? "currentColor" : "none"} />
      ))}
    </span>
  );
}
