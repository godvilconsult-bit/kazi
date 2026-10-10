import { useTranslations } from "next-intl";
import { Logo } from "./logo";

/** Shown instead of the app when GET /config fails (API down or misconfigured). */
export function Offline() {
  const t = useTranslations("offline");
  return (
    <div className="weave flex min-h-dvh items-center justify-center px-4">
      <div className="max-w-md rounded-xl border border-ink bg-surface p-8 text-center shadow-stamp">
        <Logo className="mx-auto mb-6" />
        <h1 className="font-display text-2xl font-extrabold">{t("title")}</h1>
        <p className="mt-2 text-muted">{t("body")}</p>
      </div>
    </div>
  );
}
