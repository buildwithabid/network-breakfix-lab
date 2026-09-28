import { useEffect, useState } from "react";
import { Diff } from "../components/Diff.js";
import { ApiError, api } from "../lib/api.js";
import { mmss } from "../lib/format.js";
import type { ResultsView } from "../lib/types.js";

/** /results: objectives, time, every command per device, and the config diff. */
export function Results() {
  const [results, setResults] = useState<ResultsView>();
  const [error, setError] = useState<string>();
  const [device, setDevice] = useState<string>();

  useEffect(() => {
    api
      .results()
      .then((r) => {
        setResults(r);
        setDevice(Object.keys(r.commands).find((n) => n !== "-"));
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not load your results."));
  }, []);

  if (error) {
    return (
      <main className="center-page">
        <div className="card">
          <h1>No results</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  }
  if (!results) return <main className="center-page muted">Loading…</main>;

  const all = results.passed === results.total;
  const devices = Object.keys(results.commands).filter((n) => n !== "-").sort();
  const hints = results.commands["-"]?.length ?? 0;
  const offset = (at: number) => (results.startedAt ? `+${mmss(at - results.startedAt)}` : "");

  return (
    <main className="results">
      <header className="results-head">
        <p className="eyebrow">Results</p>
        <h1>{results.scenario.title}</h1>
        <div className="score-row">
          <div className={`score ${all ? "score-pass" : "score-fail"}`} data-testid="score">
            {results.passed}/{results.total}
            <span>objectives met</span>
          </div>
          <dl className="facts">
            <div>
              <dt>Time taken</dt>
              <dd>
                {results.durationMs === null ? "—" : mmss(results.durationMs)} of {mmss(results.timeLimitMs)}
              </dd>
            </div>
            <div>
              <dt>Ended</dt>
              <dd>{results.endReason === "timeout" ? "time ran out" : "submitted"}</dd>
            </div>
            <div>
              <dt>Hints used</dt>
              <dd>{hints}</dd>
            </div>
          </dl>
        </div>
      </header>

      <section className="panel">
        <h2>Objectives</h2>
        <ul className="objectives">
          {results.objectives.map((o) => (
            <li key={o.id} className={o.passed ? "pass" : "fail"} data-objective={o.id} data-passed={o.passed}>
              <span className="mark" aria-label={o.passed ? "passed" : "failed"}>
                {o.passed ? "✓" : "✗"}
              </span>
              <div>
                <p>{o.description}</p>
                <p className="muted small">{o.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Commands</h2>
        {devices.length === 0 ? (
          <p className="muted">No commands were run.</p>
        ) : (
          <>
            <div className="tabs" role="tablist">
              {devices.map((d) => (
                <div key={d} className={`tab${d === device ? " tab-active" : ""}`}>
                  <button role="tab" aria-selected={d === device} onClick={() => setDevice(d)}>
                    {d} <span className="muted">({results.commands[d]?.length})</span>
                  </button>
                </div>
              ))}
            </div>
            <table className="commands" data-testid="commands">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Command</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {(device ? results.commands[device] ?? [] : []).map((c, i) => (
                  <tr key={i} className={c.outcome?.startsWith("rejected") ? "rejected" : ""}>
                    <td className="mono muted">{offset(c.at)}</td>
                    <td className="mono">{c.command}</td>
                    <td className="muted small">{c.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Configuration changes</h2>
        {results.configs.map((c) => (
          <details key={c.node} open={c.diff.split("\n").some((l) => /^[+-][^+-]/.test(l))} data-diff={c.node}>
            <summary>{c.node}</summary>
            <Diff text={c.diff} />
          </details>
        ))}
      </section>

      <p className="muted small">
        <a href="/api/session/bundle" download="assessment.json">
          Download the full record (JSON)
        </a>
      </p>
    </main>
  );
}
