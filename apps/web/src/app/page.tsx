import type { ReactNode } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowRight, BadgeCheck, Coins, RotateCcw } from "lucide-react";
import { formatUsdcDisplay } from "@kazi/shared";
import { getPublicConfig, serverGet } from "@/lib/server-api";
import type { Stats } from "@/lib/types";
import { AgentCard } from "@/components/agent-card";
import { Container } from "@/components/container";
import { HeroComposer } from "@/components/hero-composer";
import { buttonClass } from "@/components/ui";

export default async function HomePage() {
  const t = await getTranslations("landing");
  const [stats, cfg] = await Promise.all([serverGet<Stats>("/stats", 60), getPublicConfig()]);
  const decimals = cfg?.usdcDecimals ?? null;
  const volume =
    stats && decimals !== null ? formatUsdcDisplay(BigInt(stats.volume), decimals) : "—";

  return (
    <>
      {/* Hero */}
      <section className="weave relative overflow-hidden border-b border-ink/15">
        <Container className="grid items-center gap-10 py-12 sm:py-16 lg:grid-cols-[1.15fr_0.85fr] lg:py-20">
          <div>
            <p className="mb-4 inline-flex rounded-full border border-ink/20 bg-surface/80 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
              {t("kicker")}
            </p>
            <h1 className="font-display text-[2.6rem] leading-[0.98] font-extrabold tracking-tight sm:text-6xl lg:text-7xl">
              <span className="block">{t("title1")}</span>
              <span className="block text-accent">{t("title2")}</span>
              <span className="block">{t("title3")}</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-ink/80">{t("body")}</p>
            <div className="mt-7 max-w-2xl">
              <HeroComposer />
            </div>
          </div>
          <SampleReceipt
            labels={{
              title: t("receiptTitle"),
              task: t("receiptTask"),
              steps: [t("receiptStep1"), t("receiptStep2"), t("receiptStep3")],
              fee: t("receiptFee"),
              total: t("receiptTotal"),
              stamp: t("receiptStamp"),
            }}
          />
        </Container>
      </section>

      {/* Numbers */}
      <section className="border-b border-ink/15 bg-ink text-bg">
        <Container className="grid grid-cols-3 divide-x divide-bg/15 py-6 text-center sm:py-8">
          <Stat
            value={stats ? stats.tasksCompleted.toLocaleString() : "—"}
            label={t("statTasks")}
          />
          <Stat value={stats ? stats.activeAgents.toLocaleString() : "—"} label={t("statAgents")} />
          <Stat value={volume} label={t("statVolume")} unit="USDC" />
        </Container>
      </section>

      {/* How it works */}
      <section>
        <Container className="py-14 sm:py-20">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
            {t("howKicker")}
          </p>
          <h2 className="mt-2 max-w-2xl font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
            {t("howTitle")}
          </h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              [t("how1Title"), t("how1Body")],
              [t("how2Title"), t("how2Body")],
              [t("how3Title"), t("how3Body")],
            ].map(([title, body], i) => (
              <li
                key={title}
                className="relative rounded-xl border border-ink/80 bg-surface p-6 shadow-stamp-sm"
              >
                <span className="font-display text-6xl leading-none font-extrabold text-accent/90">
                  {i + 1}
                </span>
                <h3 className="mt-3 font-display text-xl font-bold">{title}</h3>
                <p className="mt-2 text-sm text-muted">{body}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      {/* Trust */}
      <section className="border-y border-ink/15 bg-surface-2/60">
        <Container className="grid gap-8 py-12 md:grid-cols-[0.8fr_2fr]">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
              {t("trustKicker")}
            </p>
          </div>
          <div className="grid gap-6 sm:grid-cols-3">
            <Trust
              icon={<Coins className="size-5" />}
              title={t("trust1Title")}
              body={t("trust1Body")}
            />
            <Trust
              icon={<BadgeCheck className="size-5" />}
              title={t("trust2Title")}
              body={t("trust2Body")}
            />
            <Trust
              icon={<RotateCcw className="size-5" />}
              title={t("trust3Title")}
              body={t("trust3Body")}
            />
          </div>
        </Container>
      </section>

      {/* Top agents */}
      <section>
        <Container className="py-14 sm:py-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
                {t("agentsKicker")}
              </p>
              <h2 className="mt-2 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
                {t("agentsTitle")}
              </h2>
            </div>
            <Link
              href="/agents"
              className="inline-flex items-center gap-1 font-semibold text-accent hover:underline"
            >
              {t("agentsAll")}
              <ArrowRight className="size-4" />
            </Link>
          </div>
          {stats && stats.topAgents.length > 0 ? (
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {stats.topAgents.map((p) => (
                <AgentCard key={p.slug} p={p} />
              ))}
            </div>
          ) : (
            <p className="mt-8 rounded-xl border border-dashed border-line px-6 py-10 text-center text-muted">
              {t("agentsEmpty")}
            </p>
          )}
        </Container>
      </section>

      {/* Sellers */}
      <section className="pb-6">
        <Container className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-ink bg-ink p-7 text-bg shadow-stamp sm:p-9">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-bg/60">
              {t("devKicker")}
            </p>
            <h2 className="mt-2 font-display text-2xl font-extrabold sm:text-3xl">
              {t("devTitle")}
            </h2>
            <p className="mt-3 text-bg/75">{t("devBody")}</p>
            <Link href="/developers" className={buttonClass("accent", "lg", "mt-6")}>
              {t("devCta")}
            </Link>
          </div>
          <div className="rounded-2xl border border-ink bg-accent-soft p-7 shadow-stamp sm:p-9">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
              {t("humanKicker")}
            </p>
            <h2 className="mt-2 font-display text-2xl font-extrabold sm:text-3xl">
              {t("humanTitle")}
            </h2>
            <p className="mt-3 text-ink/75">{t("humanBody")}</p>
            <Link href="/provider/new?kind=human" className={buttonClass("primary", "lg", "mt-6")}>
              {t("humanCta")}
            </Link>
          </div>
        </Container>
      </section>
    </>
  );
}

function Stat({ value, label, unit }: { value: string; label: string; unit?: string }) {
  return (
    <div className="px-2">
      <p className="num text-2xl font-bold sm:text-4xl">
        {value}
        {unit ? <span className="ml-1 text-sm font-medium text-bg/60">{unit}</span> : null}
      </p>
      <p className="mt-1 text-[11px] uppercase tracking-wider text-bg/60 sm:text-xs">{label}</p>
    </div>
  );
}

function Trust({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div>
      <div className="mb-3 grid size-10 place-items-center rounded-lg border border-ink bg-surface text-accent shadow-stamp-sm">
        {icon}
      </div>
      <h3 className="font-display text-lg font-bold">{title}</h3>
      <p className="mt-1 text-sm text-muted">{body}</p>
    </div>
  );
}

/** Illustration only: a sample quote rendered as an escrow receipt (not real data). */
function SampleReceipt({
  labels,
}: {
  labels: {
    title: string;
    task: string;
    steps: [string, string, string];
    fee: string;
    total: string;
    stamp: string;
  };
}) {
  const rows: [string, string, string][] = [
    [labels.steps[0], "research-desk", "6.00"],
    [labels.steps[1], "plan-writer", "14.00"],
    [labels.steps[2], "swahili-pro", "4.50"],
  ];
  return (
    <div className="relative mx-auto w-full max-w-sm lg:rotate-[1.5deg]" aria-hidden>
      <div className="rounded-t-xl border border-b-0 border-ink bg-surface px-6 pt-6 pb-4 shadow-stamp">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
          {labels.title}
        </p>
        <p className="mt-1 font-display text-lg font-bold leading-snug">{labels.task}</p>
        <div className="mt-4 space-y-3 border-t border-dashed border-line pt-4">
          {rows.map(([step, agent, price], i) => (
            <div key={step} className="flex items-baseline justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="font-semibold">
                  <span className="mr-2 font-mono text-xs text-muted">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {step}
                </p>
                <p className="ml-7 font-mono text-[11px] text-muted">{agent}</p>
              </div>
              <span className="num shrink-0">{price}</span>
            </div>
          ))}
          <div className="flex items-baseline justify-between text-sm text-muted">
            <span>{labels.fee}</span>
            <span className="num">1.23</span>
          </div>
        </div>
        <div className="mt-4 flex items-baseline justify-between border-t-2 border-ink pt-3">
          <span className="font-display font-bold">{labels.total}</span>
          <span className="num text-xl font-bold">
            25.73 <span className="text-xs font-medium text-muted">USDC</span>
          </span>
        </div>
      </div>
      <div className="perforated -mt-px border-x border-ink bg-surface" />
      <div className="absolute -top-3 -right-3 rotate-[9deg] rounded-md border-2 border-ok bg-surface/90 px-3 py-1 font-mono text-sm font-bold uppercase tracking-widest text-ok shadow-stamp-sm">
        {labels.stamp}
      </div>
    </div>
  );
}
