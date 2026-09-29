import { Writable } from "node:stream";
import { type Scenario, loadScenario } from "@breakfix/scenario-kit";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type Config, loadConfig } from "../config.js";
import { Store } from "../db/store.js";
import { SessionService } from "../sessions/service.js";
import { FakeDriver, quietLog } from "../test-support/fake-lab.js";
import { COOKIE, buildApp } from "./app.js";
import { createLogger, redactUrl } from "./logger.js";

const s01: Scenario = await loadScenario(new URL("../../../../scenarios/01-wrong-ip-mask", import.meta.url).pathname);
const apps: FastifyInstance[] = [];
const services: SessionService[] = [];

async function setup(env: Record<string, string> = {}) {
  const config: Config = loadConfig({ START_RATE_LIMIT: "3", WEB_DIST: "/nonexistent", ...env });
  const store = new Store(":memory:");
  const driver = new FakeDriver();
  const scenarios = new Map([[s01.meta.id, s01]]);
  const service = new SessionService({ store, driver, scenarios, maxConcurrent: 5, pollIntervalMs: 60_000, log: quietLog });
  const lines: string[] = [];
  const logger = createLogger(config, new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }));
  const app = await buildApp({ config, service, store, scenarios, logger });
  apps.push(app);
  services.push(service);
  return { app, service, store, driver, lines };
}

afterEach(async () => {
  for (const s of services.splice(0)) s.close();
  for (const a of apps.splice(0)) await a.close();
});

async function startSession(app: FastifyInstance, service: SessionService, authorization?: string) {
  const { token } = service.createTestLink("01-wrong-ip-mask");
  const res = await app.inject({ method: "POST", url: "/api/start", payload: { token }, headers: authorization ? { authorization } : {} });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === COOKIE);
  if (!cookie) throw new Error("no cookie");
  return { token, cookie, header: `${COOKIE}=${cookie.value}`, sessionId: (res.json() as { sessionId: string }).sessionId };
}

describe("HTTP API", () => {
  it("starts a session with an HttpOnly, SameSite=Strict cookie and a single-use link", async () => {
    const { app, service } = await setup();
    const { cookie, header, token } = await startSession(app, service);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
    const view = await app.inject({ url: "/api/session", headers: { cookie: header } });
    expect(view.json()).toMatchObject({ scenario: { id: "01-wrong-ip-mask" } });
    const again = await app.inject({ method: "POST", url: "/api/start", payload: { token } });
    expect(again.statusCode).toBe(409);
  });

  it("previews a link without using it up", async () => {
    const { app, service } = await setup();
    const { token } = service.createTestLink("01-wrong-ip-mask");
    const preview = await app.inject({ method: "POST", url: "/api/preview", payload: { token } });
    expect(preview.json()).toEqual({ title: "Branch cannot reach the file server", difficulty: "easy", timeLimitMinutes: 20, devices: 4 });
    expect((await app.inject({ method: "POST", url: "/api/start", payload: { token } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/preview", payload: { token } })).statusCode).toBe(409);
  });

  it("refuses requests without a valid session", async () => {
    const { app, service } = await setup();
    const { sessionId } = await startSession(app, service);
    for (const cookie of [undefined, `${COOKIE}=garbage`, `${COOKIE}=${sessionId}.${"A".repeat(43)}`]) {
      const res = await app.inject({ url: "/api/session", headers: cookie ? { cookie } : {} });
      expect(res.statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/api/start", payload: { token: "nope" } })).statusCode).toBe(404);
  });

  it("rate-limits session starts per IP", async () => {
    const { app } = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: "POST", url: "/api/start", payload: { token: "x" } })).statusCode);
    expect(codes).toEqual([404, 404, 404, 429, 429]);
  });

  it("sends security headers", async () => {
    const { app } = await setup();
    const res = await app.inject({ url: "/healthz" });
    expect(res.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("puts the whole site behind basic auth when configured", async () => {
    const { app } = await setup({ BASIC_AUTH_USER: "review", BASIC_AUTH_PASSWORD: "correct-horse-battery" });
    expect((await app.inject({ url: "/api/session" })).statusCode).toBe(401);
    const bad = Buffer.from("review:wrong-password-here").toString("base64");
    expect((await app.inject({ url: "/api/session", headers: { authorization: `Basic ${bad}` } })).statusCode).toBe(401);
    const good = Buffer.from("review:correct-horse-battery").toString("base64");
    expect((await app.inject({ url: "/api/session", headers: { authorization: `Basic ${good}` } })).statusCode).toBe(401 /* no session, but past basic auth */);
    expect((await app.inject({ url: "/api/session", headers: { authorization: `Basic ${good}` } })).body).toContain("No active test session");
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
  });

  it("never logs test-link tokens or cookies", async () => {
    const { app, service, lines } = await setup();
    const { token, header } = await startSession(app, service);
    await app.inject({ url: `/t/${token}` });
    await app.inject({ url: "/api/session", headers: { cookie: header } });
    const log = lines.join("");
    expect(log).toContain("/t/[redacted]");
    expect(log).not.toContain(token);
    expect(log).not.toContain(header.split("=")[1] ?? "never");
    expect(redactUrl("/t/abc?x=1")).toBe("/t/[redacted]?x=1");
    expect(redactUrl("Route GET:/t/abc not found")).toBe("Route GET:/t/[redacted] not found");
  });

  it("serves results and the assessment bundle only after the test ends", async () => {
    const { app, service } = await setup();
    const { header, sessionId } = await startSession(app, service);
    for (let i = 0; i < 100 && service.view(sessionId)?.state !== "running"; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await app.inject({ url: "/api/session/results", headers: { cookie: header } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/session/submit", headers: { cookie: header } })).statusCode).toBe(202);
    for (let i = 0; i < 100 && service.view(sessionId)?.state !== "finished"; i++) await new Promise((r) => setTimeout(r, 5));
    const results = await app.inject({ url: "/api/session/results", headers: { cookie: header } });
    expect(results.json()).toMatchObject({ endReason: "submitted", total: 4 });
    const bundle = await app.inject({ url: "/api/session/bundle", headers: { cookie: header } });
    expect(bundle.json()).toMatchObject({ schema: "breakfix.assessment/v1", scenario: { id: "01-wrong-ip-mask" } });
  });
});

describe("WebSocket", () => {
  async function connect(env: Record<string, string> = {}) {
    const ctx = await setup({ PUBLIC_URL: "http://lab.test", ...env });
    const auth = env.BASIC_AUTH_USER ? `Basic ${Buffer.from(`${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASSWORD}`).toString("base64")}` : undefined;
    const { header, sessionId } = await startSession(ctx.app, ctx.service, auth);
    for (let i = 0; i < 100 && ctx.service.view(sessionId)?.state !== "running"; i++) await new Promise((r) => setTimeout(r, 5));
    const address = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const open = (headers: Record<string, string>) => {
      const ws = new WebSocket(`${address.replace("http", "ws")}/api/session/ws`, { headers });
      const messages: { t: string; [k: string]: unknown }[] = [];
      ws.on("message", (m) => messages.push(JSON.parse(String(m))));
      const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
      return { ws, messages, closed };
    };
    return { ...ctx, header, sessionId, open };
  }
  const waitFor = async (check: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it("refuses connections without a session or from another origin", async () => {
    const { open, header } = await connect();
    expect(await open({}).closed).toBe(1008);
    expect(await open({ cookie: header, origin: "https://evil.example" }).closed).toBe(1008);
  });

  it("does not need basic auth on the socket, only the session cookie", async () => {
    const { open, header } = await connect({ BASIC_AUTH_USER: "review", BASIC_AUTH_PASSWORD: "correct-horse-battery" });
    const ok = open({ cookie: header, origin: "http://lab.test" });
    await new Promise((r) => ok.ws.on("open", r));
    ok.ws.close();
    expect(await open({ origin: "http://lab.test" }).closed).toBe(1008); // no session: refused
  });

  it("accepts the page's own origin, e.g. through an SSH tunnel", async () => {
    const { open, header } = await connect();
    const c = open({ cookie: header, origin: "http://localhost:8480", host: "localhost:8480" });
    await new Promise((r) => c.ws.on("open", r));
    await new Promise((r) => setTimeout(r, 100));
    expect(c.messages.some((m) => m.t === "session")).toBe(true);
    c.ws.close();
  });

  it("closes on malformed messages", async () => {
    const { open, header } = await connect();
    const c = open({ cookie: header, origin: "http://lab.test" });
    await new Promise((r) => c.ws.on("open", r));
    c.ws.send(JSON.stringify({ t: "exec", cmd: "sh" }));
    expect(await c.closed).toBe(1008);
  });

  it("records router commands and rejects shell-like host input", async () => {
    const { open, header, store, sessionId } = await connect();
    const c = open({ cookie: header, origin: "http://lab.test" });
    await new Promise((r) => c.ws.on("open", r));
    await waitFor(() => c.messages.some((m) => m.t === "session"));
    c.ws.send(JSON.stringify({ t: "open", node: "r2", cols: 80, rows: 24 }));
    await waitFor(() => c.messages.some((m) => m.t === "out" && String(m.data).includes("r2# ")));
    c.ws.send(JSON.stringify({ t: "in", node: "r2", data: "show ip route\r" }));
    c.ws.send(JSON.stringify({ t: "open", node: "h1", cols: 80, rows: 24 }));
    c.ws.send(JSON.stringify({ t: "line", node: "h1", line: "ping 10.0.3.10; sh" }));
    c.ws.send(JSON.stringify({ t: "line", node: "h1", line: "ping -c 2 10.0.3.10" }));
    await waitFor(() => store.commands(sessionId).length === 3);
    const byNode = (node: string) => store.commands(sessionId).filter((x) => x.node === node).map((x) => [x.kind, x.command, x.outcome]);
    expect(byNode("r2")).toEqual([["vtysh", "show ip route", "exec"]]);
    expect(byNode("h1")).toEqual([
      ["host", "ping 10.0.3.10; sh", "rejected: only letters, digits, spaces and . : / _ - are allowed"],
      ["host", "ping -c 2 -W 1 10.0.3.10", "exit 0"],
    ]);
    c.ws.close();
  });
});
