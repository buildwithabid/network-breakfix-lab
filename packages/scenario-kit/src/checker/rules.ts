import type { Rule } from "../schema.js";

/** One read-only command on one node. Every probe passes docker-guard's exec policy. */
export type Probe =
  | { kind: "vtysh"; node: string; command: string }
  | { kind: "host"; node: string; argv: string[] };

export interface ProbeOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface Verdict {
  passed: boolean;
  detail: string;
  /** The node could not be read at all. Negation must never turn this into a pass. */
  indeterminate?: boolean;
}

export function probeKey(probe: Probe): string {
  return probe.kind === "vtysh"
    ? `vtysh|${probe.node}|${probe.command}`
    : `host|${probe.node}|${probe.argv.join(" ")}`;
}

export function probeFor(rule: Rule): Probe {
  switch (rule.type) {
    case "reachability":
      return { kind: "host", node: rule.from, argv: ["ping", "-c", String(rule.count), "-W", "1", rule.to] };
    case "route-present":
      return { kind: "vtysh", node: rule.router, command: "show ip route json" };
    case "ospf-neighbor":
      return { kind: "vtysh", node: rule.router, command: "show ip ospf neighbor json" };
    case "bgp-session":
      return { kind: "vtysh", node: rule.router, command: "show bgp summary json" };
    case "prefix-received":
      return { kind: "vtysh", node: rule.router, command: `show bgp ipv4 unicast ${rule.prefix} json` };
  }
}

// --- FRR JSON shapes (the fields we read; captured from FRR 10.7.1, see checker/fixtures) ---

interface RouteEntry {
  protocol?: string;
  selected?: boolean;
  installed?: boolean;
  nexthops?: { ip?: string; active?: boolean; interfaceName?: string }[];
}
interface OspfNeighbors {
  neighbors?: Record<string, { nbrState?: string }[]>;
}
type BgpSummary = Record<string, { peers?: Record<string, { state?: string }> } | undefined>;
interface BgpPrefix {
  paths?: { valid?: boolean; peer?: { peerId?: string } }[];
}

function parseJson<T>(out: ProbeOutput): T | undefined {
  try {
    return JSON.parse(out.stdout) as T;
  } catch {
    return undefined;
  }
}

function unreadable(node: string): Verdict {
  return { passed: false, detail: `${node} did not answer (routing daemons down?)`, indeterminate: true };
}

export function evaluate(rule: Rule, out: ProbeOutput): Verdict {
  switch (rule.type) {
    case "reachability": {
      const received = Number(/(\d+) (?:packets )?received/.exec(out.stdout)?.[1] ?? 0);
      const passed = out.exitCode === 0 && received > 0;
      return { passed, detail: `${rule.from} → ${rule.to}: ${received}/${rule.count} replies` };
    }

    case "route-present": {
      const table = parseJson<Record<string, RouteEntry[]>>(out);
      if (!table) return unreadable(rule.router);
      const entries = table[rule.prefix] ?? [];
      const where = `${rule.router} → ${rule.prefix}`;
      if (!entries.length) return { passed: false, detail: `${where}: no route` };
      const ofProtocol = entries.filter((e) => e.protocol === rule.protocol);
      if (!ofProtocol.length) {
        const have = [...new Set(entries.map((e) => e.protocol))].join(", ");
        return { passed: false, detail: `${where}: learned via ${have}, expected ${rule.protocol}` };
      }
      const selected = ofProtocol.filter((e) => e.selected && e.installed);
      if (!selected.length) return { passed: false, detail: `${where}: ${rule.protocol} route exists but is not in use` };
      if (rule.nexthop) {
        const hops = selected.flatMap((e) => e.nexthops ?? []);
        if (!hops.some((h) => h.ip === rule.nexthop && h.active !== false)) {
          const via = hops.map((h) => h.ip ?? h.interfaceName ?? "?").join(", ");
          return { passed: false, detail: `${where}: via ${via}, expected next hop ${rule.nexthop}` };
        }
        return { passed: true, detail: `${where}: ${rule.protocol} via ${rule.nexthop}` };
      }
      return { passed: true, detail: `${where}: ${rule.protocol}` };
    }

    case "ospf-neighbor": {
      const data = parseJson<OspfNeighbors>(out);
      if (!data) return unreadable(rule.router);
      const states = (data.neighbors?.[rule.neighbor] ?? []).map((n) => n.nbrState ?? "?");
      const where = `${rule.router}: OSPF neighbour ${rule.neighbor}`;
      if (!states.length) return { passed: false, detail: `${where} not seen` };
      const passed = states.some((s) => s === rule.state || s.startsWith(`${rule.state}/`));
      return { passed, detail: `${where} is ${states.join(", ")}` };
    }

    case "bgp-session": {
      const data = parseJson<BgpSummary>(out);
      if (!data) return unreadable(rule.router);
      const where = `${rule.router}: BGP peer ${rule.peer}`;
      const peers = Object.values(data).flatMap((afi) => {
        const peer = afi?.peers?.[rule.peer];
        return peer ? [peer] : [];
      });
      if (!peers.length) return { passed: false, detail: `${where} is not configured` };
      const state = peers[0]?.state ?? "unknown";
      return { passed: peers.some((p) => p.state === rule.state), detail: `${where} is ${state}` };
    }

    case "prefix-received": {
      const data = parseJson<BgpPrefix>(out);
      if (!data) return unreadable(rule.router);
      const where = `${rule.router}: ${rule.prefix} from ${rule.peer}`;
      const paths = (data.paths ?? []).filter((p) => p.peer?.peerId === rule.peer);
      if (!paths.length) return { passed: false, detail: `${where}: not received` };
      const passed = paths.some((p) => p.valid);
      return { passed, detail: `${where}: ${passed ? "received" : "received but not valid"}` };
    }
  }
}
