"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { Offer } from "@/lib/types";
import { useNow } from "@/lib/use-task-events";
import { PageBody } from "@/components/container";
import { Usdc } from "@/components/money";
import { RequireAuth } from "@/components/require-auth";
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Notice,
  PageHeader,
  Skeleton,
} from "@/components/ui";

export default function OffersPage() {
  const t = useTranslations("freelancer");
  return (
    <PageBody>
      <PageHeader title={t("title")}>{t("intro")}</PageHeader>
      <RequireAuth>
        <OfferList />
      </RequireAuth>
    </PageBody>
  );
}

function OfferList() {
  const t = useTranslations("freelancer");
  const locale = useLocale();
  const qc = useQueryClient();
  const now = useNow(30_000);
  const q = useQuery({
    queryKey: ["freelancer", "offers"],
    queryFn: () => api<{ offers: Offer[] }>("/freelancer/offers").then((r) => r.offers),
    refetchInterval: 20_000,
  });
  const act = useMutation({
    mutationFn: ({ subtaskId, action }: { subtaskId: string; action: "accept" | "decline" }) =>
      api(`/freelancer/offers/${subtaskId}/${action}`, { method: "POST" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["freelancer"] }),
  });
  if (q.isLoading) return <Skeleton className="h-48" />;
  const offers = q.data ?? [];
  if (offers.length === 0) return <EmptyState title={t("empty")} />;
  return (
    <div className="space-y-4">
      {act.error ? <Notice tone="bad">{errorMessage(act.error)}</Notice> : null}
      {offers.map((o) => (
        <article
          key={o.id}
          className="rounded-xl border border-ink/80 bg-surface p-5 shadow-stamp-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
                {o.taskTitle}
              </p>
              <h2 className="font-display text-xl font-bold">{o.title}</h2>
              <div className="mt-1 flex flex-wrap gap-2">
                <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px]">
                  {o.capability}
                </span>
                {o.wave > 1 ? <Badge tone="info">{t("wave2")}</Badge> : null}
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                {t("payout")}
              </p>
              <Usdc value={o.payout} strong className="text-xl" />
            </div>
          </div>
          <p className="mt-3 line-clamp-3 text-sm whitespace-pre-line">{o.instructions}</p>
          <p className="mt-3 font-mono text-xs text-muted">
            {o.status === "OFFERED"
              ? `${t("expires", { time: relativeTime(o.expiresAt, locale, now) })} · `
              : ""}
            {t("due", { time: relativeTime(o.dueAt, locale, now) })}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {o.status === "ACCEPTED" ? (
              <>
                <ButtonLink href={`/freelancer/subtasks/${o.subtaskId}`} variant="accent">
                  {t("open")}
                </ButtonLink>
                <span className="self-center text-sm text-ok">{t("accepted")}</span>
              </>
            ) : (
              <>
                <Button
                  variant="accent"
                  loading={
                    act.isPending &&
                    act.variables?.subtaskId === o.subtaskId &&
                    act.variables.action === "accept"
                  }
                  onClick={() => act.mutate({ subtaskId: o.subtaskId, action: "accept" })}
                >
                  {t("accept")}
                </Button>
                <Button
                  variant="ghost"
                  loading={
                    act.isPending &&
                    act.variables?.subtaskId === o.subtaskId &&
                    act.variables.action === "decline"
                  }
                  onClick={() => act.mutate({ subtaskId: o.subtaskId, action: "decline" })}
                >
                  {t("decline")}
                </Button>
              </>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
