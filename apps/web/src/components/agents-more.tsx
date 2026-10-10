"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import type { ProviderPublic } from "@/lib/types";
import { AgentCard } from "./agent-card";
import { Button } from "./ui";

/** Appends further directory pages (cursor pagination) under the server-rendered first page. */
export function AgentsMore({ query, initialCursor }: { query: string; initialCursor: string | null }) {
  const t = useTranslations("agents");
  const [pages, setPages] = useState<ProviderPublic[]>([]);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  if (!cursor && pages.length === 0) return null;
  return (
    <>
      {pages.length > 0 ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pages.map((p) => (
            <AgentCard key={p.id} p={p} />
          ))}
        </div>
      ) : null}
      {cursor ? (
        <div className="mt-8 text-center">
          <Button
            variant="outline"
            loading={loading}
            onClick={async () => {
              setLoading(true);
              try {
                const q = new URLSearchParams(query);
                q.set("cursor", cursor);
                const res = await api<{ providers: ProviderPublic[]; nextCursor: string | null }>(`/providers?${q}`);
                setPages((prev) => [...prev, ...res.providers]);
                setCursor(res.nextCursor);
              } finally {
                setLoading(false);
              }
            }}
          >
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
