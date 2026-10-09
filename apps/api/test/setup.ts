import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/**
 * Test environment: repo-root .env, but DATABASE_URL is forced to TEST_DATABASE_URL and Redis
 * keys get a unique prefix, so tests never touch dev data.
 */
const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envPath, "utf8"))))
    process.env[k] ??= v;
}

const testDb = process.env["TEST_DATABASE_URL"];
if (!testDb) throw new Error("TEST_DATABASE_URL is required for API tests");
if (!new URL(testDb).pathname.startsWith("/kazi_test")) {
  throw new Error("Refusing to run: TEST_DATABASE_URL must point at a kazi_test database");
}
// Each suite gets its own database so turbo can run suites in parallel.
const suiteDb = new URL(testDb);
suiteDb.pathname = "/kazi_test_api";

Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: suiteDb.toString(),
  REDIS_KEY_PREFIX: `kazi-test-${randomBytes(4).toString("hex")}`,
  KAZI_NETWORK: "local",
  ARC_CHAIN_ID: "31337",
  ARC_RPC_URL: "",
  USDC_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  APP_URL: "http://localhost:3000",
  API_URL: "http://localhost:4000",
  // Anvil account #9 acts as the admin in tests.
  ADMIN_WALLETS: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  SUPABASE_URL: process.env["SUPABASE_URL"] ?? "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY:
    process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "test-service-role-key-not-used",
});
