import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LAB_NAME_MAX, LAB_NAME_PATTERN, isLabName, newLabName } from "./lab-name.js";

describe("lab names", () => {
  it("generates valid, unique names", () => {
    const a = newLabName("s");
    const b = newLabName("t", "infra");
    expect(a).toMatch(/^bfx-s-[0-9a-f]{10}$/);
    expect(b).toMatch(/^bfx-t-infra-[0-9a-f]{10}$/);
    expect(newLabName("s")).not.toBe(a);
  });

  it("rejects names the root helpers would reject", () => {
    for (const bad of ["demo", "bfx-", "bfx-UP", "bfx-a--b", "bfx-a/b", `bfx-${"a".repeat(40)}`]) {
      expect(isLabName(bad), bad).toBe(false);
    }
    expect(() => newLabName("t", "Bad Label")).toThrow();
  });

  it("uses the same pattern and limit as infra/bfx_infra/policy.py", () => {
    const py = readFileSync(new URL("../../../infra/bfx_infra/policy.py", import.meta.url), "utf8");
    expect(py).toContain(`LAB_NAME_RE = re.compile(r"${LAB_NAME_PATTERN.source}")`);
    expect(py).toContain(`LAB_NAME_MAX = ${LAB_NAME_MAX}`);
  });
});
