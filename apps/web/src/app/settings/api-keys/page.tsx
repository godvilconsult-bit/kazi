"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { PageBody } from "@/components/container";
import { CopyButton } from "@/components/money";
import { RequireAuth } from "@/components/require-auth";
import { Badge, Button, Card, EmptyState, Field, Input, Notice, PageHeader, Skeleton } from "@/components/ui";

interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export default function ApiKeysPage() {
  const t = useTranslations("settings");
  return (
    <PageBody narrow>
      <PageHeader title={t("title")}>{t("intro")}</PageHeader>
      <RequireAuth>
        <Keys />
      </RequireAuth>
    </PageBody>
  );
}

function Keys() {
  const t = useTranslations("settings");
  const locale = useLocale();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["me", "api-keys"], queryFn: () => api<{ apiKeys: ApiKeyView[] }>("/me/api-keys").then((r) => r.apiKeys) });
  const create = useMutation({
    mutationFn: () => api<{ key: string }>("/me/api-keys", { method: "POST", body: { name: name.trim() } }),
    onSuccess: (r) => {
      setFresh(r.key);
      setName("");
      void qc.invalidateQueries({ queryKey: ["me", "api-keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/me/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["me", "api-keys"] }),
  });

  return (
    <div className="space-y-6">
      <Notice tone="info">{t("fundingNote")}</Notice>
      <Card>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Field label={t("name")} className="flex-1" htmlFor="key-name">
            <Input id="key-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
          </Field>
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
            <KeyRound className="size-4" />
            {t("create")}
          </Button>
        </form>
        {create.error ? <Notice tone="bad" className="mt-3">{errorMessage(create.error)}</Notice> : null}
        {fresh ? (
          <div className="mt-4 rounded-lg border border-warn bg-warn-soft p-3">
            <p className="font-semibold">{t("newKeyTitle")}</p>
            <p className="mt-1 text-sm">{t("newKeyBody")}</p>
            <div className="mt-2 flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">{fresh}</code>
              <CopyButton value={fresh} />
            </div>
          </div>
        ) : null}
      </Card>

      {q.isLoading ? (
        <Skeleton className="h-32" />
      ) : (q.data ?? []).length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {q.data?.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">{k.name}</p>
                <p className="font-mono text-xs text-muted">
                  kz_…_{k.prefix}_… · {t("created", { date: formatDate(k.createdAt, locale) })} ·{" "}
                  {k.lastUsedAt ? t("lastUsed", { date: formatDate(k.lastUsedAt, locale) }) : t("neverUsed")}
                </p>
              </div>
              {k.revokedAt ? (
                <Badge tone="neutral">{t("revoked")}</Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={revoke.isPending && revoke.variables === k.id}
                  onClick={() => {
                    if (window.confirm(t("revokeConfirm"))) revoke.mutate(k.id);
                  }}
                >
                  {t("revoke")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
