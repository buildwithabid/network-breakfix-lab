/** JSON shapes the server sends. Mirrors apps/server (sessions/service.ts, labs/network.ts, sessions/results.ts). */

export type SessionState = "queued" | "starting" | "running" | "checking" | "finished" | "failed";

export interface Endpoint {
  node: string;
  iface: string;
}

export interface LinkInfo {
  id: string;
  a: Endpoint;
  b: Endpoint;
}

export interface SessionView {
  id: string;
  state: SessionState;
  queuePosition: number | null;
  serverNow: number;
  startedAt: number | null;
  deadlineAt: number | null;
  finishedAt: number | null;
  endReason: "submitted" | "timeout" | "error" | "server-restart" | null;
  error: string | null;
  scenario: {
    id: string;
    title: string;
    difficulty: string;
    timeLimitMinutes: number;
    ticket: string;
    hintCount: number;
    nodes: { name: string; role: "router" | "host" }[];
    links: LinkInfo[];
    positions: Record<string, [number, number]>;
  };
}

export interface TestPreview {
  title: string;
  difficulty: string;
  timeLimitMinutes: number;
  devices: number;
}

export type OspfLinkState = "full" | "forming" | "down";

export interface TopoState {
  at: number;
  nodes: Record<string, { role: "router" | "host"; up: boolean }>;
  links: { id: string; up: boolean; ospf: OspfLinkState | null }[];
  bgp: { a: string; b: string | null; peer: string; state: string }[];
}

export interface PathResult {
  hops: { node: string; link?: string }[];
  delivered: boolean;
  reason?: string;
}

export interface PacketPath {
  from: string;
  to: string;
  forward: PathResult;
  back?: PathResult;
}

export interface ResultsView {
  sessionId: string;
  scenario: { id: string; title: string; difficulty: string };
  endReason: SessionView["endReason"];
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  timeLimitMs: number;
  passed: number;
  total: number;
  objectives: { id: string; description: string; passed: boolean; detail: string }[];
  commands: Record<string, { at: number; kind: "vtysh" | "host" | "hint"; command: string; outcome: string | null }[]>;
  configs: { node: string; start: string | null; end: string | null; diff: string }[];
}

export type ServerMessage =
  | { t: "session"; view: SessionView | undefined }
  | { t: "topo"; state: TopoState }
  | { t: "out"; node: string; data: string }
  | { t: "exit"; node: string }
  | { t: "path"; path: PacketPath }
  | { t: "hint"; index: number; text: string }
  | { t: "error"; node?: string; message: string };

export type ClientMessage =
  | { t: "open"; node: string; cols: number; rows: number }
  | { t: "in"; node: string; data: string }
  | { t: "line"; node: string; line: string }
  | { t: "resize"; node: string; cols: number; rows: number }
  | { t: "close"; node: string }
  | { t: "hint"; index: number }
  | { t: "submit" };
