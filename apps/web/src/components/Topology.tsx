import { useEffect, useMemo, useRef, useState } from "react";
import type { PacketPath, SessionView, TopoState } from "../lib/types.js";

const CELL = 70;
const PAD = 70;

type Point = { x: number; y: number };

interface Props {
  scenario: SessionView["scenario"];
  topo: TopoState | undefined;
  path: { path: PacketPath; key: number } | undefined;
  openNodes: ReadonlySet<string>;
  onSelect(node: string): void;
}

const OSPF_LABEL = { full: "OSPF full", forming: "OSPF forming", down: "OSPF down" } as const;

/** The live network diagram: click a device to open its terminal. */
export function Topology({ scenario, topo, path, openNodes, onSelect }: Props) {
  const centers = useMemo(() => {
    const out: Record<string, Point> = {};
    for (const [node, [col, row]] of Object.entries(scenario.positions)) out[node] = { x: PAD + col * CELL, y: PAD + row * CELL };
    return out;
  }, [scenario.positions]);

  const xs = Object.values(centers).map((p) => p.x);
  const ys = Object.values(centers).map((p) => p.y);
  const width = Math.max(...xs) + PAD;
  const height = Math.max(...ys) + PAD + 10;
  const roles = Object.fromEntries(scenario.nodes.map((n) => [n.name, n.role]));
  const linkState = new Map(topo?.links.map((l) => [l.id, l]) ?? []);

  return (
    <div className="topology">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Network diagram" data-testid="topology">
        {scenario.links.map((link) => {
          const a = centers[link.a.node];
          const b = centers[link.b.node];
          if (!a || !b) return null;
          const live = linkState.get(link.id);
          const state = live === undefined ? "unknown" : live.up ? "up" : "down";
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          return (
            <g key={link.id} className={`link link-${state}`} data-link={link.id} data-state={state} data-ospf={live?.ospf ?? "none"}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              <IfaceLabel from={a} to={b} text={link.a.iface} />
              <IfaceLabel from={b} to={a} text={link.b.iface} />
              {live?.ospf && <Pill at={{ x: mid.x, y: mid.y - 14 }} text={OSPF_LABEL[live.ospf]} tone={live.ospf === "full" ? "ok" : live.ospf === "forming" ? "warn" : "bad"} />}
            </g>
          );
        })}

        {topo?.bgp.map((s) => {
          const a = centers[s.a];
          const b = s.b ? centers[s.b] : undefined;
          const tone = s.state === "Established" ? "ok" : "bad";
          if (!a) return null;
          if (!b) return <Pill key={`${s.a}-${s.peer}`} at={{ x: a.x, y: a.y - 44 }} text={`BGP ${s.peer}: ${s.state}`} tone="bad" />;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const ctrl = { x: (a.x + b.x) / 2 + (dy / len) * 46, y: (a.y + b.y) / 2 - (dx / len) * 46 };
          const top = { x: (a.x + 2 * ctrl.x + b.x) / 4, y: (a.y + 2 * ctrl.y + b.y) / 4 };
          return (
            <g key={`${s.a}-${s.b}`} className={`bgp bgp-${tone}`} data-bgp={s.state}>
              <path d={`M ${a.x} ${a.y} Q ${ctrl.x} ${ctrl.y} ${b.x} ${b.y}`} />
              <Pill at={top} text={`BGP ${s.state}`} tone={tone} />
            </g>
          );
        })}

        {scenario.nodes.map(({ name }) => {
          const c = centers[name];
          if (!c) return null;
          const role = roles[name];
          const down = topo ? topo.nodes[name]?.up === false : false;
          return (
            <g
              key={name}
              className={`node node-${role}${down ? " node-down" : ""}${openNodes.has(name) ? " node-open" : ""}`}
              transform={`translate(${c.x} ${c.y})`}
              role="button"
              tabIndex={0}
              aria-label={`Open ${role} ${name}`}
              data-node={name}
              onClick={() => onSelect(name)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(name);
                }
              }}
            >
              {role === "router" ? <RouterIcon /> : <HostIcon />}
              <text className="node-label" y={42}>
                {name}
              </text>
              {down && (
                <text className="node-note" y={56}>
                  not responding
                </text>
              )}
            </g>
          );
        })}

        {path && <PacketAnimation key={path.key} path={path.path} centers={centers} />}
      </svg>
      <Legend />
    </div>
  );
}

function IfaceLabel({ from, to, text }: { from: Point; to: Point; text: string }) {
  const t = 0.3;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const x = from.x + dx * t + (dy / len) * 11;
  const y = from.y + dy * t - (dx / len) * 11 + 4;
  return (
    <text className="iface-label" x={x} y={y}>
      {text}
    </text>
  );
}

function Pill({ at, text, tone }: { at: Point; text: string; tone: "ok" | "warn" | "bad" }) {
  const w = text.length * 6.2 + 14;
  return (
    <g className={`pill pill-${tone}`} transform={`translate(${at.x - w / 2} ${at.y - 9})`}>
      <rect width={w} height={18} rx={9} />
      <text x={w / 2} y={12.5}>
        {text}
      </text>
    </g>
  );
}

function RouterIcon() {
  return (
    <g className="icon">
      <circle r={24} />
      <path d="M-11 -4 h16 l-4 -4 M11 4 h-16 l4 4 M-4 -11 v16 l-4 -4 M4 11 v-16 l4 4" className="icon-lines" />
    </g>
  );
}

function HostIcon() {
  return (
    <g className="icon">
      <rect x={-24} y={-19} width={48} height={32} rx={5} />
      <rect x={-17} y={-13} width={34} height={20} rx={2} className="icon-screen" />
      <path d="M-8 19 h16 M0 13 v6" className="icon-lines" />
    </g>
  );
}

function Legend() {
  return (
    <ul className="legend" aria-label="Legend">
      <li>
        <span className="swatch swatch-up" /> link up
      </li>
      <li>
        <span className="swatch swatch-down" /> link down
      </li>
      <li>
        <span className="swatch swatch-bgp" /> BGP session
      </li>
      <li>
        <span className="dot dot-fwd" /> packet out
      </li>
      <li>
        <span className="dot dot-back" /> reply
      </li>
    </ul>
  );
}

/** A dot travels the forward path, then the reply path; a cross marks where a packet died. */
function PacketAnimation({ path, centers }: { path: PacketPath; centers: Record<string, Point> }) {
  const legs = useMemo(() => {
    const pts = (hops: { node: string }[]) => hops.map((h) => centers[h.node]).filter((p): p is Point => Boolean(p));
    const out: { points: Point[]; tone: "fwd" | "back"; result: PacketPath["forward"] }[] = [{ points: pts(path.forward.hops), tone: "fwd", result: path.forward }];
    if (path.back) out.push({ points: pts(path.back.hops), tone: "back", result: path.back });
    return out;
  }, [path, centers]);

  const [leg, setLeg] = useState(0);
  const [pos, setPos] = useState<Point | undefined>(legs[0]?.points[0]);
  const [done, setDone] = useState(false);
  const frame = useRef(0);

  useEffect(() => {
    const current = legs[leg];
    if (!current) return;
    const pts = current.points;
    const segs = pts.slice(1).map((p, i) => Math.hypot(p.x - (pts[i]?.x ?? 0), p.y - (pts[i]?.y ?? 0)));
    const total = segs.reduce((a, b) => a + b, 0);
    const duration = Math.max(500, (total / 260) * 1000);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      let d = t * total;
      let i = 0;
      while (i < segs.length && d > (segs[i] ?? 0)) d -= segs[i++] ?? 0;
      const a = pts[i] ?? pts[pts.length - 1];
      const b = pts[i + 1] ?? a;
      const f = segs[i] ? d / (segs[i] ?? 1) : 0;
      if (a && b) setPos({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else if (current.result.delivered && leg + 1 < legs.length) setLeg(leg + 1);
      else setDone(true);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [leg, legs]);

  const current = legs[leg];
  const dropped = done && current && !current.result.delivered;
  const last = current?.points[current.points.length - 1];
  return (
    <g className="packet" data-testid="packet" data-result={done ? (dropped ? "dropped" : "delivered") : "moving"}>
      {pos && !dropped && <circle className={`packet-dot packet-${current?.tone}`} cx={pos.x} cy={pos.y} r={7} />}
      {dropped && last && (
        <g transform={`translate(${last.x + 26} ${last.y - 26})`} className="packet-drop">
          <path d="M-7 -7 L7 7 M7 -7 L-7 7" />
        </g>
      )}
    </g>
  );
}
