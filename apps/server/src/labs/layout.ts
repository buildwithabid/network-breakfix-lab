import type { LinkInfo } from "./network.js";

export type Positions = Record<string, [number, number]>;

/**
 * Grid positions for the diagram. Explicit positions from scenario.yaml win; the rest are laid out
 * in columns by distance (in links) from the first host, so a chain reads left to right.
 */
export function layoutNodes(nodes: string[], links: LinkInfo[], explicit: Positions = {}, firstHost?: string): Positions {
  const out: Positions = { ...explicit };
  const missing = nodes.filter((n) => !(n in out));
  if (!missing.length) return out;
  const neighbours = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const l of links) {
    neighbours.get(l.a.node)?.push(l.b.node);
    neighbours.get(l.b.node)?.push(l.a.node);
  }
  const start = firstHost && nodes.includes(firstHost) ? firstHost : nodes[0];
  const depth = new Map<string, number>();
  const queue = start ? [start] : [];
  if (start) depth.set(start, 0);
  while (queue.length) {
    const n = queue.shift() ?? "";
    for (const m of neighbours.get(n) ?? []) {
      if (!depth.has(m)) {
        depth.set(m, (depth.get(n) ?? 0) + 1);
        queue.push(m);
      }
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const rowsUsed = new Map<number, number>();
  for (const n of nodes) {
    if (n in out) continue;
    const col = depth.get(n) ?? maxDepth + 1; // unconnected nodes go at the end
    const row = rowsUsed.get(col) ?? 0;
    rowsUsed.set(col, row + 1);
    out[n] = [col * 2, row * 2];
  }
  return out;
}
