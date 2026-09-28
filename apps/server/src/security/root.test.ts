import { describe, expect, it } from "vitest";
import { refuseRoot } from "./root.js";
import { hashToken, isToken, matchesHash, newToken } from "./tokens.js";

describe("refuseRoot", () => {
  it("throws for uid 0 only", () => {
    expect(() => refuseRoot(() => 0)).toThrow(/refusing to run as root/);
    expect(() => refuseRoot(() => 1001)).not.toThrow();
  });
});

describe("tokens", () => {
  it("are 256-bit, unique, and verified in constant time against their hash", () => {
    const a = newToken();
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(isToken(a)).toBe(true);
    expect(newToken()).not.toBe(a);
    expect(matchesHash(a, hashToken(a))).toBe(true);
    expect(matchesHash(newToken(), hashToken(a))).toBe(false);
    expect(matchesHash(a, "not-a-hash")).toBe(false);
  });
});
