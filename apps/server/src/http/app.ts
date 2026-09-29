import { existsSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { Scenario } from "@breakfix/scenario-kit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import { buildBundle, buildResults } from "../sessions/results.js";
import { type SessionService, TestLinkError } from "../sessions/service.js";
import { attachSocket } from "./socket.js";

export const COOKIE = "bfx_session";

export interface AppDeps {
  config: Config;
  service: SessionService;
  store: Store;
  scenarios: ReadonlyMap<string, Scenario>;
  logger: FastifyBaseLogger;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, service, store, scenarios } = deps;
  const app = Fastify({ trustProxy: config.TRUST_PROXY, bodyLimit: 16 * 1024, loggerInstance: deps.logger });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // Whole-site HTTP basic auth, for a private review deployment (BASIC_AUTH_USER/PASSWORD).
  if (config.BASIC_AUTH_USER && config.BASIC_AUTH_PASSWORD) {
    const expected = `Basic ${Buffer.from(`${config.BASIC_AUTH_USER}:${config.BASIC_AUTH_PASSWORD}`).toString("base64")}`;
    app.addHook("onRequest", async (req, reply) => {
      if (req.url === "/healthz") return;
      // Browsers do not reliably send basic-auth credentials on WebSocket upgrades. The socket is
      // still guarded: it needs the session cookie (256-bit secret) and a same-origin request.
      if (req.url.split("?")[0] === "/api/session/ws") return;
      if (!sameSecret(req.headers.authorization ?? "", expected)) {
        await reply.header("WWW-Authenticate", 'Basic realm="network-breakfix-lab"').code(401).send("Authentication required");
      }
    });
  }

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (config.COOKIE_SECURE) reply.header("Strict-Transport-Security", "max-age=31536000");
  });

  /** The session behind the request's cookie, or a 401. */
  function sessionOf(req: FastifyRequest, reply: FastifyReply): string | undefined {
    const raw = req.cookies[COOKIE] ?? "";
    const [id = "", secret = ""] = raw.split(".");
    const session = id && secret ? service.authenticate(id, secret) : undefined;
    if (!session) {
      void reply.code(401).send({ error: "No active test session." });
      return undefined;
    }
    return session.id;
  }

  app.get("/healthz", async () => ({ ok: true }));

  const redeemLimit = { config: { rateLimit: { max: config.START_RATE_LIMIT, timeWindow: "1 minute" } } };
  const linkError = (reply: FastifyReply, err: TestLinkError) =>
    reply.code({ invalid: 404, used: 409, expired: 410 }[err.code]).send({ error: err.message, code: err.code });

  app.post("/api/preview", redeemLimit, async (req, reply) => {
    try {
      return service.preview((req.body as { token?: unknown } | undefined)?.token);
    } catch (err) {
      if (err instanceof TestLinkError) return linkError(reply, err);
      throw err;
    }
  });

  app.post(
    "/api/start",
    redeemLimit,
    async (req, reply) => {
      const token = (req.body as { token?: unknown } | undefined)?.token;
      try {
        const { sessionId, secret } = service.start(token);
        void reply.setCookie(COOKIE, `${sessionId}.${secret}`, {
          path: "/",
          httpOnly: true,
          sameSite: "strict",
          secure: config.COOKIE_SECURE,
          maxAge: 24 * 3600,
        });
        return { sessionId };
      } catch (err) {
        if (err instanceof TestLinkError) return linkError(reply, err);
        throw err;
      }
    },
  );

  app.get("/api/session", async (req, reply) => {
    const id = sessionOf(req, reply);
    return id && service.view(id);
  });

  app.post("/api/session/submit", async (req, reply) => {
    const id = sessionOf(req, reply);
    if (!id) return;
    void service.submit(id, "submitted");
    return reply.code(202).send({ ok: true });
  });

  app.get("/api/session/results", async (req, reply) => {
    const id = sessionOf(req, reply);
    const session = id ? store.session(id) : undefined;
    if (!session) return;
    const scenario = scenarios.get(session.scenario_id);
    if (session.state !== "finished" || !scenario) return reply.code(409).send({ error: "The test is not finished yet." });
    return buildResults(store, session, scenario);
  });

  app.get("/api/session/bundle", async (req, reply) => {
    const id = sessionOf(req, reply);
    const session = id ? store.session(id) : undefined;
    if (!session) return;
    const scenario = scenarios.get(session.scenario_id);
    if (session.state !== "finished" || !scenario) return reply.code(409).send({ error: "The test is not finished yet." });
    return buildBundle(store, session, scenario);
  });

  app.get("/api/session/ws", { websocket: true }, (socket, req) => {
    // Same-origin check (blocks cross-site WebSocket hijacking). The page may be reached as
    // PUBLIC_URL or through another address of this server, e.g. an SSH tunnel to localhost.
    const origin = req.headers.origin;
    const sameHost = origin !== undefined && URL.canParse(origin) && new URL(origin).host === req.headers.host;
    if (origin && origin !== new URL(config.PUBLIC_URL).origin && !sameHost) {
      socket.close(1008, "origin not allowed");
      return;
    }
    const [id = "", secret = ""] = (req.cookies[COOKIE] ?? "").split(".");
    const session = id && secret ? service.authenticate(id, secret) : undefined;
    if (!session) {
      socket.close(1008, "no session");
      return;
    }
    attachSocket(socket, session.id, service, store, req.log);
  });

  // The web app (M4). Client-side routes (/t/<token>, /session, /results) fall back to index.html.
  const hasWeb = existsSync(join(config.WEB_DIST, "index.html"));
  if (hasWeb) await app.register(fastifyStatic, { root: config.WEB_DIST, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Not found" });
  });

  return app;
}
