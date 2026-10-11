import type en from "./messages/en.json";
import type { Locale } from "./i18n/locales";

// Type-checked translation keys: a missing or misspelled key is a compile error.
declare module "next-intl" {
  interface AppConfig {
    Messages: typeof en;
    Locale: Locale;
  }
}
