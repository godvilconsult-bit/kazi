/**
 * The web app's languages (docs/07-FRONTEND.md §1). English is the source; every other catalog in
 * src/messages has exactly its keys (test/web.test.ts). The locale lives in a cookie; URLs stay the
 * same. Safe to import from client components (no next/headers).
 */
export const LOCALES = ["en", "sw", "fr", "es", "de", "sv", "ru", "zh", "ar"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Each language's own name, as its speakers write it. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  sw: "Kiswahili",
  fr: "Français",
  es: "Español",
  de: "Deutsch",
  sv: "Svenska",
  ru: "Русский",
  zh: "中文",
  ar: "العربية",
};

const RTL: ReadonlySet<Locale> = new Set(["ar"]);

export function isLocale(v: string | undefined | null): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

export function localeDir(locale: string): "ltr" | "rtl" {
  return isLocale(locale) && RTL.has(locale) ? "rtl" : "ltr";
}

/**
 * Best supported locale for an Accept-Language header ("sv-SE,sv;q=0.9,en;q=0.8"), by quality then
 * order; region subtags match their language ("zh-CN" → zh). Falls back to English.
 */
export function matchAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return { lang: tag.toLowerCase().split("-")[0] ?? "", quality, i };
    })
    .filter((r) => r.lang && Number.isFinite(r.quality) && r.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.i - b.i);
  return ranked.map((r) => r.lang).find(isLocale) ?? DEFAULT_LOCALE;
}

/**
 * A catalog over English, key by key, so a key a catalog lacks falls back to English. Arrays (the
 * roadmap's items) are values: a translated list replaces the English one whole.
 */
export function mergeMessages(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const isObject = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x);
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObject(v) && isObject(b) ? mergeMessages(b, v) : v;
  }
  return out;
}
