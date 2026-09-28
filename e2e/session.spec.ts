import { expect, test } from "@playwright/test";
import { newLink, openDevice, startTest, terminalText, typeLines } from "./helpers.js";

test("an invalid link explains itself", async ({ page }) => {
  await page.goto(`/t/${"x".repeat(43)}`);
  await expect(page.getByRole("alert")).toHaveText("This test link is not valid.");
  await expect(page).toHaveURL(/\/start$/); // the token leaves the address bar
});

test("a candidate fixes scenario 01 in the browser and sees the results", async ({ page }) => {
  await page.goto(newLink("01-wrong-ip-mask"));
  await expect(page.getByTestId("test-title")).toHaveText("Branch cannot reach the file server");
  await page.screenshot({ path: "screenshots/desktop-1-landing.png" });

  await page.getByTestId("start").click();
  await expect(page.locator(".workspace")).toHaveAttribute("data-state", "running", { timeout: 120_000 });
  await expect(page.locator('[data-link="l1"]')).toHaveAttribute("data-state", "up");

  // the fault: pings from the branch fail, and the diagram shows where the reply dies
  await openDevice(page, "h1", "h1$");
  await typeLines(page, ["ping -c 2 10.0.3.10"]);
  await expect.poll(() => terminalText(page, "h1")).toContain("2 packets transmitted, 0 received");
  await expect(page.getByTestId("path-status")).toContainText("reply is dropped");
  await page.screenshot({ path: "screenshots/desktop-2-fault.png" });

  await openDevice(page, "r2", "r2#");
  await typeLines(page, ["show interface brief"]);
  await typeLines(page, ["configure terminal", "interface eth1", "no ip address 10.0.12.2/31", "ip address 10.0.12.2/30", "end", "write memory"]);
  await expect.poll(() => terminalText(page, "r2")).toContain("[OK]");
  await page.waitForTimeout(4500); // one poll cycle, so the diagram and path model see the fix

  await page.getByRole("tab", { name: /h1/ }).click();
  await page.locator('[data-terminal="h1"]').click();
  await typeLines(page, ["ping -c 2 10.0.3.10"]);
  await expect.poll(() => terminalText(page, "h1")).toContain("2 packets transmitted, 2 received");
  await expect(page.getByTestId("path-status")).toContainText("h1 → r1 → r2 → srv, reply returns");
  await page.screenshot({ path: "screenshots/desktop-3-fixed.png" });

  await page.getByTestId("submit").click();
  await page.getByTestId("confirm-submit").click();
  await expect(page).toHaveURL(/\/results$/, { timeout: 120_000 });
  await expect(page.getByTestId("score")).toContainText("4/4");
  await page.getByRole("tab", { name: /r2/ }).click();
  await expect(page.getByTestId("commands")).toContainText("ip address 10.0.12.2/30");
  await expect(page.locator('[data-diff="r2"]')).toContainText("+ ip address 10.0.12.2/30");
  await page.screenshot({ path: "screenshots/desktop-4-results.png", fullPage: true });
});

test("a link that goes down turns red on the diagram", async ({ page }) => {
  await startTest(page, "02-missing-default-route");
  await expect(page.locator('[data-link="l1"]')).toHaveAttribute("data-state", "up");
  await openDevice(page, "r1", "r1#");
  await typeLines(page, ["configure terminal", "interface eth2", "shutdown", "end"]);
  await expect(page.locator('[data-link="l1"]')).toHaveAttribute("data-state", "down", { timeout: 20_000 });
  await expect(page.locator('[data-link="l1"] line')).toHaveCSS("stroke", "rgb(220, 38, 38)");
  await page.screenshot({ path: "screenshots/desktop-5-link-down.png" });
  await page.getByTestId("submit").click();
  await page.getByTestId("confirm-submit").click();
  await expect(page).toHaveURL(/\/results$/, { timeout: 120_000 });
});
