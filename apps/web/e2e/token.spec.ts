import { expect, test, type Page } from "@playwright/test";

/** The stat card whose label is `label` (label and value are siblings inside the card). */
const stat = (page: Page, label: string) =>
  page.getByText(label, { exact: true }).first().locator("..");

/**
 * Token pages (docs/10-BUILD-PLAN.md Phase 6, docs/08-TOKENOMICS.md §8) on the e2e stack, where
 * DeployTokenLaunch and DeployCreditsGate have run. Kazi's token shows as "KAZI Credits" there. The
 * mock wallet has a 1,000-Credit airdrop allocation, 10,000 Credits and 5,000 KAZI (the Argus
 * stand-in): claim the vested airdrop → lock KAZI for Credits → stake (exact approve + stake) →
 * request an unstake → return Credits for KAZI → token metrics. Then the same page from a restricted
 * country: staking and locking are off, exits stay available.
 */

async function connect(page: Page) {
  await page
    .getByRole("button", { name: /connect wallet/i })
    .first()
    .click();
  await page.getByRole("button", { name: /mock connector/i }).click();
  await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
}

test("claims the airdrop, stakes, starts an unstake and sees it on the token page", async ({
  page,
}) => {
  test.setTimeout(720_000); // first visits compile each page in `next dev`
  await page.goto("/airdrop");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Airdrop");
  await expect(page.getByText("25% unlocks at launch, the rest over 180 days.")).toBeVisible();
  await connect(page);

  // 1,000-Credit allocation: 25% is claimable at launch.
  await expect(page.getByText("Your allocation")).toBeVisible();
  const claim = page.getByRole("button", { name: /^claim 250\.\d\d kazi credits$/i });
  await expect(claim).toBeEnabled();
  await claim.click();
  await expect(page.getByRole("button", { name: /^claim 0\.\d\d kazi credits$/i })).toBeVisible();

  // Lock 2,000 of the wallet's 5,000 KAZI (Argus) for 2,000 KAZI Credits, 1:1.
  await page.getByRole("contentinfo").getByRole("link", { name: "Stake", exact: true }).click();
  await page.waitForURL(/\/stake$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stake KAZI Credits");
  await expect(page.getByRole("heading", { name: "Get KAZI Credits" })).toBeVisible();
  await expect(stat(page, "KAZI in your wallet")).toContainText("5,000.00");
  await page.locator("#credits-lock-amount").fill("2000");
  await page.getByRole("button", { name: "Get KAZI Credits", exact: true }).click();
  await expect(page.getByText("Allow the exchange to take 2,000.00 KAZI")).toBeVisible();
  await expect(stat(page, "KAZI in your wallet")).toContainText("3,000.00");
  await expect(stat(page, "KAZI Credits in your wallet")).toContainText(/12,250\.\d\d/);

  // Stake 1,000 of the wallet's 12,250 Credits.
  await expect(page.getByText(/^Stakers share 30% of Kazi's platform fees/)).toBeVisible();
  await expect(stat(page, "Wallet balance")).toContainText(/12,250\.\d\d/);
  await page.locator("#stake-amount").fill("1000");
  await page.getByRole("button", { name: "Stake", exact: true }).click();
  await expect(page.getByText("Allow the vault to take 1,000.00 KAZI Credits")).toBeVisible();
  await expect(stat(page, "Warming up")).toContainText("1,000.00");
  await expect(page.locator("#stake-amount")).toHaveValue("");

  // Start unstaking 400: the cooldown starts and a second unstake would restart it.
  await page.locator("#unstake-amount").fill("400");
  await page.getByRole("button", { name: "Unstake", exact: true }).click();
  await expect(stat(page, "Unstaking")).toContainText("400.00");
  await expect(stat(page, "Unstaking")).toContainText(/ready /);
  await expect(stat(page, "Warming up")).toContainText("600.00"); // unstaking takes warming stake first
  await expect(
    page.getByText(
      "You're already unstaking 400.00 KAZI Credits. Unstaking more restarts the cooldown for all of it.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^withdraw 400\.00 kazi credits$/i }),
  ).toBeDisabled();

  // Return 500 Credits for 500 KAZI.
  await page.locator("#credits-unlock-amount").fill("500");
  await page.getByRole("button", { name: "Get my KAZI back", exact: true }).click();
  await expect(stat(page, "KAZI in your wallet")).toContainText("3,500.00");

  // Token metrics: launched, with vesting and the airdrop.
  await page.getByRole("contentinfo").getByRole("link", { name: "Token", exact: true }).click();
  await page.waitForURL(/\/token$/);
  await expect(page.getByRole("heading", { name: "Team & founders" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ecosystem & rewards" })).toBeVisible();
  await expect(page.getByText(/^Launched /)).toBeVisible();
  await expect(page.getByText(/claimed · .* left$/)).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "Airdrop" })).toBeVisible();
  // The exchange: 1,500 KAZI locked. Credits from the token launch circulate outside it locally.
  await expect(page.getByRole("heading", { name: "KAZI ⇄ KAZI Credits" })).toBeVisible();
  await expect(stat(page, "KAZI locked")).toContainText("1,500");
  await expect(page.getByText("Some Credits are not backed by locked KAZI yet.")).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "KAZI (Argus)" })).toBeVisible();
  await page.screenshot({ path: "test-results/token-metrics.png", fullPage: true });
});

test("visitors from a restricted country can't add stake or claim tokens", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext();
  // A CDN adds the country header to requests for the web app only (not to the API, where a
  // browser-sent custom header would trigger a CORS preflight).
  await context.route(`${baseURL}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-ipcountry": "US" } }),
  );
  const page = await context.newPage();
  await page.goto("/stake");
  await expect(page.getByText(/aren't available in your region/)).toBeVisible();
  await connect(page);
  await expect(page.locator("#stake-amount")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stake", exact: true })).toBeDisabled();
  await expect(page.locator("#credits-lock-amount")).toBeDisabled();
  // Exits stay open.
  await page.locator("#unstake-amount").fill("1");
  await expect(page.getByRole("button", { name: "Unstake", exact: true })).toBeEnabled();
  await page.locator("#credits-unlock-amount").fill("1");
  await expect(page.getByRole("button", { name: "Get my KAZI back", exact: true })).toBeEnabled();

  await page.getByRole("contentinfo").getByRole("link", { name: "Airdrop", exact: true }).click();
  await page.waitForURL(/\/airdrop$/);
  await expect(page.getByRole("button", { name: /^claim .* kazi credits$/i })).toBeDisabled();
  await context.close();
});
