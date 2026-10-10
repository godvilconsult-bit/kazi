import { expect, test, type Page } from "@playwright/test";

/** The stat card whose label is `label` (label and value are siblings inside the card). */
const stat = (page: Page, label: string) => page.getByText(label, { exact: true }).first().locator("..");

/**
 * $KAZI pages (docs/10-BUILD-PLAN.md Phase 6) on the e2e stack, where DeployTokenLaunch has run and
 * the mock wallet has a 1,000 KAZI airdrop allocation plus 10,000 KAZI to stake:
 * claim the vested airdrop → stake (exact approve + stake) → request an unstake → token metrics.
 * Then the same page from a restricted country: staking is off, exits stay available.
 */

async function connect(page: Page) {
  await page.getByRole("button", { name: /connect wallet/i }).first().click();
  await page.getByRole("button", { name: /mock connector/i }).click();
  await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
}

test("claims the airdrop, stakes, starts an unstake and sees it on the token page", async ({ page }) => {
  test.setTimeout(720_000); // first visits compile each page in `next dev`
  await page.goto("/airdrop");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Airdrop");
  await expect(page.getByText("25% unlocks at launch, the rest over 180 days.")).toBeVisible();
  await connect(page);

  // 1,000 KAZI allocation: 25% is claimable at launch.
  await expect(page.getByText("Your allocation")).toBeVisible();
  const claim = page.getByRole("button", { name: /^claim 250\.\d\d kazi$/i });
  await expect(claim).toBeEnabled();
  await claim.click();
  await expect(page.getByRole("button", { name: /^claim 0\.\d\d kazi$/i })).toBeVisible();

  // Stake 1,000 of the wallet's 10,250 KAZI.
  await page.getByRole("contentinfo").getByRole("link", { name: "Stake", exact: true }).click();
  await page.waitForURL(/\/stake$/);
  await expect(page.getByText(/^Stakers share 30% of Kazi's platform fees/)).toBeVisible();
  await expect(stat(page, "Wallet balance")).toContainText(/10,250\.\d\d/);
  await page.locator("#stake-amount").fill("1000");
  await page.getByRole("button", { name: "Stake", exact: true }).click();
  await expect(page.getByText("Allow the vault to take 1,000.00 KAZI")).toBeVisible();
  await expect(stat(page, "Warming up")).toContainText("1,000.00");
  await expect(page.locator("#stake-amount")).toHaveValue("");

  // Start unstaking 400: the cooldown starts and a second unstake would restart it.
  await page.locator("#unstake-amount").fill("400");
  await page.getByRole("button", { name: "Unstake", exact: true }).click();
  await expect(stat(page, "Unstaking")).toContainText("400.00");
  await expect(stat(page, "Unstaking")).toContainText(/ready /);
  await expect(stat(page, "Warming up")).toContainText("600.00"); // unstaking takes warming stake first
  await expect(page.getByText("You're already unstaking 400.00 KAZI. Unstaking more restarts the cooldown for all of it.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^withdraw 400\.00 kazi$/i })).toBeDisabled();

  // Token metrics: launched, with vesting and the airdrop.
  await page.getByRole("contentinfo").getByRole("link", { name: "Token", exact: true }).click();
  await page.waitForURL(/\/token$/);
  await expect(page.getByRole("heading", { name: "Team & founders" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ecosystem & rewards" })).toBeVisible();
  await expect(page.getByText(/^Launched /)).toBeVisible();
  await expect(page.getByText(/claimed · .* left$/)).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "Airdrop" })).toBeVisible();
  await page.screenshot({ path: "test-results/token-metrics.png", fullPage: true });
});

test("visitors from a restricted country can't add stake or claim tokens", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  // A CDN adds the country header to requests for the web app only (not to the API, where a
  // browser-sent custom header would trigger a CORS preflight).
  await context.route(`${baseURL}/**`, (route) => route.continue({ headers: { ...route.request().headers(), "cf-ipcountry": "US" } }));
  const page = await context.newPage();
  await page.goto("/stake");
  await expect(page.getByText(/aren't available in your region/)).toBeVisible();
  await connect(page);
  await expect(page.locator("#stake-amount")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stake", exact: true })).toBeDisabled();
  // Exits stay open.
  await page.locator("#unstake-amount").fill("1");
  await expect(page.getByRole("button", { name: "Unstake", exact: true })).toBeEnabled();

  await page.getByRole("contentinfo").getByRole("link", { name: "Airdrop", exact: true }).click();
  await page.waitForURL(/\/airdrop$/);
  await expect(page.getByRole("button", { name: /^claim .* kazi$/i })).toBeDisabled();
  await context.close();
});
