"use client";

import { useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContracts } from "wagmi";
import { formatUnits, kaziTokenAbi, stakingVaultAbi } from "@kazi/shared";
import { api, errorMessage } from "@/lib/api";
import {
  durationLabel,
  formatDate,
  parseTokenInput,
  toBigInt,
  tokenAmount,
  usdc,
} from "@/lib/format";
import {
  amountError,
  holderKey,
  needsApproval,
  sharePct,
  stakePosition,
  type AmountError,
  type VaultAccount,
} from "@/lib/staking";
import { useTx } from "@/lib/tx";
import {
  initSteps,
  isBusy,
  isUserRejection,
  stepsReducer,
  type StepAction,
  type TxStep,
} from "@/lib/tx-steps";
import type { Address, StakingInfo } from "@/lib/types";
import { useNowSeconds } from "@/lib/use-now";
import { useKaziConfig, useTokenName } from "@/components/config";
import { PageBody } from "@/components/container";
import { CreditsExchange } from "@/components/credits-exchange";
import { GeoNotice, useGeo } from "@/components/geo";
import { Usdc } from "@/components/money";
import { TxButton } from "@/components/tx-button";
import { TxStepper } from "@/components/tx-stepper";
import {
  ButtonLink,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  Notice,
  PageHeader,
  Skeleton,
} from "@/components/ui";
import { ConnectWalletButton } from "@/components/wallet";

type Info = Extract<StakingInfo, { deployed: true }>;
const STAKE_STEPS = ["approve", "stake"] as const;

/**
 * Holder staking (docs/08-TOKENOMICS.md §2): stake with an exact approval, request an unstake, withdraw
 * after the cooldown, claim USDC rewards. Rewards are shown as realized over the last 30 days — never as
 * a projected APR. Visitors from restricted regions can't add stake but can always exit and claim.
 */
export default function StakePage() {
  const t = useTranslations("stake");
  const tc = useTranslations("common");
  const nav = useTranslations("nav");
  const locale = useLocale();
  const cfg = useKaziConfig();
  const tokenLabel = useTokenName();
  const info = useQuery({
    queryKey: ["token", "staking"],
    queryFn: () => api<StakingInfo>("/token/staking"),
    refetchInterval: 5 * 60_000,
  });
  const vault = cfg.contracts.stakingVault;
  const token = cfg.contracts.kaziToken;
  const i = info.data?.deployed ? info.data : null;
  const unavailable =
    !vault || !token || cfg.kaziDecimals === null || info.data?.deployed === false;

  return (
    <PageBody>
      <PageHeader
        kicker={t("kicker")}
        title={t("title", { token: tokenLabel })}
        actions={
          <ButtonLink href="/token" variant="outline">
            {nav("token")}
          </ButtonLink>
        }
      >
        {i
          ? t("intro", {
              share: sharePct(i.stakerBps),
              warmup: durationLabel(i.warmupSeconds, locale),
              cooldown: durationLabel(i.cooldownSeconds, locale),
            })
          : null}
      </PageHeader>
      <GeoNotice className="mb-6" />
      {unavailable ? (
        <Notice tone="info">{t("notDeployed")}</Notice>
      ) : info.isLoading ? (
        <Skeleton className="h-64" />
      ) : info.error || !i || !vault || !token || cfg.kaziDecimals === null ? (
        <ErrorState
          title={tc("error")}
          message={info.error ? errorMessage(info.error) : undefined}
          onRetry={() => void info.refetch()}
          retryLabel={tc("retry")}
        />
      ) : (
        <div className="space-y-6">
          {i.stakerBps === 0 ? <Notice tone="warn">{t("shareOff")}</Notice> : null}
          <Realized info={i} />
          <Wallet vault={vault} token={token} info={i} decimals={cfg.kaziDecimals} />
        </div>
      )}
    </PageBody>
  );
}

function Realized({ info }: { info: Info }) {
  const t = useTranslations("stake");
  const cfg = useKaziConfig();
  const tokenLabel = useTokenName();
  return (
    <Card>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t("realized")}</p>
      {toBigInt(info.rewards30d) > 0n ? (
        <p className="num mt-1 text-2xl font-bold">
          {t("per1000", {
            amount: usdc(info.per1000Kazi30d, cfg.usdcDecimals).display,
            token: tokenLabel,
          })}
        </p>
      ) : (
        <p className="mt-1 font-semibold">{t("noRewards")}</p>
      )}
      <p className="mt-2 text-xs text-muted">{t("noApr")}</p>
    </Card>
  );
}

function Wallet({
  vault,
  token,
  info,
  decimals,
}: {
  vault: Address;
  token: Address;
  info: Info;
  decimals: number;
}) {
  const t = useTranslations("stake");
  const { address } = useAccount();
  if (!address) {
    return (
      <Card>
        <p className="font-semibold">{t("connect")}</p>
        <ConnectWalletButton className="mt-3" />
      </Card>
    );
  }
  return <Position address={address} vault={vault} token={token} info={info} decimals={decimals} />;
}

function Position({
  address,
  vault,
  token,
  info,
  decimals,
}: {
  address: Address;
  vault: Address;
  token: Address;
  info: Info;
  decimals: number;
}) {
  const t = useTranslations("stake");
  const locale = useLocale();
  const cfg = useKaziConfig();
  const tokenLabel = useTokenName();
  const geo = useGeo();
  const { write } = useTx();
  const now = useNowSeconds();
  const key = holderKey(address);
  const gate = cfg.contracts.creditsGate;
  const argusKazi = cfg.contracts.argusKazi;
  const reads = useReadContracts({
    contracts: [
      { address: token, abi: kaziTokenAbi, functionName: "balanceOf", args: [address] },
      { address: token, abi: kaziTokenAbi, functionName: "allowance", args: [address, vault] },
      { address: vault, abi: stakingVaultAbi, functionName: "getAccount", args: [key] },
      { address: vault, abi: stakingVaultAbi, functionName: "earned", args: [key] },
    ],
    query: { refetchInterval: 15_000 },
  });
  const r = reads.data;
  if (reads.isLoading || !r) return <Skeleton className="h-64" />;
  if (r.some((x) => x.status !== "success")) {
    return <ErrorState title={t("notDeployed")} onRetry={() => void reads.refetch()} />;
  }
  const balance = r[0].result as bigint;
  const allowance = r[1].result as bigint;
  const account = r[2].result as VaultAccount;
  const earned = r[3].result as bigint;
  const pos = stakePosition(account, now, info.warmupSeconds);
  const kazi = (v: bigint) => tokenAmount(v, decimals, 2);
  const refresh = () => void reads.refetch();

  return (
    <div className="space-y-6">
      {gate && argusKazi ? (
        <CreditsExchange
          address={address}
          gate={gate}
          kazi={argusKazi}
          credits={token}
          decimals={decimals}
          restricted={geo.restricted}
          onDone={refresh}
        />
      ) : null}
      <section>
        <h2 className="mb-3 font-display text-xl font-bold">{t("positionTitle")}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={t("balance")} value={kazi(balance)} unit={tokenLabel} />
          <Stat label={t("staked")} value={kazi(pos.active)} unit={tokenLabel} />
          <Stat
            label={t("warming")}
            value={kazi(pos.warming)}
            unit={tokenLabel}
            sub={
              pos.warmUntil !== null && !pos.needsActivation
                ? t("readyAt", { time: formatDate(new Date(pos.warmUntil * 1000), locale) })
                : undefined
            }
          />
          <Stat
            label={t("unbonding")}
            value={kazi(pos.unbonding)}
            unit={tokenLabel}
            sub={
              pos.unbondReadyAt !== null
                ? t("readyAt", { time: formatDate(new Date(pos.unbondReadyAt * 1000), locale) })
                : undefined
            }
          />
        </div>
      </section>

      {pos.needsActivation ? (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold">{t("needsActivation")}</p>
          <TxButton
            size="sm"
            run={(onHash) =>
              write(
                { address: vault, abi: stakingVaultAbi, functionName: "poke", args: [[key]] },
                onHash,
              )
            }
            onDone={refresh}
          >
            {t("activateCta")}
          </TxButton>
        </Card>
      ) : null}

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t("claimable")}
          </p>
          <p className="mt-1 text-xl font-bold">
            <Usdc value={earned} />
          </p>
        </div>
        {earned > 0n ? (
          <TxButton
            variant="ok"
            run={(onHash) =>
              write(
                { address: vault, abi: stakingVaultAbi, functionName: "claim", args: [] },
                onHash,
              )
            }
            onDone={refresh}
          >
            <ClaimLabel amount={earned} />
          </TxButton>
        ) : null}
      </Card>

      {pos.unbonding > 0n ? (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">
              {t("unbonding")}
            </p>
            {!pos.canWithdraw && pos.unbondReadyAt !== null ? (
              <p className="mt-1 text-sm">
                {t("readyAt", { time: formatDate(new Date(pos.unbondReadyAt * 1000), locale) })}
              </p>
            ) : null}
          </div>
          <TxButton
            disabled={!pos.canWithdraw}
            run={(onHash) =>
              write(
                { address: vault, abi: stakingVaultAbi, functionName: "withdraw", args: [] },
                onHash,
              )
            }
            onDone={refresh}
          >
            {t("withdrawCta", { amount: kazi(pos.unbonding), token: tokenLabel })}
          </TxButton>
        </Card>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <StakeForm
          vault={vault}
          token={token}
          balance={balance}
          allowance={allowance}
          decimals={decimals}
          restricted={geo.restricted}
          onDone={refresh}
        />
        <UnstakeForm
          vault={vault}
          max={pos.unstakeable}
          unbonding={pos.unbonding}
          cooldown={info.cooldownSeconds}
          decimals={decimals}
          onDone={refresh}
        />
      </div>
    </div>
  );
}

function ClaimLabel({ amount }: { amount: bigint }) {
  const t = useTranslations("stake");
  const cfg = useKaziConfig();
  return <>{t("claimCta", { amount: usdc(amount, cfg.usdcDecimals).display })}</>;
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
  sub?: string | undefined;
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

function AmountField({
  id,
  label,
  value,
  onChange,
  max,
  decimals,
  error,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: bigint;
  decimals: number;
  error: AmountError | null;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const t = useTranslations("stake");
  const errorText =
    error === "invalid"
      ? t("errInvalid")
      : error === "zero"
        ? t("errZero")
        : error === "tooMuch"
          ? t("errTooMuch")
          : undefined;
  return (
    <Field label={label} htmlFor={id} error={errorText} hint={hint}>
      <div className="flex gap-2">
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          variant="outline"
          disabled={disabled || max === 0n}
          onClick={() => onChange(formatUnits(max, decimals))}
        >
          {t("max")}
        </Button>
      </div>
    </Field>
  );
}

/** approve (exact amount, skipped when the allowance covers it) → stake. */
function StakeForm({
  vault,
  token,
  balance,
  allowance,
  decimals,
  restricted,
  onDone,
}: {
  vault: Address;
  token: Address;
  balance: bigint;
  allowance: bigint;
  decimals: number;
  restricted: boolean;
  onDone: () => void;
}) {
  const t = useTranslations("stake");
  const tokenLabel = useTokenName();
  const { write } = useTx();
  const [value, setValue] = useState("");
  const [steps, setSteps] = useState<TxStep[]>(() => initSteps(STAKE_STEPS));
  const apply = (action: StepAction) => setSteps((s) => stepsReducer(s, action));
  const amount = parseTokenInput(value, decimals);
  const error = value.trim() === "" ? null : amountError(amount, balance);
  const busy = isBusy(steps);
  const label = amount && !error ? tokenAmount(amount, decimals, 2) : "…";

  async function run() {
    if (amount === null || error) return;
    setSteps(initSteps(STAKE_STEPS));
    let current: (typeof STAKE_STEPS)[number] = "approve";
    try {
      if (!needsApproval(allowance, amount)) apply({ type: "skip", key: "approve" });
      else {
        apply({ type: "wallet", key: "approve" });
        await write(
          { address: token, abi: kaziTokenAbi, functionName: "approve", args: [vault, amount] },
          (hash) => apply({ type: "sent", key: "approve", hash }),
        );
        apply({ type: "done", key: "approve" });
      }
      current = "stake";
      apply({ type: "wallet", key: "stake" });
      await write(
        { address: vault, abi: stakingVaultAbi, functionName: "stake", args: [amount] },
        (hash) => apply({ type: "sent", key: "stake", hash }),
      );
      apply({ type: "done", key: "stake" });
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

  return (
    <Card>
      <h3 className="font-display text-lg font-bold">{t("stakeTitle")}</h3>
      <div className="mt-3 space-y-4">
        <AmountField
          id="stake-amount"
          label={t("amount", { token: tokenLabel })}
          value={value}
          onChange={(v) => {
            setValue(v);
            if (!busy) setSteps(initSteps(STAKE_STEPS));
          }}
          max={balance}
          decimals={decimals}
          error={error}
          disabled={restricted || busy}
        />
        <TxStepper
          steps={steps}
          labels={{
            approve: t("stepApprove", { amount: label, token: tokenLabel }),
            stake: t("stepStake", { amount: label, token: tokenLabel }),
          }}
        />
        <Button
          variant="accent"
          loading={busy}
          disabled={restricted || amount === null || Boolean(error) || amount === 0n}
          onClick={() => void run()}
        >
          {t("stakeCta")}
        </Button>
      </div>
    </Card>
  );
}

/** requestUnstake moves stake into the cooldown bucket (warming stake first). Never geo-restricted. */
function UnstakeForm({
  vault,
  max,
  unbonding,
  cooldown,
  decimals,
  onDone,
}: {
  vault: Address;
  max: bigint;
  unbonding: bigint;
  cooldown: number;
  decimals: number;
  onDone: () => void;
}) {
  const t = useTranslations("stake");
  const tokenLabel = useTokenName();
  const locale = useLocale();
  const { write } = useTx();
  const [value, setValue] = useState("");
  const amount = parseTokenInput(value, decimals);
  const error = value.trim() === "" ? null : amountError(amount, max);
  return (
    <Card>
      <h3 className="font-display text-lg font-bold">{t("unstakeTitle")}</h3>
      <div className="mt-3 space-y-4">
        <AmountField
          id="unstake-amount"
          label={t("amount", { token: tokenLabel })}
          value={value}
          onChange={setValue}
          max={max}
          decimals={decimals}
          error={error}
          hint={t("unstakeHint", { cooldown: durationLabel(cooldown, locale) })}
          disabled={max === 0n}
        />
        {unbonding > 0n ? (
          <Notice tone="warn">
            {t("restartsCooldown", {
              amount: tokenAmount(unbonding, decimals, 2),
              token: tokenLabel,
            })}
          </Notice>
        ) : null}
        <TxButton
          variant="outline"
          disabled={amount === null || Boolean(error) || amount === 0n}
          run={(onHash) =>
            write(
              {
                address: vault,
                abi: stakingVaultAbi,
                functionName: "requestUnstake",
                args: [amount ?? 0n],
              },
              onHash,
            )
          }
          onDone={() => {
            setValue("");
            onDone();
          }}
        >
          {t("unstakeCta")}
        </TxButton>
      </div>
    </Card>
  );
}
