import * as Sentry from "@sentry/node";
import type { Severity } from "./alerts";

/** Sentry for the worker when SENTRY_DSN is set; a no-op otherwise. Never sends request bodies or keys. */
export interface ErrorReporter {
  exception(err: unknown, context?: Record<string, unknown>): void;
  message(message: string, severity: Severity, context?: Record<string, unknown>): void;
}

export function initSentry(opts: { dsn?: string | undefined; environment: string; service: string }): ErrorReporter {
  if (!opts.dsn) return { exception: () => undefined, message: () => undefined };
  Sentry.init({ dsn: opts.dsn, environment: opts.environment, sendDefaultPii: false, tracesSampleRate: 0, initialScope: { tags: { service: opts.service } } });
  return {
    exception: (err, context) => void Sentry.captureException(err, context ? { extra: context } : undefined),
    message: (message, severity, context) =>
      void Sentry.captureMessage(message, { level: severity === "critical" ? "fatal" : severity === "warning" ? "warning" : "info", ...(context ? { extra: context } : {}) }),
  };
}
