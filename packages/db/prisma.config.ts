import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "prisma/config";

// Load the repo-root .env without overriding variables already set (so tests can point
// DATABASE_URL at the test database). No dotenv dependency: Node's built-in parser.
const envPath = resolve(import.meta.dirname, "../../.env");
if (existsSync(envPath)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envPath, "utf8")))) {
    process.env[key] ??= value;
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
