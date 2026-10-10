"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { explorerUrl, shortAddress, shortHash, usdc } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useKaziConfig } from "./config";

/** USDC amount: 2 decimals (rounded down), exact value on hover (docs/07-FRONTEND.md §1). */
export function Usdc({
  value,
  className,
  unit = true,
  strong,
}: {
  value: string | bigint | null | undefined;
  className?: string;
  unit?: boolean;
  strong?: boolean;
}) {
  const cfg = useKaziConfig();
  const v = usdc(value, cfg.usdcDecimals);
  return (
    <span
      className={cn("num whitespace-nowrap", strong && "font-bold", className)}
      title={`${v.exact} USDC`}
    >
      {v.display}
      {unit ? <span className="ml-1 text-[0.8em] font-medium text-muted">USDC</span> : null}
    </span>
  );
}

export function CopyButton({ value, className }: { value: string; className?: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={cn("rounded p-1 text-muted hover:bg-surface-2 hover:text-ink", className)}
      aria-label={t("copy")}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function AddressPill({ address, className }: { address: string; className?: string }) {
  const cfg = useKaziConfig();
  const link = explorerUrl(cfg.chain.explorerUrl, "address", address);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs",
        className,
      )}
    >
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-accent"
          title={address}
        >
          {shortAddress(address)}
        </a>
      ) : (
        <span title={address}>{shortAddress(address)}</span>
      )}
      <CopyButton value={address} />
    </span>
  );
}

export function TxLink({
  hash,
  label,
  className,
}: {
  hash: string;
  label?: string;
  className?: string;
}) {
  const cfg = useKaziConfig();
  const link = explorerUrl(cfg.chain.explorerUrl, "tx", hash);
  const text = label ?? shortHash(hash);
  return link ? (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline",
        className,
      )}
      title={hash}
    >
      {text}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  ) : (
    <span className={cn("font-mono text-xs text-muted", className)} title={hash}>
      {text}
    </span>
  );
}
