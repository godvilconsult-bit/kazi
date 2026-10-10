import type { Logger } from "pino";
import type { Redis } from "ioredis";

/**
 * Operational alerts (docs/runbooks/README.md "Alerts → runbook"). Every alert is a structured log
 * line (`alert: <KIND>`), a Sentry event when Sentry is on, and a POST to ALERT_WEBHOOK_URL
 * (Slack/Discord-compatible JSON) when set. Repeats of the same alert are suppressed for a while
 * (Redis), so a stuck condition pages once, not every minute. Sending never throws.
 */

export const ALERT_KINDS = [
  "ESCROW_RECONCILIATION_MISMATCH",
  "LARGE_RELEASE",
  "DAILY_RELEASE_VOLUME",
  "ROLE_CHANGED",
  "ESCROW_PAUSED",
  "ESCROW_UNPAUSED",
  "ADMIN_SETTING_CHANGED",
  "PAYOUT_CHANGE_REQUESTED",
  "QUEUE_BACKLOG",
  "JOB_FAILURES",
  "LLM_COST_SPIKE",
  "OPERATOR_GAS_LOW",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type Severity = "critical" | "warning" | "info";

export interface AlertOptions {
  severity?: Severity;
  /** Distinguishes instances of one kind (a queue, a provider); defaults to the kind alone. */
  key?: string;
  /** Suppress repeats of (kind, key) for this long. 0 = always send. */
  dedupeSec?: number;
}

export interface Alerter {
  send(
    kind: AlertKind,
    summary: string,
    details?: Record<string, unknown>,
    opts?: AlertOptions,
  ): Promise<boolean>;
}

export interface AlerterDeps {
  log: Logger;
  redis?: Pick<Redis, "set"> | undefined;
  prefix?: string | undefined;
  webhookUrl?: string | undefined;
  /** Sentry (or any sink) — given the formatted message and severity. */
  report?:
    ((message: string, severity: Severity, details: Record<string, unknown>) => void) | undefined;
  onSent?: ((kind: AlertKind, severity: Severity) => void) | undefined;
  fetchImpl?: typeof fetch;
}

const DEFAULT_SEVERITY: Record<AlertKind, Severity> = {
  ESCROW_RECONCILIATION_MISMATCH: "critical",
  LARGE_RELEASE: "warning",
  DAILY_RELEASE_VOLUME: "warning",
  ROLE_CHANGED: "critical",
  ESCROW_PAUSED: "critical",
  ESCROW_UNPAUSED: "warning",
  ADMIN_SETTING_CHANGED: "warning",
  PAYOUT_CHANGE_REQUESTED: "warning",
  QUEUE_BACKLOG: "warning",
  JOB_FAILURES: "warning",
  LLM_COST_SPIKE: "warning",
  OPERATOR_GAS_LOW: "critical",
};

export function createAlerter(deps: AlerterDeps): Alerter {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    async send(kind, summary, details = {}, opts = {}) {
      const severity = opts.severity ?? DEFAULT_SEVERITY[kind];
      const dedupeSec = opts.dedupeSec ?? 15 * 60;
      try {
        if (dedupeSec > 0 && deps.redis) {
          const fresh = await deps.redis.set(
            `${deps.prefix ?? "kazi"}:alert:${kind}:${opts.key ?? "-"}`,
            "1",
            "EX",
            dedupeSec,
            "NX",
          );
          if (fresh === null) return false;
        }
      } catch (err) {
        deps.log.warn({ err }, "alert dedupe unavailable; sending anyway");
      }
      const line = { alert: kind, severity, ...details };
      if (severity === "critical") deps.log.error(line, `ALERT ${kind}: ${summary}`);
      else deps.log.warn(line, `ALERT ${kind}: ${summary}`);
      deps.onSent?.(kind, severity);
      try {
        deps.report?.(`${kind}: ${summary}`, severity, details);
      } catch {
        // reporting is best effort
      }
      if (deps.webhookUrl) {
        const text = `[${severity.toUpperCase()}] ${kind} — ${summary}`;
        try {
          const res = await doFetch(deps.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              { text, content: text, kind, severity, details },
              (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
            ),
            signal: AbortSignal.timeout(5_000),
          });
          if (!res.ok)
            deps.log.warn({ status: res.status, kind }, "alert webhook rejected the alert");
        } catch (err) {
          deps.log.warn({ err, kind }, "alert webhook unreachable");
        }
      }
      return true;
    },
  };
}
