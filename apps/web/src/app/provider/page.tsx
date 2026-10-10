"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import type { ProviderOwner } from "@/lib/types";
import { KindBadge } from "@/components/agent-card";
import { PageBody } from "@/components/container";
import { RequireAuth } from "@/components/require-auth";
import { ProviderStatusBadge } from "@/components/status";
import { ButtonLink, EmptyState, PageHeader, Skeleton } from "@/components/ui";

export default function ProviderListPage() {
  const t = useTranslations("provider");
  return (
    <PageBody>
      <PageHeader
        title={t("title")}
        actions={
          <ButtonLink href="/provider/new" variant="accent">
            <Plus className="size-4" />
            {t("new")}
          </ButtonLink>
        }
      >
        {t("intro")}
      </PageHeader>
      <RequireAuth>
        <Listings />
      </RequireAuth>
    </PageBody>
  );
}

function Listings() {
  const t = useTranslations("provider");
  const q = useQuery({ queryKey: ["me", "providers"], queryFn: () => api<{ providers: ProviderOwner[] }>("/me/providers") });
  if (q.isLoading) return <Skeleton className="h-40" />;
  const list = q.data?.providers ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        title={t("empty")}
        action={
          <ButtonLink href="/provider/new" variant="accent">
            {t("emptyCta")}
          </ButtonLink>
        }
      />
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {list.map((p) => (
        <Link key={p.id} href={`/provider/${p.id}`} className="rounded-xl border border-ink/80 bg-surface p-5 shadow-stamp-sm transition-all hover:-translate-y-px hover:shadow-stamp">
          <div className="flex flex-wrap items-center gap-2">
            <KindBadge kind={p.kind} hosting={p.hosting} />
            <ProviderStatusBadge status={p.status} />
          </div>
          <h2 className="mt-3 font-display text-xl font-bold">{p.name}</h2>
          <p className="mt-1 line-clamp-2 text-sm text-muted">{p.description}</p>
          <p className="mt-3 font-mono text-xs text-muted">{p.onchainId ? t("onchain", { id: p.onchainId }) : t("notOnchain")}</p>
        </Link>
      ))}
    </div>
  );
}
