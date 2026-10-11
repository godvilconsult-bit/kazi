import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft, Star } from "lucide-react";
import { getPublicConfig, serverGet } from "@/lib/server-api";
import { explorerUrl, priceLabel, relativeTime, tokenAmount } from "@/lib/format";
import { tokenName } from "@/lib/token-name";
import type { ProviderPublic } from "@/lib/types";
import { KindBadge, ReputationMeter } from "@/components/agent-card";
import { PageBody } from "@/components/container";
import { ReputationChart } from "@/components/reputation-chart";
import { Card, buttonClass } from "@/components/ui";

type Params = Promise<{ slug: string }>;

async function load(slug: string) {
  return serverGet<{ provider: ProviderPublic }>(`/providers/${encodeURIComponent(slug)}`, 30);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const res = await load((await params).slug);
  return res
    ? { title: res.provider.name, description: res.provider.description.slice(0, 160) }
    : {};
}

export default async function AgentPage({ params }: { params: Params }) {
  const { slug } = await params;
  const t = await getTranslations("agent");
  const locale = await getLocale();
  const [res, rep, reviews, cfg] = await Promise.all([
    load(slug),
    serverGet<{ points: { value: number; createdAt: string }[] }>(
      `/providers/${encodeURIComponent(slug)}/reputation`,
      300,
    ),
    serverGet<{ reviews: { rating: number; comment: string | null; at: string }[] }>(
      `/providers/${encodeURIComponent(slug)}/reviews`,
      120,
    ),
    getPublicConfig(),
  ]);
  if (!res) notFound();
  const p = res.provider;
  const names = new Intl.DisplayNames([locale], { type: "language" });
  const registryLink =
    p.onchainId && cfg?.contracts.agentRegistry
      ? explorerUrl(cfg.chain.explorerUrl, "address", cfg.contracts.agentRegistry)
      : null;
  const bond = BigInt(p.stakeAmount || "0");
  const latency = p.avgLatencyMs ?? null;

  return (
    <PageBody>
      <Link
        href="/agents"
        className="mb-6 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" />
        {t("back")}
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="min-w-0 space-y-6">
          <header>
            <div className="flex flex-wrap items-center gap-2">
              <KindBadge kind={p.kind} hosting={p.hosting} />
              {p.isHouse ? (
                <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
                  Kazi
                </span>
              ) : null}
            </div>
            <h1 className="mt-3 font-display text-4xl font-extrabold tracking-tight break-words sm:text-5xl">
              {p.name}
            </h1>
            <p className="mt-3 max-w-2xl whitespace-pre-line text-lg text-ink/80">
              {p.description}
            </p>
          </header>

          <Card>
            <h2 className="font-display text-lg font-bold">{t("history")}</h2>
            <div className="mt-3">
              <ReputationChart
                points={rep?.points ?? []}
                emptyLabel={t("historyEmpty")}
                ariaLabel={t("historyAria")}
              />
            </div>
          </Card>

          <Card>
            <h2 className="font-display text-lg font-bold">{t("reviews")}</h2>
            {reviews && reviews.reviews.length > 0 ? (
              <ul className="mt-3 divide-y divide-dashed divide-line">
                {reviews.reviews.map((r, i) => (
                  <li key={i} className="py-3">
                    <div className="flex items-center gap-2">
                      <span className="flex text-accent" aria-label={`${r.rating}/5`}>
                        {Array.from({ length: 5 }, (_, s) => (
                          <Star
                            key={s}
                            className="size-4"
                            fill={s < r.rating ? "currentColor" : "none"}
                          />
                        ))}
                      </span>
                      <span className="font-mono text-xs text-muted">
                        {relativeTime(r.at, locale)}
                      </span>
                    </div>
                    {r.comment ? <p className="mt-1 text-sm">{r.comment}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">{t("reviewsEmpty")}</p>
            )}
          </Card>
        </div>

        <aside className="space-y-4">
          <Card className="space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                {t("reputation")}
              </p>
              <div className="mt-1 flex items-center gap-3">
                <span className="num text-4xl font-bold">{p.reputation.toFixed(0)}</span>
                <ReputationMeter value={p.reputation} />
              </div>
              <p className="mt-1 text-xs text-muted">{t("reputationHint")}</p>
            </div>
            <Row label={t("pricing")}>
              <span className="num font-semibold">{priceLabel(p.pricing)}</span>
              {p.pricing.minimum ? (
                <span className="block text-xs text-muted">
                  {t("minimum", { amount: p.pricing.minimum })}
                </span>
              ) : null}
            </Row>
            <Row label={t("tasksDone")}>
              <span className="num">{p.completedCount}</span>
            </Row>
            {latency !== null ? (
              <Row label={t("typicalTime")}>
                {latency >= 60_000
                  ? t("minutes", { count: Math.round(latency / 60_000) })
                  : t("seconds", { count: Math.max(1, Math.round(latency / 1000)) })}
              </Row>
            ) : null}
            <Row label={t("hosting")}>
              {p.kind === "HUMAN"
                ? t("hostingHuman")
                : p.hosting === "KAZI"
                  ? t("hostingKazi")
                  : t("hostingSelf")}
            </Row>
            <Row label={t("bond")}>
              {bond > 0n && cfg?.kaziDecimals != null
                ? t("bondValue", {
                    amount: tokenAmount(bond, cfg.kaziDecimals, 0),
                    token: tokenName(cfg),
                  })
                : t("noBond")}
            </Row>
            <Row label={t("onchain")}>
              {p.onchainId ? (
                registryLink ? (
                  <a
                    href={registryLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="num text-accent hover:underline"
                  >
                    #{p.onchainId}
                  </a>
                ) : (
                  <span className="num">#{p.onchainId}</span>
                )
              ) : (
                <span className="text-muted">{t("notOnchain")}</span>
              )}
            </Row>
          </Card>

          <Card className="space-y-3">
            <Row label={t("capabilities")}>
              <div className="flex flex-wrap gap-1">
                {p.capabilities.map((c) => (
                  <span
                    key={c}
                    className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </Row>
            <Row label={t("languages")}>{p.languages.map((l) => names.of(l) ?? l).join(", ")}</Row>
          </Card>

          <Card className="bg-accent-soft">
            <p className="text-sm">{t("ctaHint")}</p>
            <Link href="/new" className={buttonClass("primary", "md", "mt-3 w-full")}>
              {t("cta")}
            </Link>
          </Card>
        </aside>
      </div>
    </PageBody>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}
