#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { destroyActiveLabs } from "./lab.js";
import { ScenarioError, listScenarioDirs, loadScenario } from "./loader.js";
import { type SelfTestReport, selfTest } from "./selftest.js";

const USAGE = `usage: breakfix-scenario test <id>... | --all  [--json]

Deploys each scenario's baseline, fault and (if present) workaround variant as real labs and checks
that the objectives behave as expected. Scenarios are read from ./scenarios or $BFX_SCENARIOS_DIR.`;

function printReport(report: SelfTestReport): void {
  console.log(`${report.passed ? "PASS" : "FAIL"}  ${report.id}`);
  for (const v of report.variants) {
    const secs = (v.ms / 1000).toFixed(1);
    console.log(`  ${v.variant.padEnd(10)} ${v.passed ? "ok  " : "FAIL"}  ${v.summary} (${secs}s)`);
    if (v.error) console.log(`             ${v.error.split("\n").join("\n             ")}`);
    if (!v.passed) {
      for (const r of v.results) console.log(`             ${r.passed ? "pass" : "fail"}  ${r.id}: ${r.detail}`);
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--json");
  if (command !== "test" || args.length === 0) {
    console.error(USAGE);
    return 64;
  }
  const root = resolve(process.env.BFX_SCENARIOS_DIR ?? "scenarios");
  const dirs = args.includes("--all") ? await listScenarioDirs(root) : args.map((id) => resolve(root, basename(id)));

  const reports: SelfTestReport[] = [];
  for (const dir of dirs) {
    let report: SelfTestReport;
    try {
      const scenario = await loadScenario(dir);
      report = await selfTest(scenario, json ? {} : { log: (l) => console.error(`  … ${l}`) });
    } catch (err) {
      const message = err instanceof ScenarioError ? err.message : `${basename(dir)}: ${String(err)}`;
      report = { id: basename(dir), passed: false, variants: [] };
      console.error(message);
    }
    reports.push(report);
    if (!json) printReport(report);
  }
  if (json) console.log(JSON.stringify(reports, null, 2));
  const failed = reports.filter((r) => !r.passed).length;
  if (!json) console.log(`\n${reports.length - failed}/${reports.length} scenarios passed their self-test`);
  return failed ? 1 : 0;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.error(`\n${signal}: destroying labs…`);
    void destroyActiveLabs().finally(() => process.exit(130));
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  async (err: unknown) => {
    console.error(err);
    await destroyActiveLabs();
    process.exit(1);
  },
);
