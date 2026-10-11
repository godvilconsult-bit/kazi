/** Kazi UI kit. No hooks here, so these work in server and client components (Dialog lives in dialog.tsx). */

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/* ─── Buttons ─────────────────────────────────────────────────────────────── */

type Variant = "primary" | "accent" | "ghost" | "outline" | "danger" | "ok";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-ink text-bg hover:bg-accent hover:text-accent-ink shadow-stamp-sm hover:shadow-stamp border border-ink",
  accent:
    "bg-accent text-accent-ink border border-ink shadow-stamp-sm hover:shadow-stamp hover:-translate-x-px hover:-translate-y-px",
  ghost: "bg-transparent text-ink hover:bg-surface-2 border border-transparent",
  outline: "bg-surface text-ink border border-ink hover:bg-surface-2",
  danger: "bg-bad text-white border border-ink shadow-stamp-sm hover:shadow-stamp",
  ok: "bg-ok text-white border border-ink shadow-stamp-sm hover:shadow-stamp",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-base gap-2",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", extra?: string) {
  return cn(
    "inline-flex items-center justify-center rounded-lg font-semibold transition-all duration-150 select-none whitespace-nowrap",
    "disabled:opacity-50 disabled:pointer-events-none",
    variants[variant],
    sizes[size],
    extra,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading,
    className,
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
  external,
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
  external?: boolean;
}) {
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonClass(variant, size, className)}
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}

/* ─── Surfaces ────────────────────────────────────────────────────────────── */

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-xl border border-ink/80 bg-surface p-5 shadow-stamp-sm", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  kicker,
  className,
}: {
  children: ReactNode;
  kicker?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4", className)}>
      {kicker ? (
        <p className="mb-1 font-mono text-xs uppercase tracking-[0.18em] text-muted">{kicker}</p>
      ) : null}
      <h2 className="font-display text-xl font-bold tracking-tight sm:text-2xl">{children}</h2>
    </div>
  );
}

export function PageHeader({
  title,
  kicker,
  actions,
  children,
}: {
  title: ReactNode;
  kicker?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {kicker ? (
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.18em] text-muted">{kicker}</p>
        ) : null}
        <h1 className="font-display text-3xl font-extrabold tracking-tight break-words sm:text-4xl">
          {title}
        </h1>
        {children ? <div className="mt-2 text-muted">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";
const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink border-line",
  accent: "bg-accent-soft text-accent border-accent/40",
  ok: "bg-ok-soft text-ok border-ok/40",
  warn: "bg-warn-soft text-warn border-warn/40",
  bad: "bg-bad-soft text-bad border-bad/40",
  info: "bg-info-soft text-info border-info/40",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      className={cn("rounded-lg border px-4 py-3 text-sm", tones[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(title ? "mt-1" : "", "text-ink/90")}>{children}</div> : null}
    </div>
  );
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-muted", className)} role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label ? <span className="text-sm">{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-2", className)} aria-hidden />;
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn("my-4 border-dashed border-line", className)} />;
}

/* ─── Form fields ─────────────────────────────────────────────────────────── */

const fieldBase =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-[15px] text-ink placeholder:text-muted/70 transition-colors focus:border-ink focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(fieldBase, "h-10", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(fieldBase, "min-h-28 leading-relaxed", className)}
      {...rest}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(fieldBase, "h-10 pe-8", className)} {...rest}>
        {children}
      </select>
    );
  },
);

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-semibold">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Chip({
  active,
  onClick,
  children,
  className,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-sm transition-colors",
        active ? "border-ink bg-ink text-bg" : "border-line bg-surface hover:border-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ─── Tabs ────────────────────────────────────────────────────────────────── */

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode; count?: number | undefined }[];
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn("flex gap-1 overflow-x-auto border-b border-line pb-px", className)}
    >
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          type="button"
          aria-selected={it.value === value}
          onClick={() => onChange(it.value)}
          className={cn(
            "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold transition-colors",
            it.value === value
              ? "border-accent text-ink"
              : "border-transparent text-muted hover:text-ink",
          )}
        >
          {it.label}
          {it.count !== undefined ? (
            <span className="ms-1.5 font-mono text-xs text-muted">{it.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/* ─── States ──────────────────────────────────────────────────────────────── */

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-muted">{icon}</div> : null}
      <p className="font-display text-lg font-bold">{title}</p>
      {children ? <div className="mt-1 max-w-md text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel,
}: {
  title: ReactNode;
  message?: ReactNode;
  onRetry?: () => void;
  retryLabel?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-bad/50 bg-bad-soft px-5 py-4" role="alert">
      <p className="font-semibold text-bad">{title}</p>
      {message ? <p className="mt-1 text-sm text-ink/80">{message}</p> : null}
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          {retryLabel ?? "Retry"}
        </Button>
      ) : null}
    </div>
  );
}
