import { execFile } from "node:child_process";
import { PassThrough } from "node:stream";
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
