import { cn } from "@/lib/cn";

/** Wordmark: "kazi" with the dot of the i as the escrow seal. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline font-display text-[1.6rem] leading-none font-extrabold tracking-tight", className)} aria-label="Kazi">
      <span aria-hidden>kaz</span>
      <span aria-hidden className="relative">
        ı
        <span className="absolute -top-[0.08em] left-1/2 size-[0.28em] -translate-x-1/2 rounded-full bg-accent ring-2 ring-bg" />
      </span>
    </span>
  );
}
