import { expect, test } from "@playwright/test";
import { newLink } from "./helpers.js";

test("the test is usable at phone width", async ({ page }) => {
  await page.goto(newLink("04-bgp-wrong-remote-as"));
  await expect(page.getByTestId("test-title")).toBeVisible();
  await page.screenshot({ path: "screenshots/mobile-1-landing.png", fullPage: true });
  await page.getByTestId("start").click();
  await expect(page.locator(".workspace")).toHaveAttribute("data-state", "running", { timeout: 120_000 });
  await expect(page.locator('[data-bgp]').first()).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-device="r1"]').click();
  await expect.poll(() => page.locator('[data-terminal="r1"] .xterm-rows').innerText(), { timeout: 30_000 }).toContain("r1#");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1); // no sideways scrolling
  await page.screenshot({ path: "screenshots/mobile-2-terminal.png" });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("details summary").first().click(); // fold the ticket away to show the diagram
  await page.screenshot({ path: "screenshots/mobile-2-diagram.png" });
  await page.getByTestId("submit").click();
  await page.getByTestId("confirm-submit").click();
  await expect(page).toHaveURL(/\/results$/, { timeout: 120_000 });
  await expect(page.getByTestId("score")).toBeVisible();
  await page.screenshot({ path: "screenshots/mobile-3-results.png", fullPage: true });
});
