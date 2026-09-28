import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { CLAB_WRAPPER, GUARD_APP_SOCKET, GUARD_DEPLOY_SOCKET } from "./helpers.js";

function connectError(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createConnection(path);
    sock.on("connect", () => {
      sock.destroy();
      resolve(null);
    });
    sock.on("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"));
  });
}

describe("host preparation (scripts/bootstrap.sh)", () => {
  it("does not give this user the root-equivalent docker group", () => {
    const groups = execFileSync("id", ["-Gn"], { encoding: "utf8" }).trim().split(/\s+/);
    expect(groups).not.toContain("docker");
  });

  it("keeps the Docker socket out of reach", async () => {
    expect(await connectError("/run/docker.sock")).toBe("EACCES");
  });

  it("lets the breakfix group use only the guard's app socket", async () => {
    const app = statSync(GUARD_APP_SOCKET);
    expect(app.mode & 0o777).toBe(0o660);
    expect(await connectError(GUARD_APP_SOCKET)).toBeNull();
    expect(await connectError(GUARD_DEPLOY_SOCKET)).toBe("EACCES");
  });

  it("removed containerlab's setuid bit and emptied clab_admins", () => {
    expect(statSync("/usr/bin/containerlab").mode & 0o4000).toBe(0);
    const line = readFileSync("/etc/group", "utf8")
      .split("\n")
      .find((l) => l.startsWith("clab_admins:"));
    if (line !== undefined) expect(line.split(":")[3]).toBe("");
  });

  it("gives passwordless root to the wrapper only", () => {
    expect(() => execFileSync("sudo", ["-n", CLAB_WRAPPER, "list"], { stdio: "pipe" })).not.toThrow();
    for (const cmd of [["/usr/bin/containerlab", "version"], ["/usr/bin/docker", "ps"], ["/bin/sh", "-c", "id"]]) {
      let stderr = "";
      try {
        execFileSync("sudo", ["-n", ...cmd], { stdio: "pipe" });
      } catch (err) {
        stderr = String((err as { stderr?: Buffer }).stderr ?? "");
      }
      expect(stderr, cmd.join(" ")).toMatch(/password is required/);
    }
  });

  it("pins both lab images by image ID", () => {
    const images = JSON.parse(readFileSync("/etc/breakfix/images.json", "utf8")) as Record<
      string,
      { ref: string; id: string }
    >;
    expect(images.router?.ref).toBe("quay.io/frrouting/frr:10.7.1");
    expect(images.host?.ref).toBe("breakfix-host:0.1.0");
    for (const entry of Object.values(images)) expect(entry.id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
