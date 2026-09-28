import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the real server and real labs. Run as a member of the `breakfix`
 * group: `sg breakfix -c 'pnpm test:e2e'`. Browsers live in ./.pw-browsers (never the shared cache).
 */
export const E2E_PORT = 8490;
export const E2E_ENV = {
  PORT: String(E2E_PORT),
  INSTANCE_ID: "e2e", // keeps the production server's reaper away from e2e labs, and vice versa
  HOST: "127.0.0.1",
  DB_PATH: ".e2e/db.sqlite",
  PUBLIC_URL: `http://127.0.0.1:${E2E_PORT}`,
  POLL_INTERVAL_MS: "2000",
  LOG_LEVEL: "warn",
};

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/e2e",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${E2E_PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec/ },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }, testMatch: /mobile\.spec/ },
  ],
  // Playwright starts the web server before any global setup, so the reset and build happen here.
  webServer: {
    command:
      "rm -rf .e2e && mkdir -p .e2e screenshots && " +
      "pnpm --silent -r --filter '@breakfix/server...' --filter @breakfix/web run build && " +
      "node apps/server/dist/main.js",
    env: E2E_ENV,
    url: `http://127.0.0.1:${E2E_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
