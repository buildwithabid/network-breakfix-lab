import { rm } from "node:fs/promises";
import { type ObjectiveResult, checkObjectives } from "./checker/engine.js";
import { BASELINE_TIMEOUT_MS, SETTLE_MS } from "./constants.js";
import { Lab, sleep } from "./lab.js";
import { newLabName } from "./lab-name.js";
import type { Scenario, Variant } from "./loader.js";
import { renderLab } from "./render.js";

export interface VariantReport {
  variant: Variant;
  passed: boolean;
  /** One line saying what was expected and what happened. */
  summary: string;
  results: ObjectiveResult[];
  ms: number;
  error?: string;
}

export interface SelfTestReport {
  id: string;
  passed: boolean;
  variants: VariantReport[];
}

export interface SelfTestOptions {
  settleMs?: number;
  baselineTimeoutMs?: number;
  log?: (line: string) => void;
}

const failing = (results: ObjectiveResult[]) => results.filter((r) => !r.passed).map((r) => r.id);

/**
 * baseline   -> every objective passes (polled until the network converges)
 * fault      -> after settling, at least one objective fails, in two checks 5 s apart
 * workaround -> reachability is restored, yet at least one objective still fails, in two checks:
 *               proof that the checks look for the intended fix, not just for pings
 */
export async function selfTest(scenario: Scenario, opts: SelfTestOptions = {}): Promise<SelfTestReport> {
  const variants: Variant[] = ["baseline", "fault"];
  if (scenario.configs.workaround) variants.push("workaround");
  const reports = await Promise.all(variants.map((v) => runVariant(scenario, v, opts)));
  return { id: scenario.meta.id, passed: reports.every((r) => r.passed), variants: reports };
}

async function runVariant(scenario: Scenario, variant: Variant, opts: SelfTestOptions): Promise<VariantReport> {
  const started = Date.now();
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const timeoutMs = opts.baselineTimeoutMs ?? BASELINE_TIMEOUT_MS;
  const objectives = scenario.meta.objectives;
  const reachability = new Set(objectives.filter((o) => o.rule.type === "reachability").map((o) => o.id));
  const dir = await renderLab(scenario, variant, newLabName("t", "st"));
  let lab: Lab | undefined;
  const report = (passed: boolean, summary: string, results: ObjectiveResult[]): VariantReport => ({
    variant,
    passed,
    summary,
    results,
    ms: Date.now() - started,
  });

  try {
    lab = await Lab.deploy(dir);
    opts.log?.(`${scenario.meta.id} ${variant}: deployed ${lab.name}`);
    await lab.waitForRouters();

    if (variant === "baseline") {
      const deadline = Date.now() + timeoutMs;
      let results = await checkObjectives(objectives, lab);
      while (failing(results).length && Date.now() < deadline) {
        await sleep(3000);
        results = await checkObjectives(objectives, lab);
      }
      const bad = failing(results);
      return bad.length
        ? report(false, `expected all objectives to pass; still failing: ${bad.join(", ")}`, results)
        : report(true, `all ${objectives.length} objectives pass`, results);
    }

    await sleep(settleMs);
    let first = await checkObjectives(objectives, lab);
    if (variant === "workaround") {
      const deadline = Date.now() + timeoutMs;
      while (first.some((r) => reachability.has(r.id) && !r.passed) && Date.now() < deadline) {
        await sleep(3000);
        first = await checkObjectives(objectives, lab);
      }
    }
    await sleep(5000);
    const second = await checkObjectives(objectives, lab);
    const stillFailing = failing(first).filter((id) => failing(second).includes(id));

    if (variant === "fault") {
      return stillFailing.length
        ? report(true, `${stillFailing.length} of ${objectives.length} fail: ${stillFailing.join(", ")}`, second)
        : report(false, "expected at least one objective to fail, but all pass", second);
    }
    const unreachable = second.filter((r) => reachability.has(r.id) && !r.passed).map((r) => r.id);
    if (unreachable.length) {
      return report(false, `the workaround should restore reachability; failing: ${unreachable.join(", ")}`, second);
    }
    const caught = stillFailing.filter((id) => !reachability.has(id));
    return caught.length
      ? report(true, `reachability restored, still caught by: ${caught.join(", ")}`, second)
      : report(false, "the workaround passes every objective; the checks do not verify the intended fix", second);
  } catch (err) {
    return { ...report(false, "error", []), error: err instanceof Error ? err.message : String(err) };
  } finally {
    await lab?.destroy().catch((err: unknown) => opts.log?.(`cleanup of ${lab?.name} failed: ${String(err)}`));
    await rm(dir, { recursive: true, force: true });
  }
}
