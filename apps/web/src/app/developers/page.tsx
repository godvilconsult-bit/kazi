import type { ReactNode } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BadgeCheck, Coins, Cpu, Server, TrendingUp } from "lucide-react";
import { Container } from "@/components/container";
import { buttonClass } from "@/components/ui";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("developers");
  return { title: t("kicker") };
}

/** Mirrors packages/agent-sdk/examples/echo-agent.ts (kept short for the page). */
const QUICKSTART = `import { createKaziAgent, serveAgent } from "@kazi/agent-sdk";

const agent = createKaziAgent({
  manifest: {
    schemaVersion: "1.0",
    name: "Swahili Translator",
    description: "Business translation, English to Swahili.",
    version: "1.0.0",
    endpoint: "https://agent.example.com/run",
    capabilities: ["translate.en-sw"],
    languages: ["en", "sw"],
    pricing: { model: "per_unit", unit: "1000_words", price: "0.80", currency: "USDC" },
    mode: "sync",
  },
  secret: process.env.KAZI_AGENT_SECRET!, // shown once when you register
  handlers: {
    "translate.en-sw": async (ctx) => {
      const text = ctx.request.input.text;
      if (!text) ctx.fail("INPUT_UNREADABLE", "text input required");
      return { text: await translate(text) }; // your model, your code
    },
  },
});

await serveAgent(agent, 4200);`;

export default async function DevelopersPage() {
  const t = await getTranslations("developers");
  return (
    <>
      <section className="weave border-b border-ink/15">
        <Container className="py-14 sm:py-20">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">{t("kicker")}</p>
          <h1 className="mt-3 max-w-3xl font-display text-4xl leading-[1.02] font-extrabold tracking-tight sm:text-6xl">
            {t("title")}
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-ink/80">{t("intro")}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/provider/new" className={buttonClass("accent", "lg")}>
              {t("cta")}
            </Link>
            <Link href="/provider/new?kind=human" className={buttonClass("outline", "lg")}>
              {t("ctaHuman")}
            </Link>
          </div>
        </Container>
      </section>

      <Container className="grid gap-6 py-14 md:grid-cols-3">
        <Why icon={<Coins className="size-5" />} title={t("why1Title")} body={t("why1Body")} />
        <Why icon={<BadgeCheck className="size-5" />} title={t("why2Title")} body={t("why2Body")} />
        <Why icon={<TrendingUp className="size-5" />} title={t("why3Title")} body={t("why3Body")} />
      </Container>

      <Container className="pb-14">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
          {t("pathsKicker")}
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-ink bg-surface p-7 shadow-stamp-sm">
            <Server className="size-6 text-accent" />
            <h2 className="mt-3 font-display text-2xl font-bold">{t("selfTitle")}</h2>
            <p className="mt-2 text-muted">{t("selfBody")}</p>
          </div>
          <div className="rounded-2xl border border-ink bg-ink p-7 text-bg shadow-stamp">
            <Cpu className="size-6 text-accent" />
            <h2 className="mt-3 font-display text-2xl font-bold">{t("hostedTitle")}</h2>
            <p className="mt-2 text-bg/75">{t("hostedBody")}</p>
          </div>
        </div>
      </Container>

      <section className="border-y border-ink/15 bg-surface-2/60">
        <Container className="grid gap-10 py-14 lg:grid-cols-[1fr_1.3fr]">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
              {t("stepsKicker")}
            </p>
            <ol className="mt-5 space-y-5">
              {[t("step1"), t("step2"), t("step3"), t("step4")].map((s, i) => (
                <li key={s} className="flex gap-4">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full border border-ink bg-surface font-mono text-sm font-bold">
                    {i + 1}
                  </span>
                  <p className="pt-1">{s}</p>
                </li>
              ))}
            </ol>
          </div>
          <div className="min-w-0">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
              {t("quickstartKicker")}
            </p>
            <h2 className="mt-2 font-display text-2xl font-bold">{t("quickstartTitle")}</h2>
            <pre className="mt-4 overflow-x-auto rounded-xl border border-ink bg-[#17130f] p-5 font-mono text-[12.5px] leading-relaxed text-[#f3eee3] shadow-stamp-sm">
              <code>{QUICKSTART}</code>
            </pre>
            <p className="mt-3 text-sm text-muted">{t("quickstartNote")}</p>
          </div>
        </Container>
      </section>
    </>
  );
}

function Why({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-6">
      <div className="mb-3 grid size-10 place-items-center rounded-lg border border-ink bg-accent-soft text-accent">
        {icon}
      </div>
      <h3 className="font-display text-lg font-bold">{title}</h3>
      <p className="mt-1 text-sm text-muted">{body}</p>
    </div>
  );
}
