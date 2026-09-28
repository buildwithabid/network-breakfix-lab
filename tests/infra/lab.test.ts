import { readFileSync } from "node:fs";
import { newLabName } from "@breakfix/scenario-kit";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clab, execIn, guardDocker, prepareLab, removeDir } from "./helpers.js";

const MIB = 1024 * 1024;
const name = newLabName("t", "infra");
const r1 = `clab-${name}-r1`;
const h1 = `clab-${name}-h1`;
let dir = "";
let docker: Docker;

beforeAll(async () => {
  dir = await prepareLab("lab-basic", name);
  const res = await clab(["deploy", dir]);
  expect(res.code, JSON.stringify(res.json)).toBe(0);
  docker = guardDocker();
});

afterAll(async () => {
  const res = await clab(["destroy", name]);
  expect(res.code, JSON.stringify(res.json)).toBe(0);
  await removeDir(dir);
  const list = await clab(["list"]);
  expect(JSON.stringify(list.json)).not.toContain(name);
});

describe("a lab deployed through breakfix-clab", () => {
  it("is listed with both nodes", async () => {
    const list = (await clab(["list"])).json as unknown as { lab: string; nodes: unknown[] }[];
    expect(list.find((l) => l.lab === name)?.nodes).toHaveLength(2);
  });

  it.each([
    ["r1", { caps: 8, memory: 256 * MIB, pids: 256 }],
    ["h1", { caps: 2, memory: 64 * MIB, pids: 64 }],
  ] as const)("hardens %s: no privileged, CapDrop ALL, no network, limits", async (node, want) => {
    const info = await docker.getContainer(`clab-${name}-${node}`).inspect();
    const hc = info.HostConfig;
    expect(hc.Privileged).toBe(false);
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd).toHaveLength(want.caps);
    expect(hc.CapAdd).not.toContain("SYS_MODULE");
    expect(hc.NetworkMode).toBe("none");
    expect(hc.SecurityOpt).toContain("no-new-privileges");
    expect(hc.Memory).toBe(want.memory);
    expect(hc.PidsLimit).toBe(want.pids);
    expect(hc.RestartPolicy?.Name).toBe("no");
  });

  it("runs inside breakfix.slice, as an unprivileged host user", async () => {
    for (const container of [r1, h1]) {
      const pid = (await docker.getContainer(container).inspect()).State.Pid;
      expect(readFileSync(`/proc/${pid}/cgroup`, "utf8")).toContain("/breakfix.slice/");
      const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
      expect(Number(uid)).toBeGreaterThan(0); // root in the container is not root on the host
    }
  });

  it("runs FRRouting 10.7.1 with the configured address", async () => {
    const version = await execIn(docker, r1, ["vtysh", "-c", "show version"]);
    expect(version.stdout).toContain("FRRouting 10.7.1");
    const routes = await execIn(docker, r1, ["vtysh", "-c", "show ip route json"]);
    const table = JSON.parse(routes.stdout) as Record<string, { protocol: string }[]>;
    expect(table["10.0.1.0/24"]?.[0]?.protocol).toBe("connected");
  });

  it("saves the config cleanly with write memory", async () => {
    const res = await execIn(docker, r1, ["vtysh"], "write memory\nexit\n");
    expect(res.stdout).toContain("[OK]");
    expect(res.stdout).not.toMatch(/Error|failed|can't/i);
  });

  it("wires the link: the host reaches its gateway", async () => {
    const ping = await execIn(docker, h1, ["ping", "-c", "2", "-W", "2", "10.0.1.1"]);
    expect(ping.exitCode, ping.stdout + ping.stderr).toBe(0);
  });

  it("has no path to the internet", async () => {
    const links = JSON.parse((await execIn(docker, h1, ["ip", "-j", "link"])).stdout) as { ifname: string }[];
    expect(links.map((l) => l.ifname).sort()).toEqual(["eth1", "lo"]);
    const routes = JSON.parse((await execIn(docker, r1, ["vtysh", "-c", "show ip route json"])).stdout);
    expect(Object.keys(routes)).not.toContain("0.0.0.0/0");
    const ping = await execIn(docker, h1, ["ping", "-c", "1", "-W", "2", "1.1.1.1"]);
    expect(ping.exitCode).not.toBe(0);
  });

  it("refuses shells through the guard", async () => {
    for (const [container, cmd] of [
      [r1, ["sh"]],
      [r1, ["vtysh", "-c", "start-shell"]],
      [h1, ["sh", "-c", "id"]],
      [h1, ["cat", "/etc/shadow"]],
    ] as const) {
      await expect(docker.getContainer(container).exec({ Cmd: [...cmd] })).rejects.toMatchObject({
        statusCode: 403,
      });
    }
  });
});
