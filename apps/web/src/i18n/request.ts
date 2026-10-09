import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

/** English + Swahili (docs/07-FRONTEND.md §1). Locale lives in a cookie; URLs stay the same. */
export const LOCALES = ["en", "sw"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "NEXT_LOCALE";

function isLocale(v: string | undefined): v is Locale {
  return v !== undefined && (LOCALES as readonly string[]).includes(v);
}

export default getRequestConfig(async () => {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  let locale: Locale = "en";
  if (isLocale(fromCookie)) locale = fromCookie;
  else if (/(^|[,\s])sw\b/i.test((await headers()).get("accept-language") ?? "")) locale = "sw";
  const messages = (await import(`../messages/${locale}.json`)) as { default: Record<string, unknown> };
  return { locale, messages: messages.default, timeZone: "Africa/Nairobi" };
});
