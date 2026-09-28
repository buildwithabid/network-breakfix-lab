import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScenarioError, listScenarioDirs, loadScenario, variantConfigs } from "./loader.js";

const SCENARIOS = new URL("../../../scenarios/", import.meta.url).pathname;
const S01 = join(SCENARIOS, "01-wrong-ip-mask");
const temp: string[] = [];

afterEach(async () => {
  await Promise.all(temp.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Copy scenario 01 into a temp dir (same basename), let the test break it, return the dir. */
async function broken(edit: (dir: string) => Promise<void>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bfx-scn-"));
  temp.push(root);
  const dir = join(root, "01-wrong-ip-mask");
  await cp(S01, dir, { recursive: true });
  await edit(dir);
  return dir;
}

async function replaceIn(file: string, from: string, to: string): Promise<void> {
  const text = await readFile(file, "utf8");
  if (!text.includes(from)) throw new Error(`${from} not in ${file}`);
  await writeFile(file, text.replace(from, to));
}

async function problemsOf(dir: string): Promise<string[]> {
  try {
    await loadScenario(dir);
  } catch (err) {
    if (err instanceof ScenarioError) return err.problems;
    throw err;
  }
  return [];
}

describe("loadScenario", () => {
  it("loads every scenario in the repository", async () => {
    const dirs = await listScenarioDirs(SCENARIOS);
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) await expect(loadScenario(dir)).resolves.toBeDefined();
  });

  it("assigns roles by image and merges variants in order", async () => {
    const s = await loadScenario(S01);
    expect(s.roles).toEqual({ r1: "router", r2: "router", h1: "host", srv: "host" });
    expect(variantConfigs(s, "baseline").r2?.["frr.conf"]).toContain("10.0.12.2/30");
    expect(variantConfigs(s, "fault").r2?.["frr.conf"]).toContain("10.0.12.2/31");
    expect(variantConfigs(s, "fault").r1?.["frr.conf"]).toContain("10.0.12.1/30");
    expect(variantConfigs(s, "workaround").r2?.["frr.conf"]).toContain("ip route 10.0.12.1/32 eth1");
  });

  it.each([
    ["id must match the directory", (d: string) => replaceIn(join(d, "scenario.yaml"), "id: 01-wrong-ip-mask", "id: 01-other"), "must match the directory"],
    ["unknown image", (d: string) => replaceIn(join(d, "topology.clab.yml"), "breakfix-host:0.1.0", "alpine:3"), "image must be"],
    ["rule on the wrong role", (d: string) => replaceIn(join(d, "scenario.yaml"), "from: h1", "from: r1"), "r1 is not a host"],
    ["unknown node", (d: string) => replaceIn(join(d, "scenario.yaml"), "router: r2, prefix: 10.0.12.0/30", "router: r9, prefix: 10.0.12.0/30"), "r9 is not a router"],
    ["prefix with host bits", (d: string) => replaceIn(join(d, "scenario.yaml"), "prefix: 10.0.12.0/30", "prefix: 10.0.12.1/30"), "network address"],
    ["unknown rule type", (d: string) => replaceIn(join(d, "scenario.yaml"), "type: reachability, from: h1", "type: telepathy, from: h1"), "rule"],
    ["fault identical to baseline", async (d: string) => cp(join(d, "baseline/r2/frr.conf"), join(d, "fault/r2/frr.conf")), "fault/ must change"],
    ["workaround identical to fault", async (d: string) => cp(join(d, "fault/r2/frr.conf"), join(d, "workaround/r2/frr.conf")), "workaround/ must change"],
    ["missing baseline config", async (d: string) => rm(join(d, "baseline/r1"), { recursive: true }), "baseline/r1/frr.conf is missing"],
    ["config for a host", async (d: string) => cp(join(d, "fault/r2"), join(d, "fault/h1"), { recursive: true }), "fault/h1: not a router"],
    ["unexpected file", async (d: string) => writeFile(join(d, "fault/r2/run.sh"), "#!/bin/sh"), "only frr.conf and daemons"],
    ["exec on a router", (d: string) => replaceIn(join(d, "topology.clab.yml"), "image: quay.io/frrouting/frr:10.7.1\n    r2:", "image: quay.io/frrouting/frr:10.7.1\n      exec: [\"id\"]\n    r2:"), "routers are configured by frr.conf"],
    ["binds in the scenario topology", (d: string) => replaceIn(join(d, "topology.clab.yml"), "image: quay.io/frrouting/frr:10.7.1\n    r2:", "image: quay.io/frrouting/frr:10.7.1\n      binds: [\"/:/host\"]\n    r2:"), "binds"],
  ] as const)("reports: %s", async (_label, edit, fragment) => {
    const problems = await problemsOf(await broken(edit));
    expect(problems.join("\n")).toContain(fragment);
  });

  it("reports duplicate objective ids", async () => {
    const dir = await broken((d) => replaceIn(join(d, "scenario.yaml"), "id: server-to-branch", "id: branch-to-server"));
    expect((await problemsOf(dir)).join("\n")).toContain("used twice");
  });
});
