import { type Scenario, listScenarioDirs, loadScenario } from "@breakfix/scenario-kit";

export async function loadScenarios(dir: string): Promise<Map<string, Scenario>> {
  const map = new Map<string, Scenario>();
  for (const path of await listScenarioDirs(dir)) {
    const scenario = await loadScenario(path);
    map.set(scenario.meta.id, scenario);
  }
  return map;
}
