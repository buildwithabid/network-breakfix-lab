import { describe, expect, it } from "vitest";
import { Objective } from "../schema.js";
import { type ProbeRunner, checkObjectives } from "./engine.js";
import type { Probe } from "./rules.js";

const objectives = [
  { id: "a", description: "route a", rule: { type: "route-present", router: "r1", prefix: "10.0.1.0/24", protocol: "connected" } },
  { id: "b", description: "route b", rule: { type: "route-present", router: "r1", prefix: "10.0.2.0/24", protocol: "connected" } },
  { id: "c", description: "ping c", rule: { type: "reachability", from: "h1", to: "10.0.2.1" } },
].map((o) => Objective.parse(o));

describe("checkObjectives", () => {
  it("runs each distinct probe once and evaluates every objective", async () => {
    const calls: Probe[] = [];
    const runner: ProbeRunner = {
      run: (probe) => {
        calls.push(probe);
        if (probe.kind === "host") return Promise.resolve({ exitCode: 0, stdout: "1 received", stderr: "" });
        return Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ "10.0.1.0/24": [{ protocol: "connected", selected: true, installed: true }] }),
        });
      },
    };
    const results = await checkObjectives(objectives, runner);
    expect(calls).toHaveLength(2);
    expect(results.map((r) => [r.id, r.passed])).toEqual([["a", true], ["b", false], ["c", true]]);
    expect(results[0]?.probe).toEqual({ kind: "vtysh", node: "r1", command: "show ip route json" });
  });

  it("turns a failing probe into a failed objective instead of throwing", async () => {
    const runner: ProbeRunner = { run: () => Promise.reject(new Error("docker-guard: 403")) };
    const results = await checkObjectives(objectives, runner);
    expect(results.every((r) => !r.passed && r.detail.includes("docker-guard: 403"))).toBe(true);
  });
});
