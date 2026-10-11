import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Check, CircleDot, Clock, Rocket } from "lucide-react";
import { PageBody } from "@/components/container";
import { Badge, PageHeader } from "@/components/ui";
import { cn } from "@/lib/cn";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("roadmapPage");
  return { title: t("kicker"), description: t("intro") };
}

type Status = "done" | "live" | "next" | "later";

/** Order and status of each stage; the words live in messages (roadmapPage.phases). */
const PHASES = [
  { id: "foundations", status: "done" },
  { id: "marketplace", status: "done" },
  { id: "launch", status: "live" },
  { id: "open", status: "next" },
  { id: "token", status: "next" },
  { id: "growth", status: "later" },
] as const satisfies readonly { id: string; status: Status }[];

const STYLE: Record<Status, { tone: "ok" | "accent" | "info" | "neutral"; icon: typeof Check }> = {
  done: { tone: "ok", icon: Check },
  live: { tone: "accent", icon: Rocket },
  next: { tone: "info", icon: CircleDot },
  later: { tone: "neutral", icon: Clock },
};

export default async function RoadmapPage() {
  const t = await getTranslations("roadmapPage");
  return (
    <PageBody>
      <PageHeader kicker={t("kicker")} title={t("title")}>
        {t("intro")}
      </PageHeader>
      <ol className="relative space-y-6 border-s-2 border-dashed border-line ps-8">
        {PHASES.map((p, i) => {
          const s = STYLE[p.status];
          const Icon = s.icon;
          const items = t.raw(`phases.${p.id}.items`) as string[];
          return (
            <li key={p.id} className="relative">
              <span
                className={cn(
                  "absolute -start-[2.85rem] top-5 grid size-9 place-items-center rounded-full border-2 border-ink bg-surface",
                  p.status === "live" && "bg-accent text-accent-ink",
                  p.status === "done" && "bg-ok-soft text-ok",
                )}
                aria-hidden
              >
                <Icon className="size-4" />
              </span>
              <div
                className={cn(
                  "rounded-xl border bg-surface p-6",
                  p.status === "live" ? "border-ink shadow-stamp" : "border-ink/60 shadow-stamp-sm",
                )}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs text-muted">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h2 className="font-display text-xl font-bold">{t(`phases.${p.id}.title`)}</h2>
                  <Badge tone={s.tone}>{t(`status.${p.status}`)}</Badge>
                </div>
                <p className="mt-2 text-muted">{t(`phases.${p.id}.body`)}</p>
                <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                  {items.map((item) => (
                    <li key={item} className="flex gap-2 text-sm">
                      <span
                        className={cn(
                          "mt-1.5 size-1.5 shrink-0 rounded-full",
                          p.status === "done" ? "bg-ok" : "bg-accent",
                        )}
                        aria-hidden
                      />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-10 border-t border-dashed border-line pt-4 text-xs text-muted">
        {t("note")}
      </p>
    </PageBody>
  );
}
