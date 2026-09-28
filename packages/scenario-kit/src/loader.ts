import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import { HOST_IMAGE, ROUTER_IMAGE } from "./constants.js";
import { type Rule, ScenarioMeta, ScenarioTopology } from "./schema.js";

export type Variant = "baseline" | "fault" | "workaround";
export type Role = "router" | "host";
/** Files a scenario may provide per router and variant. vtysh.conf always comes from the kit. */
export const CONFIG_FILES = ["frr.conf", "daemons"] as const;
export type ConfigFile = (typeof CONFIG_FILES)[number];
/** router -> file -> content, as found in one variant directory (not merged). */
export type ConfigSet = Record<string, Partial<Record<ConfigFile, string>>>;

export interface Scenario {
  dir: string;
  meta: ScenarioMeta;
  topology: ScenarioTopology;
  roles: Record<string, Role>;
  configs: { baseline: ConfigSet; fault: ConfigSet; workaround?: ConfigSet };
}

export class ScenarioError extends Error {
  constructor(
    readonly where: string,
    readonly problems: string[],
  ) {
    super(`${where}:\n  - ${problems.join("\n  - ")}`);
    this.name = "ScenarioError";
  }
}

function zodProblems(file: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${file}: ${i.path.join(".") || "(root)"}: ${i.message}`);
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readYaml(path: string): Promise<unknown> {
  return parse(await readFile(path, "utf8"));
}

async function readConfigSet(dir: string, problems: string[], label: string): Promise<ConfigSet> {
  const set: ConfigSet = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      problems.push(`${label}/${entry.name}: expected one directory per router`);
      continue;
    }
    const files: Partial<Record<ConfigFile, string>> = {};
    for (const file of await readdir(join(dir, entry.name), { withFileTypes: true })) {
      if (!file.isFile() || !(CONFIG_FILES as readonly string[]).includes(file.name)) {
        problems.push(`${label}/${entry.name}/${file.name}: only ${CONFIG_FILES.join(" and ")} are allowed`);
        continue;
      }
      files[file.name as ConfigFile] = await readFile(join(dir, entry.name, file.name), "utf8");
    }
    set[entry.name] = files;
  }
  return set;
}

/** Router and host names a rule refers to, with the role each must have. */
export function ruleNodes(rule: Rule): [string, Role][] {
  return rule.type === "reachability" ? [[rule.from, "host"]] : [[rule.router, "router"]];
}

function differs(base: ConfigSet, overlay: ConfigSet): boolean {
  return Object.entries(overlay).some(([router, files]) =>
    Object.entries(files).some(([name, content]) => base[router]?.[name as ConfigFile] !== content),
  );
}

/** Load and cross-check one scenario directory. Throws ScenarioError listing every problem found. */
export async function loadScenario(dir: string): Promise<Scenario> {
  const id = basename(dir);
  const problems: string[] = [];

  const metaResult = ScenarioMeta.safeParse(await readYaml(join(dir, "scenario.yaml")).catch(() => null));
  if (!metaResult.success) problems.push(...zodProblems("scenario.yaml", metaResult.error));
  const topoResult = ScenarioTopology.safeParse(await readYaml(join(dir, "topology.clab.yml")).catch(() => null));
  if (!topoResult.success) problems.push(...zodProblems("topology.clab.yml", topoResult.error));
  if (!metaResult.success || !topoResult.success) throw new ScenarioError(id, problems);

  const meta = metaResult.data;
  const topology = topoResult.data;
  if (meta.id !== id) problems.push(`scenario.yaml: id ${meta.id} must match the directory name ${id}`);

  const roles: Record<string, Role> = {};
  for (const [name, node] of Object.entries(topology.topology.nodes)) {
    if (node.image === ROUTER_IMAGE) roles[name] = "router";
    else if (node.image === HOST_IMAGE) roles[name] = "host";
    else problems.push(`topology.clab.yml: node ${name}: image must be ${ROUTER_IMAGE} or ${HOST_IMAGE}`);
    if (node.exec && node.image === ROUTER_IMAGE) {
      problems.push(`topology.clab.yml: node ${name}: routers are configured by frr.conf, not exec`);
    }
  }
  const endpoints = new Set<string>();
  for (const link of topology.topology.links) {
    for (const ep of link.endpoints) {
      const node = ep.split(":")[0] ?? "";
      if (!(node in topology.topology.nodes)) problems.push(`topology.clab.yml: link endpoint ${ep}: no such node`);
      if (endpoints.has(ep)) problems.push(`topology.clab.yml: endpoint ${ep} is used twice`);
      endpoints.add(ep);
    }
  }
  const routers = Object.keys(roles).filter((n) => roles[n] === "router");

  const seen = new Set<string>();
  for (const objective of meta.objectives) {
    if (seen.has(objective.id)) problems.push(`scenario.yaml: objective id ${objective.id} is used twice`);
    seen.add(objective.id);
    for (const [node, role] of ruleNodes(objective.rule)) {
      if (roles[node] !== role) problems.push(`scenario.yaml: objective ${objective.id}: ${node} is not a ${role}`);
    }
  }

  const configs: Scenario["configs"] = { baseline: {}, fault: {} };
  for (const variant of ["baseline", "fault", "workaround"] as const) {
    const vdir = join(dir, variant);
    if (!(await isDir(vdir))) {
      if (variant !== "workaround") problems.push(`${variant}/ is missing`);
      continue;
    }
    const set = await readConfigSet(vdir, problems, variant);
    for (const router of Object.keys(set)) {
      if (roles[router] !== "router") problems.push(`${variant}/${router}: not a router in the topology`);
    }
    configs[variant] = set;
  }
  for (const router of routers) {
    if (!configs.baseline[router]?.["frr.conf"]) problems.push(`baseline/${router}/frr.conf is missing`);
  }
  if (!differs(configs.baseline, configs.fault)) problems.push("fault/ must change at least one baseline file");
  if (configs.workaround) {
    const faulted = mergeSets(configs.baseline, configs.fault);
    if (!differs(faulted, configs.workaround)) problems.push("workaround/ must change at least one fault file");
  }

  if (problems.length) throw new ScenarioError(id, problems);
  return { dir, meta, topology, roles, configs };
}

function mergeSets(base: ConfigSet, overlay: ConfigSet): ConfigSet {
  const out: ConfigSet = structuredClone(base);
  for (const [router, files] of Object.entries(overlay)) out[router] = { ...out[router], ...files };
  return out;
}

/** The effective config of every router for a variant: baseline, then fault, then workaround. */
export function variantConfigs(scenario: Scenario, variant: Variant): ConfigSet {
  let set = scenario.configs.baseline;
  if (variant !== "baseline") set = mergeSets(set, scenario.configs.fault);
  if (variant === "workaround") {
    if (!scenario.configs.workaround) throw new Error(`${scenario.meta.id} has no workaround variant`);
    set = mergeSets(set, scenario.configs.workaround);
  }
  return set;
}

export async function listScenarioDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^[0-9]{2}-/.test(e.name))
    .map((e) => join(root, e.name))
    .sort();
}
