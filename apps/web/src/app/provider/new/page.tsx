"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { Bot, Cpu, Trash2, UserRound } from "lucide-react";
import { CAPABILITY_DEFINITIONS, HOSTED_MODELS } from "@kazi/shared";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Capability, ProviderOwner } from "@/lib/types";
import { useAuth } from "@/components/auth";
import { PageBody } from "@/components/container";
import { CopyButton } from "@/components/money";
import { RequireAuth } from "@/components/require-auth";
import { Button, ButtonLink, Card, Chip, Field, Input, Notice, PageHeader, Select, Textarea } from "@/components/ui";

type Kind = "SELF" | "KAZI" | "HUMAN";
const LANGS = ["en", "sw", "fr", "ar", "pt", "am", "so", "rw", "zh", "es", "de", "hi"];
const UNITS = ["1000_words", "page", "file", "task", "hour", "minute_audio", "image"] as const;
const STEPS = ["stepKind", "stepDetails", "stepPricing", "stepSetup", "stepReview"] as const;

export default function NewProviderPage() {
  const t = useTranslations("wizard");
  return (
    <PageBody narrow>
      <PageHeader kicker={t("kicker")} title={t("title")} />
      <RequireAuth>
        <Suspense>
          <Wizard />
        </Suspense>
      </RequireAuth>
    </PageBody>
  );
}

function Wizard() {
  const t = useTranslations("wizard");
  const tc = useTranslations("common");
  const locale = useLocale();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { address } = useAccount();
  const caps = useQuery({ queryKey: ["capabilities"], queryFn: () => api<{ capabilities: Capability[] }>("/capabilities") });

  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<Kind>(params.get("kind") === "human" ? "HUMAN" : "SELF");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>(["en"]);
  const [model, setModel] = useState<"per_unit" | "fixed">("fixed");
  const [unit, setUnit] = useState<(typeof UNITS)[number]>("task");
  const [price, setPrice] = useState("");
  const [minimum, setMinimum] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [manifestUrl, setManifestUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const [llm, setLlm] = useState<(typeof HOSTED_MODELS)[number]>("claude-sonnet-5-5");
  const [effort, setEffort] = useState<"low" | "medium" | "high">("medium");
  const [webSearch, setWebSearch] = useState(0);
  const [samples, setSamples] = useState<{ instructions: string; input: string }[]>([]);
  const [payout, setPayout] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ provider: ProviderOwner; webhookSecret: string | null } | null>(null);

  useEffect(() => {
    if (!payout && (address ?? user?.wallet)) setPayout(address ?? user?.wallet ?? "");
  }, [address, user, payout]);
  // A capability's pricing unit is a good default for per-unit pricing.
  const unitFor = useMemo(() => new Map(CAPABILITY_DEFINITIONS.map((c) => [c.slug, c.unit])), []);
  useEffect(() => {
    const first = capabilities[0];
    const u = first ? unitFor.get(first) : undefined;
    if (u && (UNITS as readonly string[]).includes(u)) setUnit(u as (typeof UNITS)[number]);
  }, [capabilities, unitFor]);
  const names = new Intl.DisplayNames([locale], { type: "language" });

  const valid = [
    true,
    name.trim().length >= 3 && description.trim().length >= 10 && capabilities.length > 0 && languages.length > 0,
    /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(price.trim()) && (!minimum.trim() || /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(minimum.trim())),
    kind === "HUMAN" || (kind === "SELF" ? endpointUrl.startsWith("https://") : instructions.trim().length >= 50),
    /^0x[0-9a-fA-F]{40}$/.test(payout.trim()),
  ];

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        kind: kind === "HUMAN" ? "HUMAN" : "AGENT",
        name: name.trim(),
        description: description.trim(),
        capabilities,
        languages,
        pricing: {
          model,
          ...(model === "per_unit" ? { unit } : {}),
          price: price.trim(),
          currency: "USDC",
          ...(minimum.trim() ? { minimum: minimum.trim() } : {}),
        },
        payoutAddress: payout.trim(),
        hosting: kind === "KAZI" ? "KAZI" : "SELF",
        ...(kind === "SELF" ? { endpointUrl: endpointUrl.trim(), ...(manifestUrl.trim() ? { manifestUrl: manifestUrl.trim() } : {}) } : {}),
        ...(kind === "KAZI"
          ? {
              hostedConfig: {
                instructions: instructions.trim(),
                model: llm,
                effort,
                webSearch: webSearch > 0 && llm !== "claude-haiku-5-5" ? { maxUses: webSearch } : null,
                samples: samples.filter((s) => s.instructions.trim().length >= 10),
              },
            }
          : {}),
      };
      const res = await api<{ provider: ProviderOwner; webhookSecret: string | null }>("/providers", { method: "POST", body });
      void qc.invalidateQueries({ queryKey: ["me", "providers"] });
      setCreated(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <div className="space-y-4">
        <Notice tone="ok">{t("created")}</Notice>
        {created.webhookSecret ? (
          <Card className="border-warn">
            <h2 className="font-display text-lg font-bold">{t("secretTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("secretBody")}</p>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">{created.webhookSecret}</code>
              <CopyButton value={created.webhookSecret} />
            </div>
          </Card>
        ) : null}
        <ButtonLink href={`/provider/${created.provider.id}`} variant="accent" size="lg">
          {t("continue")}
        </ButtonLink>
      </div>
    );
  }

  return (
    <div>
      <ol className="mb-6 flex gap-1 overflow-x-auto" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} className="flex-1">
            <button
              type="button"
              disabled={i > step && !valid.slice(0, i).every(Boolean)}
              onClick={() => setStep(i)}
              className={cn(
                "w-full border-t-4 pt-2 text-left text-xs font-semibold uppercase tracking-wider",
                i === step ? "border-accent text-ink" : i < step ? "border-ink text-ink/70" : "border-line text-muted",
              )}
            >
              {i + 1}. {t(s)}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <div className="grid gap-3">
          {(
            [
              ["SELF", <Bot key="b" className="size-5" />, t("kindSelf"), t("kindSelfBody")],
              ["KAZI", <Cpu key="c" className="size-5" />, t("kindHosted"), t("kindHostedBody")],
              ["HUMAN", <UserRound key="u" className="size-5" />, t("kindHuman"), t("kindHumanBody")],
            ] as const
          ).map(([k, icon, title, body]) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "flex gap-4 rounded-xl border p-4 text-left transition-colors",
                kind === k ? "border-ink bg-surface shadow-stamp-sm" : "border-line bg-surface/60 hover:border-ink/60",
              )}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-ink bg-accent-soft text-accent">{icon}</span>
              <span>
                <span className="block font-display text-lg font-bold">{title}</span>
                <span className="mt-0.5 block text-sm text-muted">{body}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="space-y-5">
          <Field label={t("name")} htmlFor="p-name">
            <Input id="p-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
          </Field>
          <Field label={t("description")} hint={t("descriptionHint")} htmlFor="p-desc">
            <Textarea id="p-desc" rows={5} maxLength={4_000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label={t("capabilities")} hint={t("capabilitiesHint")}>
            <div className="flex max-h-56 flex-wrap gap-2 overflow-y-auto rounded-lg border border-line p-2">
              {(caps.data?.capabilities ?? []).map((c) => (
                <Chip
                  key={c.slug}
                  active={capabilities.includes(c.slug)}
                  onClick={() =>
                    setCapabilities((prev) => (prev.includes(c.slug) ? prev.filter((x) => x !== c.slug) : prev.length < 20 ? [...prev, c.slug] : prev))
                  }
                  className="font-mono text-xs"
                >
                  {c.slug}
                </Chip>
              ))}
            </div>
          </Field>
          <Field label={t("languages")}>
            <div className="flex flex-wrap gap-2">
              {LANGS.map((l) => (
                <Chip key={l} active={languages.includes(l)} onClick={() => setLanguages((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]))}>
                  {names.of(l) ?? l}
                </Chip>
              ))}
            </div>
          </Field>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="space-y-5">
          <Field label={t("pricingModel")}>
            <div className="flex gap-2">
              <Chip active={model === "fixed"} onClick={() => setModel("fixed")}>
                {t("fixed")}
              </Chip>
              <Chip active={model === "per_unit"} onClick={() => setModel("per_unit")}>
                {t("perUnit")}
              </Chip>
            </div>
          </Field>
          {model === "per_unit" ? (
            <Field label={t("unit")} htmlFor="p-unit">
              <Select id="p-unit" value={unit} onChange={(e) => setUnit(e.target.value as (typeof UNITS)[number])}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {t(`unit${u}`)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={t("price")} htmlFor="p-price">
              <Input id="p-price" inputMode="decimal" placeholder="2.50" value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            {model === "per_unit" ? (
              <Field label={`${t("minimum")} (${tc("optional")})`} htmlFor="p-min">
                <Input id="p-min" inputMode="decimal" placeholder="0.50" value={minimum} onChange={(e) => setMinimum(e.target.value)} />
              </Field>
            ) : null}
          </div>
          <p className="text-sm text-muted">{t("pricingHint")}</p>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="space-y-5">
          {kind === "SELF" ? (
            <>
              <Field label={t("endpoint")} hint={t("endpointHint")} htmlFor="p-endpoint">
                <Input id="p-endpoint" type="url" value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} placeholder="https://" />
              </Field>
              <Field label={`${t("manifest")} (${tc("optional")})`} htmlFor="p-manifest">
                <Input id="p-manifest" type="url" value={manifestUrl} onChange={(e) => setManifestUrl(e.target.value)} placeholder="https://… or ipfs://…" />
              </Field>
            </>
          ) : kind === "KAZI" ? (
            <>
              <Field label={t("instructions")} hint={t("instructionsHint")} htmlFor="p-instr">
                <Textarea id="p-instr" rows={10} maxLength={20_000} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={t("model")} htmlFor="p-model">
                  <Select id="p-model" value={llm} onChange={(e) => setLlm(e.target.value as (typeof HOSTED_MODELS)[number])}>
                    <option value="claude-opus-5-5">{t("modelOpus")}</option>
                    <option value="claude-sonnet-5-5">{t("modelSonnet")}</option>
                    <option value="claude-haiku-5-5">{t("modelHaiku")}</option>
                  </Select>
                </Field>
                <Field label={t("effort")} htmlFor="p-effort">
                  <Select id="p-effort" value={effort} onChange={(e) => setEffort(e.target.value as "low" | "medium" | "high")}>
                    <option value="low">{t("effortLow")}</option>
                    <option value="medium">{t("effortMedium")}</option>
                    <option value="high">{t("effortHigh")}</option>
                  </Select>
                </Field>
              </div>
              {llm !== "claude-haiku-5-5" ? (
                <Field label={t("webSearch")} hint={t("webSearchHint", { count: webSearch || 0 })} htmlFor="p-search">
                  <Input id="p-search" type="number" min={0} max={10} value={webSearch} onChange={(e) => setWebSearch(Math.max(0, Math.min(10, Number(e.target.value) || 0)))} />
                </Field>
              ) : null}
              <Field label={t("samples")} hint={t("samplesHint")}>
                <div className="space-y-3">
                  {samples.map((s, i) => (
                    <div key={i} className="space-y-2 rounded-lg border border-line p-3">
                      <Input
                        placeholder={t("sampleInstructions")}
                        value={s.instructions}
                        onChange={(e) => setSamples((prev) => prev.map((x, j) => (j === i ? { ...x, instructions: e.target.value } : x)))}
                      />
                      <Textarea
                        rows={3}
                        placeholder={t("sampleInput")}
                        value={s.input}
                        onChange={(e) => setSamples((prev) => prev.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)))}
                      />
                      <Button variant="ghost" size="sm" onClick={() => setSamples((prev) => prev.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                        {t("removeSample")}
                      </Button>
                    </div>
                  ))}
                  {samples.length < 3 ? (
                    <Button variant="outline" size="sm" onClick={() => setSamples((prev) => [...prev, { instructions: "", input: "" }])}>
                      {t("addSample")}
                    </Button>
                  ) : null}
                </div>
              </Field>
            </>
          ) : (
            <Notice tone="info">{t("humanSetup")}</Notice>
          )}
        </div>
      ) : null}

      {step === 4 ? (
        <div className="space-y-5">
          <Field label={t("payout")} hint={t("payoutHint")} htmlFor="p-payout">
            <div className="flex gap-2">
              <Input id="p-payout" className="font-mono text-sm" value={payout} onChange={(e) => setPayout(e.target.value)} />
              {address ? (
                <Button variant="outline" onClick={() => setPayout(address)}>
                  {t("useMyWallet")}
                </Button>
              ) : null}
            </div>
          </Field>
          <Card>
            <h3 className="font-display text-lg font-bold">{t("summary")}</h3>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted">{t("stepKind")}</dt>
              <dd>{kind === "SELF" ? t("kindSelf") : kind === "KAZI" ? t("kindHosted") : t("kindHuman")}</dd>
              <dt className="text-muted">{t("name")}</dt>
              <dd>{name}</dd>
              <dt className="text-muted">{t("capabilities")}</dt>
              <dd className="font-mono text-xs">{capabilities.join(", ")}</dd>
              <dt className="text-muted">{t("price")}</dt>
              <dd className="num">
                {price} USDC{model === "per_unit" ? ` / ${t(`unit${unit}`)}` : ""}
              </dd>
            </dl>
          </Card>
          {error ? <Notice tone="bad">{error}</Notice> : null}
        </div>
      ) : null}

      <div className="mt-8 flex items-center justify-between border-t border-dashed border-line pt-5">
        <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
          {tc("back")}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button disabled={!valid[step]} onClick={() => setStep((s) => s + 1)}>
            {tc("next")}
          </Button>
        ) : (
          <Button variant="accent" loading={submitting} disabled={!valid.every(Boolean)} onClick={() => void submit()}>
            {t("submit")}
          </Button>
        )}
      </div>
    </div>
  );
}
