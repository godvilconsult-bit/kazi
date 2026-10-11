"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { NotificationView } from "@/lib/types";

interface NotificationsPage {
  notifications: NotificationView[];
  unread: number;
  nextCursor: string | null;
}

/** In-app notifications (bell). Polls every 30 s while the tab is open. */
export function NotificationsBell() {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["notifications", "bell"],
    queryFn: () => api<NotificationsPage>("/notifications?limit=8"),
    refetchInterval: 30_000,
  });
  const markAll = useMutation({
    mutationFn: () => api("/notifications/read", { method: "POST", body: { all: true } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative">
      <button
        type="button"
        className="relative grid size-9 place-items-center rounded-lg hover:bg-surface-2"
        aria-label={t("title")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-accent px-1 font-mono text-[10px] font-bold text-accent-ink">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute end-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-ink bg-surface shadow-stamp">
          <div className="flex items-center justify-between border-b border-dashed border-line px-4 py-3">
            <p className="font-display font-bold">{t("title")}</p>
            {unread > 0 ? (
              <button
                type="button"
                className="text-xs font-semibold text-accent hover:underline"
                onClick={() => markAll.mutate()}
              >
                {t("markAll")}
              </button>
            ) : null}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {(q.data?.notifications ?? []).length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-muted">{t("empty")}</li>
            ) : (
              q.data?.notifications.map((n) => (
                <li
                  key={n.id}
                  className={cn(
                    "border-b border-line/60 last:border-0",
                    !n.readAt && "bg-accent-soft/40",
                  )}
                >
                  <Link
                    href={n.link ?? "/notifications"}
                    className="block px-4 py-3 hover:bg-surface-2"
                    onClick={() => setOpen(false)}
                  >
                    <p className="text-sm font-semibold">{n.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted">{n.body}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted">
                      {relativeTime(n.createdAt, locale)}
                    </p>
                  </Link>
                </li>
              ))
            )}
          </ul>
          <Link
            href="/notifications"
            className="block border-t border-dashed border-line px-4 py-2.5 text-center text-sm font-semibold hover:bg-surface-2"
            onClick={() => setOpen(false)}
          >
            {t("viewAll")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
