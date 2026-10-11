"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDate, toBigInt, tokenAmount } from "@/lib/format";
import { sharePct } from "@/lib/staking";
import type { FeeSplit, TokenMetrics, VestingProgress } from "@/lib/types";
import { useKaziConfig, useTokenName } from "@/components/config";
import { PageBody } from "@/components/container";
import { AddressPill, Usdc } from "@/components/money";
import {
  ButtonLink,
  Card,
  ErrorState,
  Notice,
  PageHeader,
  SectionTitle,
  Skeleton,
} from "@/components/ui";

const CONTRACT_LABELS = {
  kaziToken: "c_kaziToken",
  stakingVault: "c_stakingVault",
  feeDistributor: "c_feeDistributor",
  teamVesting: "c_teamVesting",
  ecosystemVesting: "c_ecosystemVesting",
  airdrop: "c_airdrop",
  treasury: "c_treasury",
  creditsGate: "c_creditsGate",
  argusKazi: "c_argusKazi",
} as const;

/** $KAZI metrics (docs/08-TOKENOMICS.md §6): realized, onchain numbers only — no prices, no projections. */
export default function TokenPage() {
  const t = useTranslations("token");
  const tc = useTranslations("common");
  const tokenLabel = useTokenName();
  const q = useQuery({
    queryKey: ["token", "metrics"],
    queryFn: () => api<TokenMetrics>("/token/metrics"),
    refetchInterval: 5 * 60_000,
  });
  return (
    <PageBody>
      <PageHeader
        kicker={t("kicker")}
        title={t("title")}
        actions={
          <ButtonLink href="/stake" variant="accent">
            {t("stakeCta", { token: tokenLabel })}
          </ButtonLink>
        }
      >
        {t("intro", { token: tokenLabel })}
      </PageHeader>
      {q.isLoading ? (
        <Skeleton className="h-72" />
      ) : q.error || !q.data ? (
        <ErrorState
          title={tc("error")}
          message={q.error ? errorMessage(q.error) : undefined}
          onRetry={() => void q.refetch()}
          retryLabel={tc("retry")}
        />
      ) : !q.data.deployed ? (
        <Notice tone="info">{t("notDeployed", { token: tokenLabel })}</Notice>
      ) : (
        <Metrics m={q.data} />
      )}
      <p className="mt-10 border-t border-dashed border-line pt-4 text-xs text-muted">
        {t("disclaimer")}
      </p>
    </PageBody>
  );
}

function Metrics({ m }: { m: Extract<TokenMetrics, { deployed: true }> }) {
  const t = useTranslations("token");
  const locale = useLocale();
  const cfg = useKaziConfig();
  const tokenLabel = useTokenName();
  const d = cfg.kaziDecimals ?? 18;
  const kazi = (v: string) => tokenAmount(v, d, 0);
  const contracts = Object.entries(m.contracts).filter(
    (e): e is [keyof typeof CONTRACT_LABELS, `0x${string}`] =>
      Boolean(e[1]) && e[0] in CONTRACT_LABELS,
  );
  return (
    <div className="space-y-8">
      {!m.launched ? (
        <Notice tone="info">{t("notLaunched")}</Notice>
      ) : m.tge ? (
        <p className="font-mono text-xs text-muted">
          {t("launchedOn", { date: formatDate(new Date(m.tge * 1000), locale) })}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("supply")} value={kazi(m.totalSupply)} unit={tokenLabel} />
        {/* Before launch the supply sits with the distributor: nothing circulates yet. */}
        {m.launched ? (
          <Stat label={t("circulating")} value={kazi(m.circulating)} unit={tokenLabel} />
        ) : null}
        <Stat
          label={t("staked")}
          value={kazi(m.staked)}
          unit={tokenLabel}
          sub={m.launched ? t("stakedShare", { pct: sharePct(m.stakedBps) }) : undefined}
        />
        <Stat label={t("rewards30")} value={<Usdc value={m.stakerRewards.last30d} />} />
        <Stat label={t("rewardsAll")} value={<Usdc value={m.stakerRewards.allTime} />} />
        <Stat label={t("feesDistributed")} value={<Usdc value={m.feesDistributed} />} />
        <Stat label={t("buyback")} value={<Usdc value={m.buybackReserved} />} />
        {m.treasuryUsdc !== null ? (
          <Stat label={t("treasury")} value={<Usdc value={m.treasuryUsdc} />} />
        ) : null}
      </div>

      {m.split ? <Split split={m.split} /> : null}

      {m.creditsGate ? (
        <section>
          <SectionTitle>{t("gateTitle")}</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label={t("gateLocked")} value={kazi(m.creditsGate.totalLocked)} unit="KAZI" />
            <Stat
              label={t("gateOutstanding")}
              value={kazi((toBigInt(m.totalSupply) - toBigInt(m.creditsGate.reserve)).toString())}
              unit="KAZI Credits"
            />
          </div>
          <Notice tone={m.creditsGate.fullyBacked ? "ok" : "warn"} className="mt-3">
            {m.creditsGate.fullyBacked ? t("gateBacked") : t("gateNotBacked")}
            {m.creditsGate.paused ? ` ${t("gatePaused")}` : ""}
          </Notice>
        </section>
      ) : null}

      {m.vesting.length > 0 ? (
        <section>
          <SectionTitle>{t("vesting")}</SectionTitle>
          <div className="grid gap-3 md:grid-cols-2">
            {m.vesting.map((v) => (
              <VestingCard key={v.address} v={v} decimals={d} />
            ))}
          </div>
        </section>
      ) : null}

      {m.airdrop ? (
        <section>
          <SectionTitle>{t("airdrop")}</SectionTitle>
          <Card>
            <p className="num text-lg font-bold">
              {t("airdropClaimed", {
                claimed: kazi(m.airdrop.claimed),
                left: kazi(m.airdrop.balance),
              })}
            </p>
            <p className="mt-1 text-sm text-muted">
              {t("airdropDeadline", {
                date: formatDate(new Date(m.airdrop.deadline * 1000), locale),
              })}
            </p>
          </Card>
        </section>
      ) : null}

      <section>
        <SectionTitle>{t("contracts")}</SectionTitle>
        <Card className="p-0">
          <dl className="divide-y divide-dashed divide-line">
            {contracts.map(([name, address]) => (
              <div
                key={name}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
              >
                <dt className="text-sm font-semibold">
                  {t(CONTRACT_LABELS[name], { token: tokenLabel })}
                </dt>
                <dd>
                  <AddressPill address={address} />
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: string;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="num text-xl font-bold">
        {value}
        {unit ? <span className="ml-1 text-[0.7em] font-medium text-muted">{unit}</span> : null}
      </p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </Card>
  );
}

function Split({ split }: { split: FeeSplit }) {
  const t = useTranslations("token");
  const parts = [
    { key: "treasury", bps: split.treasuryBps, label: t("splitTreasury"), className: "bg-ink" },
    { key: "stakers", bps: split.stakerBps, label: t("splitStakers"), className: "bg-accent" },
    { key: "buyback", bps: split.buybackBps, label: t("splitBuyback"), className: "bg-info" },
  ];
  return (
    <section>
      <SectionTitle>{t("splitTitle")}</SectionTitle>
      <Card>
        <div
          className="flex h-4 overflow-hidden rounded-full border border-ink/40"
          role="img"
          aria-label={parts.map((p) => `${p.label} ${sharePct(p.bps)}%`).join(", ")}
        >
          {parts.map((p) =>
            p.bps > 0 ? (
              <div key={p.key} className={p.className} style={{ width: `${p.bps / 100}%` }} />
            ) : null,
          )}
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {parts.map((p) => (
            <li key={p.key} className="flex items-center gap-2">
              <span className={cn("size-3 rounded-sm", p.className)} aria-hidden />
              {p.label} <span className="num font-semibold">{sharePct(p.bps)}%</span>
            </li>
          ))}
        </ul>
        {split.stakerBps === 0 ? <p className="mt-3 text-sm text-muted">{t("splitOff")}</p> : null}
      </Card>
    </section>
  );
}

function VestingCard({ v, decimals }: { v: VestingProgress; decimals: number }) {
  const t = useTranslations("token");
  const locale = useLocale();
  const total = toBigInt(v.total);
  const vested = toBigInt(v.vested);
  const pct = total > 0n ? Number((vested * 10_000n) / total) / 100 : 0;
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-bold">
          {v.name === "team" ? t("vestingTeam") : t("vestingEcosystem")}
        </h3>
        <span className="num text-sm font-semibold">{pct.toFixed(1)}%</span>
      </div>
      <div
        className="mt-3 h-2.5 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <p className="num mt-2 text-sm">
        {t("vestedOf", {
          vested: tokenAmount(vested, decimals, 0),
          total: tokenAmount(total, decimals, 0),
        })}
      </p>
      <p className="mt-1 font-mono text-xs text-muted">
        {t("vestingRange", {
          start: formatDate(new Date(v.start * 1000), locale),
          end: formatDate(new Date(v.end * 1000), locale),
        })}
      </p>
      <AddressPill address={v.address} className="mt-3" />
    </Card>
  );
}
