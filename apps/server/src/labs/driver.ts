import { rm } from "node:fs/promises";
import {
  Lab,
  type LabSummary,
  type ProbeOutput,
  type ProbeRunner,
  type Role,
  type RouterTerminal,
  type Scenario,
  type Variant,
  renderLab,
} from "@breakfix/scenario-kit";

/** What the session service needs from a running lab. The real one is backed by containerlab. */
export interface LabHandle extends ProbeRunner {
  readonly name: string;
  vtysh(router: string, command: string): Promise<ProbeOutput>;
  vtyshJson(router: string, commands: string[]): Promise<unknown[]>;
  hostStream(node: string, argv: string[], onData: (chunk: string) => void): Promise<number | null>;
  openTerminal(router: string, cols: number, rows: number): Promise<RouterTerminal>;
  waitForRouters(timeoutMs?: number): Promise<void>;
  destroy(): Promise<void>;
}

export interface LabDriver {
  deploy(scenario: Scenario, variant: Variant, labName: string): Promise<LabHandle>;
  attach(labName: string, roles: Record<string, Role>): Promise<LabHandle | undefined>;
  list(): Promise<LabSummary[]>;
  destroy(labName: string): Promise<void>;
}

/** Real labs: render to a temp dir, deploy through breakfix-clab, run commands through docker-guard. */
export const containerlabDriver: LabDriver = {
  async deploy(scenario, variant, labName) {
    const dir = await renderLab(scenario, variant, labName);
    try {
      return await Lab.deploy(dir);
    } finally {
      await rm(dir, { recursive: true, force: true }); // breakfix-clab copied what it needs
    }
  },
  attach: (labName, roles) => Lab.attach(labName, roles),
  list: () => Lab.list(),
  destroy: (labName) => Lab.destroyByName(labName),
};
