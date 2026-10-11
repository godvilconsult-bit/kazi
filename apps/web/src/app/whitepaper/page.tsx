import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { PageBody } from "@/components/container";
import { LongForm } from "@/components/long-form";
import { PrintButton } from "@/components/print-button";
import { Notice, PageHeader } from "@/components/ui";
import { longForm } from "@/lib/content";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("whitepaperPage");
  return { title: t("kicker"), description: t("intro") };
}

export default async function WhitepaperPage() {
  const [t, locale] = await Promise.all([getTranslations("whitepaperPage"), getLocale()]);
  const doc = longForm("whitepaper", locale);
  return (
    <PageBody>
      <PageHeader
        kicker={t("kicker")}
        title={t("title")}
        actions={<PrintButton label={t("print")} />}
      >
        <p>{t("intro")}</p>
        <p className="mt-2 font-mono text-xs uppercase tracking-widest">{t("version")}</p>
      </PageHeader>
      <LongForm
        markdown={doc.markdown}
        contentLang={doc.locale}
        tocLabel={t("toc")}
        notice={
          doc.translated ? null : (
            <Notice tone="info" className="mb-6 print:hidden">
              {t("englishOnly")}
            </Notice>
          )
        }
      />
    </PageBody>
  );
}
