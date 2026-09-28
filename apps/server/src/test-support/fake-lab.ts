import { PassThrough } from "node:stream";
import type { LabSummary, Probe, ProbeOutput, Role, RouterTerminal, Scenario, Variant } from "@breakfix/scenario-kit";
import type { LabDriver, LabHandle } from "../labs/driver.js";

/** A lab that answers like FRR would, without containers. `healthy` decides the check results. */
export class FakeLab implements LabHandle {
  healthy = false;
  destroyed = false;
  vtyshCalls: string[] = [];
  config = "hostname r1\n!\ninterface eth1\n ip address 10.0.12.2/31\nexit\n";

  constructor(readonly name: string, readonly roles: Record<string, Role>) {}

  async vtysh(router: string, command: string): Promise<ProbeOutput> {
    this.vtyshCalls.push(`${router}: ${command}`);
    if (command === "show running-config") return { exitCode: 0, stdout: `Building configuration...\n\nCurrent configuration:\n${this.config}`, stderr: "" };
    if (command === "show ip route json") {
      const routes = this.healthy
        ? {
            "10.0.12.0/30": [{ protocol: "connected", selected: true, installed: true }],
            "10.0.1.0/24": [{ protocol: "static", selected: true, installed: true, nexthops: [{ ip: "10.0.12.1", active: true }] }],
          }
        : {};
      return { exitCode: 0, stdout: JSON.stringify(routes), stderr: "" };
    }
    return { exitCode: 0, stdout: "{}", stderr: "" };
  }

  async vtyshJson(router: string, commands: string[]): Promise<unknown[]> {
    this.vtyshCalls.push(`${router}: ${commands.join(" | ")}`);
    return commands.map((c) => (c === "show interface json" ? { eth1: { operationalStatus: "up", ipAddresses: [{ address: "10.0.12.1/30" }] } } : {}));
  }

  async run(probe: Probe): Promise<ProbeOutput> {
    if (probe.kind === "vtysh") return this.vtysh(probe.node, probe.command);
    const ok = this.healthy;
    return { exitCode: ok ? 0 : 1, stdout: `3 packets transmitted, ${ok ? 3 : 0} received`, stderr: "" };
  }

  async hostStream(_node: string, argv: string[], onData: (chunk: string) => void): Promise<number | null> {
    onData(`ran ${argv.join(" ")}\n`);
    return 0;
  }

  /** A terminal that echoes like readline and prints a prompt after Enter. */
  async openTerminal(router: string): Promise<RouterTerminal> {
    const output = new PassThrough();
    const stream = Object.assign(output, {
      write: (data: string) => {
        for (const ch of data) output.push(ch === "\r" ? `\r\n${router}# ` : ch);
        return true;
      },
    }) as unknown as RouterTerminal["stream"];
    setTimeout(() => output.push(`${router}# `), 5);
    return { stream, resize: async () => undefined, close: () => output.end() };
  }

  async waitForRouters(): Promise<void> {}

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

export class FakeDriver implements LabDriver {
  labs = new Map<string, FakeLab>();
  failDeploy = false;
  deployDelayMs = 0;
  healthy = false;

  async deploy(scenario: Scenario, _variant: Variant, labName: string): Promise<LabHandle> {
    if (this.deployDelayMs) await new Promise((r) => setTimeout(r, this.deployDelayMs));
    if (this.failDeploy) throw new Error("deploy failed");
    const lab = new FakeLab(labName, scenario.roles);
    lab.healthy = this.healthy;
    this.labs.set(labName, lab);
    return lab;
  }

  async attach(labName: string): Promise<LabHandle | undefined> {
    const lab = this.labs.get(labName);
    return lab && !lab.destroyed ? lab : undefined;
  }

  async list(): Promise<LabSummary[]> {
    return [...this.labs.values()]
      .filter((l) => !l.destroyed)
      .map((l) => ({ lab: l.name, created: Math.floor(Date.now() / 1000), nodes: [] }));
  }

  async destroy(labName: string): Promise<void> {
    const lab = this.labs.get(labName);
    if (lab) lab.destroyed = true;
  }
}

export const quietLog = { info() {}, warn() {}, error() {} };
