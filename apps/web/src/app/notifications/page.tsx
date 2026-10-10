"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { NotificationView } from "@/lib/types";
import { RequireAuth } from "@/components/require-auth";
import { PageBody } from "@/components/container";
import { Button, Chip, EmptyState, PageHeader, Skeleton } from "@/components/ui";

interface Page {
  notifications: NotificationView[];
  unread: number;
  nextCursor: string | null;
}

export default function NotificationsPage() {
  const t = useTranslations("notifications");
  return (
    <PageBody narrow>
      <PageHeader title={t("title")} />
      <RequireAuth>
        <List />
      </RequireAuth>
    </PageBody>
  );
}

function List() {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const qc = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["notifications", "page", unreadOnly],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<Page>(`/notifications?limit=20${unreadOnly ? "&unread=1" : ""}${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  const markAll = useMutation({
    mutationFn: () => api("/notifications/read", { method: "POST", body: { all: true } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const items = q.data?.pages.flatMap((p) => p.notifications) ?? [];
  const unread = q.data?.pages[0]?.unread ?? 0;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Chip active={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
          {t("unreadOnly")}
        </Chip>
        {unread > 0 ? (
          <Button variant="outline" size="sm" loading={markAll.isPending} onClick={() => markAll.mutate()}>
            {t("markAll")}
          </Button>
        ) : null}
      </div>
      {q.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {items.map((n) => (
            <li key={n.id} className={cn(!n.readAt && "bg-accent-soft/40")}>
              <Link href={n.link ?? "#"} className="block px-4 py-3 hover:bg-surface-2">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-semibold">{n.title}</p>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{relativeTime(n.createdAt, locale)}</span>
                </div>
                <p className="mt-0.5 text-sm text-muted">{n.body}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
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
