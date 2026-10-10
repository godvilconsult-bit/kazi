// k6 load test for a staging API (docs/10-BUILD-PLAN.md Phase 7). Two scenarios:
//  - browse: public reads at a constant arrival rate (landing, directory, token pages);
//  - quick_tasks: 500 concurrent API clients, each creating a task (POST /v1/quick-tasks) and
//    polling until the router has quoted it — router + mock LLM + database under load.
// Funding is onchain and needs real wallet signatures: for the full lifecycle on a local stack use
// `pnpm -F @kazi/worker load-test` instead.
//
//   KAZI_API=https://api.staging.kazi.app KAZI_API_KEYS=kz_test_…,kz_test_… k6 run load/k6-api.js
//
// Point it at a stack running with KAZI_LLM_MOCK=e2e (no real LLM spend) and generous
// QUOTE_DAILY_LIMIT / API_KEY_RATE_LIMIT. Never at production.
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const API = __ENV.KAZI_API || "http://localhost:4001";
const KEYS = (__ENV.KAZI_API_KEYS || "").split(",").filter(Boolean);
const quoteTime = new Trend("kazi_quote_ms", true);
const quoteFailed = new Rate("kazi_quote_failed");

export const options = {
  scenarios: {
    browse: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "5m",
      preAllocatedVUs: 50,
      exec: "browse",
    },
    quick_tasks: {
      executor: "per-vu-iterations",
      vus: KEYS.length > 0 ? 500 : 1,
      iterations: 1,
      maxDuration: "20m",
      exec: "quickTask",
    },
  },
  thresholds: {
    "http_req_failed{scenario:browse}": ["rate<0.01"],
    "http_req_duration{scenario:browse}": ["p(95)<500"],
    "http_req_duration{scenario:quick_tasks}": ["p(95)<1500"],
    kazi_quote_ms: ["p(95)<120000"],
    kazi_quote_failed: ["rate<0.02"],
  },
};

const PAGES = [
  "/config",
  "/stats",
  "/capabilities",
  "/providers",
  "/token/metrics",
  "/token/staking",
  "/points/leaderboard",
];

export function browse() {
  const res = http.get(`${API}${PAGES[Math.floor(Math.random() * PAGES.length)]}`, {
    tags: { name: "public-read" },
  });
  check(res, { "status 200": (r) => r.status === 200 });
}

export function quickTask() {
  if (KEYS.length === 0) return;
  const key = KEYS[(__VU - 1) % KEYS.length];
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const started = Date.now();
  const created = http.post(
    `${API}/v1/quick-tasks`,
    JSON.stringify({
      description: `Write a business plan for a solar lamp shop in Arusha that sells ${100 + (__VU % 50)} lamps a month.`,
    }),
    { headers, tags: { name: "quick-task" } },
  );
  if (!check(created, { "task accepted": (r) => r.status === 202 })) {
    quoteFailed.add(1);
    return;
  }
  const id = created.json("task.id");
  for (let i = 0; i < 120; i++) {
    sleep(2 + Math.random());
    const q = http.get(`${API}/tasks/${id}/quote`, { headers, tags: { name: "quote-poll" } });
    const outcome = q.json("quote.outcome");
    if (outcome === "QUOTED") {
      quoteTime.add(Date.now() - started);
      quoteFailed.add(0);
      return;
    }
    if (outcome) break; // NEEDS_CLARIFICATION / INFEASIBLE
  }
  quoteFailed.add(1);
}
