import { describe, expect, it } from "vitest";
import { layoutNodes } from "./layout.js";

const link = (a: string, b: string, i: number) => ({ id: `l${i}`, a: { node: a, iface: "eth1" }, b: { node: b, iface: "eth1" } });

describe("layoutNodes", () => {
  it("lays a chain out left to right from the first host", () => {
    const links = [link("h1", "r1", 0), link("r1", "r2", 1), link("r2", "srv", 2)];
    expect(layoutNodes(["r1", "r2", "h1", "srv"], links, {}, "h1")).toEqual({ h1: [0, 0], r1: [2, 0], r2: [4, 0], srv: [6, 0] });
  });

  it("stacks branches and keeps explicit positions", () => {
    const links = [link("h1", "r1", 0), link("r1", "r2", 1), link("r2", "srv", 2), link("r2", "web", 3)];
    const pos = layoutNodes(["h1", "r1", "r2", "srv", "web"], links, { h1: [0, 1] }, "h1");
    expect(pos.h1).toEqual([0, 1]);
    expect(pos.srv?.[0]).toBe(pos.web?.[0]);
    expect(pos.srv?.[1]).not.toBe(pos.web?.[1]);
  });
});
