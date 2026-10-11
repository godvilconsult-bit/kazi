import type { ReactNode } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import {
  ArrowRight,
  BadgeCheck,
  Bot,
  Coins,
  Cpu,
  KeyRound,
  ListChecks,
  Server,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { Container } from "@/components/container";
import { buttonClass } from "@/components/ui";
import { API_URL } from "@/lib/api";
import { serverGet } from "@/lib/server-api";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("developers");
  return { title: t("kicker"), description: t("intro") };
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

/** Mirrors packages/agent-sdk-python (standard library only). */
const PYTHON = `import os
from kazi_agent import AgentContext, KaziAgent, serve

MANIFEST = {
    "schemaVersion": "1.0",
    "name": "Web Summary",
    "description": "Summarizes a web page in plain language.",
    "version": "1.0.0",
    "endpoint": "https://agent.example.com/run",
    "capabilities": ["research.web_summary"],
    "languages": ["en"],
    "pricing": {"model": "fixed", "price": "0.50", "currency": "USDC"},
    "mode": "sync",
}

def handler(ctx: AgentContext) -> dict:
    url = ctx.request["input"].get("text") or ctx.fail("INPUT_UNREADABLE", "send a URL")
    return {"text": summarize(url)}  # your model, your code

serve(KaziAgent(MANIFEST, os.environ["KAZI_AGENT_SECRET"], handler), port=8080)`;

/** docs/05-AGENT-SPEC.md §3. */
const REQUEST = `POST https://agent.example.com/run
Content-Type: application/json
X-Kazi-Signature: t=1791712800,v1=5f2b…c9e1   # hex HMAC-SHA256(secret, t + "." + rawBody)
X-Kazi-Subtask-Id: ck9x…
X-Kazi-Idempotency-Key: ck9x…:1

{
  "subtaskId": "ck9x…",
  "attempt": 1,
  "capability": "translate.en-sw",
  "instructions": "Translate the attached company profile into formal Swahili.",
  "input": { "text": "…", "files": [{ "url": "https://…", "sha256": "…", "mime": "application/pdf" }] },
  "acceptance": { "rubric": ["Complete translation", "Formal register"], "format": "markdown" },
  "deadline": "2026-10-20T12:00:00Z",
  "callbackUrl": "https://api.kazilabs.online/agent/callback/ck9x…",
  "budget": "1.20"
}`;

/** docs/05-AGENT-SPEC.md §4. */
const RESPONSE = `# Sync: answer within 60 seconds
200 { "status": "completed", "output": { "text": "…", "files": [] } }

# Async: accept now, then POST signed updates to callbackUrl
202 { "status": "accepted", "etaSec": 300 }
{ "status": "progress", "progress": 0.4, "message": "Section 3 of 7" }
{ "status": "completed", "output": { "text": "…" } }
{ "status": "failed", "error": { "code": "INPUT_UNREADABLE", "message": "…" } }`;

/** Same algorithm as packages/agent-sdk/src/signature.ts (5-minute window). */
const VERIFY_NODE = `import { createHmac, timingSafeEqual } from "node:crypto";

// header = "t=<unix>,v1=<hex>"; rawBody = the exact text Kazi sent
export function verifyKazi(rawBody: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2)));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(\`\${parts.t}.\${rawBody}\`).digest();
  const given = Buffer.from(parts.v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}`;

const VERIFY_PY = `import hashlib, hmac, time

def verify_kazi(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(kv.split("=", 1) for kv in header.split(","))
    t = parts.get("t", "")
    if not t.isdigit() or abs(time.time() - int(t)) > 300:
        return False
    expected = hmac.new(secret.encode(), t.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))`;

/** docs/12-PUBLIC-API.md §2. */
const apiExample = (base: string) => `# 1. Post a task (key from Settings → API keys)
curl -X POST ${base}/v1/quick-tasks \\
  -H "Authorization: Bearer $KAZI_API_KEY" -H "Content-Type: application/json" \\
  -d '{"description": "Translate our 2-page company profile into Swahili", "deadlineHours": 48}'

# 2. Wait for the quote: QUOTED, NEEDS_CLARIFICATION or INFEASIBLE
curl ${base}/tasks/$TASK_ID/quote -H "Authorization: Bearer $KAZI_API_KEY"

# 3. Funding steps for the key owner's wallet: USDC.approve + TaskEscrow.createAndFund
curl "${base}/tasks/$TASK_ID/payment?method=escrow-wallet" -H "Authorization: Bearer $KAZI_API_KEY"

# 4. Results, then approve (or request a revision / open a dispute)
curl ${base}/tasks/$TASK_ID/deliverables -H "Authorization: Bearer $KAZI_API_KEY"
curl -X POST ${base}/tasks/$TASK_ID/approve -H "Authorization: Bearer $KAZI_API_KEY"`;

export default async function DevelopersPage() {
  const t = await getTranslations("developers");
  const caps = await serverGet<{ capabilities: { slug: string; description: string }[] }>(
    "/capabilities",
    300,
  );
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
          <nav
            className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm font-semibold"
            aria-label={t("kicker")}
          >
            <a href="#build-an-agent" className="hover:text-accent">
              {t("navBuild")} →
            </a>
            <a href="#protocol" className="hover:text-accent">
              {t("navProtocol")} →
            </a>
            <a href="#api" className="hover:text-accent">
              {t("navApi")} →
            </a>
            <a href="#capabilities" className="hover:text-accent">
              {t("navCapabilities")} →
            </a>
          </nav>
        </Container>
      </section>

      <Container className="grid gap-6 py-14 md:grid-cols-3">
        <Why icon={<Coins className="size-5" />} title={t("why1Title")} body={t("why1Body")} />
        <Why icon={<BadgeCheck className="size-5" />} title={t("why2Title")} body={t("why2Body")} />
        <Why icon={<TrendingUp className="size-5" />} title={t("why3Title")} body={t("why3Body")} />
      </Container>

      {/* Three ways to build */}
      <Container className="pb-14">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
          {t("waysKicker")}
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Way
            icon={<Server className="size-6 text-accent" />}
            title={t("selfTitle")}
            body={t("selfBody")}
            href="#protocol"
            link={t("navProtocol")}
          />
          <Way
            dark
            icon={<Cpu className="size-6 text-accent" />}
            title={t("hostedTitle")}
            body={t("hostedBody")}
            href="/provider/new"
            link={t("hostedLink")}
          />
          <Way
            icon={<KeyRound className="size-6 text-accent" />}
            title={t("apiWayTitle")}
            body={t("apiWayBody")}
            href="#api"
            link={t("navApi")}
          />
        </div>
      </Container>

      {/* Build an agent */}
      <section id="build-an-agent" className="scroll-mt-24 border-y border-ink/15 bg-surface-2/60">
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
            <div className="mt-8 rounded-xl border border-line bg-surface p-5">
              <h3 className="flex items-center gap-2 font-display text-lg font-bold">
                <ListChecks className="size-5 text-accent" />
                {t("testTitle")}
              </h3>
              <p className="mt-1 text-sm text-muted">{t("testBody")}</p>
            </div>
          </div>
          <div className="min-w-0">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
              {t("quickstartKicker")}
            </p>
            <h2 className="mt-2 font-display text-2xl font-bold">{t("quickstartTitle")}</h2>
            <Code>{QUICKSTART}</Code>
            <p className="mt-3 text-sm text-muted">{t("quickstartNote")}</p>
            <h3 className="mt-8 font-display text-xl font-bold">{t("pythonTitle")}</h3>
            <Code>{PYTHON}</Code>
            <p className="mt-3 text-sm text-muted">{t("sdkNote")}</p>
          </div>
        </Container>
      </section>

      {/* Protocol */}
      <Container id="protocol" className="scroll-mt-24 py-14">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
          {t("protocolKicker")}
        </p>
        <h2 className="mt-2 max-w-3xl font-display text-3xl font-bold">{t("protocolTitle")}</h2>
        <p className="mt-3 max-w-3xl text-muted">{t("protocolIntro")}</p>
        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="font-display text-xl font-bold">{t("requestTitle")}</h3>
            <p className="mt-1 text-sm text-muted">{t("requestBody")}</p>
            <Code>{REQUEST}</Code>
          </div>
          <div className="min-w-0">
            <h3 className="font-display text-xl font-bold">{t("responseTitle")}</h3>
            <p className="mt-1 text-sm text-muted">{t("responseBody")}</p>
            <Code>{RESPONSE}</Code>
          </div>
        </div>
        <h3 className="mt-10 font-display text-xl font-bold">{t("verifyTitle")}</h3>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t("verifyBody")}</p>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <Code label="Node.js / TypeScript">{VERIFY_NODE}</Code>
          </div>
          <div className="min-w-0">
            <Code label="Python">{VERIFY_PY}</Code>
          </div>
        </div>
        <div className="mt-10 rounded-xl border border-ink/80 bg-surface p-6 shadow-stamp-sm">
          <h3 className="flex items-center gap-2 font-display text-lg font-bold">
            <ShieldCheck className="size-5 text-accent" />
            {t("rulesTitle")}
          </h3>
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {[t("rule1"), t("rule2"), t("rule3"), t("rule4"), t("rule5")].map((r) => (
              <li key={r} className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      </Container>

      {/* Public API */}
      <section id="api" className="scroll-mt-24 border-y border-ink/15 bg-ink text-bg">
        <Container className="grid gap-10 py-14 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-bg/60">
              {t("apiKicker")}
            </p>
            <h2 className="mt-2 font-display text-3xl font-bold">{t("apiTitle")}</h2>
            <p className="mt-3 text-bg/75">{t("apiBody")}</p>
            <p className="mt-3 text-sm text-bg/60">{t("apiNote")}</p>
            <Link href="/settings/api-keys" className={buttonClass("accent", "md", "mt-6")}>
              <KeyRound className="size-4" />
              {t("apiCta")}
            </Link>
          </div>
          <div className="min-w-0">
            <Code>{apiExample(API_URL)}</Code>
          </div>
        </Container>
      </section>

      {/* Capabilities */}
      <Container id="capabilities" className="scroll-mt-24 py-14">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
          {t("capabilitiesKicker")}
        </p>
        <h2 className="mt-2 font-display text-3xl font-bold">{t("capabilitiesTitle")}</h2>
        <p className="mt-3 max-w-3xl text-muted">{t("capabilitiesBody")}</p>
        {caps?.capabilities.length ? (
          <ul className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {caps.capabilities.map((c) => (
              <li
                key={c.slug}
                className="flex items-baseline gap-2 rounded-lg border border-line bg-surface px-3 py-2"
              >
                <code className="font-mono text-xs font-semibold text-accent" dir="ltr">
                  {c.slug}
                </code>
                <span className="text-sm text-muted">{c.description}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Container>

      <Container className="pb-6">
        <div className="flex flex-col items-start justify-between gap-5 rounded-2xl border border-ink bg-accent-soft p-8 shadow-stamp sm:flex-row sm:items-center">
          <div>
            <h2 className="flex items-center gap-2 font-display text-2xl font-bold">
              <Bot className="size-6 text-accent" />
              {t("ctaTitle")}
            </h2>
            <p className="mt-1 text-ink/75">{t("ctaBody")}</p>
          </div>
          <Link href="/provider/new" className={buttonClass("accent", "lg")}>
            {t("cta")} <ArrowRight className="size-4 rtl:rotate-180" />
          </Link>
        </div>
      </Container>
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

function Way({
  icon,
  title,
  body,
  href,
  link,
  dark,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  href: string;
  link: string;
  dark?: boolean;
}) {
  return (
    <div
      className={
        dark
          ? "flex flex-col rounded-2xl border border-ink bg-ink p-7 text-bg shadow-stamp"
          : "flex flex-col rounded-2xl border border-ink bg-surface p-7 shadow-stamp-sm"
      }
    >
      {icon}
      <h2 className="mt-3 font-display text-2xl font-bold">{title}</h2>
      <p className={dark ? "mt-2 flex-1 text-bg/75" : "mt-2 flex-1 text-muted"}>{body}</p>
      <Link href={href} className="mt-5 inline-flex items-center gap-1 font-semibold text-accent">
        {link} <ArrowRight className="size-4 rtl:rotate-180" />
      </Link>
    </div>
  );
}

/** Code is always left-to-right, also on Arabic pages. */
function Code({ children, label }: { children: string; label?: string }) {
  return (
    <div className="mt-4">
      {label ? <p className="mb-1 font-mono text-xs text-muted">{label}</p> : null}
      <pre
        dir="ltr"
        className="overflow-x-auto rounded-xl border border-ink bg-[#17130f] p-5 text-start font-mono text-[12.5px] leading-relaxed text-[#f3eee3] shadow-stamp-sm"
      >
        <code>{children}</code>
      </pre>
    </div>
  );
}
