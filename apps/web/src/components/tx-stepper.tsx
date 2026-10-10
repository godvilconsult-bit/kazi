"use client";

import type { ReactNode } from "react";
import { Check, Circle, Loader2, Minus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { TxStep } from "@/lib/tx-steps";
import { TxLink } from "./money";

/** Vertical list of wallet transactions with their live state (docs/07-FRONTEND.md §1). */
export function TxStepper({ steps, labels }: { steps: TxStep[]; labels: Record<string, ReactNode> }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={s.key} className="flex gap-3">
          <span
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-bold",
              s.status === "done" && "border-ok bg-ok text-white",
              s.status === "skipped" && "border-line bg-surface-2 text-muted",
              s.status === "error" && "border-bad bg-bad-soft text-bad",
              (s.status === "wallet" || s.status === "pending") && "border-accent bg-accent-soft text-accent",
              s.status === "idle" && "border-line bg-surface text-muted",
            )}
            aria-hidden
          >
            {s.status === "done" ? (
              <Check className="size-4" />
            ) : s.status === "skipped" ? (
              <Minus className="size-4" />
            ) : s.status === "error" ? (
              <X className="size-4" />
            ) : s.status === "wallet" || s.status === "pending" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : s.status === "idle" ? (
              <span>{i + 1}</span>
            ) : (
              <Circle className="size-3" />
            )}
          </span>
          <div className="min-w-0 pt-0.5">
            <p className={cn("text-sm font-semibold", s.status === "skipped" && "text-muted line-through")}>{labels[s.key]}</p>
            {s.hash ? <TxLink hash={s.hash} className="mt-0.5" /> : null}
            {s.error ? <p className="mt-1 text-sm text-bad">{s.error}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
