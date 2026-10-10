"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContracts } from "wagmi";
import { kaziAirdropAbi } from "@kazi/shared";
import { api, ApiError, errorMessage } from "@/lib/api";
import { durationLabel, formatDate, toBigInt, tokenAmount } from "@/lib/format";
import { sharePct } from "@/lib/staking";
import { useTx } from "@/lib/tx";
import type { Address, AirdropProof } from "@/lib/types";
import { useNowSeconds } from "@/lib/use-now";
import { useKaziConfig } from "@/components/config";
import { PageBody } from "@/components/container";
import { GeoNotice, useGeo } from "@/components/geo";
import { TxButton } from "@/components/tx-button";
import { ButtonLink, Card, ErrorState, Notice, PageHeader, Skeleton } from "@/components/ui";
import { ConnectWalletButton } from "@/components/wallet";

/**
 * Airdrop claims (docs/08-TOKENOMICS.md §1, §5): the API serves each wallet's allocation and Merkle
 * proof; the KaziAirdrop contract checks the proof and pays whatever has vested so far.
 */
export default function AirdropPage() {
  const t = useTranslations("airdrop");
  const cfg = useKaziConfig();
  const airdrop = cfg.contracts.airdrop;
  return (
    <PageBody narrow>
      <PageHeader kicker={t("kicker")} title={t("title")}>
        {t("intro")}
      </PageHeader>
      <GeoNotice className="mb-6" />
      {!airdrop || cfg.kaziDecimals === null ? (
        <Card>
          <p className="font-semibold">{t("notLive")}</p>
          <ButtonLink href="/points" variant="outline" className="mt-3">
            {t("pointsLink")}
          </ButtonLink>
        </Card>
      ) : (
        <Live airdrop={airdrop} decimals={cfg.kaziDecimals} />
      )}
    </PageBody>
  );
}

function Live({ airdrop, decimals }: { airdrop: Address; decimals: number }) {
  const t = useTranslations("airdrop");
  const locale = useLocale();
  const { address } = useAccount();
  const schedule = useReadContracts({
    contracts: [
      { address: airdrop, abi: kaziAirdropAbi, functionName: "start" },
      { address: airdrop, abi: kaziAirdropAbi, functionName: "vestingDuration" },
      { address: airdrop, abi: kaziAirdropAbi, functionName: "immediateBps" },
      { address: airdrop, abi: kaziAirdropAbi, functionName: "claimDeadline" },
    ],
  });
  const s = schedule.data;
  if (schedule.isLoading || !s) return <Skeleton className="h-48" />;
  if (s.some((x) => x.status !== "success"))
    return <ErrorState title={t("notLive")} onRetry={() => void schedule.refetch()} />;
  const start = Number(s[0].result as bigint);
  const duration = Number(s[1].result as bigint);
  const immediateBps = Number(s[2].result as number);
  const deadline = Number(s[3].result as bigint);
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        {t("schedule", {
          immediate: sharePct(immediateBps),
          duration: durationLabel(duration, locale),
        })}
      </p>
      {address ? (
        <Allocation
          airdrop={airdrop}
          account={address}
          decimals={decimals}
          start={start}
          end={start + duration}
          deadline={deadline}
        />
      ) : (
        <Card>
          <p className="font-semibold">{t("connect")}</p>
          <ConnectWalletButton className="mt-3" />
        </Card>
      )}
    </div>
  );
}

function Allocation({
  airdrop,
  account,
  decimals,
  start,
  end,
  deadline,
}: {
  airdrop: Address;
  account: Address;
  decimals: number;
  start: number;
  end: number;
  deadline: number;
}) {
  const t = useTranslations("airdrop");
  const tc = useTranslations("common");
  const locale = useLocale();
  const geo = useGeo();
  const { write } = useTx();
  const now = useNowSeconds();
  const proof = useQuery({
    queryKey: ["airdrop", account.toLowerCase()],
    queryFn: () => api<AirdropProof>(`/airdrop/${account}`),
  });
  const amount = toBigInt(proof.data?.amount);
  const reads = useReadContracts({
    contracts: [
      { address: airdrop, abi: kaziAirdropAbi, functionName: "claimed", args: [account] },
      { address: airdrop, abi: kaziAirdropAbi, functionName: "claimable", args: [account, amount] },
    ],
    query: { enabled: Boolean(proof.data), refetchInterval: 30_000 },
  });

  if (proof.isLoading) return <Skeleton className="h-40" />;
  if (proof.error instanceof ApiError && proof.error.status === 404)
    return <Notice tone="info">{t("notEligible")}</Notice>;
  if (proof.error || !proof.data) {
    return (
      <ErrorState
        title={tc("error")}
        message={proof.error ? errorMessage(proof.error) : undefined}
        onRetry={() => void proof.refetch()}
        retryLabel={tc("retry")}
      />
    );
  }
  const r = reads.data;
  if (reads.isLoading || !r) return <Skeleton className="h-40" />;
  const claimed = r[0].status === "success" ? (r[0].result as bigint) : 0n;
  const claimable = r[1].status === "success" ? (r[1].result as bigint) : 0n;
  const closed = now > deadline;
  const kazi = (v: bigint) => tokenAmount(v, decimals, 2);
  const data = proof.data;

  return (
    <Card className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Figure label={t("allocation")} value={kazi(amount)} />
        <Figure label={t("claimed")} value={kazi(claimed)} />
        <Figure label={t("claimable")} value={kazi(claimable)} strong />
      </div>
      <div className="space-y-1 text-sm text-muted">
        <p>{t("vestingEnds", { time: formatDate(new Date(end * 1000), locale) })}</p>
        <p>{t("deadline", { time: formatDate(new Date(deadline * 1000), locale) })}</p>
      </div>
      {closed ? (
        <Notice tone="warn">{t("closed")}</Notice>
      ) : (
        <TxButton
          variant="accent"
          disabled={geo.restricted || claimable === 0n || now < start}
          run={(onHash) =>
            write(
              {
                address: airdrop,
                abi: kaziAirdropAbi,
                functionName: "claim",
                args: [amount, data.proof],
              },
              onHash,
            )
          }
          onDone={() => void reads.refetch()}
        >
          {t("claimCta", { amount: kazi(claimable) })}
        </TxButton>
      )}
    </Card>
  );
}

function Figure({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={`num mt-1 text-xl ${strong ? "font-extrabold text-accent" : "font-bold"}`}>
        {value}
        <span className="ml-1 text-[0.7em] font-medium text-muted">KAZI</span>
      </p>
    </div>
  );
}
