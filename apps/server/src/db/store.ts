import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

export type SessionState = "queued" | "starting" | "running" | "checking" | "finished" | "failed";
export type EndReason = "submitted" | "timeout" | "error" | "server-restart";
export type CommandKind = "vtysh" | "host" | "hint";

export interface TestRow {
  id: string;
  scenario_id: string;
  token_hash: string;
  label: string | null;
  created_at: number;
  expires_at: number | null;
  used_at: number | null;
}

export interface SessionRow {
  id: string;
  test_id: string;
  scenario_id: string;
  secret_hash: string;
  state: SessionState;
  lab_name: string | null;
  time_limit_s: number;
  created_at: number;
  started_at: number | null;
  deadline_at: number | null;
  finished_at: number | null;
  end_reason: EndReason | null;
  error: string | null;
}

export interface CommandRow {
  id: number;
  session_id: string;
  node: string;
  at: number;
  kind: CommandKind;
  command: string;
  outcome: string | null;
}

export interface SnapshotRow {
  node: string;
  phase: "start" | "end";
  config: string;
  captured_at: number;
}

export interface ResultRow {
  position: number;
  objective_id: string;
  description: string;
  passed: 0 | 1;
  detail: string;
  probe: string;
}

/** Thin typed layer over SQLite. All writes are single statements or explicit transactions. */
export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v] ?? "");
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // -- tests (links) --------------------------------------------------------------------

  insertTest(row: TestRow): void {
    this.db
      .prepare(
        `INSERT INTO tests (id, scenario_id, token_hash, label, created_at, expires_at, used_at)
         VALUES (@id, @scenario_id, @token_hash, @label, @created_at, @expires_at, @used_at)`,
      )
      .run(row);
  }

  testByTokenHash(hash: string): TestRow | undefined {
    return this.db.prepare(`SELECT * FROM tests WHERE token_hash = ?`).get(hash) as TestRow | undefined;
  }

  // -- sessions -------------------------------------------------------------------------

  /** Mark the link used and create its session atomically: a link can start one session only. */
  startSession(testId: string, session: SessionRow): boolean {
    return this.db.transaction(() => {
      const claimed = this.db
        .prepare(`UPDATE tests SET used_at = ? WHERE id = ? AND used_at IS NULL`)
        .run(session.created_at, testId);
      if (claimed.changes !== 1) return false;
      this.db
        .prepare(
          `INSERT INTO sessions (id, test_id, scenario_id, secret_hash, state, lab_name, time_limit_s,
             created_at, started_at, deadline_at, finished_at, end_reason, error)
           VALUES (@id, @test_id, @scenario_id, @secret_hash, @state, @lab_name, @time_limit_s,
             @created_at, @started_at, @deadline_at, @finished_at, @end_reason, @error)`,
        )
        .run(session);
      return true;
    })();
  }

  session(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  }

  sessionByLab(labName: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE lab_name = ?`).get(labName) as SessionRow | undefined;
  }

  sessionsInStates(states: SessionState[]): SessionRow[] {
    const marks = states.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM sessions WHERE state IN (${marks}) ORDER BY created_at`)
      .all(...states) as SessionRow[];
  }

  updateSession(id: string, fields: Partial<Omit<SessionRow, "id">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE sessions SET ${set} WHERE id = @id`).run({ ...fields, id });
  }

  // -- commands, snapshots, results -----------------------------------------------------

  addCommand(sessionId: string, node: string, kind: CommandKind, command: string, outcome: string | null, at = Date.now()): void {
    this.db
      .prepare(`INSERT INTO commands (session_id, node, at, kind, command, outcome) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, node, at, kind, command, outcome);
  }

  commands(sessionId: string): CommandRow[] {
    return this.db.prepare(`SELECT * FROM commands WHERE session_id = ? ORDER BY id`).all(sessionId) as CommandRow[];
  }

  saveSnapshot(sessionId: string, node: string, phase: "start" | "end", config: string, at = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO config_snapshots (session_id, node, phase, config, captured_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, node, phase) DO UPDATE SET config = excluded.config, captured_at = excluded.captured_at`,
      )
      .run(sessionId, node, phase, config, at);
  }

  snapshots(sessionId: string): SnapshotRow[] {
    return this.db
      .prepare(`SELECT node, phase, config, captured_at FROM config_snapshots WHERE session_id = ? ORDER BY node, phase`)
      .all(sessionId) as SnapshotRow[];
  }

  saveResults(sessionId: string, rows: Omit<ResultRow, "position">[]): void {
    const insert = this.db.prepare(
      `INSERT INTO objective_results (session_id, position, objective_id, description, passed, detail, probe)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM objective_results WHERE session_id = ?`).run(sessionId);
      rows.forEach((r, i) => insert.run(sessionId, i, r.objective_id, r.description, r.passed, r.detail, r.probe));
    })();
  }

  results(sessionId: string): ResultRow[] {
    return this.db
      .prepare(
        `SELECT position, objective_id, description, passed, detail, probe FROM objective_results
         WHERE session_id = ? ORDER BY position`,
      )
      .all(sessionId) as ResultRow[];
  }
}
