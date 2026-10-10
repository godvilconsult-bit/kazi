import { expect, test } from "@playwright/test";

/**
 * The client happy path (docs/10-BUILD-PLAN.md Phase 4): post a task → quote (mock LLM) → exact
 * USDC approve + createAndFund (anvil) → house agent delivers, evaluator passes → approve →
 * milestones released onchain → receipt with invoice.
 */
test("a client posts, funds, reviews and completes a task", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Describe a task");

  // Connect the e2e mock wallet (an unlocked anvil account) and sign in with SIWE.
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: /mock connector/i }).click();
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page.getByRole("button", { name: /0x90f7…b906/i })).toBeVisible();

  // Post the task (client-side navigation, like a user clicking the header link).
  await page.getByRole("link", { name: "New task" }).first().click();
  await page.waitForURL(/\/new$/);
  await page.locator("#description").fill("Write a business plan for a solar lamp shop in Arusha that sells 120 lamps a month.");
  await page.getByRole("button", { name: /get my free quote/i }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);

  // Quote → fund (approve + createAndFund).
  await expect(page.getByRole("heading", { name: "Your quote" })).toBeVisible();
  await expect(page.getByText("Write the business plan").first()).toBeVisible();
  await page.getByRole("button", { name: /approve & fund/i }).click();
  await expect(page.getByText("Funded. Work is starting.")).toBeVisible();

  // The house agent delivers and the evaluator accepts.
  await expect(page.getByRole("heading", { name: "Review the work" })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole("heading", { name: "Market" })).toBeVisible();

  // Approve: the payout worker releases every milestone; the indexer closes the task.
  await page.getByRole("button", { name: /approve and pay/i }).click();
  await expect(page.getByText("Approved — payouts are on their way.")).toBeVisible();
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole("heading", { name: "Receipt" })).toBeVisible();
  await expect(page.getByRole("link", { name: /download invoice/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How did it go?" })).toBeVisible();

  await page.screenshot({ path: "test-results/completed-task.png", fullPage: true });
});
