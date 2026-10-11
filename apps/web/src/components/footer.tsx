"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { X_HANDLE, X_URL } from "@/lib/links";
import { useKaziConfig } from "./config";
import { Container } from "./container";
import { KaziCaLine } from "./kazi-ca";
import { Logo } from "./logo";

export function Footer() {
  const t = useTranslations("footer");
  const nav = useTranslations("nav");
  const cfg = useKaziConfig();
  return (
    <footer className="mt-16 border-t border-ink/15 bg-surface print:hidden">
      <Container className="grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
        <div className="max-w-sm sm:col-span-2 lg:col-span-1">
          <Logo />
          <p className="mt-3 text-sm text-muted">{t("about")}</p>
          <p className="mt-3 font-mono text-xs text-muted">
            {t("network", { name: cfg.chain.name })}
          </p>
          <KaziCaLine />
          <a
            href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-ink/70 bg-bg px-3 py-1.5 text-sm font-semibold hover:bg-surface-2"
          >
            <XLogo className="size-3.5" />
            <span>{t("followX", { handle: X_HANDLE })}</span>
          </a>
        </div>
        <FooterColumn
          title={t("product")}
          links={[
            ["/new", nav("newTask")],
            ["/agents", nav("agents")],
            ["/get-usdc", nav("getUsdc")],
          ]}
        />
        <FooterColumn
          title={t("build")}
          links={[
            ["/developers", nav("developers")],
            ["/developers#build-an-agent", t("buildAgent")],
            ["/developers#api", t("api")],
            ["/provider/new", nav("provide")],
          ]}
        />
        <FooterColumn
          title={t("resources")}
          links={[
            ["/docs", nav("docs")],
            ["/whitepaper", nav("whitepaper")],
            ["/roadmap", nav("roadmap")],
          ]}
        />
        <FooterColumn
          title={t("token")}
          links={(["token", "stake", "points", "airdrop"] as const).map((page) => [
            `/${page}`,
            nav(page),
          ])}
        />
      </Container>
      <Container className="flex flex-wrap items-center justify-between gap-3 border-t border-dashed border-line py-4 text-xs text-muted">
        <span>{t("rights", { year: new Date().getFullYear() })}</span>
        <a
          href={X_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("followX", { handle: X_HANDLE })}
          className="grid size-8 place-items-center rounded-lg hover:bg-surface-2 hover:text-ink"
        >
          <XLogo className="size-4" />
        </a>
      </Container>
    </footer>
  );
}

function FooterColumn({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">{title}</p>
      <ul className="space-y-1.5 text-sm">
        {links.map(([href, label]) => (
          <li key={href}>
            <Link href={href} className="hover:text-accent">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The X (Twitter) mark. */
function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}
