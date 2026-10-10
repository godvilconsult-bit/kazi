import Link from "next/link";
import { Bot, Cpu, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { priceLabel } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { ProviderPublic } from "@/lib/types";
import { Badge } from "./ui";

/** Directory / landing card. Server- and client-safe (no hooks beyond translations). */

export function ReputationMeter({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct >= 80 ? "bg-ok" : pct >= 60 ? "bg-warn" : "bg-bad";
  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      title={`${pct.toFixed(1)} / 100`}
    >
      <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", tone)}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="num text-xs font-semibold">{pct.toFixed(0)}</span>
    </span>
  );
}

export function KindBadge({
  kind,
  hosting,
}: {
  kind: "AGENT" | "HUMAN";
  hosting: "SELF" | "KAZI";
}) {
  const t = useTranslations("agents");
  if (kind === "HUMAN")
    return (
      <Badge tone="info">
        <UserRound className="size-3" aria-hidden />
        {t("kindHuman")}
      </Badge>
    );
  return hosting === "KAZI" ? (
    <Badge tone="accent">
      <Cpu className="size-3" aria-hidden />
      {t("kindHosted")}
    </Badge>
  ) : (
    <Badge tone="neutral">
      <Bot className="size-3" aria-hidden />
      {t("kindAgent")}
    </Badge>
  );
}

export function AgentCard({
  p,
  className,
}: {
  p: Pick<
    ProviderPublic,
    | "slug"
    | "name"
    | "kind"
    | "hosting"
    | "capabilities"
    | "pricing"
    | "reputation"
    | "completedCount"
    | "isHouse"
  > & {
    description?: string;
  };
  className?: string;
}) {
  const t = useTranslations("agents");
  return (
    <Link
      href={`/agents/${p.slug}`}
      className={cn(
        "group flex h-full flex-col rounded-xl border border-ink/80 bg-surface p-4 shadow-stamp-sm transition-all hover:-translate-x-px hover:-translate-y-px hover:shadow-stamp",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-display text-lg font-bold leading-tight group-hover:text-accent">
          {p.name}
        </h3>
        <KindBadge kind={p.kind} hosting={p.hosting} />
      </div>
      {p.description ? (
        <p className="mt-2 line-clamp-2 text-sm text-muted">{p.description}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-1">
        {p.capabilities.slice(0, 3).map((c) => (
          <span
            key={c}
            className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted"
          >
            {c}
          </span>
        ))}
        {p.capabilities.length > 3 ? (
          <span className="px-1 font-mono text-[11px] text-muted">
            +{p.capabilities.length - 3}
          </span>
        ) : null}
      </div>
      <div className="mt-auto flex items-end justify-between gap-2 pt-4">
        <div>
          <p className="num text-sm font-semibold">{priceLabel(p.pricing)}</p>
          <p className="text-xs text-muted">{t("completed", { count: p.completedCount })}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <ReputationMeter value={p.reputation} />
          {p.isHouse ? (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
              {t("byKazi")}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
