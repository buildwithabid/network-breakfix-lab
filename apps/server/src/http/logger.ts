import type { FastifyRequest } from "fastify";
import { type DestinationStream, type Logger, pino } from "pino";
import type { Config } from "../config.js";

/** Test links are /t/<token>: never let a token reach a log line. */
export function redactUrl(url: string): string {
  return url.replace(/\/t\/[^/?#\s]+/g, "/t/[redacted]");
}

export function createLogger(config: Pick<Config, "LOG_LEVEL">, destination?: DestinationStream): Logger {
  const options = {
    level: config.LOG_LEVEL,
    // Also scrub message text: e.g. Fastify's own "Route GET:/t/<token> not found".
    hooks: {
      logMethod(this: Logger, args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(this, args.map((a) => (typeof a === "string" ? redactUrl(a) : a)));
      },
    },
    redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
    serializers: {
      req: (req: FastifyRequest) => ({ method: req.method, url: redactUrl(req.url), ip: req.ip }),
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
