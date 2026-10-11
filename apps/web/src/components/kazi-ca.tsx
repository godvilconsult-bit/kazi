"use client";

import Link from "next/link";
import { ArrowRight, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { explorerUrl } from "@/lib/format";
import { useKaziConfig } from "./config";
import { KaziBurnStat } from "./kazi-burn";
import { Container } from "./container";
import { CopyButton } from "./money";
import { Card } from "./ui";

/**
 * The public KAZI token's contract address (KAZI on Argus, docs/08-TOKENOMICS.md §8), shown in full so
 * people can copy and verify it. Read from GET /config (CLAUDE.md rule 2); renders nothing on a
 * network without it.
 */
function useKaziCa() {
  const cfg = useKaziConfig();
  const address = cfg.contracts.argusKazi;
  return address ? { address, link: explorerUrl(cfg.chain.explorerUrl, "address", address) } : null;
}

function Address({ address, link }: { address: string; link: string | null }) {
  const t = useTranslations("common");
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="num break-all font-mono">{address}</span>
      <CopyButton value={address} className="shrink-0" />
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded p-1 text-muted hover:bg-surface-2 hover:text-ink"
          aria-label={t("explorer")}
          title={t("explorer")}
        >
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </span>
  );
}

/** Home page band under the numbers strip. */
export function KaziCaBand() {
  const t = useTranslations("kaziCa");
  const ca = useKaziCa();
  if (!ca) return null;
  return (
    <section className="border-b border-ink/15 bg-surface">
      <Container className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-4 text-sm">
        <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            {t("label")}
          </span>
          <Address {...ca} />
        </p>
        <KaziBurnStat />
        <Link
          href="/token"
          className="inline-flex items-center gap-1 font-semibold hover:text-accent"
        >
          {t("details")} <ArrowRight className="size-4" />
        </Link>
      </Container>
    </section>
  );
}

/** /token page card, with the impersonation warning. */
export function KaziCaCard({ className }: { className?: string }) {
  const t = useTranslations("kaziCa");
  const ca = useKaziCa();
  if (!ca) return null;
  return (
    <Card className={className}>
      <p className="font-mono text-xs uppercase tracking-widest text-muted">{t("label")}</p>
      <p className="mt-2 text-base sm:text-lg">
        <Address {...ca} />
      </p>
      <p className="mt-2 text-sm text-muted">{t("warning")}</p>
    </Card>
  );
}

/** Footer line on every page. */
export function KaziCaLine() {
  const t = useTranslations("kaziCa");
  const ca = useKaziCa();
  if (!ca) return null;
  return (
    <p className="mt-2 text-xs text-muted">
      <span className="font-mono uppercase tracking-widest">{t("short")}</span> <Address {...ca} />
    </p>
  );
}
