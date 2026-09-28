import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ProbeOutput, execCollect } from "@breakfix/scenario-kit";
import Docker from "dockerode";
import { parse, stringify } from "yaml";

const execFileAsync = promisify(execFile);

export const GUARD_APP_SOCKET = "/run/breakfix-guard/app.sock";
export const GUARD_DEPLOY_SOCKET = "/run/breakfix-guard/deploy.sock";
export const CLAB_WRAPPER = "/usr/local/sbin/breakfix-clab";
export const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

export interface ClabResult {
  code: number;
  json: Record<string, unknown> & { error?: string; refused?: boolean };
}

/** Run the root wrapper through sudo, exactly as the server will. */
export async function clab(args: string[]): Promise<ClabResult> {
  try {
    const { stdout } = await execFileAsync("sudo", ["-n", CLAB_WRAPPER, ...args], {
      timeout: 300_000,
    });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    let json: ClabResult["json"] = { error: e.stderr ?? String(err) };
    try {
      json = JSON.parse(e.stdout ?? "");
    } catch {
      // keep stderr
    }
    return { code: typeof e.code === "number" ? e.code : -1, json };
  }
}

/** Docker client that can only do what docker-guard's app profile allows. */
export function guardDocker(): Docker {
  return new Docker({ socketPath: GUARD_APP_SOCKET });
}

export type ExecResult = ProbeOutput;

/** Run a command through docker-guard (the scenario kit's exec path, used by the server too). */
export function execIn(_docker: Docker, container: string, cmd: string[], stdin?: string): Promise<ExecResult> {
  return execCollect(container, cmd, stdin);
}

export type Topology = {
  name: string;
  topology: { nodes: Record<string, Record<string, unknown>>; links: unknown[] };
};

/** Copy a fixture lab to a temp dir, give it a name, optionally edit its topology. */
export async function prepareLab(
  fixture: string,
  name: string,
  edit?: (topo: Topology, dir: string) => Promise<void> | void,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bfx-lab-"));
  await cp(join(FIXTURES, fixture), dir, { recursive: true });
  const file = join(dir, "topology.clab.yml");
  const topo = parse(await readFile(file, "utf8")) as Topology;
  topo.name = name;
  await edit?.(topo, dir);
  await writeFile(file, stringify(topo));
  return dir;
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
