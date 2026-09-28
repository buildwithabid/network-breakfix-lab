import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Rule } from "../schema.js";
import { type ProbeOutput, evaluate, probeFor } from "./rules.js";

/** Real `vtysh -c ... json` output captured from FRR 10.7.1 (two routers, OSPF + eBGP). */
function fixture(name: string): ProbeOutput {
  const stdout = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
  return { exitCode: 0, stdout, stderr: "" };
}
const rule = (r: unknown) => Rule.parse(r);

describe("route-present", () => {
  const healthy = fixture("healthy.route");
  const broken = fixture("broken.route");

  it("passes for a selected route of the required protocol", () => {
    expect(evaluate(rule({ type: "route-present", router: "r1", prefix: "10.0.12.0/30", protocol: "connected" }), healthy).passed).toBe(true);
    expect(evaluate(rule({ type: "route-present", router: "r1", prefix: "2.2.2.2/32", protocol: "ospf" }), healthy)).toEqual({
      passed: true,
      detail: "r1 → 2.2.2.2/32: ospf",
    });
    expect(evaluate(rule({ type: "route-present", router: "r1", prefix: "10.99.2.0/24", protocol: "bgp", nexthop: "10.0.12.2" }), healthy).passed).toBe(true);
  });

  it("fails when the route is missing", () => {
    const v = evaluate(rule({ type: "route-present", router: "r1", prefix: "2.2.2.2/32", protocol: "ospf" }), broken);
    expect(v).toEqual({ passed: false, detail: "r1 → 2.2.2.2/32: no route" });
  });

  it("fails when the prefix is reached by another protocol (the static-route workaround)", () => {
    const v = evaluate(rule({ type: "route-present", router: "r1", prefix: "172.16.1.0/24", protocol: "ospf" }), healthy);
    expect(v).toEqual({ passed: false, detail: "r1 → 172.16.1.0/24: learned via static, expected ospf" });
  });

  it("checks the next hop when one is given", () => {
    const v = evaluate(rule({ type: "route-present", router: "r1", prefix: "10.99.2.0/24", protocol: "bgp", nexthop: "10.0.12.9" }), healthy);
    expect(v.passed).toBe(false);
    expect(v.detail).toContain("via 10.0.12.2, expected next hop 10.0.12.9");
  });

  it("fails a route that exists but is not installed", () => {
    const out = { exitCode: 0, stderr: "", stdout: JSON.stringify({ "10.0.1.0/24": [{ protocol: "static", selected: false, installed: false, nexthops: [{ ip: "10.0.12.1", active: false }] }] }) };
    const v = evaluate(rule({ type: "route-present", router: "r2", prefix: "10.0.1.0/24", protocol: "static" }), out);
    expect(v).toEqual({ passed: false, detail: "r2 → 10.0.1.0/24: static route exists but is not in use" });
  });

  it("does not match a longer or shorter prefix", () => {
    expect(evaluate(rule({ type: "route-present", router: "r1", prefix: "10.0.12.0/24", protocol: "connected" }), healthy).passed).toBe(false);
  });
});

describe("ospf-neighbor", () => {
  it("passes on Full and fails when the neighbour is absent", () => {
    const r = rule({ type: "ospf-neighbor", router: "r1", neighbor: "2.2.2.2" });
    expect(evaluate(r, fixture("healthy.ospf-neighbor"))).toEqual({ passed: true, detail: "r1: OSPF neighbour 2.2.2.2 is Full/-" });
    expect(evaluate(r, fixture("broken.ospf-neighbor"))).toEqual({ passed: false, detail: "r1: OSPF neighbour 2.2.2.2 not seen" });
  });

  it("does not accept a stuck adjacency as Full", () => {
    const out = { exitCode: 0, stderr: "", stdout: JSON.stringify({ neighbors: { "2.2.2.2": [{ nbrState: "ExStart/-" }] } }) };
    expect(evaluate(rule({ type: "ospf-neighbor", router: "r1", neighbor: "2.2.2.2" }), out).passed).toBe(false);
  });
});

describe("bgp-session", () => {
  const r = rule({ type: "bgp-session", router: "r1", peer: "10.0.12.2" });
  it("passes when Established, fails when Idle or not configured", () => {
    expect(evaluate(r, fixture("healthy.bgp-summary")).passed).toBe(true);
    expect(evaluate(r, fixture("broken.bgp-summary"))).toEqual({ passed: false, detail: "r1: BGP peer 10.0.12.2 is Idle" });
    const other = rule({ type: "bgp-session", router: "r1", peer: "10.0.12.9" });
    expect(evaluate(other, fixture("healthy.bgp-summary")).detail).toContain("not configured");
  });
});

describe("prefix-received", () => {
  const r = rule({ type: "prefix-received", router: "r1", peer: "10.0.12.2", prefix: "10.99.2.0/24" });
  it("passes when a valid path from that peer exists", () => {
    expect(evaluate(r, fixture("healthy.bgp-prefix-10.99.2.0")).passed).toBe(true);
    expect(evaluate(r, fixture("broken.bgp-prefix-10.99.2.0")).detail).toContain("not received");
  });
  it("ignores the same prefix from another peer", () => {
    const other = rule({ type: "prefix-received", router: "r1", peer: "10.0.13.2", prefix: "10.99.2.0/24" });
    expect(evaluate(other, fixture("healthy.bgp-prefix-10.99.2.0")).passed).toBe(false);
  });
});

describe("reachability", () => {
  const r = rule({ type: "reachability", from: "h1", to: "10.0.3.10" });
  it("reads ping's summary line", () => {
    const ok = { exitCode: 0, stderr: "", stdout: "3 packets transmitted, 3 received, 0% packet loss, time 2003ms" };
    const lost = { exitCode: 1, stderr: "", stdout: "3 packets transmitted, 0 received, +3 errors, 100% packet loss" };
    expect(evaluate(r, ok)).toEqual({ passed: true, detail: "h1 → 10.0.3.10: 3/3 replies" });
    expect(evaluate(r, lost)).toEqual({ passed: false, detail: "h1 → 10.0.3.10: 0/3 replies" });
  });
});

describe("probes", () => {
  it("only produce commands docker-guard allows", () => {
    const show = /^show [A-Za-z0-9 .:/_-]{1,200}$/;
    for (const r of [
      { type: "route-present", router: "r1", prefix: "10.0.0.0/8", protocol: "static" },
      { type: "ospf-neighbor", router: "r1", neighbor: "1.1.1.1" },
      { type: "bgp-session", router: "r1", peer: "10.0.0.1" },
      { type: "prefix-received", router: "r1", peer: "10.0.0.1", prefix: "10.0.0.0/8" },
    ]) {
      const probe = probeFor(rule(r));
      expect(probe.kind === "vtysh" && show.test(probe.command)).toBe(true);
    }
    expect(probeFor(rule({ type: "reachability", from: "h1", to: "10.0.0.1", count: 10 }))).toEqual({
      kind: "host",
      node: "h1",
      argv: ["ping", "-c", "10", "-W", "1", "10.0.0.1"],
    });
  });
  it("broken or empty output fails with a readable reason", () => {
    const v = evaluate(rule({ type: "bgp-session", router: "r1", peer: "10.0.0.1" }), { exitCode: 1, stdout: "% bgpd is not running", stderr: "" });
    expect(v).toEqual({ passed: false, detail: "r1 did not answer (routing daemons down?)", indeterminate: true });
  });
});
