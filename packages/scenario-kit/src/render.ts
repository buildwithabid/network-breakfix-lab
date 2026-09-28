import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  DEFAULT_DAEMONS,
  DEFAULT_VTYSH_CONF,
  HOST_CAPS,
  ROUTER_CAPS,
  ROUTER_CONFIG_DIR,
} from "./constants.js";
import { type Scenario, type Variant, variantConfigs } from "./loader.js";

export interface RenderedFiles {
  topology: Record<string, unknown>;
  /** path relative to the lab dir -> content */
  files: Record<string, string>;
}

/** Pure part of rendering: the containerlab topology and every file of one lab variant. */
export function renderFiles(scenario: Scenario, variant: Variant, labName: string): RenderedFiles {
  const configs = variantConfigs(scenario, variant);
  const nodes: Record<string, Record<string, unknown>> = {};
  const files: Record<string, string> = {};
  for (const [name, node] of Object.entries(scenario.topology.topology.nodes)) {
    if (scenario.roles[name] === "router") {
      nodes[name] = {
        kind: "linux",
        image: node.image,
        "cap-add": [...ROUTER_CAPS],
        binds: [`${name}:${ROUTER_CONFIG_DIR}`],
      };
      const cfg = configs[name] ?? {};
      files[`${name}/frr.conf`] = cfg["frr.conf"] ?? "";
      files[`${name}/daemons`] = cfg.daemons ?? DEFAULT_DAEMONS;
      files[`${name}/vtysh.conf`] = DEFAULT_VTYSH_CONF;
    } else {
      nodes[name] = { kind: "linux", image: node.image, "cap-add": [...HOST_CAPS], ...(node.exec ? { exec: node.exec } : {}) };
    }
  }
  const topology = {
    name: labName,
    topology: { nodes, links: scenario.topology.topology.links.map((l) => ({ endpoints: [...l.endpoints] })) },
  };
  return { topology, files };
}

/** Write a lab variant to a fresh temp directory and return its path. */
export async function renderLab(scenario: Scenario, variant: Variant, labName: string): Promise<string> {
  const { topology, files } = renderFiles(scenario, variant, labName);
  const dir = await mkdtemp(join(tmpdir(), "bfx-lab-"));
  await writeFile(join(dir, "topology.clab.yml"), stringify(topology));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}
