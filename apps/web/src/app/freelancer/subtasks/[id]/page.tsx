"use client";

import { use, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatBytes, relativeTime } from "@/lib/format";
import { openFile } from "@/lib/upload";
import type { FileView, FreelancerWork } from "@/lib/types";
import { PageBody } from "@/components/container";
import { FileUpload } from "@/components/file-upload";
import { Markdown } from "@/components/output-viewer";
import { RequireAuth } from "@/components/require-auth";
import { StepStatusBadge } from "@/components/status";
import { Button, Card, EmptyState, Field, Notice, PageHeader, Skeleton, Textarea } from "@/components/ui";

export default function FreelancerWorkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <PageBody>
      <RequireAuth>
        <Work id={id} />
      </RequireAuth>
    </PageBody>
  );
}

function Work({ id }: { id: string }) {
  const t = useTranslations("freelancer");
  const tc = useTranslations("common");
  const locale = useLocale();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["freelancer", "work", id],
    queryFn: () => api<FreelancerWork>(`/freelancer/subtasks/${id}`),
    refetchInterval: (query) => (query.state.data && !query.state.data.subtask.assigned ? 10_000 : false),
  });
  const [text, setText] = useState("");
  const [files, setFiles] = useState<FileView[]>([]);
  const submit = useMutation({
    mutationFn: () => api(`/freelancer/subtasks/${id}/submit`, { method: "POST", body: { ...(text.trim() ? { text: text.trim() } : {}), files: files.map((f) => f.id) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["freelancer"] }),
  });

  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error) return q.error instanceof ApiError && q.error.status === 404 ? <EmptyState title={t("taken")} /> : <Notice tone="bad">{errorMessage(q.error)}</Notice>;
  const w = q.data;
  if (!w) return null;
  const s = w.subtask;
  const open = s.status === "DISPATCHED";

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="min-w-0 space-y-6">
        <PageHeader kicker={t("workTitle")} title={s.title}>
          <span className="font-mono text-xs">{t("due", { time: relativeTime(s.dueAt, locale) })}</span>
        </PageHeader>
        {!s.assigned ? <Notice tone="info">{t("notAssigned")}</Notice> : null}
        {s.feedback ? <Notice tone="warn" title={t("feedback")}>{s.feedback}</Notice> : null}
        <Card>
          <h2 className="font-display text-lg font-bold">{t("instructions")}</h2>
          <p className="mt-2 whitespace-pre-line text-sm">{s.instructions}</p>
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted">{t("acceptance")}</h3>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {(s.acceptance.rubric ?? []).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {s.acceptance.format ? <p className="mt-2 font-mono text-xs text-muted">{t("format", { format: s.acceptance.format })}</p> : null}
          {s.acceptance.mustInclude?.length ? <p className="font-mono text-xs text-muted">{t("mustInclude", { terms: s.acceptance.mustInclude.join("; ") })}</p> : null}
        </Card>
        <Card>
          <h2 className="font-display text-lg font-bold">{t("request")}</h2>
          <p className="mt-2 font-semibold">{w.request.title}</p>
          <div className="mt-1 text-sm">
            <Markdown>{w.request.description}</Markdown>
          </div>
        </Card>
        {w.previousSteps.length > 0 ? (
          <Card>
            <h2 className="font-display text-lg font-bold">{t("previous")}</h2>
            {w.previousSteps.map((p) => (
              <details key={p.title} className="mt-3 rounded-lg border border-line p-3">
                <summary className="cursor-pointer font-semibold">{p.title}</summary>
                <div className="mt-2 text-sm">
                  <Markdown>{p.text}</Markdown>
                </div>
              </details>
            ))}
          </Card>
        ) : null}
      </div>

      <aside className="space-y-6">
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold">{t("files")}</h2>
            <StepStatusBadge status={s.status} />
          </div>
          {w.files.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{tc("none")}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {w.files.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-ink"
                    onClick={() => void openFile(`/freelancer/subtasks/${id}/files/${f.id}/download-url`)}
                  >
                    <FileText className="size-4 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{f.filename}</span>
                    <span className="font-mono text-xs text-muted">{formatBytes(f.size)}</span>
                    <Download className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="border-ink shadow-stamp">
          <h2 className="font-display text-lg font-bold">{t("submitTitle")}</h2>
          {submit.isSuccess ? (
            <Notice tone="ok" className="mt-3">{t("submitted")}</Notice>
          ) : !open ? (
            <Notice tone="info" className="mt-3">{t("notOpen")}</Notice>
          ) : (
            <div className="mt-3 space-y-4">
              <Field label={t("submitText")} htmlFor="w-text">
                <Textarea id="w-text" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
              <Field label={t("submitFiles")}>
                <FileUpload files={files} onChange={setFiles} />
              </Field>
              {submit.error ? <Notice tone="bad">{errorMessage(submit.error)}</Notice> : null}
              <Button
                variant="accent"
                className="w-full"
                loading={submit.isPending}
                disabled={!s.assigned || (text.trim().length === 0 && files.length === 0)}
                onClick={() => submit.mutate()}
              >
                {t("submit")}
              </Button>
            </div>
          )}
        </Card>
      </aside>
    </div>
  );
}
