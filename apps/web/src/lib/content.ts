import docsEn from "@/content/docs/en.md";
import whitepaperEn from "@/content/whitepaper/en.md";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/locales";

/**
 * Long-form pages (src/content/<kind>/<locale>.md). English is the source; a translation is used as
 * soon as its file is added here, and other languages show the English text with a notice.
 */
const CONTENT: Record<"docs" | "whitepaper", Partial<Record<Locale, string>>> = {
  docs: { en: docsEn },
  whitepaper: { en: whitepaperEn },
};

export function longForm(
  kind: keyof typeof CONTENT,
  locale: string,
): { markdown: string; locale: Locale; translated: boolean } {
  const wanted: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const own = CONTENT[kind][wanted];
  if (own) return { markdown: own, locale: wanted, translated: true };
  return {
    markdown: CONTENT[kind][DEFAULT_LOCALE] ?? "",
    locale: DEFAULT_LOCALE,
    translated: false,
  };
}
