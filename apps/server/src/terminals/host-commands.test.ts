import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseHostCommand } from "./host-commands.js";

describe("parseHostCommand", () => {
  it.each([
    ["ping 10.0.3.10", ["ping", "-c", "4", "-W", "1", "10.0.3.10"]],
    ["ping -c 2 10.0.3.10", ["ping", "-c", "2", "-W", "1", "10.0.3.10"]],
    ["traceroute 10.0.3.10", ["traceroute", "-n", "-w", "1", "-q", "1", "-m", "15", "10.0.3.10"]],
    ["ip a", ["ip", "addr"]],
    ["ip -br addr show", ["ip", "-br", "addr"]],
    ["ip route show dev eth1", ["ip", "route", "show", "dev", "eth1"]],
    ["ip route get 10.0.3.10", ["ip", "route", "get", "10.0.3.10"]],
    ["  ip   neigh  ", ["ip", "neigh"]],
  ])("%s", (line, argv) => {
    expect(parseHostCommand(line)).toMatchObject({ ok: true, argv });
  });

  it.each([
    "sh",
    "bash -i",
    "ping 10.0.3.10; sh",
    "ping $(id)",
    "ping `id`",
    "ping 10.0.3.10 | nc x 1",
    "ping -c 100 10.0.3.10",
    "ping -f 10.0.3.10",
    "ping example.com",
    "ping 10.0.3.10 10.0.3.11",
    "traceroute -I 10.0.3.10",
    "ip addr add 10.0.1.99/24 dev eth1",
    "ip route add default via 10.0.1.1",
    "ip link set eth1 down",
    "ip route flush all",
    "ip netns exec x sh",
    "ip -b /etc/passwd",
    "cat /etc/shadow",
    "busybox sh",
    "ping 10.0.3.10 && id",
    "ping\t10.0.3.10",
  ])("refuses %j", (line) => {
    expect(parseHostCommand(line).ok).toBe(false);
  });

  it("only produces commands docker-guard also accepts (checked with the Python policy)", () => {
    const lines = ["ping 10.0.3.10", "ping -c 10 -W 5 -s 1472 -n -4 10.0.3.10", "traceroute 10.0.3.10", "traceroute -n -w 5 -q 3 -m 30 10.0.3.10",
      "ip a", "ip -4 -br route show dev eth2", "ip route get 10.0.3.10", "ip -j link", "ip neigh show"];
    const argvs = lines.map((l) => {
      const parsed = parseHostCommand(l);
      if (!parsed.ok) throw new Error(`${l}: ${parsed.error}`);
      return parsed.argv;
    });
    const script = [
      "import json, sys",
      "sys.path.insert(0, 'infra')",
      "from bfx_infra.policy import check_host_command",
      "for argv in json.load(sys.stdin): check_host_command(argv)",
      "print('ok')",
    ].join("\n");
    const root = new URL("../../../../", import.meta.url).pathname;
    expect(execFileSync("python3", ["-c", script], { cwd: root, input: JSON.stringify(argvs), encoding: "utf8" }).trim()).toBe("ok");
  });
});
