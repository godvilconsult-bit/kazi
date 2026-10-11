"use client";

import { use, useEffect, useReducer, useState, type ReactNode } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useReadContracts } from "wagmi";
import { keccak256, stringToHex } from "viem";
import { ArrowLeft, KeyRound, Play } from "lucide-react";
import {
  agentRegistryAbi,
  kaziTokenAbi,
  nanoToUsd,
  stakingVaultAbi,
  type HostedConfig,
} from "@kazi/shared";
import { api, errorMessage } from "@/lib/api";
import { relativeTime, shortAddress, tokenAmount, usdc } from "@/lib/format";
import { useTx } from "@/lib/tx";
import { initSteps, isBusy, isUserRejection, stepsReducer } from "@/lib/tx-steps";
import type {
  ProviderOwner,
  ProviderStats,
  ProviderSubmission,
  ProviderTestState,
} from "@/lib/types";
import { KindBadge } from "@/components/agent-card";
import { useAuth } from "@/components/auth";
import { useKaziConfig, useTokenName } from "@/components/config";
import { PageBody } from "@/components/container";
import { CopyButton, Usdc } from "@/components/money";
import { Markdown } from "@/components/output-viewer";
import { RequireAuth } from "@/components/require-auth";
import { ReputationChart } from "@/components/reputation-chart";
import { ProviderStatusBadge } from "@/components/status";
import { TxStepper } from "@/components/tx-stepper";
import { ConnectWalletButton } from "@/components/wallet";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Notice,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";

// On by default since Phase 6; NEXT_PUBLIC_FEATURE_BOND=0 shows the pre-launch notice instead.
const BOND_ENABLED = process.env["NEXT_PUBLIC_FEATURE_BOND"] !== "0";

export default function ProviderDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <PageBody>
      <RequireAuth>
        <Dashboard id={id} />
      </RequireAuth>
    </PageBody>
  );
}

function Dashboard({ id }: { id: string }) {
  const t = useTranslations("dashboard");
  const tp = useTranslations("provider");
  const q = useQuery({
    queryKey: ["provider", id],
    queryFn: () => api<{ provider: ProviderOwner }>(`/me/providers/${id}`).then((r) => r.provider),
    refetchInterval: (query) =>
      query.state.data &&
      (query.state.data.onchainId === null || query.state.data.hostedAdvice?.status === "RUNNING")
        ? 6_000
        : false,
  });
  const p = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!p) return <EmptyState title={tp("empty")} />;
  return (
    <div className="space-y-6">
      <Link
        href="/provider"
        className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" />
        {t("back")}
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            <KindBadge kind={p.kind} hosting={p.hosting} />
            <ProviderStatusBadge status={p.status} />
          </div>
          <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight break-words sm:text-4xl">
            {p.name}
          </h1>
          {p.status === "PENDING" ? (
            <p className="mt-1 text-sm text-muted">{t("reviewNote")}</p>
          ) : null}
        </div>
        {p.kind === "HUMAN" ? (
          <Link href="/freelancer/offers" className="text-sm font-semibold text-accent underline">
            {tp("offers")}
          </Link>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 space-y-6">
          <Stats id={id} />
          {p.status !== "PENDING" ? <ReputationCard slug={p.slug} /> : null}
          {p.hosting === "KAZI" ? <HostedSettings p={p} /> : null}
          {p.kind === "AGENT" && p.hosting === "SELF" ? <TestConsole p={p} /> : null}
          <Submissions id={id} />
        </div>
        <aside className="space-y-6">
          <Onchain p={p} />
          {p.onchainId ? (
            BOND_ENABLED ? (
              <Bond p={p} />
            ) : (
              <Notice tone="info">{t("bondMock")}</Notice>
            )
          ) : null}
          {p.kind === "AGENT" && p.hosting === "SELF" ? <Secret id={id} /> : null}
        </aside>
      </div>
    </div>
  );
}

function Stats({ id }: { id: string }) {
  const t = useTranslations("dashboard");
  const q = useQuery({
    queryKey: ["provider", id, "stats"],
    queryFn: () => api<{ stats: ProviderStats }>(`/providers/${id}/stats`).then((r) => r.stats),
  });
  const s = q.data;
  return (
    <Card>
      <h2 className="font-display text-lg font-bold">{t("stats")}</h2>
      {s ? (
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label={t("earnings")} value={<Usdc value={s.earningsGross} />} />
          <Stat label={t("completed")} value={s.completedCount} />
          <Stat label={t("failed")} value={s.failedCount} />
          <Stat
            label={t("successRate")}
            value={s.successRateBps === null ? "—" : `${(s.successRateBps / 100).toFixed(1)}%`}
          />
          <Stat
            label={t("latency")}
            value={s.avgLatencyMs === null ? "—" : `${Math.round(s.avgLatencyMs / 1000)} s`}
          />
          <Stat label={t("reputation")} value={s.reputation.toFixed(0)} />
        </dl>
      ) : (
        <Skeleton className="mt-4 h-20" />
      )}
    </Card>
  );
}

function ReputationCard({ slug }: { slug: string }) {
  const t = useTranslations("agent");
  const q = useQuery({
    queryKey: ["provider", slug, "reputation"],
    queryFn: () =>
      api<{ points: { value: number; createdAt: string }[] }>(`/providers/${slug}/reputation`).then(
        (r) => r.points,
      ),
  });
  return (
    <Card>
      <h2 className="font-display text-lg font-bold">{t("history")}</h2>
      <div className="mt-3">
        <ReputationChart
          points={q.data ?? []}
          emptyLabel={t("historyEmpty")}
          ariaLabel={t("historyAria")}
        />
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</dt>
      <dd className="num mt-1 text-xl font-bold">{value}</dd>
    </div>
  );
}

/** Register in AgentRegistry from the owner's wallet; the indexer links it to this listing. */
function Onchain({ p }: { p: ProviderOwner }) {
  const t = useTranslations("dashboard");
  const cfg = useKaziConfig();
  const { user } = useAuth();
  const { address } = useAccount();
  const { write } = useTx();
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const rightWallet = Boolean(
    address && user && address.toLowerCase() === user.wallet.toLowerCase(),
  );

  if (p.onchainId) return <Notice tone="ok">{t("registered", { id: p.onchainId })}</Notice>;
  return (
    <Card>
      <h2 className="font-display text-lg font-bold">{t("onchainTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("onchainBody")}</p>
      {!address ? <ConnectWalletButton className="mt-3" /> : null}
      {address && !rightWallet && user ? (
        <Notice tone="warn" className="mt-3">
          {t("wrongWallet", { wallet: shortAddress(user.wallet) })}
        </Notice>
      ) : null}
      {state === "sent" ? (
        <Notice tone="info" className="mt-3">
          {t("registering")}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="bad" className="mt-3">
          {error}
        </Notice>
      ) : null}
      <Button
        className="mt-4"
        loading={state === "busy"}
        disabled={!rightWallet || !cfg.contracts.agentRegistry || state === "sent"}
        onClick={async () => {
          if (!cfg.contracts.agentRegistry) return;
          setError(null);
          setState("busy");
          try {
            await write({
              address: cfg.contracts.agentRegistry,
              abi: agentRegistryAbi,
              functionName: "register",
              args: [
                p.kind === "HUMAN" ? 1 : 0,
                p.payoutAddress,
                `kazi://providers/${p.id}`,
                keccak256(stringToHex(p.id)),
              ],
            });
            setState("sent");
          } catch (err) {
            setState("idle");
            if (!isUserRejection(err)) setError(errorMessage(err));
          }
        }}
      >
        {t("register")}
      </Button>
    </Card>
  );
}

/** $KAZI bond: approve exactly what's missing, then StakingVault.bond (docs/08-TOKENOMICS.md §2). */
function Bond({ p }: { p: ProviderOwner }) {
  const t = useTranslations("dashboard");
  const cfg = useKaziConfig();
  const tokenLabel = useTokenName();
  const { address } = useAccount();
  const { write } = useTx();
  const [steps, dispatch] = useReducer(stepsReducer, initSteps(["approve", "bond"]));
  const [error, setError] = useState<string | null>(null);
  const reg = cfg.contracts.agentRegistry;
  const vault = cfg.contracts.stakingVault;
  const token = cfg.contracts.kaziToken;
  const reads = useReadContracts({
    contracts:
      reg && vault && token && p.onchainId && address
        ? [
            {
              address: reg,
              abi: agentRegistryAbi,
              functionName: "minStake",
              args: [p.kind === "HUMAN" ? 1 : 0],
            },
            {
              address: vault,
              abi: stakingVaultAbi,
              functionName: "stakedOf",
              args: [BigInt(p.onchainId)],
            },
            {
              address: token,
              abi: kaziTokenAbi,
              functionName: "allowance",
              args: [address, vault],
            },
          ]
        : [],
    query: {
      enabled: Boolean(reg && vault && token && p.onchainId && address),
      refetchInterval: 15_000,
    },
  });
  const decimals = cfg.kaziDecimals ?? 18;
  const min = reads.data?.[0]?.status === "success" ? (reads.data[0].result as bigint) : null;
  const staked = reads.data?.[1]?.status === "success" ? (reads.data[1].result as bigint) : null;
  const allowance = reads.data?.[2]?.status === "success" ? (reads.data[2].result as bigint) : 0n;
  const need = min !== null && staked !== null && staked < min ? min - staked : 0n;
  const amount = tokenAmount(need, decimals, 0);
  // No bond on this network (minimum 0, e.g. testnet listings reviewed by Kazi): nothing to show.
  if (!vault || !token || !p.onchainId || min === 0n) return null;
  return (
    <Card>
      <h2 className="font-display text-lg font-bold">{t("bondTitle")}</h2>
      <p className="mt-1 text-sm text-muted">
        {t("bondBody", {
          amount: min !== null ? tokenAmount(min, decimals, 0) : "…",
          token: tokenLabel,
        })}
      </p>
      {staked !== null ? (
        <p className="mt-2 font-mono text-sm">
          {t("bondCurrent", { amount: tokenAmount(staked, decimals, 0), token: tokenLabel })}
        </p>
      ) : null}
      {need > 0n ? (
        <>
          <div className="mt-4">
            <TxStepper
              steps={steps}
              labels={{
                approve: t("bondApprove", { amount, token: tokenLabel }),
                bond: t("bondSend", { amount, token: tokenLabel }),
              }}
            />
          </div>
          {error ? (
            <Notice tone="bad" className="mt-3">
              {error}
            </Notice>
          ) : null}
          <Button
            className="mt-4"
            loading={isBusy(steps)}
            onClick={async () => {
              setError(null);
              let current: "approve" | "bond" = "approve";
              try {
                if (allowance >= need) dispatch({ type: "skip", key: "approve" });
                else {
                  dispatch({ type: "wallet", key: "approve" });
                  await write(
                    {
                      address: token,
                      abi: kaziTokenAbi,
                      functionName: "approve",
                      args: [vault, need],
                    },
                    (hash) => dispatch({ type: "sent", key: "approve", hash }),
                  );
                  dispatch({ type: "done", key: "approve" });
                }
                current = "bond";
                dispatch({ type: "wallet", key: "bond" });
                await write(
                  {
                    address: vault,
                    abi: stakingVaultAbi,
                    functionName: "bond",
                    args: [BigInt(p.onchainId ?? "0"), need],
                  },
                  (hash) => dispatch({ type: "sent", key: "bond", hash }),
                );
                dispatch({ type: "done", key: "bond" });
                void reads.refetch();
              } catch (err) {
                dispatch({
                  type: "error",
                  key: current,
                  error: isUserRejection(err) ? undefined : errorMessage(err),
                });
              }
            }}
          >
            {t("bondCta")}
          </Button>
        </>
      ) : null}
    </Card>
  );
}

function Secret({ id }: { id: string }) {
  const t = useTranslations("dashboard");
  const [secret, setSecret] = useState<string | null>(null);
  const rotate = useMutation({
    mutationFn: () =>
      api<{ webhookSecret: string }>(`/providers/${id}/rotate-secret`, { method: "POST" }),
    onSuccess: (r) => setSecret(r.webhookSecret),
  });
  return (
    <Card>
      <h2 className="flex items-center gap-2 font-display text-lg font-bold">
        <KeyRound className="size-4" />
        {t("secretTitle")}
      </h2>
      {secret ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-warn bg-warn-soft px-3 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-xs">{secret}</code>
          <CopyButton value={secret} />
        </div>
      ) : null}
      {rotate.error ? (
        <Notice tone="bad" className="mt-3">
          {errorMessage(rotate.error)}
        </Notice>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        loading={rotate.isPending}
        onClick={() => {
          if (window.confirm(t("rotateConfirm"))) rotate.mutate();
        }}
      >
        {t("rotate")}
      </Button>
    </Card>
  );
}

/** Dry run against the developer's endpoint (POST /providers/:id/test), polled until final. */
function TestConsole({ p }: { p: ProviderOwner }) {
  const t = useTranslations("dashboard");
  const [capability, setCapability] = useState(p.capabilities[0] ?? "");
  const [text, setText] = useState("");
  const [testId, setTestId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      api<{ test: ProviderTestState }>(`/providers/${p.id}/test`, {
        method: "POST",
        body: { capability, ...(text.trim() ? { text: text.trim() } : {}) },
      }),
    onSuccess: (r) => setTestId(r.test.testId),
  });
  const state = useQuery({
    queryKey: ["provider", p.id, "test", testId],
    queryFn: () =>
      api<{ test: ProviderTestState }>(`/providers/${p.id}/tests/${testId}`).then((r) => r.test),
    enabled: Boolean(testId),
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === "COMPLETED" || q.state.data.status === "FAILED")
        ? false
        : 2_000,
  });
  const s = state.data;
  return (
    <Card>
      <h2 className="font-display text-lg font-bold">{t("testTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("testBody")}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_2fr]">
        <Field label={t("testCapability")} htmlFor="t-cap">
          <Select id="t-cap" value={capability} onChange={(e) => setCapability(e.target.value)}>
            {p.capabilities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("testText")} htmlFor="t-text">
          <Textarea id="t-text" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
      <Button className="mt-3" loading={start.isPending} onClick={() => start.mutate()}>
        <Play className="size-4" />
        {t("testRun")}
      </Button>
      {start.error ? (
        <Notice tone="bad" className="mt-3">
          {errorMessage(start.error)}
        </Notice>
      ) : null}
      {s ? (
        <div className="mt-4 space-y-3 rounded-lg border border-line bg-surface-2/50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={s.status === "COMPLETED" ? "ok" : s.status === "FAILED" ? "bad" : "info"}>
              {t(`testStatus${s.status}`)}
            </Badge>
            {s.latencyMs !== undefined && s.http !== undefined ? (
              <span className="font-mono text-xs text-muted">
                {t("testLatency", { ms: s.latencyMs, http: s.http })}
              </span>
            ) : null}
          </div>
          {s.error ? (
            <p className="text-sm text-bad">
              {s.error.code}: {s.error.message}
            </p>
          ) : null}
          {s.checks ? (
            s.checks.length === 0 ? (
              <p className="text-sm text-ok">{t("testChecksOk")}</p>
            ) : (
              <div className="text-sm text-bad">
                {t("testChecksFailed")}
                <ul className="list-disc ps-5">
                  {s.checks.map((c) => (
                    <li key={c.code}>{c.message}</li>
                  ))}
                </ul>
              </div>
            )
          ) : null}
          {s.output?.text ? (
            <div className="max-h-80 overflow-y-auto rounded-lg border border-line bg-surface p-3 text-sm">
              <Markdown>{s.output.text}</Markdown>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function HostedSettings({ p }: { p: ProviderOwner }) {
  const t = useTranslations("dashboard");
  const tw = useTranslations("wizard");
  const qc = useQueryClient();
  const locale = useLocale();
  const cfg = p.hostedConfig;
  const [instructions, setInstructions] = useState(cfg?.instructions ?? "");
  const [model, setModel] = useState<HostedConfig["model"]>(cfg?.model ?? "claude-sonnet-5-5");
  const [effort, setEffort] = useState<HostedConfig["effort"]>(cfg?.effort ?? "medium");
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [instructions, model, effort]);
  const save = useMutation({
    mutationFn: () =>
      api(`/providers/${p.id}`, {
        method: "PATCH",
        body: {
          hostedConfig: {
            instructions: instructions.trim(),
            model,
            effort,
            webSearch: model === "claude-haiku-5-5" ? null : (cfg?.webSearch ?? null),
            maxOutputTokens: cfg?.maxOutputTokens ?? 32_000,
            samples: cfg?.samples ?? [],
          },
        },
      }),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ["provider", p.id] });
    },
  });
  const advise = useMutation({
    mutationFn: () => api(`/providers/${p.id}/advise`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["provider", p.id] }),
  });
  const advice = p.hostedAdvice;
  return (
    <>
      <Card>
        <h2 className="font-display text-lg font-bold">{t("hostedTitle")}</h2>
        <Field
          label={tw("instructions")}
          hint={tw("instructionsHint")}
          className="mt-3"
          htmlFor="h-instr"
        >
          <Textarea
            id="h-instr"
            rows={8}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label={tw("model")} htmlFor="h-model">
            <Select
              id="h-model"
              value={model}
              onChange={(e) => setModel(e.target.value as HostedConfig["model"])}
            >
              <option value="claude-opus-5-5">{tw("modelOpus")}</option>
              <option value="claude-sonnet-5-5">{tw("modelSonnet")}</option>
              <option value="claude-haiku-5-5">{tw("modelHaiku")}</option>
            </Select>
          </Field>
          <Field label={tw("effort")} htmlFor="h-effort">
            <Select
              id="h-effort"
              value={effort}
              onChange={(e) => setEffort(e.target.value as HostedConfig["effort"])}
            >
              <option value="low">{tw("effortLow")}</option>
              <option value="medium">{tw("effortMedium")}</option>
              <option value="high">{tw("effortHigh")}</option>
            </Select>
          </Field>
        </div>
        {save.error ? (
          <Notice tone="bad" className="mt-3">
            {errorMessage(save.error)}
          </Notice>
        ) : null}
        {saved ? (
          <Notice tone="ok" className="mt-3">
            {t("hostedSaved")}
          </Notice>
        ) : null}
        <Button
          className="mt-4"
          loading={save.isPending}
          disabled={instructions.trim().length < 50}
          onClick={() => save.mutate()}
        >
          {t("hostedSave")}
        </Button>
      </Card>

      <Card>
        <h2 className="font-display text-lg font-bold">{t("adviceTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t("adviceBody")}</p>
        {p.aiCostUsd ? (
          <div className="mt-3 rounded-lg border border-line bg-surface-2/50 p-3 text-sm">
            <p className="font-semibold">{t("costTitle")}</p>
            <p className="num">
              {t("costEconomy", { amount: p.aiCostUsd.economy })} ·{" "}
              {t("costExpress", { amount: p.aiCostUsd.express })}
            </p>
            <p className="text-xs text-muted">{t("costNote")}</p>
          </div>
        ) : null}
        {advice?.status === "RUNNING" ? (
          <Notice tone="info" className="mt-3">
            {t("adviceRunning")}
          </Notice>
        ) : advice && advice.rows.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="py-2 pe-3">{t("adviceModel")}</th>
                  <th className="py-2 pe-3">{t("advicePass")}</th>
                  <th className="py-2 pe-3">{t("adviceScore")}</th>
                  <th className="py-2 pe-3">{t("adviceEconomy")}</th>
                  <th className="py-2">{t("adviceExpress")}</th>
                </tr>
              </thead>
              <tbody className="num">
                {advice.rows.map((r) => (
                  <tr key={r.model} className="border-t border-dashed border-line">
                    <td className="py-2 pe-3 font-sans font-semibold">
                      {r.model.replace("claude-", "")}
                    </td>
                    <td className="py-2 pe-3">
                      {r.passed}/{r.runs}
                    </td>
                    <td className="py-2 pe-3">{r.avgScore.toFixed(0)}</td>
                    <td className="py-2 pe-3">${nanoToUsd(BigInt(r.economyNano))}</td>
                    <td className="py-2">${nanoToUsd(BigInt(r.expressNano))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {advice.finishedAt ? (
              <p className="mt-2 font-mono text-[11px] text-muted">
                {relativeTime(advice.finishedAt, locale)}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">{t("adviceNone")}</p>
        )}
        {advise.error ? (
          <Notice tone="bad" className="mt-3">
            {errorMessage(advise.error)}
          </Notice>
        ) : null}
        <Button
          className="mt-4"
          variant="outline"
          loading={advise.isPending}
          disabled={advice?.status === "RUNNING"}
          onClick={() => advise.mutate()}
        >
          {t("adviceRun")}
        </Button>
      </Card>
    </>
  );
}

function Submissions({ id }: { id: string }) {
  const t = useTranslations("dashboard");
  const locale = useLocale();
  const cfg = useKaziConfig();
  const q = useQuery({
    queryKey: ["provider", id, "submissions"],
    queryFn: () =>
      api<{ submissions: ProviderSubmission[] }>(`/providers/${id}/submissions`).then(
        (r) => r.submissions,
      ),
  });
  return (
    <Card>
      <h2 className="font-display text-lg font-bold">{t("submissions")}</h2>
      {!q.data ? (
        <Skeleton className="mt-3 h-20" />
      ) : q.data.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{t("noSubmissions")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-dashed divide-line">
          {q.data.map((s) => (
            <li key={s.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">{s.step}</p>
                <div className="flex items-center gap-2">
                  {s.score !== null ? (
                    <span className="num text-xs">{Math.round(s.score)}/100</span>
                  ) : null}
                  {s.accepted === true ? (
                    <Badge tone="ok">{t("accepted")}</Badge>
                  ) : s.accepted === false ? (
                    <Badge tone="bad">{t("rejected")}</Badge>
                  ) : null}
                </div>
              </div>
              <p className="mt-0.5 font-mono text-[11px] text-muted">
                {s.capability} · {usdc(s.amount, cfg.usdcDecimals).display} USDC ·{" "}
                {relativeTime(s.createdAt, locale)}
              </p>
              {s.feedback ? (
                <p className="mt-1 text-muted">
                  <span className="font-semibold text-ink">{t("feedback")}: </span>
                  {String(s.feedback).slice(0, 600)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
