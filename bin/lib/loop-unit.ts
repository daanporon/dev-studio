// loop-unit.ts — which loop a state root runs (side-loop-host U12): main's, or a side host's when `ds join`
// wrote <root>/link/host.json. `ds loop-ts`, `ds install-ts`, `ds up`, `ds join` and the side loop
// (link/side.ts) read it here. No imports of dev-studio code: the install reads it, and stays small.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MAIN_UNIT = "ds-loop.service";
export const SIDE_UNIT = "ds-side-loop.service";

export type SideConfig = { main: string; name: string };

export const sideConfigPath = (stateRoot: string): string => join(stateRoot, "link", "host.json");

export function readDoc(file: string): Record<string, unknown> | null {
  try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" ? v : null; } catch { return null; }
}
export function writeDoc(file: string, doc: object): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(doc) + "\n");
  renameSync(`${file}.tmp`, file);
}

/** The main this state root joined, or null: it is not a side root. */
export function readSideConfig(stateRoot: string): SideConfig | null {
  const d = readDoc(sideConfigPath(stateRoot));
  return d && typeof d.main === "string" && typeof d.name === "string" ? { main: d.main, name: d.name } : null;
}
export const writeSideConfig = (stateRoot: string, c: SideConfig): void => writeDoc(sideConfigPath(stateRoot), c);

export const loopUnit = (stateRoot: string): string => (readSideConfig(stateRoot) ? SIDE_UNIT : MAIN_UNIT);
export const loopArgs = (stateRoot: string): string[] => (readSideConfig(stateRoot) ? ["--role", "side"] : []);
