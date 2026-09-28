import type { Objective } from "../schema.js";
import { type Probe, type ProbeOutput, type Verdict, evaluate, probeFor, probeKey } from "./rules.js";

export interface ProbeRunner {
  run(probe: Probe): Promise<ProbeOutput>;
}

export interface ObjectiveResult {
  id: string;
  description: string;
  passed: boolean;
  detail: string;
  /** The probe behind the verdict, kept so results can be audited (and later assessed) as-is. */
  probe: Probe;
}

/** Run every objective's probe once (shared probes are deduplicated) and evaluate the results. */
export async function checkObjectives(objectives: Objective[], runner: ProbeRunner): Promise<ObjectiveResult[]> {
  const probes = new Map<string, Probe>();
  for (const o of objectives) {
    const probe = probeFor(o.rule);
    probes.set(probeKey(probe), probe);
  }
  const outputs = new Map<string, ProbeOutput | Error>();
  await Promise.all(
    [...probes].map(async ([key, probe]) => {
      try {
        outputs.set(key, await runner.run(probe));
      } catch (err) {
        outputs.set(key, err instanceof Error ? err : new Error(String(err)));
      }
    }),
  );
  return objectives.map((o) => {
    const probe = probeFor(o.rule);
    const out = outputs.get(probeKey(probe));
    const verdict: Verdict =
      out === undefined || out instanceof Error
        ? { passed: false, detail: `could not run the check: ${out?.message ?? "no output"}`, indeterminate: true }
        : evaluate(o.rule, out);
    const passed = o.negate && !verdict.indeterminate ? !verdict.passed : verdict.passed;
    const detail = o.negate ? `must not hold: ${verdict.detail}` : verdict.detail;
    return { id: o.id, description: o.description, passed, detail, probe };
  });
}
