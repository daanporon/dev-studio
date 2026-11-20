// dependency-waits — a dependency pause lasts while its prerequisites do, and (U220) a started unit
// that waits on another gets one placed:
//   - a `dispatched` unit with an unmet dep (the units' `deps`/`ext_deps` that `wait-on` and
//     `register-plan` write; "met" is the squad-state rule `ready-units` uses) whose Builder has no
//     pause of any kind gets a dependency pause on the unmet deps (`by: wait-on`), so its slot frees;
//   - a pause `wait-on` placed follows the unit's deps: still unmet -> the prerequisites are kept
//     current, none left (`wait-off`, or the dep merged) -> released;
//   - any other dependency pause is released once its prerequisites resolve, as before; a revoked
//     plan's wait (squad-state revoke-plan, prerequisite kind `plan`) resolves when the plan is approved again.
// A Builder with a manual pause is left alone; a planned unit's dep places nothing (it is not started).
import { clearDependency, intents, pause, type Prerequisite, type Target } from "../pause/pause.ts";
import { dependencyReasons } from "../pause/pause-conditions.ts";
import type { Reconciler } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";

const WAIT_ON = "wait-on";
const list = (v: unknown): string[] => { try { const x = JSON.parse(String(v ?? "[]")); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };

// squad-state's `satisfied`, over the units table: done, or cancelled with its work folded into a done
// unit / a merged PR / the dependent itself.
function satisfied(store: Store, project: string, squad: string, slug: string, self: string): boolean {
  let cur = slug;
  for (let n = 0; n <= 10; n++) {
    const hit = store.get("units", { project, squad, slug: cur });
    if (!hit) return false;
    if (hit.status === "done") return true;
    if (hit.status !== "cancelled") return false;
    const into = String(hit.superseded_by ?? "");
    if (!into) return false;
    if (into === self) return true;
    if (into.startsWith("PR#")) return !!hit.into_merged;
    cur = into;
  }
  return false;
}

// The unmet deps of a started unit, as prerequisites.
function unmet(store: Store, u: Row): Prerequisite[] {
  const project = String(u.project), squad = String(u.squad), slug = String(u.slug);
  const own = list(u.deps).filter((d) => !satisfied(store, project, squad, d, slug)).map((d) => ({ kind: "unit", project, squad, slug: d }) as Prerequisite);
  const ext = list(u.ext_deps).flatMap((r) => {
    const [sq, ...rest] = r.split("/"), dep = rest.join("/");
    const row = sq && dep ? store.get("units", { project, squad: sq, slug: dep }) : null;
    return row && row.status !== "done" ? [{ kind: "unit", project, squad: sq, slug: dep } as Prerequisite] : [];
  });
  return [...own, ...ext].filter((p) => p.kind !== "unit" || store.get("units", { project: p.project, squad: p.squad, slug: p.slug }));
}

const dependencyWaits: Reconciler = {
  name: "dependency-waits",
  run({ store, project, now }) {
    const placed = new Set<string>();
    for (const row of store.db.query("SELECT * FROM pause_intents WHERE project = ? AND source = 'dependency' AND cleared_at IS NULL").all(project) as Row[]) {
      const refs = JSON.parse(String(row.prerequisites ?? "[]")) as Prerequisite[];
      if (row.requested_by === WAIT_ON && row.scope === "member") {
        const u = store.get("units", { project, squad: String(row.squad), slug: String(row.suffix) });
        // A revoked plan's wait merged into this pause (squad-state revoke-plan) stays until approval.
        const now_ = u ? [...unmet(store, u), ...refs.filter((p) => p.kind === "plan")] : refs;
        placed.add(`${row.squad}\0${row.suffix}`);
        if (u && u.status === "dispatched") {
          if (!now_.length) { clearDependency(store, row, now); continue; }
          if (JSON.stringify(now_) !== JSON.stringify(refs)) store.upsert("pause_intents", { scope: row.scope, project, squad: row.squad, role: row.role, suffix: row.suffix, source: "dependency" }, { prerequisites: now_ });
        }
      }
      if (refs.length && !dependencyReasons(store, row as Target, refs).length) clearDependency(store, row, now);
    }
    for (const u of store.db.query("SELECT * FROM units WHERE project = ? AND status = 'dispatched'").all(project) as Row[]) {
      const squad = String(u.squad), slug = String(u.slug);
      if (placed.has(`${squad}\0${slug}`)) continue;
      const prereqs = unmet(store, u);
      if (!prereqs.length) continue;
      const m = store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = 'builder' AND (suffix = ? OR (? != '' AND wt = ?)) AND COALESCE(want, '') != 'gone' ORDER BY id DESC LIMIT 1")
        .get(project, squad, slug, String(u.builder_wt ?? ""), String(u.builder_wt ?? "")) as Row | null;
      if (!m) continue;
      const t: Target = { project, squad, role: "builder", suffix: String(m.suffix ?? "") };
      if (intents(store, t).length) continue;
      try { pause(store, { scope: "member", project, squad, role: "builder", suffix: String(m.suffix ?? "") }, { source: "dependency", prerequisites: prereqs, by: WAIT_ON }, now); } catch { /* already met, untracked: nothing to wait for */ }
    }
    return [];
  },
};
export default dependencyWaits;
