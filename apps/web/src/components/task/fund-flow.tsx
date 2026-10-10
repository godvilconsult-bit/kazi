"use client";

import { useReducer, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useReadContracts } from "wagmi";
import { mockUsdcAbi, taskEscrowAbi } from "@kazi/shared";
import { api, errorMessage } from "@/lib/api";
import { shortAddress, toBigInt, usdc } from "@/lib/format";
import { initSteps, isBusy, isUserRejection, stepsReducer } from "@/lib/tx-steps";
import { useTx } from "@/lib/tx";
import type { FundParams } from "@/lib/types";
import { useAuth } from "../auth";
import { useKaziConfig } from "../config";
import { TxStepper } from "../tx-stepper";
import { Button, Notice } from "../ui";
import { ConnectWalletButton } from "../wallet";

/**
 * Exact USDC approve (never infinite) → TaskEscrow.createAndFund(quote, signature). The task becomes
 * FUNDED only when the indexer sees TaskFunded onchain (CLAUDE.md rule 3); the page listens for it.
 */
export function FundFlow({ taskId, quoteClient }: { taskId: string; quoteClient: string }) {
  const t = useTranslations("task");
  const cfg = useKaziConfig();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { address } = useAccount();
  const { write } = useTx();
  const [steps, dispatch] = useReducer(stepsReducer, initSteps(["approve", "fund"]));
  const [funded, setFunded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rightWallet = Boolean(address && address.toLowerCase() === quoteClient.toLowerCase());
  const params = useQuery({
    queryKey: ["task", taskId, "fund-params"],
    queryFn: () => api<FundParams>(`/tasks/${taskId}/fund-params`),
    enabled: Boolean(user) && rightWallet,
    staleTime: 60_000,
  });
  const p = params.data;
  const reads = useReadContracts({
    contracts:
      p && address
        ? [
            {
              address: p.usdcAddress,
              abi: mockUsdcAbi,
              functionName: "balanceOf",
              args: [address],
            },
            {
              address: p.usdcAddress,
              abi: mockUsdcAbi,
              functionName: "allowance",
              args: [address, p.escrowAddress],
            },
          ]
        : [],
    query: { enabled: Boolean(p && address), refetchInterval: 10_000 },
  });
  const balance = reads.data?.[0]?.status === "success" ? (reads.data[0].result as bigint) : null;
  const allowance = reads.data?.[1]?.status === "success" ? (reads.data[1].result as bigint) : null;
  const total = p ? toBigInt(p.total) : 0n;
  const enough = balance === null || balance >= total;
  const amount = usdc(total, cfg.usdcDecimals).display;

  async function run() {
    if (!p) return;
    setError(null);
    dispatch({ type: "reset" });
    let current: "approve" | "fund" = "approve";
    try {
      if (steps.find((s) => s.key === "approve")?.status === "done") {
        // approved in an earlier run
      } else if (allowance !== null && allowance >= total)
        dispatch({ type: "skip", key: "approve" });
      else {
        dispatch({ type: "wallet", key: "approve" });
        await write(
          {
            address: p.usdcAddress,
            abi: mockUsdcAbi,
            functionName: "approve",
            args: [p.escrowAddress, total],
          },
          (hash) => dispatch({ type: "sent", key: "approve", hash }),
        );
        dispatch({ type: "done", key: "approve" });
      }
      current = "fund";
      dispatch({ type: "wallet", key: "fund" });
      await write(
        {
          address: p.escrowAddress,
          abi: taskEscrowAbi,
          functionName: "createAndFund",
          args: [
            {
              taskId: p.quote.taskId,
              providerIds: p.quote.providerIds.map((x) => BigInt(x)),
              amounts: p.quote.amounts.map((x) => BigInt(x)),
              deadline: BigInt(p.quote.deadline),
              feeBps: p.quote.feeBps,
              expiry: BigInt(p.quote.expiry),
            },
            p.quoteSig,
          ],
        },
        (hash) => dispatch({ type: "sent", key: "fund", hash }),
      );
      dispatch({ type: "done", key: "fund" });
      setFunded(true);
      void qc.invalidateQueries({ queryKey: ["task", taskId] });
    } catch (err) {
      const message = isUserRejection(err) ? "" : errorMessage(err);
      dispatch({ type: "error", key: current, error: message || undefined });
      if (message) setError(message);
      void reads.refetch();
    }
  }

  if (funded) return <Notice tone="ok">{t("funded")}</Notice>;
  if (!address) {
    return (
      <div className="space-y-3 rounded-xl border border-ink bg-surface p-5 shadow-stamp-sm">
        <p className="text-sm">{t("connectToFund")}</p>
        <ConnectWalletButton variant="primary" size="md" />
      </div>
    );
  }
  if (!rightWallet)
    return <Notice tone="warn">{t("wrongWallet", { wallet: shortAddress(quoteClient) })}</Notice>;

  return (
    <div className="rounded-xl border border-ink bg-surface p-5 shadow-stamp-sm">
      <h2 className="font-display text-xl font-bold">{t("fundTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("fundIntro")}</p>
      <div className="mt-4">
        <TxStepper
          steps={steps}
          labels={{ approve: t("stepApprove", { amount }), fund: t("stepFund", { amount }) }}
        />
      </div>
      {balance !== null ? (
        <p className={`mt-4 text-sm ${enough ? "text-muted" : "text-bad"}`}>
          {enough
            ? t("balance", { amount: usdc(balance, cfg.usdcDecimals).display })
            : t("insufficient", { amount })}{" "}
          {!enough ? (
            <Link href="/get-usdc" className="font-semibold text-accent underline">
              {t("getUsdc")}
            </Link>
          ) : null}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-muted">{t("gasNote")}</p>
      {params.error ? (
        <Notice tone="bad" className="mt-3">
          {errorMessage(params.error)}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="bad" className="mt-3">
          {error}
        </Notice>
      ) : null}
      <Button
        variant="accent"
        size="lg"
        className="mt-5 w-full"
        onClick={() => void run()}
        loading={isBusy(steps)}
        disabled={!p || !enough}
      >
        {isBusy(steps)
          ? t("funding")
          : steps.some((s) => s.status === "done" || s.status === "error")
            ? t("fundContinue")
            : t("fundCta")}
      </Button>
    </div>
  );
}
