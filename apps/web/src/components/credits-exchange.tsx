"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useReadContracts } from "wagmi";
import { formatUnits, kaziCreditsGateAbi, kaziTokenAbi } from "@kazi/shared";
import { errorMessage } from "@/lib/api";
import { parseTokenInput, tokenAmount } from "@/lib/format";
import { amountError, needsApproval, type AmountError } from "@/lib/staking";
import { useTx } from "@/lib/tx";
import {
  initSteps,
  isBusy,
  isUserRejection,
  stepsReducer,
  type StepAction,
  type TxStep,
} from "@/lib/tx-steps";
import type { Address } from "@/lib/types";
import { AddressPill } from "@/components/money";
import { TxStepper } from "@/components/tx-stepper";
import { Button, Card, ErrorState, Field, Input, Notice, Skeleton } from "@/components/ui";

const LOCK_STEPS = ["approve", "lock"] as const;
const UNLOCK_STEPS = ["approve", "unlock"] as const;

/**
 * KAZI (bought on Argus) ⇄ KAZI Credits, 1:1, through KaziCreditsGate (docs/08-TOKENOMICS.md §8).
 * Locking gives Credits to stake; returning Credits gives the KAZI back and is never restricted.
 */
export function CreditsExchange({
  address,
  gate,
  kazi,
  credits,
  decimals,
  restricted,
  onDone,
}: {
  address: Address;
  gate: Address;
  kazi: Address;
  credits: Address;
  decimals: number;
  restricted: boolean;
  onDone: () => void;
}) {
  const t = useTranslations("credits");
  const reads = useReadContracts({
    contracts: [
      { address: kazi, abi: kaziTokenAbi, functionName: "balanceOf", args: [address] },
      { address: kazi, abi: kaziTokenAbi, functionName: "allowance", args: [address, gate] },
      { address: credits, abi: kaziTokenAbi, functionName: "balanceOf", args: [address] },
      { address: credits, abi: kaziTokenAbi, functionName: "allowance", args: [address, gate] },
      { address: gate, abi: kaziCreditsGateAbi, functionName: "paused" },
      { address: gate, abi: kaziCreditsGateAbi, functionName: "totalLocked" },
    ],
    query: { refetchInterval: 15_000 },
  });
  const r = reads.data;
  if (reads.isLoading || !r) return <Skeleton className="h-48" />;
  if (r.some((x) => x.status !== "success")) {
    return <ErrorState title={t("title")} onRetry={() => void reads.refetch()} />;
  }
  const kaziBalance = r[0].result as bigint;
  const kaziAllowance = r[1].result as bigint;
  const creditsBalance = r[2].result as bigint;
  const creditsAllowance = r[3].result as bigint;
  const paused = r[4].result as boolean;
  const totalLocked = r[5].result as bigint;
  const done = () => {
    void reads.refetch();
    onDone();
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-bold">{t("title")}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t("intro")}</p>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t("dividendsNote")}</p>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          {t("kaziContract")} <AddressPill address={kazi} />
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Balance
          label={t("kaziBalance")}
          value={tokenAmount(kaziBalance, decimals, 2)}
          unit="KAZI"
        />
        <Balance
          label={t("creditsBalance")}
          value={tokenAmount(creditsBalance, decimals, 2)}
          unit="KAZI Credits"
        />
      </div>
      {paused ? <Notice tone="warn">{t("paused")}</Notice> : null}
      <div className="grid gap-6 md:grid-cols-2">
        <ExchangeForm
          kind="lock"
          token={kazi}
          gate={gate}
          balance={kaziBalance}
          allowance={kaziAllowance}
          decimals={decimals}
          disabled={restricted || paused}
          onDone={done}
        />
        <ExchangeForm
          kind="unlock"
          token={credits}
          gate={gate}
          // The gate returns at most the KAZI locked in it.
          balance={creditsBalance < totalLocked ? creditsBalance : totalLocked}
          allowance={creditsAllowance}
          decimals={decimals}
          disabled={false}
          hint={t("exitAlways")}
          onDone={done}
        />
      </div>
    </section>
  );
}

function Balance({ label, value, unit }: { label: string; value: ReactNode; unit: string }) {
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="num text-xl font-bold">
        {value}
        <span className="ml-1 text-[0.7em] font-medium text-muted">{unit}</span>
      </p>
    </Card>
  );
}

/** approve (exact amount, skipped when the allowance covers it) → lock / unlock. */
function ExchangeForm({
  kind,
  token,
  gate,
  balance,
  allowance,
  decimals,
  disabled,
  hint,
  onDone,
}: {
  kind: "lock" | "unlock";
  token: Address;
  gate: Address;
  balance: bigint;
  allowance: bigint;
  decimals: number;
  disabled: boolean;
  hint?: string;
  onDone: () => void;
}) {
  const t = useTranslations("credits");
  const ts = useTranslations("stake");
  const { write } = useTx();
  const keys = kind === "lock" ? LOCK_STEPS : UNLOCK_STEPS;
  const [value, setValue] = useState("");
  const [steps, setSteps] = useState<TxStep[]>(() => initSteps(keys));
  const apply = (action: StepAction) => setSteps((s) => stepsReducer(s, action));
  const amount = parseTokenInput(value, decimals);
  const error: AmountError | null = value.trim() === "" ? null : amountError(amount, balance);
  const busy = isBusy(steps);
  const label = amount && !error ? tokenAmount(amount, decimals, 2) : "…";
  const errorText =
    error === "invalid"
      ? ts("errInvalid")
      : error === "zero"
        ? ts("errZero")
        : error === "tooMuch"
          ? ts("errTooMuch")
          : undefined;

  async function run() {
    if (amount === null || error) return;
    setSteps(initSteps(keys));
    let current: string = "approve";
    try {
      if (!needsApproval(allowance, amount)) apply({ type: "skip", key: "approve" });
      else {
        apply({ type: "wallet", key: "approve" });
        await write(
          { address: token, abi: kaziTokenAbi, functionName: "approve", args: [gate, amount] },
          (hash) => apply({ type: "sent", key: "approve", hash }),
        );
        apply({ type: "done", key: "approve" });
      }
      current = kind;
      apply({ type: "wallet", key: kind });
      await write(
        { address: gate, abi: kaziCreditsGateAbi, functionName: kind, args: [amount] },
        (hash) => apply({ type: "sent", key: kind, hash }),
      );
      apply({ type: "done", key: kind });
      setValue("");
      onDone();
    } catch (err) {
      apply({
        type: "error",
        key: current,
        error: isUserRejection(err) ? undefined : errorMessage(err),
      });
    }
  }

  const id = `credits-${kind}-amount`;
  return (
    <Card>
      <h3 className="font-display text-lg font-bold">
        {kind === "lock" ? t("lockTitle") : t("unlockTitle")}
      </h3>
      <div className="mt-3 space-y-4">
        <Field
          label={kind === "lock" ? t("amountKazi") : t("amountCredits")}
          htmlFor={id}
          error={errorText}
          hint={hint}
        >
          <div className="flex gap-2">
            <Input
              id={id}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.0"
              value={value}
              disabled={disabled || busy}
              onChange={(e) => {
                setValue(e.target.value);
                if (!busy) setSteps(initSteps(keys));
              }}
            />
            <Button
              variant="outline"
              disabled={disabled || busy || balance === 0n}
              onClick={() => setValue(formatUnits(balance, decimals))}
            >
              {ts("max")}
            </Button>
          </div>
        </Field>
        <TxStepper
          steps={steps}
          labels={
            kind === "lock"
              ? {
                  approve: t("stepApproveKazi", { amount: label }),
                  lock: t("stepLock", { amount: label }),
                }
              : {
                  approve: t("stepApproveCredits", { amount: label }),
                  unlock: t("stepUnlock", { amount: label }),
                }
          }
        />
        <Button
          variant={kind === "lock" ? "accent" : "outline"}
          loading={busy}
          disabled={disabled || amount === null || Boolean(error) || amount === 0n}
          onClick={() => void run()}
        >
          {kind === "lock" ? t("lockCta") : t("unlockCta")}
        </Button>
      </div>
    </Card>
  );
}
