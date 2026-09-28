import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_CAPS, ROUTER_CAPS } from "./constants.js";
import { loadScenario } from "./loader.js";
import { renderFiles } from "./render.js";

const S01 = new URL("../../../scenarios/01-wrong-ip-mask", import.meta.url).pathname;

describe("renderFiles", () => {
  it("adds config binds and the measured capabilities, and names the lab", async () => {
    const s = await loadScenario(S01);
    const { topology, files } = renderFiles(s, "fault", "bfx-t-unit");
    const nodes = (topology.topology as { nodes: Record<string, Record<string, unknown>> }).nodes;
    expect(topology.name).toBe("bfx-t-unit");
    expect(nodes.r1).toMatchObject({ binds: ["r1:/etc/frr"], "cap-add": [...ROUTER_CAPS] });
    expect(nodes.h1).toMatchObject({ "cap-add": [...HOST_CAPS] });
    expect(nodes.h1?.exec).toContain("ip addr add 10.0.1.10/24 dev eth1");
    expect(files["r2/frr.conf"]).toContain("10.0.12.2/31");
    expect(files["r1/frr.conf"]).toContain("10.0.12.1/30");
    expect(files["r1/daemons"]).toContain("ospfd=yes");
    expect(files["r1/vtysh.conf"]).toBe("service integrated-vtysh-config\n");
    expect(Object.keys(files).some((f) => f.startsWith("h1/"))).toBe(false);
  });

  it("uses exactly the capability sets the root-side policy allows", () => {
    const py = readFileSync(new URL("../../../infra/bfx_infra/policy.py", import.meta.url), "utf8");
    const block = (role: string) => {
      const m = new RegExp(`"${role}": frozenset\\(\\s*\\{([^}]*)\\}`, "m").exec(py);
      return [...(m?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]).sort();
    };
    expect([...ROUTER_CAPS].sort()).toEqual(block("router"));
    expect([...HOST_CAPS].sort()).toEqual(block("host"));
  });
});
