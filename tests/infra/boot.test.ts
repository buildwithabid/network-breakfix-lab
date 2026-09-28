import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url).pathname;

/** Vitest runs TypeScript directly; this catches what only breaks in the built, plain-Node server. */
describe("built server", () => {
  it("boots from dist/ and answers health checks", async () => {
    execFileSync("pnpm", ["--silent", "-r", "--filter", "@breakfix/server...", "run", "build"], { cwd: root, stdio: "pipe" });
    const dir = await mkdtemp(join(tmpdir(), "bfx-boot-"));
    const port = 18_000 + Math.floor(Math.random() * 2000);
    const child = spawn("node", ["apps/server/dist/main.js"], {
      cwd: root,
      env: { ...process.env, PORT: String(port), DB_PATH: join(dir, "db.sqlite"), LOG_LEVEL: "warn" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    try {
      let ok = false;
      for (let i = 0; i < 50 && !ok; i++) {
        await new Promise((r) => setTimeout(r, 200));
        ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
      }
      expect(ok, stderr).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
