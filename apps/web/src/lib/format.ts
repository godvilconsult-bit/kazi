import { formatUnits, formatUsdcDisplay, parseUnits } from "@kazi/shared";

/**
 * Money display (docs/07-FRONTEND.md §1): 2 decimals, rounded down, exact value on hover. Amounts
 * arrive as base-unit strings; decimals come from the token via GET /config (CLAUDE.md rule 1).
 */

export function toBigInt(v: string | bigint | null | undefined): bigint {
  if (v === null || v === undefined || v === "") return 0n;
  return typeof v === "bigint" ? v : BigInt(v);
}

export function usdc(v: string | bigint | null | undefined, decimals: number) {
  const n = toBigInt(v);
  return { display: formatUsdcDisplay(n, decimals), exact: formatUnits(n, decimals) };
}

/** User input ("12.5") → base units; null when invalid. */
export function parseUsdcInput(value: string, decimals: number): bigint | null {
  const v = value.trim();
  if (v === "") return null;
  try {
    return parseUnits(v, decimals);
  } catch {
    return null;
  }
}

/** Token amounts with a few more decimals (stake, rewards). */
export function tokenAmount(v: string | bigint | null | undefined, decimals: number, places = 2): string {
  const exact = formatUnits(toBigInt(v), decimals);
  const [whole = "0", fraction = ""] = exact.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return places > 0 ? `${grouped}.${fraction.padEnd(places, "0").slice(0, places)}` : grouped;
}

export function shortAddress(a: string | null | undefined): string {
  if (!a) return "";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function shortHash(h: string | null | undefined): string {
  if (!h) return "";
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

export function explorerUrl(base: string | null | undefined, kind: "tx" | "address", value: string): string | null {
  return base ? `${base.replace(/\/$/, "")}/${kind}/${value}` : null;
}

/** "in 3 h", "2 d ago" — coarse, locale-aware relative time. */
export function relativeTime(iso: string | Date, locale: string, now = Date.now()): string {
  const t = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
  const diff = t - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(Math.round(diff / 1000), "second");
}

export function formatDate(iso: string | Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    typeof iso === "string" ? new Date(iso) : iso,
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function priceLabel(p: { model: string; unit?: string | undefined; price: string }): string {
  const unit = p.unit?.replace(/_/g, " ").replace(/^1000 /, "1,000 ");
  return p.model === "per_unit" && unit ? `${p.price} USDC / ${unit}` : `${p.price} USDC`;
}
