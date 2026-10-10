// Prepares the integration-test databases next to DATABASE_URL (same server, separate DBs so
// suites can run in parallel): creates them if missing, records TEST_DATABASE_URL in the
// repo-root .env, and applies all migrations. Safe to run repeatedly: `pnpm -F @kazi/db db:test:prepare`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";
import { pgPoolConfig } from "../src/pg-config";

export const TEST_DATABASES = ["kazi_test_api", "kazi_test_worker", "kazi_test_e2e"] as const;

const root = resolve(import.meta.dirname, "../../..");
const envPath = resolve(root, ".env");
const hasEnvFile = existsSync(envPath);
if (hasEnvFile) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envPath, "utf8"))))
    process.env[k] ??= v;
}
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const client = new pg.Client({ ...pgPoolConfig(databaseUrl), connectionTimeoutMillis: 15_000 });
await client.connect();
for (const name of TEST_DATABASES) {
  const exists = await client.query("select 1 from pg_database where datname = $1", [name]);
  if (exists.rowCount === 0) {
    await client.query(`create database ${name}`);
    console.log(`created database ${name}`);
  }
}
await client.end();

// TEST_DATABASE_URL points at the server; each suite swaps in its own database name.
const testUrl = new URL(databaseUrl);
testUrl.pathname = "/kazi_test";
const env = hasEnvFile ? readFileSync(envPath, "utf8") : "";
if (hasEnvFile && !process.env["TEST_DATABASE_URL"] && !/^TEST_DATABASE_URL=/m.test(env)) {
  writeFileSync(
    envPath,
    env.replace(/^DATABASE_URL=.*$/m, (line) => `${line}\nTEST_DATABASE_URL=${testUrl.toString()}`),
  );
  console.log("TEST_DATABASE_URL added to .env");
}

for (const name of TEST_DATABASES) {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: resolve(root, "packages/db"),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: "inherit",
    shell: true,
  });
}
console.log(`test databases ready: ${TEST_DATABASES.join(", ")}`);
