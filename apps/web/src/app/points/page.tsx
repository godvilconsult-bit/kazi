"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import {
  CLIENT_POINTS_PER_USDC,
  POINTS_DAILY_CAP,
  POINTS_MIN_TASK_USDC,
  POINTS_REPEAT_PAIR_LIMIT,
  PROVIDER_POINTS_PER_USDC,
  type PointsFlag,
} from "@kazi/shared";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { PointsLeader, PointsMe } from "@/lib/types";
import { useAuth } from "@/components/auth";
import { PageBody } from "@/components/container";
import { RequireAuth } from "@/components/require-auth";
import { Badge, Card, EmptyState, PageHeader, SectionTitle, Skeleton } from "@/components/ui";

/** Points program (docs/08-TOKENOMICS.md §5): weighted by USDC fees actually paid, with sybil filters. */
export default function PointsPage() {
  const t = useTranslations("points");
  return (
    <PageBody>
      <PageHeader kicker={t("kicker")} title={t("title")}>
        {t("intro")}
      </PageHeader>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <RequireAuth>
            <Mine />
          </RequireAuth>
        </div>
        <aside className="min-w-0 space-y-6">
          <Leaderboard />
          <Rules />
        </aside>
      </div>
      <p className="mt-10 border-t border-dashed border-line pt-4 text-xs text-muted">
        {t("disclaimer")}
      </p>
    </PageBody>
  );
}

function Mine() {
  const t = useTranslations("points");
  const locale = useLocale();
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["points", "me", user?.id],
    queryFn: () => api<PointsMe>("/points/me"),
    enabled: Boolean(user),
  });
  if (q.isLoading || !q.data) return <Skeleton className="h-48" />;
  const { total, entries } = q.data;
  return (
    <>
      <Card>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">
          {t("yourTotal")}
        </p>
        <p className="num mt-1 font-display text-4xl font-extrabold">
          {total.toLocaleString(locale)}
        </p>
      </Card>
      <section>
        <SectionTitle>{t("history")}</SectionTitle>
        {entries.length === 0 ? (
          <EmptyState title={t("empty")} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-4 py-3">{t("date")}</th>
                  <th className="px-4 py-3">{t("task")}</th>
                  <th className="px-4 py-3">{t("role")}</th>
                  <th className="px-4 py-3 text-right">{t("pointsCol")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={`${e.taskId}-${e.role}`}
                    className="border-b border-dashed border-line align-top last:border-0"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">
                      {formatDate(e.at, locale)}
                    </td>
                    <td className="px-4 py-3">
                      {e.role === "CLIENT" ? (
                        <Link
                          href={`/tasks/${e.taskId}`}
                          className="font-semibold hover:text-accent"
                        >
                          {e.title ?? e.taskId}
                        </Link>
                      ) : (
                        <span className="font-semibold">{e.title ?? e.taskId}</span>
                      )}
                      {e.flag ? (
                        <p className="mt-1 text-xs text-warn">{flagText(t, e.flag)}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={e.role === "CLIENT" ? "info" : "accent"}>
                        {e.role === "CLIENT" ? t("role_CLIENT") : t("role_PROVIDER")}
                      </Badge>
                    </td>
                    <td className="num px-4 py-3 text-right font-bold">
                      {e.points.toLocaleString(locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function flagText(t: ReturnType<typeof useTranslations<"points">>, flag: PointsFlag): string {
  switch (flag) {
    case "self-dealing":
      return t("flag_self-dealing");
    case "below-minimum":
      return t("flag_below-minimum", { min: POINTS_MIN_TASK_USDC });
    case "repeat-pair":
      return t("flag_repeat-pair");
    case "daily-cap":
      return t("flag_daily-cap");
  }
}

function Leaderboard() {
  const t = useTranslations("points");
  const locale = useLocale();
  const q = useQuery({
    queryKey: ["points", "leaderboard"],
    queryFn: () => api<{ leaders: PointsLeader[] }>("/points/leaderboard").then((r) => r.leaders),
    refetchInterval: 5 * 60_000,
  });
  return (
    <Card>
      <h2 className="font-display text-lg font-bold">{t("leaderboard")}</h2>
      {q.isLoading ? (
        <Skeleton className="mt-3 h-32" />
      ) : (q.data ?? []).length === 0 ? (
        <p className="mt-2 text-sm text-muted">{t("noLeaders")}</p>
      ) : (
        <ol className="mt-3 divide-y divide-dashed divide-line">
          {q.data?.map((l) => (
            <li key={l.rank} className="flex items-center gap-3 py-2 text-sm">
              <span className="num w-6 text-right text-muted">{l.rank}</span>
              <span className="flex-1 font-mono text-xs">{l.wallet}</span>
              <span className="num font-semibold">{l.points.toLocaleString(locale)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function Rules() {
  const t = useTranslations("points");
  const locale = useLocale();
  return (
    <Card>
      <h2 className="font-display text-lg font-bold">{t("rules")}</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
        <li>
          {t("rule1", {
            client: CLIENT_POINTS_PER_USDC.toString(),
            provider: PROVIDER_POINTS_PER_USDC.toString(),
          })}
        </li>
        <li>{t("rule2")}</li>
        <li>
          {t("rule3", {
            limit: POINTS_REPEAT_PAIR_LIMIT,
            cap: POINTS_DAILY_CAP.toLocaleString(locale),
          })}
        </li>
      </ul>
    </Card>
  );
}
