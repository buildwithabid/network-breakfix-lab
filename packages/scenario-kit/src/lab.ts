import { execFile } from "node:child_process";
import { type Duplex, PassThrough } from "node:stream";
import { promisify } from "node:util";
import Docker from "dockerode";
import type { ProbeRunner } from "./checker/engine.js";
import type { Probe, ProbeOutput } from "./checker/rules.js";
import { CLAB_WRAPPER, GUARD_SOCKET } from "./constants.js";
import type { Role } from "./loader.js";

const execFileAsync = promisify(execFile);

export class WrapperError extends Error {
  constructor(
    message: string,
    readonly refused: boolean,
  ) {
    super(message);
    this.name = "WrapperError";
  }
}

/** Run breakfix-clab through sudo. It prints JSON on stdout; exit 2 means refused by policy. */
export async function clab(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("sudo", ["-n", CLAB_WRAPPER, ...args], { timeout: 300_000 });
    return JSON.parse(stdout);
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    let message = e.stderr?.trim() || e.message;
    try {
      message = (JSON.parse(e.stdout ?? "") as { error?: string }).error ?? message;
    } catch {
      // not JSON: keep stderr
    }
    throw new WrapperError(`breakfix-clab ${args[0] ?? ""}: ${message}`, e.code === 2);
  }
}

export interface LabNode {
  node: string;
  container: string;
  role: Role;
}

export interface LabSummary {
  lab: string;
  created: number;
  nodes: { node: string; container: string; state: string }[];
}

let dockerClient: Docker | undefined;
function docker(): Docker {
  dockerClient ??= new Docker({ socketPath: GUARD_SOCKET });
  return dockerClient;
}

/** Run a command in a lab container through docker-guard and collect its output. */
export async function execCollect(container: string, cmd: string[], stdin?: string): Promise<ProbeOutput> {
  const exec = await docker().getContainer(container).exec({
    Cmd: cmd,
    AttachStdin: stdin !== undefined,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: stdin !== undefined });
  const out = new PassThrough();
  const err = new PassThrough();
  const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
  out.on("data", (c: Buffer) => chunks.out.push(c));
  err.on("data", (c: Buffer) => chunks.err.push(c));
  docker().modem.demuxStream(stream, out, err);
  const done = new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });
  if (stdin !== undefined) {
    stream.write(stdin);
    stream.end();
  }
  await done;
  const info = await exec.inspect();
  return {
    exitCode: info.ExitCode,
    stdout: Buffer.concat(chunks.out).toString("utf8"),
    stderr: Buffer.concat(chunks.err).toString("utf8"),
  };
}

/** Run a non-interactive command and stream stdout+stderr as it arrives. Resolves to the exit code. */
export async function execStream(container: string, cmd: string[], onData: (chunk: string) => void): Promise<number | null> {
  const exec = await docker().getContainer(container).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  const sink = new PassThrough();
  sink.on("data", (c: Buffer) => onData(c.toString("utf8")));
  docker().modem.demuxStream(stream, sink, sink);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });
  return (await exec.inspect()).ExitCode;
}

export interface RouterTerminal {
  /** Raw TTY stream: write keystrokes, read screen output. */
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void>;
  close(): void;
}

/** Start an interactive vtysh on a router (docker-guard forces VTYSH_PAGER=cat and TERM). */
export async function openRouterTerminal(container: string, cols: number, rows: number): Promise<RouterTerminal> {
  const exec = await docker().getContainer(container).exec({
    Cmd: ["vtysh"],
    Tty: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    ConsoleSize: [rows, cols],
  });
  const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as Duplex;
  return {
    stream,
    resize: async (c, r) => {
      await exec.resize({ w: c, h: r });
    },
    close: () => stream.destroy(),
  };
}

const active = new Set<Lab>();

/** A deployed lab. Tracked until destroyed so an interrupted run can still clean up. */
export class Lab implements ProbeRunner {
  private constructor(
    readonly name: string,
    readonly nodes: ReadonlyMap<string, LabNode>,
  ) {}

  static async deploy(dir: string): Promise<Lab> {
    const result = (await clab(["deploy", dir])) as { lab: string; nodes: LabNode[] };
    const lab = new Lab(result.lab, new Map(result.nodes.map((n) => [n.node, n])));
    active.add(lab);
    return lab;
  }

  /** Re-attach to a lab deployed earlier (e.g. by a previous server process). */
  static async attach(name: string, roles: Record<string, Role>): Promise<Lab | undefined> {
    const summary = (await Lab.list()).find((l) => l.lab === name);
    if (!summary || summary.nodes.length === 0) return undefined;
    const nodes = summary.nodes.flatMap((n) => {
      const role = roles[n.node];
      return role ? [{ node: n.node, container: n.container, role }] : [];
    });
    const lab = new Lab(name, new Map(nodes.map((n) => [n.node, n])));
    active.add(lab);
    return lab;
  }

  static async list(): Promise<LabSummary[]> {
    return (await clab(["list"])) as LabSummary[];
  }

  static async destroyByName(name: string): Promise<void> {
    await clab(["destroy", name]);
  }

  async destroy(): Promise<void> {
    active.delete(this);
    await Lab.destroyByName(this.name);
  }

  private container(node: string, role: Role): string {
    const n = this.nodes.get(node);
    if (!n || n.role !== role) throw new Error(`${this.name} has no ${role} named ${node}`);
    return n.container;
  }

  async vtysh(router: string, command: string): Promise<ProbeOutput> {
    return execCollect(this.container(router, "router"), ["vtysh", "-c", command]);
  }

  async host(node: string, argv: string[]): Promise<ProbeOutput> {
    return execCollect(this.container(node, "host"), argv);
  }

  /** Several `show … json` commands in one exec; returns one parsed document (or null) per command. */
  async vtyshJson(router: string, commands: string[]): Promise<unknown[]> {
    const out = await execCollect(
      this.container(router, "router"),
      ["vtysh", ...commands.flatMap((c) => ["-c", c])],
    );
    const docs = splitJsonDocuments(out.stdout);
    return commands.map((_, i) => docs[i] ?? null);
  }

  openTerminal(router: string, cols: number, rows: number): Promise<RouterTerminal> {
    return openRouterTerminal(this.container(router, "router"), cols, rows);
  }

  hostStream(node: string, argv: string[], onData: (chunk: string) => void): Promise<number | null> {
    return execStream(this.container(node, "host"), argv, onData);
  }

  run(probe: Probe): Promise<ProbeOutput> {
    return probe.kind === "vtysh" ? this.vtysh(probe.node, probe.command) : this.host(probe.node, probe.argv);
  }

  /** Wait until every router's vtysh answers with all daemons running. */
  async waitForRouters(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const routers = [...this.nodes.values()].filter((n) => n.role === "router");
    for (const r of routers) {
      for (;;) {
        const out = await this.vtysh(r.node, "show version").catch(() => undefined);
        if (out?.exitCode === 0 && out.stdout.includes("FRRouting")) break;
        if (Date.now() > deadline) throw new Error(`${this.name}: router ${r.node} did not start`);
        await sleep(1000);
      }
    }
  }
}

/** Destroy every lab this process deployed and has not destroyed yet. */
export async function destroyActiveLabs(): Promise<void> {
  await Promise.allSettled([...active].map((lab) => lab.destroy()));
}

/**
 * vtysh prints one JSON document per `-c` command, back to back. Split them; a document that does
 * not parse becomes null so the caller can tell which command failed.
 */
export function splitJsonDocuments(text: string): (unknown | null)[] {
  const docs: (unknown | null)[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if ((ch === "}" || ch === "]") && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          docs.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          docs.push(null);
        }
        start = -1;
      }
    }
  }
  return docs;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
