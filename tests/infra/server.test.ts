import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lab, loadScenario } from "@breakfix/scenario-kit";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadConfig } from "../../apps/server/src/config.js";
import { Store } from "../../apps/server/src/db/store.js";
import { COOKIE, buildApp } from "../../apps/server/src/http/app.js";
import { createLogger } from "../../apps/server/src/http/logger.js";
import { containerlabDriver } from "../../apps/server/src/labs/driver.js";
import { SessionService } from "../../apps/server/src/sessions/service.js";

/**
 * The whole server against a real lab (scenario 01): start from a test link, try to break out of
 * vtysh and the host console, fix the fault through the terminal, submit, and read the results.
 */
type Msg = { t: string; node?: string; data?: string; [k: string]: unknown };

let dir = "";
let app: FastifyInstance;
let service: SessionService;
let store: Store;
let base = "";
let cookie = "";
let sessionId = "";
let ws: WebSocket;
const messages: Msg[] = [];

const waitFor = async (check: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const output = (node: string) => messages.filter((m) => m.t === "out" && m.node === node).map((m) => m.data).join("");
const send = (msg: object) => ws.send(JSON.stringify(msg));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bfx-server-"));
  const config = loadConfig({
    DB_PATH: join(dir, "db.sqlite"),
    SCENARIOS_DIR: new URL("../../scenarios", import.meta.url).pathname,
    WEB_DIST: "/nonexistent",
    PUBLIC_URL: "http://127.0.0.1",
    POLL_INTERVAL_MS: "2000",
    LOG_LEVEL: "warn",
  });
  const s01 = await loadScenario(join(config.SCENARIOS_DIR, "01-wrong-ip-mask"));
  const scenarios = new Map([[s01.meta.id, s01]]);
  store = new Store(config.DB_PATH);
  const logger = createLogger(config);
  service = new SessionService({ store, driver: containerlabDriver, scenarios, maxConcurrent: 2, pollIntervalMs: 2000, log: logger });
  app = await buildApp({ config, service, store, scenarios, logger });
  base = await app.listen({ port: 0, host: "127.0.0.1" });

  const { token } = service.createTestLink("01-wrong-ip-mask");
  const res = await fetch(`${base}/api/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  expect(res.status).toBe(200);
  sessionId = ((await res.json()) as { sessionId: string }).sessionId;
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie.startsWith(`${COOKIE}=`)).toBe(true);
  await waitFor(() => service.view(sessionId)?.state === "running", 120_000, "the lab to start");

  ws = new WebSocket(`${base.replace("http", "ws")}/api/session/ws`, { headers: { cookie, origin: "http://127.0.0.1" } });
  ws.on("message", (m) => messages.push(JSON.parse(String(m)) as Msg));
  await new Promise((r) => ws.on("open", r));
}, 180_000);

afterAll(async () => {
  ws?.close();
  const lab = store?.session(sessionId)?.lab_name;
  service?.close();
  await app?.close();
  if (lab && (await Lab.list()).some((l) => l.lab === lab)) await Lab.destroyByName(lab);
  store?.close();
  await rm(dir, { recursive: true, force: true });
}, 120_000);

describe("server with a real lab", () => {
  it("streams the live topology state", async () => {
    await waitFor(() => messages.some((m) => m.t === "topo"), 20_000, "topology state");
    const topo = messages.findLast((m) => m.t === "topo")?.state as { nodes: Record<string, { up: boolean }>; links: { id: string; up: boolean }[] };
    expect(topo.nodes.r1?.up).toBe(true);
    expect(topo.links.every((l) => l.up)).toBe(true);
  });

  it("gives vtysh, never a shell", async () => {
    send({ t: "open", node: "r1", cols: 120, rows: 40 });
    await waitFor(() => output("r1").includes("r1# "), 20_000, "the r1 prompt");
    for (const line of [
      "start-shell",
      "start-shell bash",
      "terminal paginate",
      "show running-config",
      "!sh",
      "ssh root@10.0.1.10",
      "telnet 10.0.1.10",
      "echo PWNED-$((6*7))",
      "show version",
    ]) {
      send({ t: "in", node: "r1", data: `${line}\r` });
      await new Promise((r) => setTimeout(r, 400));
    }
    await waitFor(() => output("r1").includes("FRRouting (version 10.7.1"), 10_000, "show version");
    const text = output("r1");
    expect(text).not.toContain("PWNED-42");
    expect(text).not.toMatch(/uid=\d+/);
    expect(text).toContain("% Unknown command: start-shell");
  });

  it("host console: only whitelisted commands, and no internet", async () => {
    send({ t: "open", node: "h1", cols: 120, rows: 40 });
    await waitFor(() => output("h1").includes("h1$ "), 10_000, "the h1 prompt");
    for (const line of ["sh", "ping 1.1.1.1; id", "ip addr add 10.0.1.99/24 dev eth1", "cat /etc/shadow"]) {
      send({ t: "line", node: "h1", line });
    }
    send({ t: "line", node: "h1", line: "ping -c 1 1.1.1.1" });
    await waitFor(() => /1 packets transmitted, 0 received/.test(output("h1")), 20_000, "the internet ping to fail");
    expect(output("h1")).not.toMatch(/uid=\d+|root:/);
  });

  it("the candidate fixes the fault in r2's CLI and the ping works, with its path", async () => {
    send({ t: "open", node: "r2", cols: 120, rows: 40 });
    await waitFor(() => output("r2").includes("r2# "), 20_000, "the r2 prompt");
    send({ t: "in", node: "r2", data: "configure terminal\rinterface eth1\rno ip address 10.0.12.2/31\rip address 10.0.12.2/30\rend\rwrite memory\r" });
    await waitFor(() => output("r2").includes("[OK]"), 20_000, "write memory");
    await new Promise((r) => setTimeout(r, 4500)); // let the poller see the fix
    const before = messages.length;
    send({ t: "line", node: "h1", line: "ping -c 2 10.0.3.10" });
    await waitFor(() => /2 packets transmitted, 2 received/.test(output("h1")), 20_000, "the ping to the server");
    const path = messages.slice(before).find((m) => m.t === "path")?.path as { forward: { delivered: boolean; hops: { node: string }[] }; back?: { delivered: boolean } };
    expect(path.forward.hops.map((h) => h.node)).toEqual(["h1", "r1", "r2", "srv"]);
    expect(path.forward.delivered && path.back?.delivered).toBe(true);
  });

  it("submit: checks pass, commands and the config diff are recorded, the lab is gone", async () => {
    send({ t: "submit" });
    await waitFor(() => service.view(sessionId)?.state === "finished", 120_000, "the check");
    const res = await fetch(`${base}/api/session/results`, { headers: { cookie } });
    const results = (await res.json()) as {
      passed: number;
      total: number;
      commands: Record<string, { command: string }[]>;
      configs: { node: string; diff: string }[];
    };
    expect(results.passed).toBe(results.total);
    const r2 = results.commands.r2?.map((c) => c.command) ?? [];
    expect(r2).toEqual(expect.arrayContaining(["configure terminal", "interface eth1", "no ip address 10.0.12.2/31", "ip address 10.0.12.2/30", "end", "write memory"]));
    expect(results.commands.r1?.map((c) => c.command)).toContain("start-shell");
    const all = Object.values(results.commands).flat().map((c) => c.command).join("\n");
    expect(all).not.toMatch(/show interface json|show ip ospf interface json|show ip ospf neighbor json|show bgp summary json|show ip route json/);
    expect(results.configs.find((c) => c.node === "r2")?.diff).toMatch(/\+ ip address 10\.0\.12\.2\/30/);
    const lab = store.session(sessionId)?.lab_name ?? "";
    expect((await Lab.list()).some((l) => l.lab === lab)).toBe(false);
  });
});
