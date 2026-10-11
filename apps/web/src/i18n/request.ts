import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  matchAcceptLanguage,
  mergeMessages,
  type Locale,
} from "./locales";

/** Locale from the cookie (set by the header's language menu), else the browser's languages. */
export default getRequestConfig(async () => {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(fromCookie)
    ? fromCookie
    : matchAcceptLanguage((await headers()).get("accept-language"));
  const messages = (await import(`../messages/${locale}.json`)) as {
    default: Record<string, unknown>;
  };
  // Every catalog has every key (test/web.test.ts); English fills anything a build somehow misses.
  const fallback =
    locale === DEFAULT_LOCALE
      ? messages.default
      : ((await import("../messages/en.json")) as { default: Record<string, unknown> }).default;
  return {
    locale,
    messages:
      locale === DEFAULT_LOCALE ? messages.default : mergeMessages(fallback, messages.default),
    timeZone: "Africa/Nairobi",
  };
});
