import type { Store } from "../db/store.js";
import type { Logger, SessionService } from "../sessions/service.js";
import type { LabDriver } from "./driver.js";

/** A finished session's lab gets this long after its deadline before it is force-destroyed. */
export const DEADLINE_GRACE_MS = 5 * 60_000;
/** Labs from tests and the CLI (bfx-t-*) have no session; they are removed after this age. */
export const TEST_LAB_MAX_AGE_MS = 2 * 3_600_000;

export interface ReaperDeps {
  driver: LabDriver;
  store: Store;
  service: SessionService;
  log: Logger;
}

/**
 * Destroy labs nobody should be using: this instance's session labs whose session is over, unknown,
 * or long past its deadline, and test labs older than two hours. Labs the service is actively
 * running are left alone (their own timers end them), and so are other instances' session labs.
 */
export async function reapOnce(deps: ReaperDeps, now = Date.now()): Promise<string[]> {
  const destroyed: string[] = [];
  for (const lab of await deps.driver.list()) {
    let reason: string | undefined;
    if (lab.lab.startsWith(`bfx-s-${deps.service.instanceId}-`)) {
      if (deps.service.isActiveLab(lab.lab)) continue;
      const session = deps.store.sessionByLab(lab.lab);
      if (!session) reason = "no session";
      else if (session.state === "finished" || session.state === "failed") reason = `session ${session.state}`;
      else if (session.deadline_at !== null && now > session.deadline_at + DEADLINE_GRACE_MS) reason = "past deadline";
    } else if (lab.lab.startsWith("bfx-t-") && now - lab.created * 1000 > TEST_LAB_MAX_AGE_MS) {
      reason = "stale test lab";
    }
    if (!reason) continue;
    try {
      await deps.driver.destroy(lab.lab);
      destroyed.push(lab.lab);
      deps.log.info({ lab: lab.lab, reason }, "reaper destroyed lab");
    } catch (err) {
      deps.log.warn({ lab: lab.lab, reason, err }, "reaper could not destroy lab");
    }
  }
  return destroyed;
}

export function startReaper(deps: ReaperDeps, intervalMs = 60_000): { stop(): void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reapOnce(deps);
    } catch (err) {
      deps.log.warn({ err }, "reaper run failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return { stop: () => clearInterval(timer) };
}
