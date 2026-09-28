import type { Role, ScenarioTopology } from "@breakfix/scenario-kit";

/**
 * A model of the lab built from real router output (polled `show … json`) plus the host addressing
 * in the topology. It drives two things on the candidate's diagram: link and protocol colours, and
 * the path a ping takes. It never feeds the checker, which reads the routers directly.
 */

export interface RouterPoll {
  at: number;
  ok: boolean;
  interfaces: Record<string, { operationalStatus?: string; ipAddresses?: { address?: string }[] }> | null;
  ospfInterfaces: { interfaces?: Record<string, unknown> } | null;
  ospfNeighbors: { neighbors?: Record<string, { nbrState?: string; ifaceName?: string }[]> } | null;
  bgpSummary: Record<string, { peers?: Record<string, { state?: string }> } | undefined> | null;
  routes: Record<string, RouteEntry[]> | null;
}

export interface RouteEntry {
  protocol?: string;
  selected?: boolean;
  installed?: boolean;
  nexthops?: { ip?: string; interfaceName?: string; active?: boolean; blackhole?: boolean; unreachable?: boolean }[];
}

/** The `show … json` commands one poll runs on each router, in this order. */
export const POLL_COMMANDS = [
  "show interface json",
  "show ip ospf interface json",
  "show ip ospf neighbor json",
  "show bgp summary json",
  "show ip route json",
] as const;

export function pollFromDocs(docs: unknown[], at = Date.now()): RouterPoll {
  const [interfaces, ospfInterfaces, ospfNeighbors, bgpSummary, routes] = docs as [
    RouterPoll["interfaces"], RouterPoll["ospfInterfaces"], RouterPoll["ospfNeighbors"], RouterPoll["bgpSummary"], RouterPoll["routes"],
  ];
  return { at, ok: interfaces !== null, interfaces, ospfInterfaces, ospfNeighbors, bgpSummary, routes };
}

// ---------------------------------------------------------------------------------------------
// Static facts from the topology
// ---------------------------------------------------------------------------------------------

export interface Endpoint {
  node: string;
  iface: string;
}

export interface LinkInfo {
  id: string;
  a: Endpoint;
  b: Endpoint;
}

export interface HostAddressing {
  /** node -> iface -> CIDRs */
  addresses: Record<string, Record<string, string[]>>;
  gateways: Record<string, string>;
}

export function linksOf(topology: ScenarioTopology): LinkInfo[] {
  return topology.topology.links.map((l, i) => {
    const [a = "", b = ""] = l.endpoints;
    const [an = "", ai = ""] = a.split(":");
    const [bn = "", bi = ""] = b.split(":");
    return { id: `l${i}`, a: { node: an, iface: ai }, b: { node: bn, iface: bi } };
  });
}

/** Host addresses and gateways come from the topology's (allowlisted) exec lines. */
export function hostAddressing(topology: ScenarioTopology): HostAddressing {
  const addresses: HostAddressing["addresses"] = {};
  const gateways: HostAddressing["gateways"] = {};
  for (const [name, node] of Object.entries(topology.topology.nodes)) {
    for (const line of node.exec ?? []) {
      const addr = /^ip addr add (\S+) dev (\S+)$/.exec(line);
      if (addr?.[1] && addr[2]) ((addresses[name] ??= {})[addr[2]] ??= []).push(addr[1]);
      const gw = /^ip route add default via (\S+)/.exec(line);
      if (gw?.[1]) gateways[name] = gw[1];
    }
  }
  return { addresses, gateways };
}

// ---------------------------------------------------------------------------------------------
// IPv4 helpers
// ---------------------------------------------------------------------------------------------

export function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
}

function parseCidr(cidr: string): { ip: number; len: number } | undefined {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr);
  if (!m?.[1] || !m[2]) return undefined;
  return { ip: ipToInt(m[1]), len: Number(m[2]) };
}

function mask(len: number): number {
  return len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
}

export function inSubnet(ip: string, cidr: string): boolean {
  const c = parseCidr(cidr);
  if (!c) return false;
  const m = mask(c.len);
  return ((ipToInt(ip) & m) >>> 0) === ((c.ip & m) >>> 0);
}

const addressOf = (cidr: string) => cidr.split("/")[0] ?? "";

// ---------------------------------------------------------------------------------------------
// Live model
// ---------------------------------------------------------------------------------------------

export interface NetModel {
  roles: Record<string, Role>;
  links: LinkInfo[];
  /** node -> iface -> { cidrs, up } (routers from polls; hosts from the topology) */
  ifaces: Record<string, Record<string, { cidrs: string[]; up: boolean }>>;
  routes: Record<string, Record<string, RouteEntry[]> | null>;
  gateways: Record<string, string>;
  polls: Record<string, RouterPoll | undefined>;
}

export function buildModel(
  topology: ScenarioTopology,
  roles: Record<string, Role>,
  polls: Record<string, RouterPoll | undefined>,
): NetModel {
  const hosts = hostAddressing(topology);
  const ifaces: NetModel["ifaces"] = {};
  const routes: NetModel["routes"] = {};
  for (const node of Object.keys(roles)) {
    if (roles[node] === "host") {
      ifaces[node] = Object.fromEntries(
        Object.entries(hosts.addresses[node] ?? {}).map(([iface, cidrs]) => [iface, { cidrs, up: true }]),
      );
      continue;
    }
    const poll = polls[node];
    routes[node] = poll?.routes ?? null;
    ifaces[node] = Object.fromEntries(
      Object.entries(poll?.interfaces ?? {}).map(([iface, info]) => [
        iface,
        {
          up: info.operationalStatus === "up",
          cidrs: (info.ipAddresses ?? []).map((a) => a.address ?? "").filter((a) => a.includes(".")),
        },
      ]),
    );
  }
  return { roles, links: linksOf(topology), ifaces, routes, gateways: hosts.gateways, polls };
}

function ownerOf(model: NetModel, ip: string): Endpoint | undefined {
  for (const [node, list] of Object.entries(model.ifaces)) {
    for (const [iface, info] of Object.entries(list)) {
      if (info.cidrs.some((c) => addressOf(c) === ip)) return { node, iface };
    }
  }
  return undefined;
}

function peerOf(model: NetModel, ep: Endpoint): Endpoint | undefined {
  for (const l of model.links) {
    if (l.a.node === ep.node && l.a.iface === ep.iface) return l.b;
    if (l.b.node === ep.node && l.b.iface === ep.iface) return l.a;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Diagram state
// ---------------------------------------------------------------------------------------------

export type OspfLinkState = "full" | "forming" | "down";

export interface TopoState {
  at: number;
  nodes: Record<string, { role: Role; up: boolean }>;
  links: { id: string; up: boolean; ospf: OspfLinkState | null }[];
  bgp: { a: string; b: string | null; peer: string; state: string }[];
}

function ospfOnIface(poll: RouterPoll | undefined, iface: string): boolean {
  const ifs = poll?.ospfInterfaces?.interfaces ?? (poll?.ospfInterfaces as Record<string, unknown> | null | undefined);
  return Boolean(ifs && iface in ifs);
}

function ospfNeighborStates(poll: RouterPoll | undefined, iface: string): string[] {
  return Object.values(poll?.ospfNeighbors?.neighbors ?? {})
    .flat()
    .filter((n) => (n.ifaceName ?? "").split(":")[0] === iface)
    .map((n) => n.nbrState ?? "");
}

export function deriveTopoState(model: NetModel, at = Date.now()): TopoState {
  const nodes: TopoState["nodes"] = {};
  for (const [node, role] of Object.entries(model.roles)) {
    nodes[node] = { role, up: role === "host" ? true : Boolean(model.polls[node]?.ok) };
  }

  const links = model.links.map((l) => {
    const side = (ep: Endpoint) =>
      model.roles[ep.node] === "host" ? true : Boolean(model.ifaces[ep.node]?.[ep.iface]?.up);
    const up = side(l.a) && side(l.b);
    const ospfSides = [l.a, l.b].filter((ep) => model.roles[ep.node] === "router" && ospfOnIface(model.polls[ep.node], ep.iface));
    let ospf: OspfLinkState | null = null;
    if (ospfSides.length) {
      const states = ospfSides.flatMap((ep) => ospfNeighborStates(model.polls[ep.node], ep.iface));
      const full = states.filter((s) => s.startsWith("Full")).length;
      ospf = ospfSides.length === 2 && full >= 2 ? "full" : states.length ? "forming" : "down";
      if (ospfSides.length === 1) ospf = "down"; // OSPF on one side only: no adjacency possible
    }
    return { id: l.id, up, ospf };
  });

  const bgp: TopoState["bgp"] = [];
  const seen = new Map<string, number>();
  for (const [node, role] of Object.entries(model.roles)) {
    if (role !== "router") continue;
    const summary = model.polls[node]?.bgpSummary ?? {};
    for (const afi of Object.values(summary)) {
      for (const [peer, info] of Object.entries(afi?.peers ?? {})) {
        const owner = ownerOf(model, peer)?.node ?? null;
        const key = [node, owner ?? peer].sort().join("|");
        const state = info.state ?? "unknown";
        const existing = seen.get(key);
        if (existing === undefined) {
          seen.set(key, bgp.length);
          bgp.push({ a: node, b: owner, peer, state });
        } else if (state !== "Established") {
          const entry = bgp[existing];
          if (entry) entry.state = state; // a session is only up if both sides say so
        }
      }
    }
  }
  return { at, nodes, links, bgp };
}

// ---------------------------------------------------------------------------------------------
// Packet path
// ---------------------------------------------------------------------------------------------

export interface Hop {
  node: string;
  /** link the packet leaves on (absent on the last hop) */
  link?: string;
}

export interface PathResult {
  hops: Hop[];
  delivered: boolean;
  reason?: string;
}

function lpm(table: Record<string, RouteEntry[]>, ip: string): { prefix: string; entry: RouteEntry } | undefined {
  let best: { prefix: string; entry: RouteEntry; len: number } | undefined;
  for (const [prefix, entries] of Object.entries(table)) {
    const c = parseCidr(prefix);
    if (!c || !inSubnet(ip, prefix)) continue;
    const entry = entries.find((e) => e.selected && e.installed !== false);
    if (entry && (!best || c.len > best.len)) best = { prefix, entry, len: c.len };
  }
  return best && { prefix: best.prefix, entry: best.entry };
}

function linkId(model: NetModel, ep: Endpoint): string | undefined {
  return model.links.find(
    (l) => (l.a.node === ep.node && l.a.iface === ep.iface) || (l.b.node === ep.node && l.b.iface === ep.iface),
  )?.id;
}

/** Follow the forwarding decisions from `from` towards `dst`, as the routers' tables describe them. */
export function tracePath(model: NetModel, from: string, dst: string): PathResult {
  const hops: Hop[] = [];
  let current = from;
  for (let ttl = 0; ttl < 32; ttl++) {
    const hop: Hop = { node: current };
    hops.push(hop);
    const local = Object.values(model.ifaces[current] ?? {}).some((i) => i.cidrs.some((c) => addressOf(c) === dst));
    if (local) return { hops, delivered: true };

    let nextIp: string | undefined;
    let outIface: string | undefined;
    if (model.roles[current] === "host") {
      const direct = Object.entries(model.ifaces[current] ?? {}).find(([, i]) => i.cidrs.some((c) => inSubnet(dst, c)));
      const gw = model.gateways[current];
      if (direct) [nextIp, outIface] = [dst, direct[0]];
      else if (gw) {
        nextIp = gw;
        outIface = Object.entries(model.ifaces[current] ?? {}).find(([, i]) => i.cidrs.some((c) => inSubnet(gw, c)))?.[0];
      }
      if (!nextIp || !outIface) return { hops, delivered: false, reason: `${current} has no route to ${dst}` };
    } else {
      const table = model.routes[current];
      if (!table) return { hops, delivered: false, reason: `${current} is not answering` };
      const match = lpm(table, dst);
      if (!match) return { hops, delivered: false, reason: `${current} has no route to ${dst}` };
      const nh = match.entry.nexthops?.find((n) => n.active !== false) ?? match.entry.nexthops?.[0];
      if (!nh || nh.blackhole || nh.unreachable) return { hops, delivered: false, reason: `${current} discards traffic to ${match.prefix}` };
      outIface = nh.interfaceName;
      nextIp = match.entry.protocol === "connected" || match.entry.protocol === "local" || !nh.ip ? dst : nh.ip;
      if (!outIface) return { hops, delivered: false, reason: `${current}: next hop ${nextIp} is not resolved` };
    }

    if (model.ifaces[current]?.[outIface]?.up === false) return { hops, delivered: false, reason: `${current} ${outIface} is down` };
    const peer = peerOf(model, { node: current, iface: outIface });
    const id = linkId(model, { node: current, iface: outIface });
    if (peer && model.roles[peer.node] === "router" && !model.polls[peer.node]?.ok) {
      if (id) hop.link = id;
      hops.push({ node: peer.node });
      return { hops, delivered: false, reason: `${peer.node} is not answering` };
    }
    const answers = peer && model.ifaces[peer.node]?.[peer.iface]?.cidrs.some((c) => addressOf(c) === nextIp);
    if (!peer || !answers || model.ifaces[peer.node]?.[peer.iface]?.up === false) {
      return { hops, delivered: false, reason: `${current}: ${nextIp} does not answer on ${outIface}` };
    }
    if (id) hop.link = id;
    current = peer.node;
  }
  return { hops, delivered: false, reason: "routing loop (TTL expired)" };
}

export interface PacketPath {
  from: string;
  to: string;
  forward: PathResult;
  back?: PathResult;
}

/** Forward path to dst and, if it arrives, the reply's path back to the sender's address. */
export function packetPath(model: NetModel, from: string, dst: string): PacketPath {
  const forward = tracePath(model, from, dst);
  const result: PacketPath = { from, to: dst, forward };
  const last = forward.hops.at(-1)?.node;
  const source = Object.values(model.ifaces[from] ?? {}).flatMap((i) => i.cidrs)[0];
  if (forward.delivered && last && source) result.back = tracePath(model, last, addressOf(source));
  return result;
}
