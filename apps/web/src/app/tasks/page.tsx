"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { TaskView } from "@/lib/types";
import { PageBody } from "@/components/container";
import { Usdc } from "@/components/money";
import { RequireAuth } from "@/components/require-auth";
import { TaskStatusBadge } from "@/components/status";
import { Button, ButtonLink, EmptyState, PageHeader, Skeleton, Tabs } from "@/components/ui";

const FILTERS = {
  all: [],
  active: ["DRAFT", "QUOTED", "FUNDED", "IN_PROGRESS"],
  review: ["DELIVERED", "DISPUTED"],
  done: ["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED", "RESOLVED", "CANCELLED", "EXPIRED"],
} as const;
type Filter = keyof typeof FILTERS;

export default function TasksPage() {
  const t = useTranslations("tasks");
  return (
    <PageBody>
      <PageHeader
        title={t("title")}
        actions={
          <ButtonLink href="/new" variant="accent">
            <Plus className="size-4" />
            {t("new")}
          </ButtonLink>
        }
      />
      <RequireAuth>
        <TaskList />
      </RequireAuth>
    </PageBody>
  );
}

function TaskList() {
  const t = useTranslations("tasks");
  const locale = useLocale();
  const [filter, setFilter] = useState<Filter>("all");
  const q = useInfiniteQuery({
    queryKey: ["tasks"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<{ tasks: TaskView[]; nextCursor: string | null }>(`/tasks?limit=50${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  const all = q.data?.pages.flatMap((p) => p.tasks) ?? [];
  const allowed = FILTERS[filter] as readonly string[];
  const tasks = allowed.length === 0 ? all : all.filter((x) => allowed.includes(x.status));
  const count = (f: Filter) => (FILTERS[f].length === 0 ? all.length : all.filter((x) => (FILTERS[f] as readonly string[]).includes(x.status)).length);

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (all.length === 0) {
    return (
      <EmptyState
        title={t("empty")}
        action={
          <ButtonLink href="/new" variant="accent">
            {t("emptyCta")}
          </ButtonLink>
        }
      />
    );
  }
  return (
    <div>
      <Tabs
        value={filter}
        onChange={setFilter}
        className="mb-4"
        items={[
          { value: "all", label: t("filterAll"), count: count("all") },
          { value: "active", label: t("filterActive"), count: count("active") },
          { value: "review", label: t("filterReview"), count: count("review") },
          { value: "done", label: t("filterDone"), count: count("done") },
        ]}
      />
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id}>
            <Link
              href={`/tasks/${task.id}`}
              className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:border-ink sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold">{task.title}</p>
                <p className="font-mono text-xs text-muted">
                  {t("created", { date: formatDate(task.createdAt, locale) })} · {t("due", { date: formatDate(task.deadline, locale) })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {task.totalAmount ? <Usdc value={task.totalAmount} className="text-sm" /> : null}
                <TaskStatusBadge status={task.status} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {q.hasNextPage ? (
        <div className="mt-4 text-center">
          <Button variant="outline" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
