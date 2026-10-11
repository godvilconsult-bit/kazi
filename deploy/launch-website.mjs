// Puts the website live on Railway in one go, after the contracts are deployed:
//   1. deploy/railway-setup.mjs — services + variables (secrets over stdin, never printed)
//   2. `railway up` for house-agents, api, worker and web (Railway builds the root Dockerfile)
//   3. the custom domains, printing the DNS records to add at your registrar
//
//   node deploy/launch-website.mjs
//
// Safe to re-run: existing services, variables and domains are kept or updated.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const ENVIRONMENT = "production";

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
const railway = (args, opts = {}) =>
  execFileSync(railwayBin(), args, { cwd: ROOT, stdio: "pipe", ...opts })?.toString() ?? "";

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

if (!existsSync(resolve(ROOT, "packages/config/deployments/mainnet.json")))
  throw new Error(
    "deploy the contracts first: pnpm -F @kazi/contracts deploy:mainnet -- --i-accept-unaudited-contracts",
  );
const env = readEnv(resolve(ROOT, ".env.production"));
const site = env.SITE_HOST || env.DOMAIN;
const apiHost = `api.${env.DOMAIN}`;

console.log("1/3 services and variables");
execFileSync(process.execPath, [resolve(ROOT, "deploy/railway-setup.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
});

console.log("\n2/3 uploading and building (Railway builds in the background)");
for (const s of ["house-agents", "api", "worker", "web"]) {
  railway(["up", ROOT, "--service", s, "--environment", ENVIRONMENT, "--detach"]);
  console.log(`  ${s}: upload done, build started`);
}

console.log("\n3/3 domains");
for (const [domain, service, port] of [
  [site, "web", "3000"],
  [apiHost, "api", "4000"],
]) {
  try {
    const out = railway([
      "domain",
      domain,
      "--service",
      service,
      "--environment",
      ENVIRONMENT,
      "--port",
      port,
    ]);
    console.log(`\n${domain} → ${service}\n${out.trim()}`);
  } catch (err) {
    // Already attached: show its DNS details again.
    const status = (() => {
      try {
        return railway([
          "domain",
          "status",
          domain,
          "--service",
          service,
          "--environment",
          ENVIRONMENT,
        ]);
      } catch {
        return String(err?.stderr ?? err?.message ?? err);
      }
    })();
    console.log(`\n${domain} → ${service}\n${status.trim()}`);
  }
}

console.log(`
Next:
  • Add the DNS records above at your registrar (Namecheap → Domain List → ${env.DOMAIN} → Advanced DNS),
    remove the parking records, and add a URL redirect from @ to https://${site}.
  • Watch the builds: railway logs --service api --environment production
  • When https://${apiHost}/health answers, register the house agents: node deploy/register-house-agents.mjs
  • Send ~5 USDC (Arc mainnet) to the operator for payout gas.`);
