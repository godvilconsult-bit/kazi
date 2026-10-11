import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Standard page width + gutters (16px on phones). */
export function Container({
  children,
  className,
  narrow,
  id,
}: {
  children: ReactNode;
  className?: string;
  narrow?: boolean;
  /** Anchor target, e.g. /developers#protocol. */
  id?: string;
}) {
  return (
    <div
      id={id}
      className={cn("mx-auto w-full px-4 sm:px-6", narrow ? "max-w-3xl" : "max-w-6xl", className)}
    >
      {children}
    </div>
  );
}

export function PageBody({
  children,
  className,
  narrow,
}: {
  children: ReactNode;
  className?: string;
  narrow?: boolean;
}) {
  return (
    <Container narrow={narrow} className={cn("py-6 sm:py-10", className)}>
      {children}
    </Container>
  );
}
