import { execFileSync } from "node:child_process";
import { type Page, expect } from "@playwright/test";
import { E2E_ENV } from "../playwright.config.js";

/** A fresh single-use test link path (/t/<token>) for a scenario, made with the admin CLI. */
export function newLink(scenario: string): string {
  const url = execFileSync("node", ["apps/server/dist/admin-cli.js", "link", scenario], {
    env: { ...process.env, ...E2E_ENV },
    encoding: "utf8",
  }).trim();
  return new URL(url).pathname;
}

export async function startTest(page: Page, scenario: string): Promise<void> {
  await page.goto(newLink(scenario));
  await page.getByTestId("start").click();
  await expect(page).toHaveURL(/\/session$/);
  await expect(page.locator(".workspace")).toHaveAttribute("data-state", "running", { timeout: 120_000 });
}

/** Text currently rendered in a device's terminal. */
export function terminalText(page: Page, node: string): Promise<string> {
  return page.locator(`[data-terminal="${node}"] .xterm-rows`).innerText();
}

export async function openDevice(page: Page, node: string, prompt: string): Promise<void> {
  await page.locator(`[data-node="${node}"]`).click();
  await expect.poll(() => terminalText(page, node), { timeout: 30_000 }).toContain(prompt);
  await page.locator(`[data-terminal="${node}"]`).click();
}

export async function typeLines(page: Page, lines: string[]): Promise<void> {
  for (const line of lines) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  }
}
