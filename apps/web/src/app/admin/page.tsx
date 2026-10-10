"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Hex } from "viem";
import { api, errorMessage } from "@/lib/api";
import { relativeTime, shortAddress } from "@/lib/format";
import { useTx } from "@/lib/tx";
import { isUserRejection } from "@/lib/tx-steps";
import { sharePct } from "@/lib/staking";
import type { AdminDispute, CalldataTx, FeeSplit, ProviderOwner } from "@/lib/types";
import { KindBadge } from "@/components/agent-card";
import { useKaziConfig } from "@/components/config";
import { PageBody } from "@/components/container";
import { AddressPill, CopyButton, TxLink, Usdc } from "@/components/money";
import { Markdown } from "@/components/output-viewer";
import { RequireAuth } from "@/components/require-auth";
import { StepStatusBadge } from "@/components/status";
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeader,
  Skeleton,
  Tabs,
  Textarea,
} from "@/components/ui";

type Tab = "providers" | "disputes" | "queues" | "reconciliation" | "token" | "settings";

export default function AdminPage() {
  const t = useTranslations("admin");
  const [tab, setTab] = useState<Tab>("providers");
  return (
    <PageBody>
      <PageHeader title={t("title")}>{t("freshLogin")}</PageHeader>
      <RequireAuth admin>
        <Tabs
          value={tab}
          onChange={setTab}
          className="mb-6"
          items={[
            { value: "providers", label: t("providers") },
            { value: "disputes", label: t("disputes") },
            { value: "queues", label: t("queues") },
            { value: "reconciliation", label: t("reconciliation") },
            { value: "token", label: t("token") },
            { value: "settings", label: t("settings") },
          ]}
        />
        {tab === "providers" ? <Providers /> : null}
        {tab === "disputes" ? <Disputes /> : null}
        {tab === "queues" ? <Queues /> : null}
        {tab === "reconciliation" ? (
          <div className="space-y-6">
            <EscrowStatus />
            <Reconciliation />
          </div>
        ) : null}
        {tab === "token" ? <TokenAdmin /> : null}
        {tab === "settings" ? <Settings /> : null}
      </RequireAuth>
    </PageBody>
  );
}

/** Onchain admin actions come back as calldata: sign with this wallet if it holds the role, or paste into the Safe. */
function CalldataActions({ txs, signer }: { txs: CalldataTx[]; signer: string }) {
  const t = useTranslations("admin");
  const cfg = useKaziConfig();
  const { send } = useTx();
  const [hashes, setHashes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const batch = JSON.stringify(
    {
      version: "1.0",
      chainId: String(cfg.chain.id),
      meta: { name: "Kazi admin action" },
      transactions: txs.map((x) => ({ to: x.to, value: x.value, data: x.data })),
    },
    null,
    2,
  );
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface-2/50 p-3">
      <p className="text-xs text-muted">{t("signerHint", { signer })}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          loading={busy}
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              for (const tx of txs) {
                const hash = await send({ to: tx.to, data: tx.data as Hex });
                setHashes((h) => [...h, hash]);
              }
            } catch (err) {
              if (!isUserRejection(err)) setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("sendTx")}
        </Button>
        <span className="inline-flex items-center gap-1 text-xs text-muted">
          {t("copyCalldata")} <CopyButton value={batch} />
        </span>
      </div>
      {hashes.map((h) => (
        <TxLink key={h} hash={h} label={t("txSent")} />
      ))}
      {error ? <p className="text-sm text-bad">{error}</p> : null}
    </div>
  );
}

function MaybeCalldata({ entry }: { entry: { txs: CalldataTx[]; signer: string } | undefined }) {
  return entry ? <CalldataActions txs={entry.txs} signer={entry.signer} /> : null;
}

function Providers() {
  const t = useTranslations("admin");
  const qc = useQueryClient();
  const [status, setStatus] = useState<"PENDING" | "ACTIVE" | "SUSPENDED">("PENDING");
  const q = useQuery({
    queryKey: ["admin", "providers", status],
    queryFn: () =>
      api<{ providers: (ProviderOwner & { ownerWallet: string; reviewScore: number | null })[] }>(
        `/admin/providers?status=${status}`,
      ).then((r) => r.providers),
  });
  const [calldata, setCalldata] = useState<Record<string, { txs: CalldataTx[]; signer: string }>>(
    {},
  );
  const [scores, setScores] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const action = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: "activate" | "suspend" }) =>
      api<{ tx: CalldataTx; signer: string }>(`/admin/providers/${id}/${kind}`, { method: "POST" }),
    onSuccess: (r, v) => setCalldata((c) => ({ ...c, [v.id]: { txs: [r.tx], signer: r.signer } })),
    onError: (err) => setError(errorMessage(err)),
  });
  const review = useMutation({
    mutationFn: ({ id, score }: { id: string; score: number }) =>
      api(`/admin/providers/${id}/review`, { method: "POST", body: { reviewScore: score } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "providers"] }),
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(["PENDING", "ACTIVE", "SUSPENDED"] as const).map((s) => (
          <Chip key={s} active={status === s} onClick={() => setStatus(s)}>
            {t(s === "PENDING" ? "pending" : s === "ACTIVE" ? "active" : "suspended")}
          </Chip>
        ))}
      </div>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : (q.data ?? []).length === 0 ? (
        <EmptyState title={t("noProviders")} />
      ) : (
        q.data?.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap gap-2">
                  <KindBadge kind={p.kind} hosting={p.hosting} />
                  {p.onchainId ? (
                    <Badge>#{p.onchainId}</Badge>
                  ) : (
                    <Badge tone="warn">offchain</Badge>
                  )}
                </div>
                <h3 className="mt-2 font-display text-lg font-bold">{p.name}</h3>
                <p className="mt-1 line-clamp-3 text-sm text-muted">{p.description}</p>
                <p className="mt-2 font-mono text-xs">{p.capabilities.join(", ")}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {t("owner")} <AddressPill address={p.ownerWallet} />
                </div>
                {p.endpointUrl ? (
                  <p className="mt-1 break-all font-mono text-xs text-muted">{p.endpointUrl}</p>
                ) : null}
              </div>
              <div className="flex items-end gap-2">
                <Field label={t("reviewScore")} htmlFor={`score-${p.id}`}>
                  <Input
                    id={`score-${p.id}`}
                    className="w-20"
                    inputMode="numeric"
                    value={scores[p.id] ?? p.reviewScore?.toString() ?? ""}
                    onChange={(e) => setScores((s) => ({ ...s, [p.id]: e.target.value }))}
                  />
                </Field>
                <Button
                  variant="outline"
                  size="sm"
                  className="mb-0.5"
                  onClick={() => {
                    const n = Number(scores[p.id]);
                    if (Number.isInteger(n) && n >= 0 && n <= 100)
                      review.mutate({ id: p.id, score: n });
                  }}
                >
                  {t("saveScore")}
                </Button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {p.status !== "ACTIVE" ? (
                <Button
                  variant="ok"
                  size="sm"
                  disabled={!p.onchainId}
                  loading={action.isPending && action.variables?.id === p.id}
                  onClick={() => action.mutate({ id: p.id, kind: "activate" })}
                >
                  {t("activate")}
                </Button>
              ) : null}
              {p.status !== "SUSPENDED" ? (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!p.onchainId}
                  onClick={() => action.mutate({ id: p.id, kind: "suspend" })}
                >
                  {t("suspend")}
                </Button>
              ) : null}
            </div>
            <MaybeCalldata entry={calldata[p.id]} />
          </Card>
        ))
      )}
    </div>
  );
}

function Disputes() {
  const t = useTranslations("admin");
  const locale = useLocale();
  const q = useQuery({
    queryKey: ["admin", "disputes"],
    queryFn: () => api<{ disputes: AdminDispute[] }>("/admin/disputes").then((r) => r.disputes),
  });
  if (q.isLoading) return <Skeleton className="h-40" />;
  const list = q.data ?? [];
  if (list.length === 0) return <EmptyState title={t("noDisputes")} />;
  return (
    <div className="space-y-6">
      {list.map((d) => (
        <DisputeCard key={d.id} d={d} locale={locale} />
      ))}
    </div>
  );
}

function DisputeCard({ d, locale }: { d: AdminDispute; locale: string }) {
  const t = useTranslations("admin");
  const open = d.task.steps.filter((s) => !["RELEASED", "REFUNDED"].includes(s.status));
  const [shares, setShares] = useState<Record<number, number>>(() =>
    Object.fromEntries(open.map((s) => [s.index, 5000])),
  );
  const [result, setResult] = useState<{ txs: CalldataTx[]; signer: string } | null>(null);
  const resolve = useMutation({
    mutationFn: () =>
      api<{ txs: CalldataTx[]; signer: string }>(`/admin/disputes/${d.id}/resolve`, {
        method: "POST",
        body: {
          resolutions: open.map((s) => ({
            index: s.index,
            clientShareBps: shares[s.index] ?? 5000,
          })),
        },
      }),
    onSuccess: setResult,
  });
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-lg font-bold">{d.task.title}</h3>
          <p className="font-mono text-xs text-muted">
            {relativeTime(d.createdAt, locale)} · {shortAddress(d.task.clientWallet)} ·{" "}
            <Usdc value={d.task.totalAmount} />
          </p>
        </div>
        <Badge tone={d.status === "OPEN" ? "bad" : "warn"}>{d.status}</Badge>
      </div>
      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted">
        {t("disputeReason")}
      </h4>
      <p className="mt-1 whitespace-pre-line text-sm">{d.reason}</p>
      {d.evidence.length > 0 ? (
        <>
          <h4 className="mt-3 text-xs font-semibold uppercase tracking-wider text-muted">
            {t("evidence")}
          </h4>
          <ul className="mt-1 list-disc pl-5 text-sm break-all">
            {d.evidence.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="mt-4 space-y-3">
        {d.task.steps.map((s) => {
          const out = s.latest?.output as { text?: string } | undefined;
          return (
            <details key={s.index} className="rounded-lg border border-line p-3">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                <span className="font-semibold">
                  {s.index + 1}. {s.title}
                </span>
                <StepStatusBadge status={s.status} />
                <Usdc value={s.amount} className="text-xs" />
                {s.provider ? <span className="text-xs text-muted">{s.provider.name}</span> : null}
              </summary>
              {out?.text ? (
                <div className="mt-2 max-h-72 overflow-y-auto border-t border-dashed border-line pt-2 text-sm">
                  <Markdown>{out.text}</Markdown>
                </div>
              ) : null}
            </details>
          );
        })}
      </div>
      {d.status !== "RESOLVED" && d.task.status === "DISPUTED" ? (
        <div className="mt-4 space-y-3 border-t border-dashed border-line pt-4">
          <p className="text-sm text-muted">{t("resolveHint")}</p>
          {open.map((s) => (
            <label key={s.index} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="w-48">{t("clientShare", { n: s.index + 1 })}</span>
              <input
                type="range"
                min={0}
                max={10000}
                step={500}
                value={shares[s.index] ?? 5000}
                onChange={(e) => setShares((x) => ({ ...x, [s.index]: Number(e.target.value) }))}
                className="flex-1 accent-[var(--accent)]"
              />
              <span className="num w-14 text-right">
                {((shares[s.index] ?? 5000) / 100).toFixed(0)}%
              </span>
            </label>
          ))}
          {resolve.error ? <Notice tone="bad">{errorMessage(resolve.error)}</Notice> : null}
          <Button loading={resolve.isPending} onClick={() => resolve.mutate()}>
            {t("resolve")}
          </Button>
          {result ? <CalldataActions txs={result.txs} signer={result.signer} /> : null}
        </div>
      ) : null}
    </Card>
  );
}

function Queues() {
  const t = useTranslations("admin");
  const q = useQuery({
    queryKey: ["admin", "queues"],
    queryFn: () =>
      api<{ queues: Record<string, Record<string, number>> }>("/admin/queues").then(
        (r) => r.queues,
      ),
    refetchInterval: 10_000,
  });
  if (!q.data) return <Skeleton className="h-40" />;
  const cols = ["waiting", "active", "delayed", "failed", "completed"] as const;
  const label = {
    waiting: t("waiting"),
    active: t("activeJobs"),
    delayed: t("delayed"),
    failed: t("failedJobs"),
    completed: t("completedJobs"),
  };
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-xs uppercase tracking-wider text-muted">
          <tr>
            <th className="px-4 py-3">{t("queue")}</th>
            {cols.map((c) => (
              <th key={c} className="px-4 py-3 text-right">
                {label[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="num">
          {Object.entries(q.data).map(([name, counts]) => (
            <tr key={name} className="border-b border-dashed border-line last:border-0">
              <td className="px-4 py-2 font-sans font-semibold">{name}</td>
              {cols.map((c) => (
                <td
                  key={c}
                  className={`px-4 py-2 text-right ${c === "failed" && (counts[c] ?? 0) > 0 ? "text-bad font-bold" : ""}`}
                >
                  {counts[c] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EscrowStatus() {
  const t = useTranslations("admin");
  const q = useQuery({
    queryKey: ["admin", "escrow"],
    queryFn: () => api<{ escrow: string; paused: boolean; feeBps: number }>("/admin/escrow"),
    refetchInterval: 30_000,
  });
  const [result, setResult] = useState<{ txs: CalldataTx[]; signer: string } | null>(null);
  const prepare = useMutation({
    mutationFn: (action: "pause" | "unpause") =>
      api<{ tx: CalldataTx; signer: string }>(`/admin/escrow/${action}`, { method: "POST" }),
    onSuccess: (r) => setResult({ txs: [r.tx], signer: r.signer }),
  });
  if (!q.data) return null;
  return (
    <Card className={q.data.paused ? "border-bad" : ""}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">{t("escrowTitle")}</h2>
          <p className="mt-1 text-sm text-muted">
            {q.data.paused ? t("escrowPaused") : t("escrowActive")}
          </p>
        </div>
        <Button
          variant={q.data.paused ? "outline" : "danger"}
          loading={prepare.isPending}
          onClick={() => {
            if (q.data.paused || window.confirm(t("pauseConfirm")))
              prepare.mutate(q.data.paused ? "unpause" : "pause");
          }}
        >
          {q.data.paused ? t("unpause") : t("pause")}
        </Button>
      </div>
      {prepare.error ? (
        <Notice tone="bad" className="mt-3">
          {errorMessage(prepare.error)}
        </Notice>
      ) : null}
      {result ? <CalldataActions txs={result.txs} signer={result.signer} /> : null}
    </Card>
  );
}

function Reconciliation() {
  const t = useTranslations("admin");
  const locale = useLocale();
  const q = useQuery({
    queryKey: ["admin", "reconciliation"],
    queryFn: () =>
      api<{
        reconciliation: {
          checkedAt: string;
          block: string;
          onchainBalance: string;
          expectedBalance: string;
          difference: string;
          ok: boolean;
        } | null;
      }>("/admin/reconciliation").then((r) => r.reconciliation),
    refetchInterval: 30_000,
  });
  if (q.isLoading) return <Skeleton className="h-32" />;
  const r = q.data;
  if (!r) return <EmptyState title={t("reconNone")} />;
  return (
    <Card className={r.ok ? "" : "border-bad"}>
      <Notice tone={r.ok ? "ok" : "bad"}>{r.ok ? t("reconOk") : t("reconMismatch")}</Notice>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted">Onchain</dt>
        <dd>
          <Usdc value={r.onchainBalance} />
        </dd>
        <dt className="text-muted">Expected</dt>
        <dd>
          <Usdc value={r.expectedBalance} />
        </dd>
        <dt className="text-muted">Δ</dt>
        <dd className="num">{r.difference}</dd>
        <dt className="text-muted">Block</dt>
        <dd className="num">{r.block}</dd>
        <dt className="text-muted">Checked</dt>
        <dd>{relativeTime(r.checkedAt, locale)}</dd>
      </dl>
    </Card>
  );
}

/** docs/08-TOKENOMICS.md §3: 50% treasury, 30% stakers, 20% buybacks once the token is live. */
const LAUNCH_SPLIT: FeeSplit = { treasuryBps: 5_000, stakerBps: 3_000, buybackBps: 2_000 };

function TokenAdmin() {
  const t = useTranslations("admin");
  const q = useQuery({
    queryKey: ["admin", "fee-split"],
    queryFn: () => api<{ split: FeeSplit; stakingVault: string }>("/admin/fee-split"),
  });
  const [draft, setDraft] = useState<FeeSplit | null>(null);
  const [result, setResult] = useState<{ txs: CalldataTx[]; signer: string } | null>(null);
  const propose = useMutation({
    mutationFn: (split: FeeSplit) =>
      api<{ tx: CalldataTx; signer: string }>("/admin/fee-split", { method: "POST", body: split }),
    onSuccess: (r) => setResult({ txs: [r.tx], signer: r.signer }),
  });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (!q.data)
    return <Notice tone="bad">{q.error ? errorMessage(q.error) : t("noFeeSplit")}</Notice>;
  const current = q.data.split;
  const split = draft ?? current;
  const sum = split.treasuryBps + split.stakerBps + split.buybackBps;
  const field = (key: keyof FeeSplit, label: string) => (
    <Field label={label} htmlFor={`split-${key}`}>
      <Input
        id={`split-${key}`}
        inputMode="numeric"
        value={String(split[key])}
        onChange={(e) =>
          setDraft({ ...split, [key]: Number(e.target.value.replace(/\D/g, "")) || 0 })
        }
      />
    </Field>
  );
  return (
    <Card className="max-w-2xl space-y-4">
      <div>
        <h2 className="font-display text-lg font-bold">{t("feeSplit")}</h2>
        <p className="mt-1 text-sm text-muted">{t("feeSplitHint")}</p>
      </div>
      <p className="num text-sm">
        {t("currentSplit", {
          treasury: sharePct(current.treasuryBps),
          stakers: sharePct(current.stakerBps),
          buyback: sharePct(current.buybackBps),
        })}
      </p>
      {current.stakerBps === 0 ? (
        <Button
          variant="accent"
          loading={propose.isPending && draft === null}
          onClick={() => propose.mutate(LAUNCH_SPLIT)}
        >
          {t("enableStakers")}
        </Button>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        {field("treasuryBps", t("bpsTreasury"))}
        {field("stakerBps", t("bpsStakers"))}
        {field("buybackBps", t("bpsBuyback"))}
      </div>
      {sum !== 10_000 ? <p className="text-sm text-bad">{t("splitSum", { sum })}</p> : null}
      {propose.error ? <Notice tone="bad">{errorMessage(propose.error)}</Notice> : null}
      <Button
        variant="outline"
        disabled={sum !== 10_000 || draft === null}
        loading={propose.isPending && draft !== null}
        onClick={() => draft && propose.mutate(draft)}
      >
        {t("proposeSplit")}
      </Button>
      {result ? <CalldataActions txs={result.txs} signer={result.signer} /> : null}
    </Card>
  );
}

function Settings() {
  const t = useTranslations("admin");
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () =>
      api<{ settings: { announcement?: string | null } }>("/admin/settings").then(
        (r) => r.settings,
      ),
  });
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api("/admin/settings", {
        method: "PATCH",
        body: { announcement: (announcement ?? "").trim() || null },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "settings"] }),
  });
  if (!q.data) return <Skeleton className="h-32" />;
  return (
    <Card className="max-w-2xl">
      <Field label={t("announcement")} hint={t("announcementHint")} htmlFor="announcement">
        <Textarea
          id="announcement"
          rows={2}
          maxLength={500}
          value={announcement ?? q.data.announcement ?? ""}
          onChange={(e) => setAnnouncement(e.target.value)}
        />
      </Field>
      {save.error ? (
        <Notice tone="bad" className="mt-3">
          {errorMessage(save.error)}
        </Notice>
      ) : null}
      {save.isSuccess ? (
        <Notice tone="ok" className="mt-3">
          {t("saved")}
        </Notice>
      ) : null}
      <Button className="mt-4" loading={save.isPending} onClick={() => save.mutate()}>
        {t("saveSettings")}
      </Button>
    </Card>
  );
}
