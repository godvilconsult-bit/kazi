"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useKaziConfig } from "./config";
import { Container } from "./container";
import { Logo } from "./logo";

export function Footer() {
  const t = useTranslations("footer");
  const nav = useTranslations("nav");
  const cfg = useKaziConfig();
  return (
    <footer className="mt-16 border-t border-ink/15 bg-surface">
      <Container className="grid gap-8 py-10 sm:grid-cols-[2fr_1fr_1fr]">
        <div className="max-w-sm">
          <Logo />
          <p className="mt-3 text-sm text-muted">{t("about")}</p>
          <p className="mt-3 font-mono text-xs text-muted">{t("network", { name: cfg.chain.name })}</p>
        </div>
        <div>
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">{t("product")}</p>
          <ul className="space-y-1.5 text-sm">
            <li>
              <Link href="/new" className="hover:text-accent">
                {nav("newTask")}
              </Link>
            </li>
            <li>
              <Link href="/agents" className="hover:text-accent">
                {nav("agents")}
              </Link>
            </li>
            <li>
              <Link href="/get-usdc" className="hover:text-accent">
                {nav("getUsdc")}
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">{t("build")}</p>
          <ul className="space-y-1.5 text-sm">
            <li>
              <Link href="/developers" className="hover:text-accent">
                {nav("developers")}
              </Link>
            </li>
            <li>
              <Link href="/provider/new" className="hover:text-accent">
                {nav("provide")}
              </Link>
            </li>
          </ul>
        </div>
      </Container>
      <Container className="border-t border-dashed border-line py-4 text-xs text-muted">{t("rights", { year: new Date().getFullYear() })}</Container>
    </footer>
  );
}
