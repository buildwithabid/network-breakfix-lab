import { resolve } from "node:path";
import { z } from "zod";

const bool = z.enum(["0", "1", "true", "false"]).transform((v) => v === "1" || v === "true");

/** Every setting comes from the environment; .env.example documents each one. */
const Env = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8480),
  DB_PATH: z.string().default("./data/breakfix.db"),
  SCENARIOS_DIR: z.string().default("./scenarios"),
  WEB_DIST: z.string().default("./apps/web/dist"),
  /** e.g. https://lab.example.com; used for printed test links and the WebSocket origin check */
  PUBLIC_URL: z.string().url().default("http://localhost:8480"),
  MAX_CONCURRENT_LABS: z.coerce.number().int().min(1).max(20).default(5),
  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(60_000).default(3000),
  /** session starts allowed per IP per minute */
  START_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
  COOKIE_SECURE: bool.default(false),
  TRUST_PROXY: bool.default(false),
  /** optional: protect the whole site with HTTP basic auth (the M4 review deployment) */
  BASIC_AUTH_USER: z.string().min(1).optional(),
  BASIC_AUTH_PASSWORD: z.string().min(12).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${problems}`);
  }
  const config = parsed.data;
  if (Boolean(config.BASIC_AUTH_USER) !== Boolean(config.BASIC_AUTH_PASSWORD)) {
    throw new Error("invalid configuration: set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD, or neither");
  }
  return {
    ...config,
    DB_PATH: resolve(config.DB_PATH),
    SCENARIOS_DIR: resolve(config.SCENARIOS_DIR),
    WEB_DIST: resolve(config.WEB_DIST),
  };
}
