import type { Scenario } from "@breakfix/scenario-kit";
import { createTwoFilesPatch } from "diff";
import type { CommandRow, SessionRow, Store } from "../db/store.js";

export interface ResultsView {
  sessionId: string;
  scenario: { id: string; title: string; difficulty: string };
  endReason: SessionRow["end_reason"];
  startedAt: number | null;
  finishedAt: number | null;
  /** time spent working: from lab ready to submit (or to the deadline) */
  durationMs: number | null;
  timeLimitMs: number;
  passed: number;
  total: number;
  objectives: { id: string; description: string; passed: boolean; detail: string }[];
  /** node -> commands in order; hints are listed under "-" */
  commands: Record<string, { at: number; kind: CommandRow["kind"]; command: string; outcome: string | null }[]>;
  configs: { node: string; start: string | null; end: string | null; diff: string }[];
}

export function buildResults(store: Store, session: SessionRow, scenario: Scenario): ResultsView {
  const results = store.results(session.id);
  const commands: ResultsView["commands"] = {};
  for (const c of store.commands(session.id)) {
    (commands[c.node] ??= []).push({ at: c.at, kind: c.kind, command: c.command, outcome: c.outcome });
  }
  const byNode = new Map<string, { start: string | null; end: string | null }>();
  for (const snap of store.snapshots(session.id)) {
    const entry = byNode.get(snap.node) ?? { start: null, end: null };
    entry[snap.phase] = snap.config;
    byNode.set(snap.node, entry);
  }
  const configs = [...byNode].map(([node, { start, end }]) => ({
    node,
    start,
    end,
    diff: createTwoFilesPatch(`${node} (at start)`, `${node} (at submit)`, start ?? "", end ?? "", "", "", { context: 3 }),
  }));
  const end = session.end_reason === "timeout" && session.deadline_at ? session.deadline_at : session.finished_at;
  return {
    sessionId: session.id,
    scenario: { id: scenario.meta.id, title: scenario.meta.title, difficulty: scenario.meta.difficulty },
    endReason: session.end_reason,
    startedAt: session.started_at,
    finishedAt: session.finished_at,
    durationMs: session.started_at && end ? Math.max(0, end - session.started_at) : null,
    timeLimitMs: session.time_limit_s * 1000,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    objectives: results.map((r) => ({ id: r.objective_id, description: r.description, passed: r.passed === 1, detail: r.detail })),
    commands,
    configs,
  };
}

/**
 * Everything an assessor (human or, later, an AI step) needs about one attempt, in one versioned
 * JSON document: the task, the rules, what the candidate did in order, and what the network looked
 * like before and after. See docs/results.md.
 */
export function buildBundle(store: Store, session: SessionRow, scenario: Scenario) {
  const view = buildResults(store, session, scenario);
  return {
    schema: "breakfix.assessment/v1",
    generatedAt: new Date().toISOString(),
    scenario: {
      id: scenario.meta.id,
      title: scenario.meta.title,
      difficulty: scenario.meta.difficulty,
      ticket: scenario.meta.ticket,
      timeLimitMinutes: scenario.meta.timeLimitMinutes,
      objectives: scenario.meta.objectives,
      hints: scenario.meta.hints,
    },
    attempt: {
      sessionId: session.id,
      endReason: session.end_reason,
      startedAt: session.started_at && new Date(session.started_at).toISOString(),
      finishedAt: session.finished_at && new Date(session.finished_at).toISOString(),
      durationSeconds: view.durationMs === null ? null : Math.round(view.durationMs / 1000),
    },
    outcome: {
      passed: view.passed,
      total: view.total,
      objectives: store.results(session.id).map((r) => ({
        id: r.objective_id,
        passed: r.passed === 1,
        detail: r.detail,
        probe: JSON.parse(r.probe) as unknown,
      })),
    },
    timeline: store.commands(session.id).map((c) => ({
      at: new Date(c.at).toISOString(),
      offsetSeconds: session.started_at ? Math.round((c.at - session.started_at) / 1000) : null,
      node: c.node,
      kind: c.kind,
      command: c.command,
      outcome: c.outcome,
    })),
    configs: view.configs,
  };
}
