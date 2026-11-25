// contract-limited.ts — the `limited` rows of the squads off Orca (U35, orca-backend-alternatives).
// The Orca adapter's `limited` verb reads only Orca workers' screens, so accounts-refresh never saw a usage
// limit, credits error or ended login on a tmux or herdr member. The contract observer (observers/contract.ts)
// already reads each live member's screen through its own backend's `terminal.read`, and keeps the tail in
// observed_workers; this runs the same match (fingerprints.ts scan, the one module the limits reconciler
// uses) over those tails and returns rows in the verb's shape:
//   "<wt>\t<reset epoch or ->\t<notice>[\t-\tlogin|credits | \tdialog]"
import type { Store } from "../core/store.ts";
import { scan } from "./fingerprints.ts";

type Row = Record<string, unknown>;
const epoch = (v: unknown): number | null => (v != null && /^[0-9]+$/.test(String(v)) ? Number(v) : null);

export function contractLimited(store: Store, now: number, silentMin = 10): string {
  const rows = store.db.query(`SELECT ow.wt AS wt, ow.state AS state, ow.since AS since, ow.last_output_at AS last_output_at, ow.tail AS tail,
      m.agent AS agent FROM observed_workers ow
      JOIN members m ON m.project = ow.project AND m.wt = ow.wt AND COALESCE(m.status, '') != 'gone'
      JOIN squads s ON s.project = m.project AND s.topic = m.squad AND COALESCE(s.backend, 'orca') != 'orca'
      WHERE ow.gone_at IS NULL AND ow.state IS NOT NULL AND ow.tail IS NOT NULL ORDER BY ow.wt`).all() as Row[];
  let out = "";
  for (const r of rows) {
    const lim = scan(String(r.tail), { agent: (r.agent as string) || "claude", state: String(r.state), since: epoch(r.since), lastOutput: epoch(r.last_output_at), now, silentMin });
    if (!lim) continue;
    const kind = lim.kind === "login" ? "\t-\tlogin" : lim.kind === "credits" ? "\t-\tcredits" : lim.dialog ? "\tdialog" : "";
    out += `${r.wt}\t${lim.reset ?? "-"}\t${lim.notice}${kind}\n`;
  }
  return out;
}
