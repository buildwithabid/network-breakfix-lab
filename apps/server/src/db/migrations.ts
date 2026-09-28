/**
 * Schema migrations, applied in order; PRAGMA user_version records the last one applied.
 * Never edit a released migration: add a new one.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE tests (
    id           TEXT PRIMARY KEY,
    scenario_id  TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    label        TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER,
    used_at      INTEGER
  );

  CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,
    test_id       TEXT NOT NULL UNIQUE REFERENCES tests(id),
    scenario_id   TEXT NOT NULL,
    secret_hash   TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('queued','starting','running','checking','finished','failed')),
    lab_name      TEXT UNIQUE,
    time_limit_s  INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    deadline_at   INTEGER,
    finished_at   INTEGER,
    end_reason    TEXT CHECK (end_reason IN ('submitted','timeout','error','server-restart')),
    error         TEXT
  );
  CREATE INDEX sessions_state ON sessions(state);

  -- Every command a candidate ran, per device, in order. kind: vtysh | host | hint
  CREATE TABLE commands (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    node        TEXT NOT NULL,
    at          INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('vtysh','host','hint')),
    command     TEXT NOT NULL,
    outcome     TEXT
  );
  CREATE INDEX commands_session ON commands(session_id, id);

  CREATE TABLE config_snapshots (
    session_id   TEXT NOT NULL REFERENCES sessions(id),
    node         TEXT NOT NULL,
    phase        TEXT NOT NULL CHECK (phase IN ('start','end')),
    config       TEXT NOT NULL,
    captured_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, node, phase)
  );

  CREATE TABLE objective_results (
    session_id    TEXT NOT NULL REFERENCES sessions(id),
    position      INTEGER NOT NULL,
    objective_id  TEXT NOT NULL,
    description   TEXT NOT NULL,
    passed        INTEGER NOT NULL CHECK (passed IN (0,1)),
    detail        TEXT NOT NULL,
    probe         TEXT NOT NULL,
    PRIMARY KEY (session_id, objective_id)
  );
  `,
];
