// focus.ts — the project's focus squad (squad-priority U1): one limits key, `focus_squad` (default `-` =
// none), so a project never has more than one. Its queued Builder work goes first for a free seat, after
// urgent and unblocking work and inside the limit, its units with the most open dependents first
// (unblock_first, slot.ts placeOf / lineOrder). The focus counts only
// while its squad is a live feature squad: a suspended one keeps the key and gets it back on resume; a
// closed, done or gone one clears it (reconcilers/focus.ts). Written through settings.ts like any setting
// (`ds focus`, the board's limits POST, a Settings undo), which logs one `focus_set` event per change.
// Only reads here.
import type { Row, Store } from "../core/store.ts";

export const FOCUS_KEY = "focus_squad";
export const NO_FOCUS = "-";
// A squad in one of these states takes no seat (slot.ts builders(), liveness.ts liveSquads).
export const NOT_LIVE = ["suspended", "on-hold", "done", "failed", "closed", "gone"];
// A focus naming a squad in one of these is cleared by the loop.
export const ENDED = ["done", "closed", "gone"];

export const squadRow = (store: Store, project: string, squad: string): Row | null =>
  store.db.query("SELECT * FROM squads WHERE project = ? AND topic = ? ORDER BY id DESC").get(project, squad) as Row | null;

// Why `squad` cannot be made the focus now, or null when it can: it must be a live feature squad.
export function focusProblem(store: Store, project: string, squad: string): string | null {
  const s = squadRow(store, project, squad);
  if (!s) return `no squad '${squad}' in ${project}`;
  if ((s.type ?? "feature") !== "feature") return `${squad} is a ${s.type} squad: only a feature squad can be the focus`;
  const st = String(s.status ?? "running");
  if (NOT_LIVE.includes(st)) return `${squad} is ${st}: only a live squad can be the focus`;
  return null;
}

// The focus_squad value in force (env, project row, default), `-` when none.
export function focusValue(store: Store, project: string): string {
  const env = process.env.DS_LIMIT_FOCUS_SQUAD;
  if (env) return env.trim().split(/\s+/)[0] || NO_FOCUS;
  for (const p of [project, ""]) {
    const r = store.get("config", { project: p, file: "limits.conf", key: FOCUS_KEY });
    const v = r ? String(r.value ?? "").trim().split(/\s+/)[0] : "";
    if (v) return v;
  }
  return NO_FOCUS;
}

// The focus squad that counts now: the value, when it names a live feature squad; else null.
export function focusSquad(store: Store, project: string): string | null {
  const v = focusValue(store, project);
  if (v === NO_FOCUS) return null;
  return focusProblem(store, project, v) ? null : v;
}
