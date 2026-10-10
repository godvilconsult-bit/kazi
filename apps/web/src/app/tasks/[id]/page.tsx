"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Radio } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { QuoteView, TaskView } from "@/lib/types";
import { useTaskEvents } from "@/lib/use-task-events";
import { useAuth } from "@/components/auth";
import { PageBody } from "@/components/container";
import { Markdown } from "@/components/output-viewer";
import { RequireAuth } from "@/components/require-auth";
import { TaskStatusBadge } from "@/components/status";
import { FundFlow } from "@/components/task/fund-flow";
import { Activity, StepTimeline } from "@/components/task/progress";
import { QuoteCard } from "@/components/task/quote-card";
import { RatingForm, Receipt } from "@/components/task/receipt";
import { Deliverables, ReviewPanel, useDeliverables } from "@/components/task/review";
import { Button, Card, EmptyState, ErrorState, Field, Notice, Skeleton, Textarea } from "@/components/ui";

const ACTIVE = ["FUNDED", "IN_PROGRESS"];
const CLOSED = ["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED", "RESOLVED"];

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <PageBody>
      <RequireAuth>
        <TaskView id={id} />
      </RequireAuth>
    </PageBody>
  );
}

function TaskView({ id }: { id: string }) {
  const t = useTranslations("task");
  const tc = useTranslations("common");
  const locale = useLocale();
  const qc = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();
  const { events, connected } = useTaskEvents(id, Boolean(user));

  const taskQ = useQuery({
    queryKey: ["task", id],
    queryFn: () => api<{ task: TaskView }>(`/tasks/${id}`).then((r) => r.task),
    refetchInterval: (q) => (q.state.data && ["DRAFT", ...ACTIVE].includes(q.state.data.status) ? 8_000 : false),
  });
  const task = taskQ.data;
  const wantsQuote = task ? ["DRAFT", "QUOTED", "EXPIRED"].includes(task.status) : false;
  const quoteQ = useQuery({
    queryKey: ["task", id, "quote", task?.quoteVersion, task?.status],
    queryFn: () => api<{ quote: QuoteView | null; status: string }>(`/tasks/${id}/quote`).then((r) => r.quote),
    enabled: wantsQuote,
  });
  const closed = task ? CLOSED.includes(task.status) || task.status === "DISPUTED" : false;
  const deliverables = useDeliverables(id, closed);

  const requote = useMutation({
    mutationFn: (speed?: "ECONOMY" | "EXPRESS") => api(`/tasks/${id}/quote`, { method: "POST", body: speed ? { speed } : {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["task", id] }),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/tasks/${id}/cancel`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["task", id] }),
  });

  if (taskQ.isLoading) return <Skeleton className="h-96" />;
  if (taskQ.error) {
    return taskQ.error instanceof ApiError && taskQ.error.status === 404 ? (
      <EmptyState title={t("notFound")} />
    ) : (
      <ErrorState title={tc("error")} message={errorMessage(taskQ.error)} onRetry={() => void taskQ.refetch()} retryLabel={tc("retry")} />
    );
  }
  if (!task) return null;
  const quote = quoteQ.data ?? null;
  const steps = task.subtasks ?? [];

  return (
    <div className="space-y-8">
      <div>
        <Link href="/tasks" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
          <ArrowLeft className="size-4" />
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 font-display text-3xl font-extrabold tracking-tight break-words sm:text-4xl">{task.title}</h1>
          <div className="flex items-center gap-2">
            {connected ? (
              <span className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-ok">
                <Radio className="size-3.5" />
                {t("live")}
              </span>
            ) : null}
            <TaskStatusBadge status={task.status} />
          </div>
        </div>
        <p className="mt-2 font-mono text-xs text-muted">
          {t("deadline")}: {formatDate(task.deadline, locale)} · {t("speed")}: {task.speed === "ECONOMY" ? t("speedEconomy") : t("speedExpress")}
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr]">
        <div className="min-w-0 space-y-6">
          {/* Planning and quoting */}
          {task.status === "DRAFT" && (!quote || requote.isPending) ? (
            <Card className="flex items-start gap-4">
              <Loader2 className="mt-1 size-6 shrink-0 animate-spin text-accent" />
              <div>
                <h2 className="font-display text-xl font-bold">{t("planningTitle")}</h2>
                <p className="mt-1 text-sm text-muted">{t("planningBody")}</p>
              </div>
            </Card>
          ) : null}
          {task.status === "DRAFT" && quote?.outcome === "NEEDS_CLARIFICATION" ? <Clarify task={task} questions={quote.questions} /> : null}
          {task.status === "DRAFT" && quote?.outcome === "INFEASIBLE" ? (
            <Card className="border-bad/60">
              <h2 className="font-display text-xl font-bold">{t("infeasibleTitle")}</h2>
              <p className="mt-2 text-sm">{quote.reason}</p>
              <p className="mt-1 text-sm text-muted">{t("infeasibleBody")}</p>
              <Button className="mt-4" variant="outline" onClick={() => router.push(`/new?from=${task.id}`)}>
                {t("editTask")}
              </Button>
            </Card>
          ) : null}
          {task.status === "QUOTED" && quote?.outcome === "QUOTED" ? (
            <QuoteCard quote={quote} task={task} switching={requote.isPending} onSwitchSpeed={(s) => requote.mutate(s)} />
          ) : null}
          {(task.status === "EXPIRED" || (task.status === "QUOTED" && quote?.outcome === "QUOTED" && quote.expired)) ? (
            <Card>
              <h2 className="font-display text-lg font-bold">{t("expiredTitle")}</h2>
              <Button className="mt-3" loading={requote.isPending} onClick={() => requote.mutate(undefined)}>
                {t("requote")}
              </Button>
            </Card>
          ) : null}
          {task.status === "CANCELLED" ? <Notice tone="info">{t("cancelled")}</Notice> : null}

          {/* Work in progress */}
          {[...ACTIVE, "DELIVERED", "DISPUTED", ...CLOSED].includes(task.status) && steps.length > 0 ? (
            <section>
              <h2 className="mb-3 font-display text-xl font-bold">{t("progressTitle")}</h2>
              <StepTimeline steps={steps} events={events} />
            </section>
          ) : null}

          {task.status === "DELIVERED" ? <ReviewPanel task={task} /> : null}
          {task.status === "DISPUTED" ? <Notice tone="bad">{t("disputed")}</Notice> : null}
          {task.status === "REFUNDED" ? <Notice tone="info" title={t("refundedTitle")}>{t("refundedBody")}</Notice> : null}
          {task.status === "PARTIALLY_REFUNDED" ? <Notice tone="info" title={t("partialTitle")}>{t("partialBody")}</Notice> : null}
          {task.status === "RESOLVED" ? <Notice tone="info" title={t("resolvedTitle")}>{t("resolvedBody")}</Notice> : null}
          {closed ? (
            <section>
              <h2 className="mb-3 font-display text-xl font-bold">{t("deliverables")}</h2>
              <Deliverables steps={deliverables.data?.steps} />
            </section>
          ) : null}
        </div>

        <aside className="space-y-6">
          {task.status === "QUOTED" && quote?.outcome === "QUOTED" && !quote.expired ? (
            <FundFlow taskId={task.id} quoteClient={quote.client} />
          ) : null}
          {CLOSED.includes(task.status) ? <Receipt task={task} /> : null}
          {task.status === "COMPLETED" ? <RatingForm task={task} /> : null}

          <Card>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{t("description")}</h2>
            <div className="max-h-72 overflow-y-auto text-sm">
              <Markdown>{task.description}</Markdown>
            </div>
            {task.attachments.length > 0 ? <p className="mt-2 font-mono text-xs text-muted">{t("attachments", { count: task.attachments.length })}</p> : null}
          </Card>

          <Card>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">{t("activity")}</h2>
            <Activity events={events} />
          </Card>

          {["DRAFT", "QUOTED"].includes(task.status) ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => router.push(`/new?from=${task.id}`)}>
                {t("editTask")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                loading={cancel.isPending}
                onClick={() => {
                  if (window.confirm(t("cancelConfirm"))) cancel.mutate();
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          ) : null}
          {requote.error ? <Notice tone="bad">{errorMessage(requote.error)}</Notice> : null}
          {cancel.error ? <Notice tone="bad">{errorMessage(cancel.error)}</Notice> : null}
        </aside>
      </div>
    </div>
  );
}

/** The router asked questions: append the answers to the request and quote again (PATCH /tasks/:id). */
function Clarify({ task, questions }: { task: TaskView; questions: string[] }) {
  const t = useTranslations("task");
  const qc = useQueryClient();
  const [answers, setAnswers] = useState("");
  const send = useMutation({
    mutationFn: () =>
      api(`/tasks/${task.id}`, {
        method: "PATCH",
        body: {
          description: `${task.description}\n\nAnswers to the planner's questions:\n${questions.map((q) => `- ${q}`).join("\n")}\n\n${answers.trim()}`.slice(0, 20_000),
          requote: true,
        },
      }),
    onSuccess: () => {
      setAnswers("");
      void qc.invalidateQueries({ queryKey: ["task", task.id] });
    },
  });
  return (
    <Card className="border-info/60">
      <h2 className="font-display text-xl font-bold">{t("clarifyTitle")}</h2>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
        {questions.map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted">{t("clarifyBody")}</p>
      <Field label={t("clarifyLabel")} className="mt-3" htmlFor="clarify">
        <Textarea id="clarify" rows={5} value={answers} onChange={(e) => setAnswers(e.target.value)} />
      </Field>
      {send.error ? <Notice tone="bad" className="mt-3">{errorMessage(send.error)}</Notice> : null}
      <Button className="mt-3" loading={send.isPending} disabled={answers.trim().length < 3} onClick={() => send.mutate()}>
        {t("clarifySend")}
      </Button>
    </Card>
  );
}
