import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// Same safety rules as the API tests: only a kazi_test database (its own one), unique Redis prefix.
const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envPath, "utf8"))))
    process.env[k] ??= v;
}
const testDb = process.env["TEST_DATABASE_URL"];
if (!testDb) throw new Error("TEST_DATABASE_URL is required for worker tests");
if (!new URL(testDb).pathname.startsWith("/kazi_test")) {
  throw new Error("Refusing to run: TEST_DATABASE_URL must point at a kazi_test database");
}
// Each suite gets its own database so turbo can run suites in parallel.
const suiteDb = new URL(testDb);
suiteDb.pathname = "/kazi_test_worker";
process.env["DATABASE_URL"] = suiteDb.toString();
process.env["REDIS_KEY_PREFIX"] = `kazi-test-${randomBytes(4).toString("hex")}`;
