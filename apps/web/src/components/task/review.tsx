"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { taskEscrowAbi } from "@kazi/shared";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { openFile } from "@/lib/upload";
import { useTx } from "@/lib/tx";
import { isUserRejection } from "@/lib/tx-steps";
import type { Deliverable, TaskView } from "@/lib/types";
import { useNow } from "@/lib/use-task-events";
import { useKaziConfig } from "../config";
import { Dialog } from "../dialog";
import { Markdown } from "../output-viewer";
import { StepStatusBadge } from "../status";
import { Badge, Button, Field, Notice, Skeleton, Textarea } from "../ui";

export function useDeliverables(taskId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["task", taskId, "deliverables"],
    queryFn: () => api<{ steps: Deliverable[] }>(`/tasks/${taskId}/deliverables`),
    enabled,
  });
}

/** Accepted outputs per step. Agent output is untrusted: sanitized markdown, files via signed URLs. */
export function Deliverables({
  steps,
  onRevise,
  canRevise,
}: {
  steps: Deliverable[] | undefined;
  onRevise?: (index: number) => void;
  canRevise?: boolean;
}) {
  const t = useTranslations("task");
  if (!steps) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-4">
      {steps.map((s, i) => (
        <article
          key={s.index}
          className="overflow-hidden rounded-xl border border-ink/80 bg-surface shadow-stamp-sm"
        >
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-line px-5 py-3">
            <div className="min-w-0">
              <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
                {t("step", { n: i + 1 })}
              </p>
              <h3 className="font-display text-lg font-bold">{s.title}</h3>
              {s.provider ? <p className="text-sm text-muted">{s.provider.name}</p> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {s.score !== null ? (
                <Badge tone="info">{t("score", { score: Math.round(s.score) })}</Badge>
              ) : null}
              <StepStatusBadge status={s.status} />
            </div>
          </header>
          <div className="px-5 py-4">
            {s.output?.text ? (
              <Markdown>{s.output.text}</Markdown>
            ) : (
              <p className="text-sm text-muted">{t("noOutput")}</p>
            )}
            {s.output && s.output.files.length > 0 ? (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
                  {t("files")}
                </p>
                <ul className="flex flex-wrap gap-2">
                  {s.output.files.map((f, j) =>
                    f.fileId ? (
                      <li key={j}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void openFile(`/files/${f.fileId}/download-url`)}
                        >
                          <FileText className="size-4" />
                          {f.mime}
                          <Download className="size-3.5" />
                        </Button>
                      </li>
                    ) : null,
                  )}
                </ul>
              </div>
            ) : null}
          </div>
          {onRevise ? (
            <footer className="border-t border-dashed border-line px-5 py-3">
              {s.revisions > 0 ? (
                <span className="text-sm text-muted">{t("revisionUsed")}</span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canRevise || s.status !== "ACCEPTED"}
                  onClick={() => onRevise(s.index)}
                >
                  {t("revision")}
                </Button>
              )}
            </footer>
          ) : null}
        </article>
      ))}
    </div>
  );
}

/** DELIVERED: approve all, revise one step, or dispute; auto-approval countdown. */
export function ReviewPanel({ task }: { task: TaskView }) {
  const t = useTranslations("task");
  const locale = useLocale();
  const qc = useQueryClient();
  const now = useNow(30_000);
  const deliverables = useDeliverables(task.id, true);
  const [revising, setRevising] = useState<number | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const approve = useMutation({
    mutationFn: () => api(`/tasks/${task.id}/approve`, { method: "POST" }),
    onSuccess: () => {
      setDone(t("approved"));
      void qc.invalidateQueries({ queryKey: ["task", task.id] });
    },
  });
  const workSteps = deliverables.data?.steps ?? [];
  const position = new Map(workSteps.map((s, i) => [s.index, i + 1]));

  return (
    <section className="space-y-5">
      <div className="rounded-xl border border-ink bg-accent-soft p-5 shadow-stamp">
        <h2 className="font-display text-2xl font-extrabold">{t("reviewTitle")}</h2>
        <p className="mt-1 text-sm text-ink/80">{t("reviewIntro")}</p>
        {task.reviewUntil ? (
          <p className="mt-2 font-mono text-xs text-muted">
            {t("autoApprove", { time: relativeTime(task.reviewUntil, locale, now) })}
          </p>
        ) : null}
        {done ? (
          <Notice tone="ok" className="mt-3">
            {done}
          </Notice>
        ) : null}
        {approve.error ? (
          <Notice tone="bad" className="mt-3">
            {errorMessage(approve.error)}
          </Notice>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="ok"
            size="lg"
            loading={approve.isPending}
            disabled={Boolean(done)}
            onClick={() => {
              if (window.confirm(t("approveConfirm"))) approve.mutate();
            }}
          >
            {t("approve")}
          </Button>
          <Button variant="outline" size="lg" onClick={() => setDisputing(true)}>
            {t("dispute")}
          </Button>
        </div>
      </div>

      <h3 className="font-display text-xl font-bold">{t("deliverables")}</h3>
      <Deliverables steps={deliverables.data?.steps} onRevise={setRevising} canRevise={!done} />

      <RevisionDialog
        taskId={task.id}
        index={revising}
        position={revising !== null ? (position.get(revising) ?? revising + 1) : 0}
        onClose={() => setRevising(null)}
      />
      <DisputeDialog task={task} open={disputing} onClose={() => setDisputing(false)} />
    </section>
  );
}

function RevisionDialog({
  taskId,
  index,
  position,
  onClose,
}: {
  taskId: string;
  index: number | null;
  position: number;
  onClose: () => void;
}) {
  const t = useTranslations("task");
  const tc = useTranslations("common");
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () =>
      api(`/tasks/${taskId}/revision`, {
        method: "POST",
        body: { subtaskIndex: index, note: note.trim() },
      }),
    onSuccess: () => {
      setNote("");
      onClose();
      void qc.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });
  return (
    <Dialog
      open={index !== null}
      onClose={onClose}
      title={t("revisionTitle", { n: position })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            loading={send.isPending}
            disabled={note.trim().length < 10}
            onClick={() => send.mutate()}
          >
            {t("revisionSend")}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">{t("revisionHint")}</p>
      <Field label={t("revisionLabel")} htmlFor="revision-note">
        <Textarea
          id="revision-note"
          rows={5}
          maxLength={2_000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      {send.error ? (
        <Notice tone="bad" className="mt-3">
          {errorMessage(send.error)}
        </Notice>
      ) : null}
    </Dialog>
  );
}

/** Records the reason with the API, then opens the dispute onchain from the client's wallet. */
export function DisputeDialog({
  task,
  open,
  onClose,
}: {
  task: TaskView;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("task");
  const tc = useTranslations("common");
  const cfg = useKaziConfig();
  const qc = useQueryClient();
  const { write } = useTx();
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [stage, setStage] = useState<"idle" | "api" | "wallet" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!cfg.contracts.escrow) return;
    setError(null);
    try {
      setStage("api");
      await api(`/tasks/${task.id}/dispute`, {
        method: "POST",
        body: {
          reason: reason.trim(),
          evidence: evidence
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 10),
        },
      });
      setStage("wallet");
      await write({
        address: cfg.contracts.escrow,
        abi: taskEscrowAbi,
        functionName: "openDispute",
        args: [task.onchainId],
      });
      setStage("done");
      void qc.invalidateQueries({ queryKey: ["task", task.id] });
    } catch (err) {
      setStage("idle");
      if (!isUserRejection(err)) setError(errorMessage(err));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("disputeTitle")}
      footer={
        stage === "done" ? (
          <Button onClick={onClose}>{tc("close")}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button
              variant="danger"
              loading={stage === "api" || stage === "wallet"}
              disabled={reason.trim().length < 10}
              onClick={() => void submit()}
            >
              {t("disputeSend")}
            </Button>
          </>
        )
      }
    >
      {stage === "done" ? (
        <Notice tone="ok">{t("disputed")}</Notice>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t("disputeIntro")}</p>
          <Field label={t("disputeReason")} htmlFor="dispute-reason">
            <Textarea
              id="dispute-reason"
              rows={4}
              maxLength={4_000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Field label={t("disputeEvidence")} htmlFor="dispute-evidence">
            <Textarea
              id="dispute-evidence"
              rows={3}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </Field>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li className={stage === "api" ? "font-semibold text-ink" : ""}>{t("disputeStep1")}</li>
            <li className={stage === "wallet" ? "font-semibold text-ink" : ""}>
              {t("disputeStep2")}
            </li>
          </ol>
          {error ? <Notice tone="bad">{error}</Notice> : null}
        </div>
      )}
    </Dialog>
  );
}
