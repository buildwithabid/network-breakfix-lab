#!/usr/bin/env node
/**
 * Create test links from the command line (the admin UI arrives in M5).
 *   node apps/server/dist/admin-cli.js link <scenario-id> [--label "Jane D."] [--ttl-hours 72]
 *   node apps/server/dist/admin-cli.js scenarios
 * Reads the same environment as the server (DB_PATH, SCENARIOS_DIR, PUBLIC_URL).
 */
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { Store } from "./db/store.js";
import { containerlabDriver } from "./labs/driver.js";
import { loadScenarios } from "./scenarios.js";
import { SessionService } from "./sessions/service.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { label: { type: "string" }, "ttl-hours": { type: "string" } },
});
const config = loadConfig();
const scenarios = await loadScenarios(config.SCENARIOS_DIR);
const [command, scenarioId] = positionals;

if (command === "scenarios") {
  for (const s of scenarios.values()) console.log(`${s.meta.id.padEnd(28)} ${s.meta.difficulty.padEnd(7)} ${s.meta.title}`);
} else if (command === "link" && scenarioId) {
  const store = new Store(config.DB_PATH);
  const quiet = { info() {}, warn() {}, error() {} };
  const service = new SessionService({ store, driver: containerlabDriver, scenarios, maxConcurrent: 1, pollIntervalMs: 60_000, log: quiet });
  const ttl = values["ttl-hours"] ? Number(values["ttl-hours"]) : undefined;
  const { token } = service.createTestLink(scenarioId, {
    ...(values.label ? { label: values.label } : {}),
    ...(ttl ? { ttlHours: ttl } : {}),
  });
  store.close();
  console.log(`${config.PUBLIC_URL.replace(/\/$/, "")}/t/${token}`);
} else {
  console.error("usage: admin-cli link <scenario-id> [--label TEXT] [--ttl-hours N] | admin-cli scenarios");
  process.exit(64);
}
