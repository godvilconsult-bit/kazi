import Link from "next/link";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { serverGet } from "@/lib/server-api";
import type { Capability, ProviderPublic } from "@/lib/types";
import { AgentCard } from "@/components/agent-card";
import { AgentsMore } from "@/components/agents-more";
import { PageBody } from "@/components/container";
import { PageHeader, buttonClass } from "@/components/ui";

/** Languages offered in the filter; providers declare ISO 639-1 codes. */
const LANGUAGES = ["en", "sw", "fr", "ar", "pt", "am", "so", "rw", "zh", "es", "de", "hi"];

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("agents");
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function AgentsPage({ searchParams }: { searchParams: SearchParams }) {
  const t = await getTranslations("agents");
  const locale = await getLocale();
  const sp = await searchParams;
  const filters = {
    capability: one(sp["capability"]),
    language: one(sp["language"]),
    kind: one(sp["kind"]),
    minReputation: one(sp["minReputation"]),
    sort: one(sp["sort"]) || "reputation",
  };
  const q = new URLSearchParams({ limit: "24" });
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  const [list, caps] = await Promise.all([
    serverGet<{ providers: ProviderPublic[]; nextCursor: string | null }>(`/providers?${q}`, 30),
    serverGet<{ capabilities: Capability[] }>("/capabilities", 300),
  ]);
  const names = new Intl.DisplayNames([locale], { type: "language" });
  const select = "h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm focus:border-ink focus:outline-none";

  return (
    <PageBody>
      <PageHeader title={t("title")}>{t("subtitle")}</PageHeader>

      <form method="get" className="mb-8 grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]">
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          {t("capability")}
          <select name="capability" defaultValue={filters.capability} className={select}>
            <option value="">{t("anyCapability")}</option>
            {(caps?.capabilities ?? []).map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.slug}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          {t("language")}
          <select name="language" defaultValue={filters.language} className={select}>
            <option value="">{t("anyLanguage")}</option>
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {names.of(l) ?? l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          {t("kind")}
          <select name="kind" defaultValue={filters.kind} className={select}>
            <option value="">{t("anyKind")}</option>
            <option value="AGENT">{t("kindAgents")}</option>
            <option value="HUMAN">{t("kindHumans")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          {t("minReputation")}
          <select name="minReputation" defaultValue={filters.minReputation} className={select}>
            <option value="">—</option>
            {[50, 60, 70, 80, 90].map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          {t("sort")}
          <select name="sort" defaultValue={filters.sort} className={select}>
            <option value="reputation">{t("sortReputation")}</option>
            <option value="newest">{t("sortNewest")}</option>
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button type="submit" className={buttonClass("primary", "md", "flex-1")}>
            {t("apply")}
          </button>
          <Link href="/agents" className={buttonClass("ghost", "md")}>
            {t("reset")}
          </Link>
        </div>
      </form>

      {list && list.providers.length > 0 ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.providers.map((p) => (
              <AgentCard key={p.id} p={p} />
            ))}
          </div>
          <AgentsMore query={q.toString()} initialCursor={list.nextCursor} />
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-line px-6 py-14 text-center text-muted">{t("empty")}</p>
      )}
    </PageBody>
  );
}
