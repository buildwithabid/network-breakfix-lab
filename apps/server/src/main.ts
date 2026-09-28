import { loadConfig } from "./config.js";
import { Store } from "./db/store.js";
import { buildApp } from "./http/app.js";
import { createLogger } from "./http/logger.js";
import { containerlabDriver } from "./labs/driver.js";
import { startReaper } from "./labs/reaper.js";
import { loadScenarios } from "./scenarios.js";
import { refuseRoot } from "./security/root.js";
import { SessionService } from "./sessions/service.js";

try {
  refuseRoot();
} catch (err) {
  console.error(String(err));
  process.exit(1);
}

const config = loadConfig();
const logger = createLogger(config);
const scenarios = await loadScenarios(config.SCENARIOS_DIR);
const store = new Store(config.DB_PATH);
const service = new SessionService({
  store,
  driver: containerlabDriver,
  scenarios,
  maxConcurrent: config.MAX_CONCURRENT_LABS,
  pollIntervalMs: config.POLL_INTERVAL_MS,
  log: logger,
  instanceId: config.INSTANCE_ID,
});
const app = await buildApp({ config, service, store, scenarios, logger });

await service.resume();
const reaper = startReaper({ driver: containerlabDriver, store, service, log: app.log });
await app.listen({ host: config.HOST, port: config.PORT });
app.log.info({ scenarios: [...scenarios.keys()], maxConcurrentLabs: config.MAX_CONCURRENT_LABS }, "ready");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "shutting down; running labs keep running and resume on restart");
    reaper.stop();
    service.close();
    void app.close().finally(() => {
      store.close();
      process.exit(0);
    });
  });
}
