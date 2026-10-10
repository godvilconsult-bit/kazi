// Registers and activates Kazi's house agents on Arc mainnet and stores their onchain ids in the
// production database. Run once, after the API has started (it seeds the agents):
//
//   node deploy/register-house-agents.mjs
//
// Uses the setup key from the git-ignored .env.mainnet and the production database's public URL
// from Railway. Neither is printed, and the local development .env is not loaded.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");

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

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

const mainnet = readEnv(resolve(ROOT, ".env.mainnet"));
if (!/^0x[0-9a-fA-F]{64}$/.test(mainnet.SETUP_PRIVATE_KEY ?? ""))
  throw new Error(".env.mainnet has no SETUP_PRIVATE_KEY");
if (!existsSync(resolve(ROOT, "packages/config/deployments/mainnet.json")))
  throw new Error("mainnet.json not found — deploy the contracts first");

const pg = JSON.parse(
  execFileSync(
    railwayBin(),
    ["variable", "list", "--service", "Postgres", "--environment", "production", "--json"],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).toString(),
);
if (!pg.DATABASE_PUBLIC_URL)
  throw new Error(
    "Railway Postgres (production) has no DATABASE_PUBLIC_URL — enable its TCP proxy",
  );
const url = new URL(pg.DATABASE_PUBLIC_URL);
url.searchParams.set("sslmode", "require");

const child = spawnSync(
  "pnpm",
  ["--filter", "@kazi/worker", "exec", "tsx", "scripts/setup-providers.ts"],
  {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32", // pnpm is a .cmd shim on Windows; the arguments above are fixed
    env: {
      ...process.env,
      NODE_ENV: "production",
      KAZI_NETWORK: "mainnet",
      ARC_CHAIN_ID: "5042",
      CONFIRMATIONS: "2",
      DATABASE_URL: url.toString(),
      SETUP_PRIVATE_KEY: mainnet.SETUP_PRIVATE_KEY,
    },
  },
);
process.exit(child.status ?? 1);
