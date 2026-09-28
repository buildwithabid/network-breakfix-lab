/**
 * The host console. Candidates never get a shell on a host: each line they type is parsed here
 * into an argv for one of four read-only tools, with every argument validated, and executed without
 * a shell. docker-guard applies the same rules again (infra/bfx_infra/policy.py check_host_command).
 */

export type HostCommand =
  | { ok: true; argv: string[]; tool: "ping" | "traceroute" | "ip"; target?: string }
  | { ok: false; error: string };

export const HOST_HELP = [
  "Available commands:",
  "  ping [-c 1-10] [-W 1-5] [-s 0-1472] <ip>",
  "  traceroute [-n] [-w 1-5] [-q 1-3] [-m 1-30] <ip>",
  "  ip [-4|-6] [-br] addr|route|link|neigh [show] [dev ethN]",
  "  ip route get <ip>",
].join("\r\n");

const LINE_RE = /^[A-Za-z0-9 .:/_-]*$/;
const IPV4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;
const IFACE_RE = /^eth([1-9]|[12][0-9]|3[0-2])$/;
const IP_OBJECTS: Record<string, string> = {
  a: "addr", addr: "addr", address: "addr",
  r: "route", route: "route",
  l: "link", link: "link",
  n: "neigh", neigh: "neigh",
};

type FlagSpec = Record<string, [number, number] | null>;

function parseFlags(args: string[], spec: FlagSpec, tool: string): { flags: Map<string, string | null>; target: string } | string {
  const flags = new Map<string, string | null>();
  let i = 0;
  while (i < args.length - 1) {
    const flag = args[i] ?? "";
    if (!(flag in spec)) return `${tool}: option ${flag} is not available`;
    const bounds = spec[flag];
    if (bounds === null || bounds === undefined) {
      flags.set(flag, null);
      i += 1;
      continue;
    }
    const value = args[i + 1] ?? "";
    if (i + 1 >= args.length - 1 || !/^[0-9]{1,4}$/.test(value) || +value < bounds[0] || +value > bounds[1]) {
      return `${tool}: ${flag} needs a number from ${bounds[0]} to ${bounds[1]}`;
    }
    flags.set(flag, value);
    i += 2;
  }
  const target = args[args.length - 1] ?? "";
  if (i !== args.length - 1 || !IPV4_RE.test(target)) return `${tool}: give one IPv4 address as the destination`;
  return { flags, target };
}

function withDefaults(flags: Map<string, string | null>, defaults: [string, string | null][]): string[] {
  for (const [flag, value] of defaults) if (!flags.has(flag)) flags.set(flag, value);
  return [...flags].flatMap(([flag, value]) => (value === null ? [flag] : [flag, value]));
}

export function parseHostCommand(line: string): HostCommand {
  const text = line.trim();
  if (text.length > 200) return { ok: false, error: "command too long" };
  if (!LINE_RE.test(text)) return { ok: false, error: "only letters, digits, spaces and . : / _ - are allowed" };
  const [tool = "", ...args] = text.split(/\s+/);

  if (tool === "ping") {
    const parsed = parseFlags(args, { "-c": [1, 10], "-W": [1, 5], "-s": [0, 1472], "-n": null, "-4": null }, "ping");
    if (typeof parsed === "string") return { ok: false, error: parsed };
    // Without -c, ping never stops: default to 4 packets and a 1 s reply timeout.
    const flags = withDefaults(parsed.flags, [["-c", "4"], ["-W", "1"]]);
    return { ok: true, tool, argv: ["ping", ...flags, parsed.target], target: parsed.target };
  }

  if (tool === "traceroute") {
    const parsed = parseFlags(args, { "-n": null, "-w": [1, 5], "-q": [1, 3], "-m": [1, 30] }, "traceroute");
    if (typeof parsed === "string") return { ok: false, error: parsed };
    // Keep an unreachable destination from taking minutes: 1 probe per hop, 1 s wait, 15 hops.
    const flags = withDefaults(parsed.flags, [["-n", null], ["-w", "1"], ["-q", "1"], ["-m", "15"]]);
    return { ok: true, tool, argv: ["traceroute", ...flags, parsed.target], target: parsed.target };
  }

  if (tool === "ip") {
    const rest = [...args];
    const opts: string[] = [];
    while (rest[0] !== undefined && ["-4", "-6", "-br", "-j", "-d"].includes(rest[0])) opts.push(rest.shift() ?? "");
    const object = IP_OBJECTS[rest.shift() ?? ""];
    if (!object) return { ok: false, error: "ip: only addr, route, link and neigh can be shown" };
    if (object === "route" && rest[0] === "get") {
      if (rest.length !== 2 || !IPV4_RE.test(rest[1] ?? "")) return { ok: false, error: "ip route get: give one IPv4 address" };
      return { ok: true, tool, argv: ["ip", ...opts, "route", "get", rest[1] ?? ""], target: rest[1] ?? "" };
    }
    if (rest[0] === "show" || rest[0] === "list") rest.shift();
    if (rest.length && !(rest.length === 2 && rest[0] === "dev" && IFACE_RE.test(rest[1] ?? ""))) {
      return { ok: false, error: "ip: only 'show' and 'show dev ethN' are available (the host is read-only)" };
    }
    return { ok: true, tool, argv: ["ip", ...opts, object, ...(rest.length ? ["show", ...rest] : [])] };
  }

  return { ok: false, error: `${tool}: command not available here. Type 'help'.` };
}
