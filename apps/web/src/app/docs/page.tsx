import Link from "next/link";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowRight, Code2, FileText, Map } from "lucide-react";
import { PageBody } from "@/components/container";
import { LongForm } from "@/components/long-form";
import { Notice, PageHeader } from "@/components/ui";
import { longForm } from "@/lib/content";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("docsPage");
  return { title: t("title"), description: t("intro") };
}

export default async function DocsPage() {
  const [t, locale] = await Promise.all([getTranslations("docsPage"), getLocale()]);
  const doc = longForm("docs", locale);
  const links = [
    { href: "/developers", icon: <Code2 className="size-5" />, title: t("devTitle"), body: t("devBody") },
    { href: "/whitepaper", icon: <FileText className="size-5" />, title: t("paperTitle"), body: t("paperBody") },
    { href: "/roadmap", icon: <Map className="size-5" />, title: t("roadmapTitle"), body: t("roadmapBody") },
  ];
  return (
    <PageBody>
      <PageHeader kicker={t("kicker")} title={t("title")}>
        {t("intro")}
      </PageHeader>
      <div className="mb-10 grid gap-3 md:grid-cols-3">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="group rounded-xl border border-ink/80 bg-surface p-5 shadow-stamp-sm transition-shadow hover:shadow-stamp"
          >
            <span className="grid size-10 place-items-center rounded-lg border border-ink bg-accent-soft text-accent">
              {l.icon}
            </span>
            <span className="mt-3 flex items-center gap-1 font-display text-lg font-bold">
              {l.title}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180" />
            </span>
            <span className="mt-1 block text-sm text-muted">{l.body}</span>
          </Link>
        ))}
      </div>
      <LongForm
        markdown={doc.markdown}
        contentLang={doc.locale}
        tocLabel={t("toc")}
        notice={
          doc.translated ? null : (
            <Notice tone="info" className="mb-6">
              {t("englishOnly")}
            </Notice>
          )
        }
      />
    </PageBody>
  );
}
