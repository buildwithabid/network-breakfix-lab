import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { newLabName } from "@breakfix/scenario-kit";
import { describe, expect, it } from "vitest";
import { type Topology, clab, prepareLab, removeDir } from "./helpers.js";

type Edit = (topo: Topology, dir: string) => Promise<void> | void;

const r1 = (t: Topology) => t.topology.nodes.r1 as Record<string, unknown>;
const h1 = (t: Topology) => t.topology.nodes.h1 as Record<string, unknown>;

const refusals: [string, Edit][] = [
  ["privileged node", (t) => void (r1(t).privileged = true)],
  ["host network", (t) => void (r1(t)["network-mode"] = "host")],
  ["bind of the host root", (t) => void (r1(t).binds = ["/:/host"])],
  ["bind of the Docker socket", (t) => void (r1(t).binds = ["/run/docker.sock:/run/docker.sock"])],
  [
    "config file that is a symlink to /etc/shadow",
    async (_t, dir) => {
      await rm(join(dir, "r1/frr.conf"));
      await symlink("/etc/shadow", join(dir, "r1/frr.conf"));
    },
  ],
  ["image that is not pinned", (t) => void (r1(t).image = "alpine:3")],
  ["exec on a router", (t) => void (r1(t).exec = ["ip link set eth1 up"])],
  ["shell exec on a host", (t) => void (h1(t).exec = ["sh -c id"])],
  ["capability outside the allowlist", (t) => void (r1(t)["cap-add"] = ["SYS_MODULE"])],
  ["custom entrypoint", (t) => void (r1(t).entrypoint = "/bin/sh")],
];

describe("breakfix-clab refuses labs outside the policy", () => {
  it.each(refusals)("%s", async (_label, edit) => {
    const name = newLabName("t", "refuse");
    const dir = await prepareLab("lab-basic", name, edit);
    try {
      const res = await clab(["deploy", dir]);
      expect(res.code, JSON.stringify(res.json)).toBe(2);
      expect(res.json.refused).toBe(true);
      const list = await clab(["list"]);
      expect(JSON.stringify(list.json)).not.toContain(name);
    } finally {
      await removeDir(dir);
    }
  });

  it("refuses lab names outside bfx-*", async () => {
    const dir = await prepareLab("lab-basic", "prod");
    try {
      expect((await clab(["deploy", dir])).code).toBe(2);
    } finally {
      await removeDir(dir);
    }
    for (const name of ["../../etc", "prod", "bfx-t-x/../../etc"]) {
      expect((await clab(["destroy", name])).code, name).toBe(2);
    }
  });

  it("rejects unknown sub-commands", async () => {
    expect((await clab(["exec", "sh"])).code).toBe(1);
    expect((await clab([])).code).toBe(1);
  });
});
