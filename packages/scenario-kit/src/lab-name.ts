import { randomBytes } from "node:crypto";

/**
 * Lab names are the one identifier shared with the root-side helpers (infra/bfx_infra/policy.py
 * LAB_NAME_RE), so the pattern and length limit here must stay identical to theirs.
 */
export const LAB_NAME_PATTERN = /^bfx-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LAB_NAME_MAX = 40;

/** `s` = a candidate session (reaped by the server), `t` = a test or CLI run. */
export type LabKind = "s" | "t";

export function isLabName(name: string): boolean {
  return name.length <= LAB_NAME_MAX && LAB_NAME_PATTERN.test(name);
}

export function newLabName(kind: LabKind, label?: string): string {
  const suffix = randomBytes(5).toString("hex");
  const name = label === undefined ? `bfx-${kind}-${suffix}` : `bfx-${kind}-${label}-${suffix}`;
  if (!isLabName(name)) {
    throw new Error(`invalid lab name ${JSON.stringify(name)}`);
  }
  return name;
}
