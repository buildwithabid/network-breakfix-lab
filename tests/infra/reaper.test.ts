import { Lab, loadScenario, newLabName, renderLab } from "@breakfix/scenario-kit";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Store } from "../../apps/server/src/db/store.js";
import { containerlabDriver } from "../../apps/server/src/labs/driver.js";
import { reapOnce } from "../../apps/server/src/labs/reaper.js";
import { SessionService } from "../../apps/server/src/sessions/service.js";

const quiet = { info() {}, warn() {}, error() {} };

describe("reaper (real labs)", () => {
  it("destroys a session lab that has no session record", async () => {
    const s01 = await loadScenario(new URL("../../scenarios/01-wrong-ip-mask", import.meta.url).pathname);
    const name = newLabName("s", "it");
    const dir = await renderLab(s01, "fault", name);
    await Lab.deploy(dir);
    await rm(dir, { recursive: true, force: true });
    const store = new Store(":memory:");
    const service = new SessionService({ store, driver: containerlabDriver, scenarios: new Map(), maxConcurrent: 1, pollIntervalMs: 60_000, log: quiet, instanceId: "it" });
    try {
      const destroyed = await reapOnce({ driver: containerlabDriver, store, service, log: quiet });
      expect(destroyed).toContain(name);
      expect((await Lab.list()).some((l) => l.lab === name)).toBe(false);
    } finally {
      service.close();
      store.close();
      if ((await Lab.list()).some((l) => l.lab === name)) await Lab.destroyByName(name);
    }
  }, 120_000);
});
