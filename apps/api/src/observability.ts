import { timingSafeEqual } from "node:crypto";
import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";
import { Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Production observability for the API (docs/runbooks/deploy.md §5): Sentry for unhandled errors,
 * Prometheus metrics at GET /metrics behind a bearer token. Both are off unless configured.
 */

export type ErrorReporter = (err: unknown, context: Record<string, unknown>) => void;

export function initSentry(
  dsn: string | undefined,
  environment: string,
): ErrorReporter | undefined {
  if (!dsn) return undefined;
  Sentry.init({
    dsn,
    environment,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    initialScope: { tags: { service: "api" } },
  });
  return (err, context) => void Sentry.captureException(err, { extra: context });
}

export function registerMetrics(app: FastifyInstance, token: string | undefined): void {
  if (!token) return;
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "kazi_api_" });
  const duration = new Histogram({
    name: "kazi_api_request_duration_seconds",
    help: "API request duration by route and status",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  app.addHook("onResponse", async (req, reply) => {
    // Route templates (/tasks/:id), never raw URLs: bounded label cardinality, no ids in metrics.
    const route = req.routeOptions.url ?? "unmatched";
    if (route === "/metrics") return;
    duration.observe(
      { method: req.method, route, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });
  const expected = Buffer.from(`Bearer ${token}`);
  app.get("/metrics", async (req, reply) => {
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return reply.status(401).send();
    return reply.header("content-type", registry.contentType).send(await registry.metrics());
  });
}
