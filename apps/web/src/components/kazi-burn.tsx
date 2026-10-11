"use client";

import { Flame } from "lucide-react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { tokenAmount, usdc } from "@/lib/format";
import { sharePct } from "@/lib/staking";
import type { KaziBurn } from "@/lib/types";
import { AddressPill } from "./money";
import { Card, Skeleton } from "./ui";

/**
 * KAZI bought back and burned through its Argus launch (GET /token/kazi-burn, docs/08 §8): realized
 * onchain figures only. Renders nothing on a network without an Argus launch.
 */
function useKaziBurn() {
  return useQuery({
    queryKey: ["token", "kazi-burn"],
    queryFn: () => api<KaziBurn>("/token/kazi-burn"),
    refetchInterval: 5 * 60_000,
  });
}

/** /token page card. */
export function KaziBurnCard({ className }: { className?: string }) {
  const t = useTranslations("kaziBurn");
  const q = useKaziBurn();
  if (q.isLoading) return <Skeleton className={cn("h-44", className)} />;
  const b = q.data;
  if (!b?.available) return null;
  return (
    <Card className={className}>
      <div className="flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg border border-ink bg-accent-soft text-accent">
          <Flame className="size-4" aria-hidden />
        </span>
        <p className="font-mono text-xs uppercase tracking-widest text-muted">{t("title")}</p>
      </div>
      <p className="num mt-3 text-3xl font-bold">
        {tokenAmount(b.burned, b.kaziDecimals, 0)}
        <span className="ms-1.5 text-base font-medium text-muted">KAZI</span>
      </p>
      <p className="text-sm text-muted">{t("ofSupply", { pct: sharePct(b.burnedBps) })}</p>
      <dl className="mt-4 grid gap-3 border-t border-dashed border-line pt-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t("spent")}
          </dt>
          <dd className="num font-semibold">
            {usdc(b.buybackSpent, b.quoteDecimals).display}
            <span className="ms-1 text-xs text-muted">USDC</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t("pending")}
          </dt>
          <dd className="num font-semibold">
            {usdc(b.buybackPending, b.quoteDecimals).display}
            <span className="ms-1 text-xs text-muted">USDC</span>
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-sm text-muted">
        {t("how", {
          share: sharePct(b.burnShareBps),
          buy: sharePct(b.buyTaxBps),
          sell: sharePct(b.sellTaxBps),
        })}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        {t("burnAddress")} <AddressPill address={b.burnAddress} />
      </p>
    </Card>
  );
}

/** One line for the home page band. */
export function KaziBurnStat() {
  const t = useTranslations("kaziBurn");
  const q = useKaziBurn();
  const b = q.data;
  if (!b?.available) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Flame className="size-4 text-accent" aria-hidden />
      <span className="font-mono text-xs uppercase tracking-widest text-muted">{t("short")}</span>
      <span className="num font-semibold">{tokenAmount(b.burned, b.kaziDecimals, 0)} KAZI</span>
    </span>
  );
}
