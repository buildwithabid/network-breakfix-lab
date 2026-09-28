import { loadScenario } from "@breakfix/scenario-kit";
import { describe, expect, it } from "vitest";
import { type RouterPoll, buildModel, deriveTopoState, hostAddressing, inSubnet, packetPath, pollFromDocs } from "./network.js";

const s01 = await loadScenario(new URL("../../../../scenarios/01-wrong-ip-mask", import.meta.url).pathname);

const iface = (address: string, up = true) => ({ operationalStatus: up ? "up" : "down", ipAddresses: [{ address }] });
const connected = (ifname: string) => [{ protocol: "connected", selected: true, installed: true, nexthops: [{ interfaceName: ifname, active: true }] }];
const staticVia = (ip: string, ifname: string) => [{ protocol: "static", selected: true, installed: true, nexthops: [{ ip, interfaceName: ifname, active: true }] }];

function poll(interfaces: RouterPoll["interfaces"], routes: RouterPoll["routes"]): RouterPoll {
  return pollFromDocs([interfaces, { interfaces: {} }, { neighbors: {} }, {}, routes]);
}

const r1 = poll(
  { eth1: iface("10.0.1.1/24"), eth2: iface("10.0.12.1/30") },
  { "10.0.1.0/24": connected("eth1"), "10.0.12.0/30": connected("eth2"), "10.0.3.0/24": staticVia("10.0.12.2", "eth2") },
);
const r2Good = poll(
  { eth1: iface("10.0.12.2/30"), eth2: iface("10.0.3.1/24") },
  { "10.0.12.0/30": connected("eth1"), "10.0.3.0/24": connected("eth2"), "10.0.1.0/24": staticVia("10.0.12.1", "eth1") },
);
// the fault: /31 on the transit link, so the static route back to the branch is unusable
const r2Fault = poll(
  { eth1: iface("10.0.12.2/31"), eth2: iface("10.0.3.1/24") },
  { "10.0.12.2/31": connected("eth1"), "10.0.3.0/24": connected("eth2") },
);

describe("host addressing", () => {
  it("reads addresses and gateways from the topology exec lines", () => {
    const h = hostAddressing(s01.topology);
    expect(h.addresses.h1).toEqual({ eth1: ["10.0.1.10/24"] });
    expect(h.gateways).toEqual({ h1: "10.0.1.1", srv: "10.0.3.1" });
    expect(inSubnet("10.0.12.1", "10.0.12.2/31")).toBe(false);
    expect(inSubnet("10.0.12.1", "10.0.12.2/30")).toBe(true);
    expect(inSubnet("8.8.8.8", "0.0.0.0/0")).toBe(true);
  });
});

describe("packetPath", () => {
  it("follows the routing tables there and back", () => {
    const model = buildModel(s01.topology, s01.roles, { r1, r2: r2Good });
    const path = packetPath(model, "h1", "10.0.3.10");
    expect(path.forward).toEqual({
      delivered: true,
      hops: [{ node: "h1", link: "l0" }, { node: "r1", link: "l1" }, { node: "r2", link: "l2" }, { node: "srv" }],
    });
    expect(path.back?.delivered).toBe(true);
    expect(path.back?.hops.map((h) => h.node)).toEqual(["srv", "r2", "r1", "h1"]);
  });

  it("shows where the reply dies in the fault", () => {
    const model = buildModel(s01.topology, s01.roles, { r1, r2: r2Fault });
    const path = packetPath(model, "h1", "10.0.3.10");
    expect(path.forward.delivered).toBe(true); // r2 still answers ARP for 10.0.12.2
    expect(path.back).toMatchObject({ delivered: false, reason: "r2 has no route to 10.0.1.10" });
  });

  it("stops at a down interface, a missing route and a silent router", () => {
    const down = poll({ eth1: iface("10.0.1.1/24"), eth2: iface("10.0.12.1/30", false) }, r1.routes);
    expect(packetPath(buildModel(s01.topology, s01.roles, { r1: down, r2: r2Good }), "h1", "10.0.3.10").forward.reason).toBe("r1 eth2 is down");
    expect(packetPath(buildModel(s01.topology, s01.roles, { r1, r2: r2Good }), "h1", "192.0.2.1").forward.reason).toBe("r1 has no route to 192.0.2.1");
    expect(packetPath(buildModel(s01.topology, s01.roles, { r1 }), "h1", "10.0.3.10").forward.reason).toBe("r2 is not answering");
  });
});

describe("deriveTopoState", () => {
  it("reports routers, links and protocol state", () => {
    const withOspf = pollFromDocs([
      r1.interfaces,
      { interfaces: { eth2: {} } },
      { neighbors: { "2.2.2.2": [{ nbrState: "Full/-", ifaceName: "eth2:10.0.12.1" }] } },
      { ipv4Unicast: { peers: { "10.0.12.2": { state: "Established" } } } },
      r1.routes,
    ]);
    const r2Ospf = pollFromDocs([
      r2Good.interfaces,
      { interfaces: { eth1: {} } },
      { neighbors: { "1.1.1.1": [{ nbrState: "ExStart/-", ifaceName: "eth1:10.0.12.2" }] } },
      { ipv4Unicast: { peers: { "10.0.12.1": { state: "Active" } } } },
      r2Good.routes,
    ]);
    const state = deriveTopoState(buildModel(s01.topology, s01.roles, { r1: withOspf, r2: r2Ospf }));
    expect(state.nodes.r1).toEqual({ role: "router", up: true });
    expect(state.links.find((l) => l.id === "l1")).toEqual({ id: "l1", up: true, ospf: "forming" });
    expect(state.links.find((l) => l.id === "l0")?.ospf).toBeNull();
    expect(state.bgp).toEqual([{ a: "r1", b: "r2", peer: "10.0.12.2", state: "Active" }]);
  });
});
