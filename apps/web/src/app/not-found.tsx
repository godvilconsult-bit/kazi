import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageBody } from "@/components/container";
import { buttonClass } from "@/components/ui";

export default async function NotFound() {
  const t = await getTranslations("notFound");
  return (
    <PageBody narrow className="py-20 text-center">
      <p className="font-mono text-7xl font-bold text-accent">404</p>
      <h1 className="mt-4 font-display text-3xl font-extrabold">{t("title")}</h1>
      <p className="mt-2 text-muted">{t("body")}</p>
      <Link href="/" className={buttonClass("primary", "md", "mt-6")}>
        {t("home")}
      </Link>
    </PageBody>
  );
}
