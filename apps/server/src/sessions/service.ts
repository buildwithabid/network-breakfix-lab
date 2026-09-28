import { EventEmitter } from "node:events";
import { type Scenario, checkObjectives, newLabName } from "@breakfix/scenario-kit";
import type { SessionRow, Store } from "../db/store.js";
import type { LabDriver, LabHandle } from "../labs/driver.js";
import { type NetModel, POLL_COMMANDS, type RouterPoll, type TopoState, buildModel, deriveTopoState, linksOf, pollFromDocs } from "../labs/network.js";
import { hashToken, isToken, matchesHash, newId, newToken } from "../security/tokens.js";

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export class TestLinkError extends Error {
  constructor(
    readonly code: "invalid" | "used" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "TestLinkError";
  }
}

export interface SessionView {
  id: string;
  state: SessionRow["state"];
  queuePosition: number | null;
  serverNow: number;
  startedAt: number | null;
  deadlineAt: number | null;
  finishedAt: number | null;
  endReason: SessionRow["end_reason"];
  error: string | null;
  scenario: {
    id: string;
    title: string;
    difficulty: string;
    timeLimitMinutes: number;
    ticket: string;
    hintCount: number;
    nodes: { name: string; role: string }[];
    links: ReturnType<typeof linksOf>;
  };
}

interface RunningLab {
  lab: LabHandle;
  timer: NodeJS.Timeout;
  poller: NodeJS.Timeout;
  polling: boolean;
  polls: Record<string, RouterPoll | undefined>;
  model?: NetModel;
  topo?: TopoState;
}

export interface SessionServiceOptions {
  store: Store;
  driver: LabDriver;
  scenarios: ReadonlyMap<string, Scenario>;
  maxConcurrent: number;
  pollIntervalMs: number;
  log: Logger;
  startTimeoutMs?: number;
}

const START_FAILED = "The lab could not be started. Please contact the test organiser.";

/**
 * Owns every session's lifecycle: queue -> starting -> running -> checking -> finished | failed.
 * At most `maxConcurrent` labs exist at once; the rest wait in a FIFO queue.
 *
 * Events: "session" (sessionId) when a session's view changes, "topo" (sessionId, TopoState)
 * when the live diagram state of a running lab changes.
 */
export class SessionService extends EventEmitter {
  private readonly queue: string[] = [];
  private readonly starting = new Set<string>();
  private readonly running = new Map<string, RunningLab>();
  private closed = false;

  constructor(private readonly opts: SessionServiceOptions) {
    super();
  }

  private scenarioOf(session: SessionRow): Scenario {
    const scenario = this.opts.scenarios.get(session.scenario_id);
    if (!scenario) throw new Error(`scenario ${session.scenario_id} is not loaded`);
    return scenario;
  }

  // -- links and sessions -----------------------------------------------------------------

  createTestLink(scenarioId: string, opts: { label?: string; ttlHours?: number } = {}): { testId: string; token: string } {
    if (!this.opts.scenarios.has(scenarioId)) throw new Error(`unknown scenario ${scenarioId}`);
    const token = newToken();
    const now = Date.now();
    const testId = newId();
    this.opts.store.insertTest({
      id: testId,
      scenario_id: scenarioId,
      token_hash: hashToken(token),
      label: opts.label ?? null,
      created_at: now,
      expires_at: opts.ttlHours ? now + opts.ttlHours * 3_600_000 : null,
      used_at: null,
    });
    return { testId, token };
  }

  /** Redeem a test link. Each link starts exactly one session. */
  start(token: unknown): { sessionId: string; secret: string } {
    if (!isToken(token)) throw new TestLinkError("invalid", "This test link is not valid.");
    const test = this.opts.store.testByTokenHash(hashToken(token));
    if (!test) throw new TestLinkError("invalid", "This test link is not valid.");
    if (test.expires_at !== null && test.expires_at < Date.now()) throw new TestLinkError("expired", "This test link has expired.");
    if (test.used_at !== null) throw new TestLinkError("used", "This test link has already been used.");
    const scenario = this.opts.scenarios.get(test.scenario_id);
    if (!scenario) throw new TestLinkError("invalid", "This test link is not valid.");

    const secret = newToken();
    const session: SessionRow = {
      id: newId(),
      test_id: test.id,
      scenario_id: test.scenario_id,
      secret_hash: hashToken(secret),
      state: "queued",
      lab_name: null,
      time_limit_s: scenario.meta.timeLimitMinutes * 60,
      created_at: Date.now(),
      started_at: null,
      deadline_at: null,
      finished_at: null,
      end_reason: null,
      error: null,
    };
    if (!this.opts.store.startSession(test.id, session)) throw new TestLinkError("used", "This test link has already been used.");
    this.opts.log.info({ sessionId: session.id, scenario: session.scenario_id }, "session created");
    this.queue.push(session.id);
    this.pump();
    return { sessionId: session.id, secret };
  }

  authenticate(sessionId: string, secret: string): SessionRow | undefined {
    const session = this.opts.store.session(sessionId);
    return session && matchesHash(secret, session.secret_hash) ? session : undefined;
  }

  view(sessionId: string): SessionView | undefined {
    const s = this.opts.store.session(sessionId);
    if (!s) return undefined;
    const scenario = this.scenarioOf(s);
    const position = this.queue.indexOf(s.id);
    return {
      id: s.id,
      state: s.state,
      queuePosition: position >= 0 ? position + 1 : null,
      serverNow: Date.now(),
      startedAt: s.started_at,
      deadlineAt: s.deadline_at,
      finishedAt: s.finished_at,
      endReason: s.end_reason,
      error: s.error,
      scenario: {
        id: scenario.meta.id,
        title: scenario.meta.title,
        difficulty: scenario.meta.difficulty,
        timeLimitMinutes: scenario.meta.timeLimitMinutes,
        ticket: scenario.meta.ticket,
        hintCount: scenario.meta.hints.length,
        nodes: Object.entries(scenario.roles).map(([name, role]) => ({ name, role })),
        links: linksOf(scenario.topology),
      },
    };
  }

  /** The running lab of a session, for terminals and the host console. */
  runningLab(sessionId: string): { lab: LabHandle; scenario: Scenario; model: NetModel | undefined } | undefined {
    const r = this.running.get(sessionId);
    const s = this.opts.store.session(sessionId);
    if (!r || !s || s.state !== "running") return undefined;
    return { lab: r.lab, scenario: this.scenarioOf(s), model: r.model };
  }

  topo(sessionId: string): TopoState | undefined {
    return this.running.get(sessionId)?.topo;
  }

  hint(sessionId: string, index: number): string | undefined {
    const s = this.opts.store.session(sessionId);
    if (!s || s.state !== "running") return undefined;
    const text = this.scenarioOf(s).meta.hints[index];
    if (text !== undefined) this.opts.store.addCommand(sessionId, "-", "hint", `hint ${index + 1}`, null);
    return text;
  }

  isActiveLab(labName: string): boolean {
    for (const id of [...this.starting, ...this.running.keys()]) {
      if (this.opts.store.session(id)?.lab_name === labName) return true;
    }
    return false;
  }

  // -- lifecycle --------------------------------------------------------------------------

  private emitView(sessionId: string): void {
    this.emit("session", sessionId);
  }

  private pump(): void {
    while (!this.closed && this.queue.length && this.starting.size + this.running.size < this.opts.maxConcurrent) {
      const id = this.queue.shift();
      if (id) void this.launch(id);
    }
    for (const id of this.queue) this.emitView(id); // queue positions moved
  }

  private async launch(sessionId: string): Promise<void> {
    const session = this.opts.store.session(sessionId);
    if (!session) return;
    const scenario = this.scenarioOf(session);
    const labName = newLabName("s");
    this.starting.add(sessionId);
    this.opts.store.updateSession(sessionId, { state: "starting", lab_name: labName });
    this.emitView(sessionId);
    let lab: LabHandle | undefined;
    try {
      lab = await this.opts.driver.deploy(scenario, "fault", labName);
      await lab.waitForRouters(this.opts.startTimeoutMs ?? 90_000);
      await this.snapshot(sessionId, lab, scenario, "start");
      const now = Date.now();
      const deadline = now + session.time_limit_s * 1000;
      this.opts.store.updateSession(sessionId, { state: "running", started_at: now, deadline_at: deadline });
      this.track(sessionId, lab, deadline);
      this.opts.log.info({ sessionId, lab: labName }, "lab running");
    } catch (err) {
      this.opts.log.error({ sessionId, lab: labName, err }, "lab start failed");
      this.opts.store.updateSession(sessionId, { state: "failed", end_reason: "error", error: START_FAILED, finished_at: Date.now() });
      await (lab ? lab.destroy() : this.opts.driver.destroy(labName)).catch(() => undefined);
    } finally {
      this.starting.delete(sessionId);
      this.emitView(sessionId);
      this.pump();
    }
  }

  private track(sessionId: string, lab: LabHandle, deadline: number): void {
    const entry: RunningLab = {
      lab,
      polls: {},
      polling: false,
      timer: setTimeout(() => void this.submit(sessionId, "timeout"), Math.max(0, deadline - Date.now())),
      poller: setInterval(() => void this.poll(sessionId), this.opts.pollIntervalMs),
    };
    this.running.set(sessionId, entry);
    void this.poll(sessionId);
  }

  /** Read every router's state for the live diagram. These commands never reach the command log. */
  private async poll(sessionId: string): Promise<void> {
    const r = this.running.get(sessionId);
    const s = this.opts.store.session(sessionId);
    if (!r || !s || r.polling) return;
    r.polling = true;
    try {
      const scenario = this.scenarioOf(s);
      const routers = Object.keys(scenario.roles).filter((n) => scenario.roles[n] === "router");
      await Promise.all(
        routers.map(async (router) => {
          try {
            r.polls[router] = pollFromDocs(await r.lab.vtyshJson(router, [...POLL_COMMANDS]));
          } catch {
            r.polls[router] = pollFromDocs([null, null, null, null, null]);
          }
        }),
      );
      r.model = buildModel(scenario.topology, scenario.roles, r.polls);
      const topo = deriveTopoState(r.model);
      const changed = JSON.stringify({ ...topo, at: 0 }) !== JSON.stringify({ ...r.topo, at: 0 });
      r.topo = topo;
      if (changed && this.running.has(sessionId)) this.emit("topo", sessionId, topo);
    } finally {
      r.polling = false;
    }
  }

  private async snapshot(sessionId: string, lab: LabHandle, scenario: Scenario, phase: "start" | "end"): Promise<void> {
    const routers = Object.keys(scenario.roles).filter((n) => scenario.roles[n] === "router");
    await Promise.all(
      routers.map(async (router) => {
        const out = await lab.vtysh(router, "show running-config").catch(() => undefined);
        if (out?.exitCode === 0) this.opts.store.saveSnapshot(sessionId, router, phase, normaliseConfig(out.stdout));
      }),
    );
  }

  /** Candidate submits, or the time runs out: capture configs, run the checks, destroy the lab. */
  async submit(sessionId: string, reason: "submitted" | "timeout"): Promise<void> {
    const session = this.opts.store.session(sessionId);
    if (!session) return;
    if (session.state === "queued") {
      this.queue.splice(this.queue.indexOf(sessionId), 1);
      this.opts.store.updateSession(sessionId, { state: "finished", end_reason: reason, finished_at: Date.now() });
      this.emitView(sessionId);
      this.pump();
      return;
    }
    const r = this.running.get(sessionId);
    if (session.state !== "running" || !r) return;
    clearTimeout(r.timer);
    clearInterval(r.poller);
    this.opts.store.updateSession(sessionId, { state: "checking" });
    this.emitView(sessionId);
    const scenario = this.scenarioOf(session);
    try {
      await this.snapshot(sessionId, r.lab, scenario, "end");
      const results = await checkObjectives(scenario.meta.objectives, r.lab);
      this.opts.store.saveResults(
        sessionId,
        results.map((x) => ({
          objective_id: x.id,
          description: x.description,
          passed: x.passed ? 1 : 0,
          detail: x.detail,
          probe: JSON.stringify(x.probe),
        })),
      );
      this.opts.log.info({ sessionId, reason, passed: results.filter((x) => x.passed).length, total: results.length }, "session checked");
    } catch (err) {
      this.opts.log.error({ sessionId, err }, "check failed");
    } finally {
      await r.lab.destroy().catch((err: unknown) => this.opts.log.warn({ sessionId, err }, "lab destroy failed; the reaper will retry"));
      this.running.delete(sessionId);
      this.opts.store.updateSession(sessionId, { state: "finished", end_reason: reason, finished_at: Date.now() });
      this.emitView(sessionId);
      this.pump();
    }
  }

  /** After a restart: re-queue waiting sessions, re-attach running labs, close what can't resume. */
  async resume(): Promise<void> {
    for (const s of this.opts.store.sessionsInStates(["queued"])) this.queue.push(s.id);
    for (const s of this.opts.store.sessionsInStates(["starting", "running", "checking"])) {
      const scenario = this.opts.scenarios.get(s.scenario_id);
      const lab = scenario && s.lab_name && s.state !== "starting" ? await this.opts.driver.attach(s.lab_name, scenario.roles) : undefined;
      if (!lab || !s.deadline_at) {
        this.opts.store.updateSession(s.id, { state: "failed", end_reason: "server-restart", error: START_FAILED, finished_at: Date.now() });
        if (s.lab_name) await this.opts.driver.destroy(s.lab_name).catch(() => undefined);
        continue;
      }
      this.opts.store.updateSession(s.id, { state: "running" });
      this.track(s.id, lab, s.deadline_at);
      if (s.state === "checking" || s.deadline_at <= Date.now()) void this.submit(s.id, "timeout");
      this.opts.log.info({ sessionId: s.id, lab: s.lab_name }, "session resumed");
    }
    this.pump();
  }

  /** Stop timers and pollers. Labs keep running; resume() picks them up again. */
  close(): void {
    this.closed = true;
    for (const r of this.running.values()) {
      clearTimeout(r.timer);
      clearInterval(r.poller);
    }
    this.running.clear();
  }
}

/** Drop the banner lines vtysh prints before a running config. */
export function normaliseConfig(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^(Building configuration\.\.\.|Current configuration:)\s*$/.test(line))
    .join("\n")
    .replace(/^\n+/, "");
}
