"use client";

import { useLocale, useTranslations } from "next-intl";
import { Clock, Cpu } from "lucide-react";
import { relativeTime, usdc } from "@/lib/format";
import type { QuoteView, TaskView } from "@/lib/types";
import { useNow } from "@/lib/use-task-events";
import { useKaziConfig } from "../config";
import { Usdc } from "../money";
import { Badge, Button } from "../ui";

type Quoted = Extract<QuoteView, { outcome: "QUOTED" }>;

/** The signed quote as a receipt: steps, providers, fees, total, validity (docs/07 §3 QUOTED). */
export function QuoteCard({
  quote,
  task,
  onSwitchSpeed,
  switching,
}: {
  quote: Quoted;
  task: TaskView;
  onSwitchSpeed?: (speed: "ECONOMY" | "EXPRESS") => void;
  switching?: boolean;
}) {
  const t = useTranslations("task");
  const locale = useLocale();
  const cfg = useKaziConfig();
  const now = useNow(15_000);
  const expired = quote.expired || new Date(quote.expiresAt).getTime() <= now;
  const speed = quote.speed ?? task.speed;
  const other = speed === "ECONOMY" ? "EXPRESS" : "ECONOMY";
  const work = quote.steps.filter((s) => s.kind === "WORK");
  const planByIndex = new Map(quote.plan.subtasks.map((s) => [s.index, s]));

  return (
    <div className="overflow-hidden rounded-xl border border-ink bg-surface shadow-stamp">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-line px-5 py-4">
        <h2 className="font-display text-xl font-bold">{t("quoteTitle")}</h2>
        <div className="flex items-center gap-2">
          <Badge tone={speed === "ECONOMY" ? "ok" : "accent"}>
            {speed === "ECONOMY" ? t("speedEconomy") : t("speedExpress")}
          </Badge>
          <span
            className={`inline-flex items-center gap-1 font-mono text-xs ${expired ? "text-bad" : "text-muted"}`}
          >
            <Clock className="size-3.5" />
            {expired
              ? t("quoteExpired")
              : t("quoteValid", {
                  time: relativeTime(quote.expiresAt, locale, now).replace(/^in /, ""),
                })}
          </span>
        </div>
      </div>

      <ol className="divide-y divide-dashed divide-line">
        {work.map((s, i) => {
          const plan = planByIndex.get(s.index);
          return (
            <li key={s.index} className="flex items-start justify-between gap-4 px-5 py-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  <span className="mr-2 font-mono text-xs text-muted">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {s.title}
                </p>
                <p className="ml-7 mt-0.5 text-sm text-muted">
                  {t("doneBy")} <span className="font-medium text-ink">{s.providerName}</span>
                  {s.aiCost ? (
                    <Cpu className="ml-1 inline size-3.5 text-accent" aria-label={t("aiCost")} />
                  ) : null}
                  {plan && plan.dependsOn.length > 0 ? (
                    <span className="ml-2 font-mono text-[11px]">
                      · {t("dependsOn", { steps: plan.dependsOn.map((d) => d + 1).join(", ") })}
                    </span>
                  ) : null}
                </p>
              </div>
              <Usdc value={s.amount} className="shrink-0 text-sm" />
            </li>
          );
        })}
      </ol>

      <div className="space-y-1.5 border-t border-dashed border-line px-5 py-3 text-sm">
        <div className="flex justify-between text-muted">
          <span>{t("serviceFee")}</span>
          <Usdc value={quote.serviceFee} unit={false} />
        </div>
        {quote.aiCost && BigInt(quote.aiCost) > 0n ? (
          <div className="flex justify-between text-muted" title={t("aiCostHint")}>
            <span>{t("aiCost")}</span>
            <Usdc value={quote.aiCost} unit={false} />
          </div>
        ) : null}
      </div>
      <div className="flex items-baseline justify-between border-t-2 border-ink px-5 py-4">
        <span className="font-display text-lg font-bold">{t("total")}</span>
        <Usdc value={quote.total} strong className="text-2xl" />
      </div>
      {quote.overBudget && task.budgetMax ? (
        <p className="border-t border-warn/40 bg-warn-soft px-5 py-2 text-sm text-warn">
          {t("overBudget", { budget: usdc(task.budgetMax, cfg.usdcDecimals).display })}
        </p>
      ) : null}
      {onSwitchSpeed && !expired ? (
        <div className="border-t border-dashed border-line px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            loading={switching}
            onClick={() => onSwitchSpeed(other)}
          >
            {t("switchTo", { speed: other === "ECONOMY" ? t("speedEconomy") : t("speedExpress") })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
