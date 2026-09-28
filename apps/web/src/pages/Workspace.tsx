import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { type Tab, TerminalPane } from "../components/TerminalPane.js";
import { Timer } from "../components/Timer.js";
import { Topology } from "../components/Topology.js";
import { ApiError, api } from "../lib/api.js";
import { navigate } from "../lib/router.js";
import { SessionSocket } from "../lib/socket.js";
import type { PacketPath, SessionView, TopoState } from "../lib/types.js";

/** /session: the ticket, the live diagram, terminals, timer and submit. */
export function Workspace() {
  const [view, setView] = useState<SessionView>();
  const [clockOffset, setClockOffset] = useState(0);
  const [error, setError] = useState<string>();
  const [socket, setSocket] = useState<SessionSocket>();
  const [topo, setTopo] = useState<TopoState>();
  const [path, setPath] = useState<{ path: PacketPath; key: number }>();
  const [hints, setHints] = useState<string[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string>();

  const accept = useCallback((v: SessionView | undefined) => {
    if (!v) return;
    setView(v);
    setClockOffset(v.serverNow - Date.now());
    if (v.state === "finished") navigate("/results", true);
  }, []);

  useEffect(() => {
    let s: SessionSocket | undefined;
    api
      .session()
      .then((v) => {
        accept(v);
        if (v.state === "finished" || v.state === "failed") return;
        s = new SessionSocket();
        s.on((msg) => {
          if (msg.t === "session") accept(msg.view);
          else if (msg.t === "topo") setTopo(msg.state);
          else if (msg.t === "path") setPath({ path: msg.path, key: Date.now() });
          else if (msg.t === "hint") setHints((h) => (h.includes(msg.text) ? h : [...h, msg.text]));
          else if (msg.t === "error" && !msg.node) setNotice(msg.message);
        });
        setSocket(s);
      })
      .catch((err: unknown) => setError(err instanceof ApiError && err.status === 401 ? "No test is running in this browser. Open your test link to start." : "Could not load your test. Reload the page."));
    return () => s?.close();
  }, [accept]);

  const roles = useMemo(() => Object.fromEntries(view?.scenario.nodes.map((n) => [n.name, n.role]) ?? []), [view]);
  const openNode = useCallback(
    (node: string) => {
      const role = roles[node];
      if (!role) return;
      setTabs((t) => (t.some((x) => x.node === node) ? t : [...t, { node, role }]));
      setActive(node);
      // On narrow screens the terminal sits below the diagram: bring it into view.
      if (window.matchMedia("(max-width: 900px)").matches) {
        requestAnimationFrame(() => document.querySelector(".terminals")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    },
    [roles],
  );
  const closeNode = (node: string) => {
    setTabs((t) => {
      const rest = t.filter((x) => x.node !== node);
      if (active === node) setActive(rest[rest.length - 1]?.node);
      return rest;
    });
  };

  if (error) {
    return (
      <main className="center-page">
        <div className="card">
          <h1>No test running</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  }
  if (!view) return <main className="center-page muted">Loading…</main>;

  const s = view.scenario;
  const running = view.state === "running";
  const lastPath = path?.path;
  const pathText = lastPath && describePath(lastPath);

  return (
    <div className="workspace" data-state={view.state}>
      <header className="topbar">
        <div className="topbar-title">
          <span className="brand">Break/Fix Lab</span>
          <h1>{s.title}</h1>
          <span className={`badge badge-${s.difficulty}`}>{s.difficulty}</span>
        </div>
        <div className="topbar-actions">
          {running && view.deadlineAt && <Timer deadlineAt={view.deadlineAt} clockOffset={clockOffset} />}
          <button className="btn btn-primary" disabled={!running} onClick={() => setConfirming(true)} data-testid="submit">
            Submit
          </button>
        </div>
      </header>

      <aside className="ticket" aria-label="Ticket">
        <details open>
          <summary>
            <h2>Ticket</h2>
          </summary>
          <p className="ticket-text">{s.ticket}</p>
        </details>
        <section>
          <h2>Devices</h2>
          <ul className="devices">
            {s.nodes.map((n) => (
              <li key={n.name}>
                <button className="device" disabled={!running} onClick={() => openNode(n.name)} data-device={n.name}>
                  <span className={`tab-role tab-role-${n.role}`}>{n.role === "router" ? "R" : "H"}</span>
                  {n.name}
                  <span className="muted">{n.role === "router" ? "router CLI" : "host console"}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        {s.hintCount > 0 && running && (
          <section>
            <h2>Hints</h2>
            <ol className="hints">
              {hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ol>
            {hints.length < s.hintCount && (
              <button className="btn btn-small" onClick={() => socket?.send({ t: "hint", index: hints.length })}>
                Show hint {hints.length + 1} of {s.hintCount}
              </button>
            )}
            <p className="muted small">Opening a hint is noted in your results.</p>
          </section>
        )}
      </aside>

      <main className="stage">
        {view.state === "queued" && <Waiting title="You are in the queue" text={`Position ${view.queuePosition ?? "?"}. Your lab starts automatically; keep this page open.`} />}
        {view.state === "starting" && <Waiting title="Starting your lab" text="Building the routers and hosts. This takes about 10–20 seconds. The timer starts when it is ready." />}
        {view.state === "checking" && <Waiting title="Checking your network" text="Your configuration is being captured and checked." />}
        {view.state === "failed" && (
          <div className="waiting">
            <h2>Something went wrong</h2>
            <p>{view.error ?? "The lab stopped unexpectedly."}</p>
          </div>
        )}
        {running && (
          <>
            <Topology scenario={s} topo={topo} path={path} openNodes={new Set(tabs.map((t) => t.node))} onSelect={openNode} />
            {pathText && (
              <p className={`path-status ${lastPath?.forward.delivered && lastPath.back?.delivered ? "ok" : "bad"}`} data-testid="path-status" role="status">
                {pathText}
              </p>
            )}
            {socket && <TerminalPane socket={socket} tabs={tabs} active={active} onActivate={setActive} onClose={closeNode} />}
          </>
        )}
        {notice && (
          <p className="toast" role="alert" onClick={() => setNotice(undefined)}>
            {notice}
          </p>
        )}
      </main>

      {confirming && (
        <ConfirmDialog
          title="Submit your work?"
          body="Your network is checked as it is now and the lab is shut down. You cannot make further changes."
          confirm="Submit"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            socket?.send({ t: "submit" });
          }}
        />
      )}
    </div>
  );
}

function Waiting({ title, text }: { title: string; text: string }) {
  return (
    <div className="waiting" role="status">
      <div className="spinner" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function describePath(p: PacketPath): string {
  if (!p.forward.delivered) return `${p.from} → ${p.to}: dropped. ${p.forward.reason ?? ""}`;
  if (p.back && !p.back.delivered) return `${p.from} → ${p.to}: arrives, but the reply is dropped. ${p.back.reason ?? ""}`;
  return `${p.from} → ${p.to}: path ${p.forward.hops.map((h) => h.node).join(" → ")}, reply returns.`;
}
