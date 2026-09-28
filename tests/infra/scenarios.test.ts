import { basename } from "node:path";
import { listScenarioDirs, loadScenario, selfTest } from "@breakfix/scenario-kit";
import { describe, expect, it } from "vitest";

const SCENARIOS = new URL("../../scenarios/", import.meta.url).pathname;
const dirs = await listScenarioDirs(SCENARIOS);

describe("scenario self-tests (real labs)", () => {
  it.each(dirs.map((d) => [basename(d), d]))(
    "%s: baseline passes, fault fails, workaround is caught",
    async (_id, dir) => {
      const report = await selfTest(await loadScenario(dir));
      const summary = report.variants.map((v) => `${v.variant}: ${v.summary}${v.error ? ` (${v.error})` : ""}`);
      expect(report.passed, summary.join("\n")).toBe(true);
    },
    300_000,
  );
});
