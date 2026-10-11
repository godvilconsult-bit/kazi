// Creates Kazi's services in the Railway `production` environment and sets their variables for
// Arc mainnet (guarded launch). Idempotent: re-run after changing .env.production.
//
//   node deploy/railway-setup.mjs            # needs .env.production and packages/config/deployments/mainnet.json
//
// Secrets are read from the git-ignored .env.production (and the platform signer keys from
// .env.mainnet) and piped to Railway on stdin — never printed or passed on a command line. Deploying
// is a separate step (deploy/README.md).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_FILE = resolve(ROOT, ".env.production");
const MAINNET_ENV_FILE = resolve(ROOT, ".env.mainnet");
const DEPLOYMENT = resolve(ROOT, "packages/config/deployments/mainnet.json");
const ENVIRONMENT = "production";
const SERVICES = ["api", "worker", "house-agents", "web"];

function railwayBin() {
  const exe = join(
    homedir(),
    "AppData",
    "Roaming",
    "npm",
    "node_modules",
    "@railway",
    "cli",
    "bin",
    "railway.exe",
  );
  return (
    process.env.RAILWAY_BIN ?? (process.platform === "win32" && existsSync(exe) ? exe : "railway")
  );
}
const railway = (args, input) =>
  execFileSync(railwayBin(), args, {
    cwd: ROOT,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).toString();

function readEnv(path) {
  if (!existsSync(path))
    throw new Error(`${path} not found — copy deploy/production.env.example and fill it in`);
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

const env = readEnv(ENV_FILE);
const required = [
  "DOMAIN",
  "ADMIN_WALLETS",
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];
const missing = required.filter((k) => !env[k]);
if (missing.length) throw new Error(`.env.production is missing: ${missing.join(", ")}`);

// Platform signers (docs/runbooks/deploy.md §4): AWS KMS when its key ids are set; otherwise the keys
// in .env.mainnet (`pnpm -F @kazi/contracts signers:generate`), held as Railway secrets. The worker
// accepts those on mainnet only while open escrow is capped at 10,000 USDC or less.
const kms = Boolean(env.OPERATOR_KMS_KEY_ID && env.QUOTER_KMS_KEY_ID);
if (kms) {
  const miss = ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
  if (miss.length) throw new Error(`KMS signers need ${miss.join(", ")} in .env.production`);
} else {
  const mainnetEnv = readEnv(MAINNET_ENV_FILE);
  for (const k of ["OPERATOR_PRIVATE_KEY", "QUOTER_PRIVATE_KEY"]) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(mainnetEnv[k] ?? ""))
      throw new Error(
        `.env.mainnet has no ${k}: run \`pnpm -F @kazi/contracts signers:generate\` (or set the KMS key ids)`,
      );
    env[k] = mainnetEnv[k]; // in memory only; piped to the worker below
  }
  const units = (v) => {
    if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`not a USDC amount: ${v}`);
    const [whole, fraction = ""] = v.split(".");
    return BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18));
  };
  if (units(env.MAX_OPEN_ESCROW_USDC || "2000") > units("10000"))
    throw new Error("Railway-held signer keys need MAX_OPEN_ESCROW_USDC ≤ 10000: use KMS first");
}
const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
if (!hostname.test(env.DOMAIN) || env.DOMAIN.startsWith("www."))
  throw new Error(`DOMAIN must be the bare domain (e.g. kazilabs.online), got: ${env.DOMAIN}`);
// The site's own host: the bare domain, or a subdomain of it such as www.
const site = env.SITE_HOST || env.DOMAIN;
if (!hostname.test(site) || (site !== env.DOMAIN && !site.endsWith(`.${env.DOMAIN}`)))
  throw new Error(`SITE_HOST must be ${env.DOMAIN} or a subdomain of it, got: ${site}`);
if (!existsSync(DEPLOYMENT))
  throw new Error("deploy the contracts first: pnpm -F @kazi/contracts deploy:mainnet");
const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
const safe = deployment.adminSafe;

// The private files bucket in Supabase Storage (signed URLs only); created once, idempotent.
const bucket = env.STORAGE_BUCKET || "kazi-files-prod";
const bucketRes = await globalThis.fetch(
  `${env.SUPABASE_URL.replace(/\/$/, "")}/storage/v1/bucket`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
  },
);
if (bucketRes.ok) console.log(`created private storage bucket ${bucket}`);
else {
  const body = await bucketRes.text();
  if (!/already exists/i.test(body))
    throw new Error(
      `creating storage bucket ${bucket} failed: ${bucketRes.status} ${body.slice(0, 200)}`,
    );
}

// Generated once, then kept in .env.production so re-runs don't log everyone out.
const generated = {
  JWT_SECRET: () => randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
  HOUSE_AGENTS_SECRET: () => randomBytes(48).toString("base64url"),
  METRICS_TOKEN: () => randomBytes(24).toString("base64url"),
};
for (const [k, make] of Object.entries(generated)) {
  if (!env[k]) {
    env[k] = make();
    appendFileSync(ENV_FILE, `${k}=${env[k]}\n`);
    console.log(`generated ${k} (stored in .env.production)`);
  }
}

const app = `https://${site}`;
const api = `https://api.${env.DOMAIN}`;
const shared = {
  NODE_ENV: "production",
  KAZI_NETWORK: "mainnet",
  ARC_CHAIN_ID: "5042",
  CONFIRMATIONS: "2",
  DATABASE_URL: "${{Postgres.DATABASE_URL}}?connection_limit=20",
  REDIS_URL: "${{Redis.REDIS_URL}}",
  REDIS_KEY_PREFIX: "kazi",
  APP_URL: app,
  API_URL: api,
  ADMIN_WALLETS: env.ADMIN_WALLETS,
  TREASURY_ADDRESS: safe,
  STORAGE_BUCKET: env.STORAGE_BUCKET || "kazi-files-prod",
  SUPABASE_URL: env.SUPABASE_URL,
  LOG_LEVEL: "info",
};
const plain = {
  api: {
    ...shared,
    KAZI_SERVICE: "api",
    API_HOST: "::", // IPv4 + IPv6: Railway's private network (web → api.railway.internal) can be IPv6
    PORT: "4000",
    TRUST_PROXY: "1",
    COOKIE_DOMAIN: `.${env.DOMAIN}`,
    PUBLIC_RPC_URL: "https://rpc.mainnet.arc.io",
    SEED_ON_START: "true",
    HOUSE_AGENTS_BASE_URL: "http://house-agents.railway.internal:4100",
    HOUSE_AGENTS_PAYOUT_ADDRESS: safe,
    ROUTER_DISABLED: "false",
  },
  worker: {
    ...shared,
    KAZI_SERVICE: "worker",
    ...(kms
      ? {
          SIGNER_BACKEND: "aws-kms",
          AWS_REGION: env.AWS_REGION,
          OPERATOR_KMS_KEY_ID: env.OPERATOR_KMS_KEY_ID,
          QUOTER_KMS_KEY_ID: env.QUOTER_KMS_KEY_ID,
        }
      : { SIGNER_BACKEND: "env", ALLOW_PLAINTEXT_KEYS: "true" }),
    // Guarded launch: small caps, Kazi's own agents only (no slug matches this allowlist entry).
    MAX_TASK_USDC: env.MAX_TASK_USDC || "100",
    MAX_OPEN_ESCROW_USDC: env.MAX_OPEN_ESCROW_USDC || "2000",
    PROVIDER_ALLOWLIST: "kazi-house-agents-only",
    ROUTER_CONCURRENCY: "4",
    ALERT_LARGE_RELEASE_USDC: "50",
    ALERT_DAILY_RELEASE_USDC: "1000",
    ALERT_OPERATOR_MIN_GAS: "1",
    ALERT_LLM_HOURLY_USD: "10",
  },
  // Needs no database, Redis or storage access: it only talks to Claude and signs its replies.
  "house-agents": {
    KAZI_SERVICE: "house-agents",
    NODE_ENV: "production",
    PORT: "4100",
    HOUSE_AGENTS_BASE_URL: "http://house-agents.railway.internal:4100",
  },
  web: {
    KAZI_SERVICE: "web",
    PORT: "3000",
    NODE_ENV: "production",
    NEXT_PUBLIC_API_URL: api,
    API_URL_INTERNAL: "http://api.railway.internal:4000",
    NEXT_PUBLIC_FEATURE_BOND: "0", // no provider bonds before the token launch
    GEO_RESTRICTED_COUNTRIES: "US,CU,IR,KP,SY",
    GEO_COUNTRY_HEADER: "cf-ipcountry", // put Cloudflare (proxied) in front of the domain
  },
};
const secrets = {
  api: [
    "JWT_SECRET",
    "ENCRYPTION_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "HOUSE_AGENTS_SECRET",
    "METRICS_TOKEN",
    "SENTRY_DSN",
    "CHAINALYSIS_API_KEY",
  ],
  worker: [
    "ENCRYPTION_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ANTHROPIC_API_KEY",
    ...(kms
      ? ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
      : ["OPERATOR_PRIVATE_KEY", "QUOTER_PRIVATE_KEY"]),
    "METRICS_TOKEN",
    "SENTRY_DSN",
    "ALERT_WEBHOOK_URL",
  ],
  "house-agents": ["HOUSE_AGENTS_SECRET", "ANTHROPIC_API_KEY"],
  web: ["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"],
};

// ── Services ─────────────────────────────────────────────────────────────────
railway(["environment", "link", ENVIRONMENT]);
const status = JSON.parse(railway(["status", "--json"]));
// Services belong to the project; an instance per environment. Count both so a re-run never duplicates.
const prod = status.environments.edges.find((e) => e.node.name === ENVIRONMENT)?.node;
const existing = new Set([
  ...status.services.edges.map((e) => e.node.name),
  ...(prod?.serviceInstances?.edges ?? []).map((e) => e.node.serviceName),
]);
for (const s of SERVICES) {
  if (existing.has(s)) continue;
  railway(["add", "--service", s]);
  console.log(`created service ${s}`);
}

// ── Variables ────────────────────────────────────────────────────────────────
for (const s of SERVICES) {
  const pairs = Object.entries(plain[s]).map(([k, v]) => `${k}=${v}`);
  railway([
    "variable",
    "set",
    ...pairs,
    "--service",
    s,
    "--environment",
    ENVIRONMENT,
    "--skip-deploys",
  ]);
  let n = 0;
  for (const k of secrets[s]) {
    if (!env[k]) continue;
    railway(
      [
        "variable",
        "set",
        k,
        "--stdin",
        "--service",
        s,
        "--environment",
        ENVIRONMENT,
        "--skip-deploys",
      ],
      env[k],
    );
    n++;
  }
  console.log(`${s}: ${pairs.length} settings + ${n} secrets set`);
}
console.log(`worker signers: ${kms ? "AWS KMS" : "Railway secrets (keys from .env.mainnet)"}`);
console.log(
  `\nNext: deploy each service (deploy/README.md), then point ${site} and api.${env.DOMAIN} at Railway.`,
);
