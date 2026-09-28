import { describe, expect, it } from "vitest";
import { CommandCapture } from "./command-capture.js";

function capture() {
  const commands: [string, string][] = [];
  const c = new CommandCapture(80, 24, (cmd, mode) => commands.push([cmd, mode]));
  return { c, commands };
}

describe("CommandCapture", () => {
  it("records the line on screen when Enter is echoed", async () => {
    const { c, commands } = capture();
    c.output("r1# ");
    c.input("show ip ro");
    c.output("show ip ro");
    c.input("\t");
    c.output("ute "); // tab completion happens inside vtysh
    c.input("\r");
    c.output("\r\nCodes: K - kernel route, C - connected\r\nC>* 10.0.1.0/24 is directly connected\r\nr1# ");
    await c.flush();
    expect(commands).toEqual([["show ip route", "exec"]]);
  });

  it("uses the recalled history line, not the arrow keystrokes", async () => {
    const { c, commands } = capture();
    c.output("r1# ");
    c.input("\x1b[A");
    c.output("show running-config");
    c.input("\r");
    c.output("\r\nBuilding configuration...\r\nr1# ");
    await c.flush();
    expect(commands).toEqual([["show running-config", "exec"]]);
  });

  it("handles pasted lines and config modes, ignoring command output", async () => {
    const { c, commands } = capture();
    c.output("r2# ");
    c.input("configure terminal\rinterface eth1\rip address 10.0.12.2/30\rend\r");
    c.output("configure terminal\r\nr2(config)# interface eth1\r\nr2(config-if)# ip address 10.0.12.2/30\r\n");
    c.output("r2(config-if)# end\r\nr2# ");
    await c.flush();
    expect(commands).toEqual([
      ["configure terminal", "exec"],
      ["interface eth1", "config"],
      ["ip address 10.0.12.2/30", "config-if"],
      ["end", "config-if"],
    ]);
  });

  it("skips empty lines and handles commands longer than the terminal width", async () => {
    const { c, commands } = capture();
    const long = `show bgp ipv4 unicast neighbors 10.0.12.2 advertised-routes ${"x".repeat(40)}`;
    c.output("r1# ");
    c.input("\r");
    c.output("\r\nr1# ");
    c.input(`${long}\r`);
    c.output(`${long}\r\n% Unknown command\r\nr1# `);
    await c.flush();
    expect(commands).toEqual([[long, "exec"]]);
  });
});
