import { defineConfig } from "@playwright/test";

/**
 * Browser e2e on an isolated local stack (apps/worker/scripts/e2e-stack.ts): fresh anvil chain,
 * `kazi_test_e2e` database, scripted mock LLM, house agents, API, worker and this web app on :3100.
 * Uses the installed Microsoft Edge (no browser download). Run: `pnpm -F @kazi/web e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 360_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://localhost:3100",
    channel: "msedge",
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm --filter @kazi/worker e2e:stack",
    url: "http://localhost:3100",
    timeout: 900_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
