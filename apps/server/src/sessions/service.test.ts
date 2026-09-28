import { type Scenario, loadScenario } from "@breakfix/scenario-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../db/store.js";
import { reapOnce } from "../labs/reaper.js";
import { FakeDriver, quietLog } from "../test-support/fake-lab.js";
import { buildResults } from "./results.js";
import { SessionService, TestLinkError, normaliseConfig } from "./service.js";

const s01 = await loadScenario(new URL("../../../../scenarios/01-wrong-ip-mask", import.meta.url).pathname);
const services: SessionService[] = [];

function setup(opts: { maxConcurrent?: number; timeLimitMinutes?: number } = {}) {
  const scenario: Scenario = structuredClone(s01);
  if (opts.timeLimitMinutes !== undefined) scenario.meta.timeLimitMinutes = opts.timeLimitMinutes;
  const store = new Store(":memory:");
  const driver = new FakeDriver();
  const service = new SessionService({
    store,
    driver,
    scenarios: new Map([[scenario.meta.id, scenario]]),
    maxConcurrent: opts.maxConcurrent ?? 5,
    pollIntervalMs: 60_000,
    log: quietLog,
  });
  services.push(service);
  return { store, driver, service, scenario };
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

afterEach(() => {
  for (const s of services.splice(0)) s.close();
  vi.useRealTimers();
});

describe("test links", () => {
  it("start one session each and are single-use", () => {
    const { service } = setup();
    const { token } = service.createTestLink("01-wrong-ip-mask");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { sessionId, secret } = service.start(token);
    expect(service.authenticate(sessionId, secret)?.id).toBe(sessionId);
    expect(service.authenticate(sessionId, `${secret.slice(0, -1)}A`)).toBeUndefined();
    expect(() => service.start(token)).toThrow(expect.objectContaining({ code: "used" }));
  });

  it("reject malformed, unknown and expired tokens", () => {
    const { service, store } = setup();
    for (const bad of [undefined, "", "x", "a".repeat(43), "../../etc/passwd", 7]) {
      expect(() => service.start(bad)).toThrow(TestLinkError);
    }
    const { token, testId } = service.createTestLink("01-wrong-ip-mask", { ttlHours: 1 });
    store.db.prepare("UPDATE tests SET expires_at = ? WHERE id = ?").run(Date.now() - 1, testId);
    expect(() => service.start(token)).toThrow(expect.objectContaining({ code: "expired" }));
  });

  it("store only hashes of tokens and secrets", () => {
    const { service, store } = setup();
    const { token } = service.createTestLink("01-wrong-ip-mask");
    const { secret } = service.start(token);
    const dump = JSON.stringify([store.db.prepare("SELECT * FROM tests").all(), store.db.prepare("SELECT * FROM sessions").all()]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(secret);
  });
});

describe("lab lifecycle", () => {
  it("queues beyond the concurrency cap and starts the next one when a lab frees up", async () => {
    const { service } = setup({ maxConcurrent: 1 });
    const a = service.start(service.createTestLink("01-wrong-ip-mask").token).sessionId;
    const b = service.start(service.createTestLink("01-wrong-ip-mask").token).sessionId;
    await until(() => service.view(a)?.state === "running");
    expect(service.view(b)).toMatchObject({ state: "queued", queuePosition: 1 });
    await service.submit(a, "submitted");
    await until(() => service.view(b)?.state === "running");
    expect(service.view(a)?.state).toBe("finished");
  });

  it("checks, snapshots and destroys the lab on submit", async () => {
    const { service, driver, store, scenario } = setup();
    const id = service.start(service.createTestLink("01-wrong-ip-mask").token).sessionId;
    await until(() => service.view(id)?.state === "running");
    const lab = [...driver.labs.values()][0];
    if (!lab) throw new Error("no lab");
    expect(lab.name).toMatch(/^bfx-s-/);
    lab.healthy = true;
    lab.config = lab.config.replace("/31", "/30");
    await service.submit(id, "submitted");
    expect(lab.destroyed).toBe(true);
    const session = store.session(id);
    if (!session) throw new Error("no session");
    const results = buildResults(store, session, scenario);
    expect(results.endReason).toBe("submitted");
    expect(results.passed).toBe(results.total);
    expect(results.configs.find((c) => c.node === "r2")?.diff).toMatch(/-.*10\.0\.12\.2\/31\n\+.*10\.0\.12\.2\/30/);
  });

  it("submits automatically when the time is up", async () => {
    const { service, driver } = setup({ timeLimitMinutes: 0.001 }); // 60 ms
    const id = service.start(service.createTestLink("01-wrong-ip-mask").token).sessionId;
    await until(() => service.view(id)?.state === "finished", 3000);
    expect(service.view(id)?.endReason).toBe("timeout");
    expect([...driver.labs.values()].every((l) => l.destroyed)).toBe(true);
  });

  it("marks a session failed when its lab cannot start, and moves the queue on", async () => {
    const { service, driver } = setup({ maxConcurrent: 1 });
    driver.failDeploy = true;
    const a = service.start(service.createTestLink("01-wrong-ip-mask").token).sessionId;
    await until(() => service.view(a)?.state === "failed");
    expect(service.view(a)?.error).toMatch(/could not be started/);
    driver.failDeploy = false;
    const b = service.start(service.createTestLink("01-wrong-ip-mask").token).sessionId;
    await until(() => service.view(b)?.state === "running");
  });

  it("never records the live-state polling as candidate commands", async () => {
    const { service, driver, store } = setup();
    const id = service.start(service.createTestLink("01-wrong-ip-mask").token).sessionId;
    await until(() => service.view(id)?.state === "running");
    await until(() => [...driver.labs.values()][0]?.vtyshCalls.some((c) => c.includes("show interface json")) ?? false);
    expect(store.commands(id)).toEqual([]);
  });
});

describe("restart and reaper", () => {
  it("resumes running labs and fails the ones that are gone", async () => {
    const first = setup();
    const a = first.service.start(first.service.createTestLink("01-wrong-ip-mask").token).sessionId;
    const b = first.service.start(first.service.createTestLink("01-wrong-ip-mask").token).sessionId;
    await until(() => first.service.view(a)?.state === "running" && first.service.view(b)?.state === "running");
    first.service.close();
    const labB = first.store.session(b)?.lab_name ?? "";
    await first.driver.destroy(labB);

    const second = new SessionService({ store: first.store, driver: first.driver, scenarios: new Map([[s01.meta.id, s01]]), maxConcurrent: 5, pollIntervalMs: 60_000, log: quietLog });
    services.push(second);
    await second.resume();
    expect(second.view(a)?.state).toBe("running");
    expect(second.view(b)).toMatchObject({ state: "failed", endReason: "server-restart" });
  });

  it("destroys orphaned and finished session labs, leaves active ones", async () => {
    const { service, driver, store } = setup();
    const id = service.start(service.createTestLink("01-wrong-ip-mask").token).sessionId;
    await until(() => service.view(id)?.state === "running");
    await driver.deploy(s01, "fault", "bfx-s-orphan");
    const destroyed = await reapOnce({ driver, store, service, log: quietLog });
    expect(destroyed).toEqual(["bfx-s-orphan"]);
    expect(await driver.list()).toHaveLength(1);
  });
});

describe("normaliseConfig", () => {
  it("drops the vtysh banner", () => {
    expect(normaliseConfig("Building configuration...\n\nCurrent configuration:\n!\nhostname r1\n")).toBe("!\nhostname r1\n");
  });
});
