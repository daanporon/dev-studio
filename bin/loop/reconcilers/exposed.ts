// exposed.ts — an exposed entry ends when what it pointed at is gone (expose-hosted-services U2, R7,
// KTD3). For each open `exposed` row of the project, the first reason that holds ends it (gone_at +
// gone_why with one `unexposed` event, bin/loop/squad/exposed.ts endExposed). Ending keeps the row; only `ds remove-project` deletes it, into the
// project's archive:
//   squad-closed      its squad's row says closed or gone, is wished gone, or there is no squad row
//   squad-done        its squad's row says done (exposed-cleanup U2): a done squad hosts nothing
//   owner-gone        scope member: no live members row has the owner's worktree (nor is it the squad's lead_wt)
//   worktree-removed  scope member: the owner worktree's path no longer exists
//   down              any scope: the probe (observers/exposed.ts) has seen it down for expose_down_min minutes
//                     since its down run began or its last update (a re-expose), whichever is later
// A squad-scope entry (a detached env meant to outlive its starter, or one the squad owns) only ends
// with its squad or the down timer.
//
// exposed-cleanup U2, the stop commands (`ds expose --stop`): every end but `down` and `unexposed` queues
// the entry's stop in endExposed. This reconciler then
//   - queues the late stop of a row that ended `down` once its squad ends or its owner is gone,
//   - settles a stop `running` longer than expose_stop_s + 60 s as `lost` (never run again),
//   - groups the queued stops (stopGroups): a row whose stack another open entry still exposes, or whose
//     group already stopped after it was registered, is `skipped`; each other group is one `expose.stop`
//     action (fulfil/expose-stop.ts), subject and episode `expose-stop:<lowest id>`,
//   - raises one Studio alert per failed, timed-out or lost group, unless every entry ended `down` and none of its ports listens.
import { existsSync } from "node:fs";
import { endExposed, queueLateStops, settleStops, squadEnd, stopGroups, STOP_FAILED, type GoneWhy } from "../squad/exposed.ts";
import { limitInt } from "../settings/limits.ts";
import { wtPath } from "../observers/orca.ts";
import { alertAction } from "./alerts.ts";
import { target } from "../observers/exposed.ts";
import { redact } from "../core/redact.ts";
import type { Action, Reconciler } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";

// The path of a worktree id ('<repo>::<path>', or a bare absolute path), or null.
export const pathOf = (wt: string): string | null => wtPath(wt) || (wt.startsWith("/") ? wt : null);

// Is the owner of a member-scope entry gone (no live member on its worktree, and not the squad's Lead)?
function ownerGone(store: Store, e: Row): boolean {
  const wt = String(e.owner_wt ?? "");
  if (!wt) return false;
  const live = store.db.query("SELECT 1 FROM members WHERE project = ? AND squad = ? AND wt = ? AND COALESCE(status, '') != 'gone' LIMIT 1")
    .get(String(e.project), String(e.squad), wt);
  if (live) return false;
  const sq = store.db.query("SELECT lead_wt FROM squads WHERE project = ? AND topic = ?").get(String(e.project), String(e.squad)) as Row | null;
  return sq?.lead_wt !== wt;
}

export function goneWhy(store: Store, e: Row, now: number, downMin: number): GoneWhy | null {
  const end = squadEnd(store, String(e.project), String(e.squad));
  if (end) return end;
  const wt = String(e.owner_wt ?? "");
  if (e.scope === "member" && wt) {
    if (ownerGone(store, e)) return "owner-gone";
    const p = pathOf(wt);
    if (p && !existsSync(p)) return "worktree-removed";
  }
  // A re-expose (same row, new url or note) restarts the down timer: the old URL's down run does not count.
  if (e.status === "down" && e.down_since != null && now - Math.max(Number(e.down_since), Number(e.updated_at ?? 0)) >= downMin * 60) return "down";
  return null;
}

const ownerName = (r: Row) => `${r.role}${r.suffix ? `/${r.suffix}` : ""}`;

function stopResult(r: Row): Row {
  try { return JSON.parse(String(r.stop_result ?? "{}")) as Row; } catch { return {}; }
}

// The ids of the group a row's stop ran in (its stop_result's ids, written when the stop was claimed).
function groupIds(r: Row, res = stopResult(r)): number[] {
  return Array.isArray(res.ids) && res.ids.length ? res.ids.map(Number) : [Number(r.id)];
}

// The ports of a group's rows: each url's port and its `ports` column.
function groupPorts(rows: Row[]): number[] {
  const out = new Set<number>();
  for (const r of rows) {
    const t = target(String(r.url));
    if (t) out.add(t.port);
    let ps: unknown = [];
    try { ps = JSON.parse(String(r.ports ?? "[]")); } catch { /* unreadable: none */ }
    for (const p of Array.isArray(ps) ? ps : []) if (Number.isInteger(Number(p))) out.add(Number(p));
  }
  return [...out];
}

// Every port some live worktree's procs row lists as listening (observed_procs keeps only live worktrees).
function listening(store: Store, project: string): Set<number> {
  const out = new Set<number>();
  let rows: Row[] = [];
  try { rows = store.db.query("SELECT listen FROM observed_procs WHERE project = ? AND listen IS NOT NULL").all(project) as Row[]; } catch { return out; }   // before migration 0049
  for (const r of rows) {
    let l: unknown = [];
    try { l = JSON.parse(String(r.listen)); } catch { /* unreadable: none */ }
    for (const x of Array.isArray(l) ? l : []) if (Number.isInteger(Number((x as Row).port))) out.add(Number((x as Row).port));
  }
  return out;
}

// The probe saw the stack down before the stop ran, so a non-zero exit means "nothing to stop": no card
// when every entry of the group ended `down` and none of its ports listens. A lost stop always alerts.
function settledDown(store: Store, project: string, group: Row[]): boolean {
  if (group.some((x) => x.gone_why !== "down" || x.stop_state === "lost")) return false;
  const live = listening(store, project);
  return !groupPorts(group).some((p) => live.has(p));
}

// One alert per failed, timed-out or lost group: the rows of a group share their stop_result's ids.
function alerts(store: Store, project: string): Action[] {
  const rows = store.db.query(`SELECT * FROM exposed WHERE project = ? AND stop_state IN (${STOP_FAILED.map(() => "?").join(", ")}) ORDER BY id`)
    .all(project, ...STOP_FAILED) as Row[];
  const seen = new Set<number>(), out: Action[] = [];
  for (const r of rows) {
    const res = stopResult(r), ids = groupIds(r, res);
    const low = Math.min(...ids);
    if (seen.has(low)) continue;
    seen.add(low);
    const group = rows.filter((x) => ids.includes(Number(x.id)));
    if (settledDown(store, project, group)) continue;
    const names = group.map((x) => `'${x.name}'`);
    const how = r.stop_state === "lost" ? "was lost (the loop stopped while it ran; it is not run again)"
      : r.stop_state === "timeout" ? `timed out after ${Math.round(Number(res.ms ?? 0) / 1000)} s`
      : `failed with exit code ${res.code ?? "?"}`;
    const text = `The stop command of exposed ${names.join(", ")} (${ownerName(r)} in squad ${r.squad}) ${how}: \`${redact(String(r.stop_cmd))}\`. `
      + `What it hosted may still run; stop it by hand.${res.tail ? ` Output: ${String(res.tail).slice(-300)}` : ""}`;
    out.push(...alertAction(store, { project, squad: null, key: `expose-stop:${low}`, episode: `expose-stop:${low}`, title: "Stop command failed", text,
      option: "done — stopped by hand", why: "a hosted stack whose stop failed keeps its ports and processes" }));
  }
  return out;
}

const exposed: Reconciler = {
  name: "exposed",
  run({ store, project, now }) {
    const rows = store.db.query(`SELECT e.*, o.status, o.down_since FROM exposed e LEFT JOIN observed_exposed o ON o.exposed_id = e.id
      WHERE e.project = ? AND e.gone_at IS NULL ORDER BY e.id`).all(project) as Row[];
    const downMin = limitInt(store, project, "expose_down_min", 15);
    for (const e of rows) {
      const why = goneWhy(store, e, now, downMin);
      if (why) endExposed(store, e, why, "loop", now);
    }
    const late = store.db.query("SELECT * FROM exposed WHERE project = ? AND gone_why = 'down' AND stop_cmd IS NOT NULL AND stop_state IS NULL").all(project) as Row[];
    if (late.length) queueLateStops(store, late.filter((r) => squadEnd(store, project, String(r.squad)) || (r.scope === "member" && ownerGone(store, r))), now);

    const stopS = limitInt(store, project, "expose_stop_s", 90);
    for (const r of store.db.query("SELECT * FROM exposed WHERE project = ? AND stop_state = 'running' AND stop_at < ?").all(project, now - (stopS + 60)) as Row[]) {
      // The whole group at once: its other rows are no longer running, so one event per group.
      const ids = groupIds(r);
      if (settleStops(store, ids, "running", "lost", { ids, lost: true }).length)
        store.event("expose_stop", { project, squad: String(r.squad), payload: { ids, state: "lost" } });
    }

    const { run, skip } = stopGroups(store, project);
    for (const k of skip) settleStops(store, k.ids, "queued", "skipped", { ids: k.ids, skipped: k.why }, now);
    const out: Action[] = run.map((g) => {
      const low = Math.min(...g.ids), cwd = g.owner_wt ? pathOf(g.owner_wt) : null;
      return { project, squad: g.squad, subject: `expose-stop:${low}`, kind: "expose.stop", episode: `expose-stop:${low}`,
        payload: { ids: g.ids, cmd: g.cmd, ...(cwd ? { cwd } : {}) } };
    });
    return [...out, ...alerts(store, project)];
  },
};
export default exposed;
