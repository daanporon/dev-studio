// ds lanes — each lane rule with its units, how many were moved (misses) and the median CPU-hours, plus
// the median CPU-hours per top-level folder for unmarked units (light-lane plan U5).
import { openReadOnly, stateRoot } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel, writeOut } from "../lib/shared";
import { formatReport, laneReport } from "../loop/capacity/unit-lanes.ts";

export const help = "<project> [--json] — lane rules with units, misses and median CPU-hours; per-folder medians of unmarked units";
export async function run(args: string[]): Promise<number> {
  const { pos, flag } = parse(args, [], ["json"]);
  if (pos.length !== 1) { console.error("usage: ds lanes <project> [--json]"); return 2; }
  const label = dsLabel(pos[0]);
  const s = openReadOnly();
  try {
    const rep = laneReport(s, stateRoot(), label);
    if (flag.has("json")) print(rep); else writeOut(formatReport(label, rep));
  } finally { s.close(); }
  return 0;
}
