import { createServer, type Server } from "node:http";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

/** Prometheus metrics for the worker (docs/runbooks/deploy.md §5). USDC gauges are display values. */
export function createWorkerMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "kazi_worker_" });
  const registers = [registry];
  return {
    registry,
    queueJobs: new Gauge({
      name: "kazi_queue_jobs",
      help: "Jobs per queue and state",
      labelNames: ["queue", "state"] as const,
      registers,
    }),
    jobs: new Counter({
      name: "kazi_jobs_total",
      help: "Jobs processed, by result",
      labelNames: ["queue", "name", "result"] as const,
      registers,
    }),
    alerts: new Counter({
      name: "kazi_alerts_total",
      help: "Alerts sent",
      labelNames: ["kind", "severity"] as const,
      registers,
    }),
    llmCostUsd: new Counter({
      name: "kazi_llm_cost_usd_total",
      help: "Kazi's own LLM spend through the worker (USD)",
      registers,
    }),
    llmCostThisHourUsd: new Gauge({
      name: "kazi_llm_cost_usd_this_hour",
      help: "LLM spend in the current UTC hour (USD)",
      registers,
    }),
    operatorBalance: new Gauge({
      name: "kazi_operator_native_balance",
      help: "Operator gas balance (native currency units)",
      registers,
    }),
    escrowBalanceUsdc: new Gauge({
      name: "kazi_escrow_usdc_balance",
      help: "USDC held by the escrow (last reconciliation)",
      registers,
    }),
    reconciliationOk: new Gauge({
      name: "kazi_escrow_reconciliation_ok",
      help: "1 if the last reconciliation matched, else 0",
      registers,
    }),
    releases24hUsdc: new Gauge({
      name: "kazi_releases_24h_usdc",
      help: "USDC released by the escrow in the last 24 h",
      registers,
    }),
  };
}
export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>;

/** GET /metrics on its own port; with a token, Prometheus must send `Authorization: Bearer <token>`. */
export function startMetricsServer(registry: Registry, port: number, token?: string): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/metrics") return void res.writeHead(404).end();
    if (token && req.headers.authorization !== `Bearer ${token}`)
      return void res.writeHead(401).end();
    registry
      .metrics()
      .then((body) => res.writeHead(200, { "content-type": registry.contentType }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  server.listen(port);
  return server;
}
