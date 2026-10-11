// Registers and activates Kazi's house agents on Arc mainnet and stores their onchain ids in the
// production database. Run once, after `deploy/launch-website.mjs` and once the worker is running
// (the API seeds the agents into the database on its first start):
//
//   node deploy/register-house-agents.mjs
//
// The registration runs inside the worker's container over `railway ssh`, so it reaches Postgres on
// Railway's private network and the database never needs a public address. It uses the worker's own
// environment (DATABASE_URL, chain settings, and SETUP_PRIVATE_KEY set by railway-setup.mjs).
// Idempotent: agents that already have an onchain id are skipped.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

if (!existsSync(resolve(ROOT, "packages/config/deployments/mainnet.json")))
  throw new Error("mainnet.json not found — deploy the contracts first");

const child = spawnSync(
  railwayBin(),
  [
    "ssh",
    "--service",
    "worker",
    "--environment",
    "production",
    "--",
    "sh",
    "-c",
    "cd /app/apps/worker && ./node_modules/.bin/tsx scripts/setup-providers.ts",
  ],
  { cwd: ROOT, stdio: "inherit" },
);
if (child.status !== 0)
  console.error(
    "\nRegistration didn't finish. Check that the worker is running (railway logs --service worker --environment production) and that the setup wallet has USDC for gas, then run this again.",
  );
process.exit(child.status ?? 1);
