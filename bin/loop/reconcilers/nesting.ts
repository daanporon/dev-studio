// nesting.ts — the squad tree as reality (U206, U213): Studio > squad Lead > the Lead's other members
// (Thinker, Builders, unit workers). The Orca observer stores each
// worktree's parent (`observed_worktrees.parent`); for each standing member with a worktree in a live
// squad this compares it with the parent it should have:
//   the Lead         its project's `projects.studio_wt`
//   any other member the squad's `lead_wt`
// and, when they differ and both worktrees are observed, files one `wt-set-parent` (fulfil/nesting.ts)
// under the seat key `nest:<member id>`. The parent is a wish (U259), not an event: the episode is
// "<wt>><wanted parent>#<repairs so far>", so a set that landed and was later undone (Orca dropped the
// parent) is a new drift, a new episode, and is repaired again. NEST_GRACE_S after a set the observer may
// still show the old parent: no new action then. A fourth drift of one worktree within an hour raises
// one alert (key `nest-drift.<wt>`) and files nothing. It does nothing when the wanted parent is unknown (no `studio_wt`, `lead_wt` not set yet)
// or not observed. `startVia` (drivers/types.ts parentFor) starts a new role under its parent where
// that is known; this repairs the rest — a role started before its Lead had a worktree (a resume
// starts every role in one tick, before the new Lead worktree is known), an older squad, a hand move.
import type { Action, Reconciler } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { liveSquads } from "./liveness.ts";
import { alertAction } from "./alerts.ts";
import { onContract } from "../squad/backend.ts";

export const NEST_KIND = "nest-repairs";
export const NEST_MAX = 3;          // repairs of one worktree per NEST_WINDOW_S before an alert replaces the next
export const NEST_WINDOW_S = 3600;
const graceS = () => Number(process.env.DS_LOOP_NEST_GRACE_S ?? 30);

// The times (loop clock) this worktree was set under a parent, newest last; kept in an episodes row.
export function repairTimes(store: Store, project: string, wt: string): number[] {
  const r = store.get("episodes", { project, subject: wt, kind: NEST_KIND });
  try { const v = JSON.parse(String(r?.state ?? "[]")); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; }
}
export function recordRepair(store: Store, project: string, wt: string, at: number): void {
  const times = [...repairTimes(store, project, wt), at].slice(-20);
  store.upsert("episodes", { project, subject: wt, kind: NEST_KIND }, { state: JSON.stringify(times), source: "loop", observed_at: at });
}

const nesting: Reconciler = {
  name: "nesting",
  run({ store, project, now }) {
    // U54 (project-start): a Studio off Orca (a `local::` folder) has no Orca worktree to nest a Lead under.
    const sw = (store.get("projects", { label: project })?.studio_wt as string | null | undefined) || null;
    const studio = sw?.startsWith("local::") ? null : sw;
    const seen = (wt: string): Row | null => store.db.query("SELECT parent FROM observed_worktrees WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, wt) as Row | null;
    const out: Action[] = [];
    for (const sq of liveSquads(store, project)) {
      // U11: only Orca nests worktrees and has the op that moves one (wt-set-parent). A squad on another
      // backend gets its parent at create (`parents: native`) or keeps the tree in loop.db (`groups`, `none`).
      if (onContract(store, project, String(sq.topic))) continue;
      const lead = sq.lead_wt ? String(sq.lead_wt) : null;
      const rows = store.db.query("SELECT id, wt, role FROM members WHERE project = ? AND squad = ? AND wt IS NOT NULL AND COALESCE(status, '') != 'gone' ORDER BY id")
        .all(project, String(sq.topic)) as Row[];
      for (const m of rows) {
        const role = String(m.role), wt = String(m.wt);
        if (role === "studio") continue;
        const want = role === "lead" ? studio : lead;
        if (!want || want === wt) continue;
        const me = seen(wt);
        if (!me || !seen(want)) continue;
        if ((me.parent ?? null) === want) continue;
        const times = repairTimes(store, project, wt);
        if (times.length && now - times[times.length - 1] < graceS()) continue;
        const episode = `${wt}>${want}#${times.length}`;
        if (times.filter((t) => t > now - NEST_WINDOW_S).length >= NEST_MAX) {
          out.push(...alertAction(store, { project, squad: String(sq.topic), key: `nest-drift.${wt}`, episode,
            text: `Worktree ${wt} keeps leaving its parent: the loop set it under ${want} ${NEST_MAX} times in the last hour and Orca dropped it again. The loop stops repairing it until the hour has passed.`,
            option: "done — I looked at why Orca drops the parent", why: `check what moves ${wt} (a hand drag, an Orca bug); ds nudge wt-set-parent forces one set` }));
          continue;
        }
        out.push({ project, squad: String(sq.topic), member: wt, subject: `nest:${m.id}`, kind: "wt-set-parent", episode, payload: { wt, parent: want } });
      }
    }
    return out;
  },
};
export default nesting;
