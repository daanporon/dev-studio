// fulfil/unit-action.ts — kind `unit-action`: the board's ⋯ menu on a Work units row (squad-done-definition U5).
// Payload {action: "cancel"|"release", slug, why?}.
//   cancel   runs `squad-state.sh <state> cancel-unit <slug> --why "<why> (board)"` for the unit and for every
//            open unit that depends on it, directly or through others ("depends on <slug>, cancelled from the
//            board"): the same wish path the Lead uses. Without this a dependent waits forever on a cancelled
//            unit, and the squad never finishes. Then it tells the Lead once, naming them all.
//   release  resumes the squad when it is paused and tells the Lead "operator: release <slug>"; the Lead runs
//            the hold kind's own command (roles/lead.md).
// The Lead is told by one `poke` request keyed on this request, so a replay (a step retried after a failed
// spawn) neither cancels twice (cancel-unit is idempotent) nor tells the Lead twice.
import { join } from "node:path";
import { failRequest, finishRequest, requestActions, type Exec, type Fulfiller } from "../core/actuator.ts";
import type { Action } from "../core/plugins.ts";
import { paused } from "../pause/pause.ts";
import { spawn } from "../io/orca.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import { payloadOf } from "../core/kinds.ts";

const closed = (st: unknown) => st === "done" || st === "cancelled";
const depsOf = (u: Row): string[] => { try { const d = JSON.parse(String(u.deps ?? "[]")); return Array.isArray(d) ? d.map(String) : []; } catch { return []; } };

/** The open units of a squad that wait on `slug`, directly or through others, in the order found. */
export function dependentsOf(store: Store, project: string, squad: string, slug: string): string[] {
  const units = store.db.query("SELECT slug, status, deps FROM units WHERE project = ? AND squad = ? ORDER BY ord, id").all(project, squad) as Row[];
  const found: string[] = [], seen = new Set([slug]);
  for (let grew = true; grew;) {
    grew = false;
    for (const u of units) {
      const s = String(u.slug);
      if (seen.has(s) || closed(u.status) || !depsOf(u).some((d) => seen.has(d))) continue;
      seen.add(s); found.push(s); grew = true;
    }
  }
  return found;
}

const unitAction: Fulfiller = {
  name: "unit-action",
  scope: "host",
  kinds: ["unit-action"],
  run: (ctx) => requestActions(ctx, ["unit-action"]),
  async exec(a: Action, x: Exec) {
    const p = payloadOf<"unit-action">(a);
    const project = a.project, squad = a.squad ?? "";
    if (!project || !squad || !p.slug || (p.action !== "cancel" && p.action !== "release")) return { failed: "a unit action needs a project, a squad, a unit and release or cancel" };
    const unit = x.store.db.query("SELECT status, hold FROM units WHERE project = ? AND squad = ? AND slug = ?").get(project, squad, p.slug) as Row | null;
    if (!unit) return { failed: `no unit ${p.slug} in ${project}/${squad}` };
    // A retry after a half-finished cancel finds the unit already cancelled: cancel-unit is idempotent, so go on.
    if (unit.status === "done" || (unit.status === "cancelled" && p.action === "release")) return { failed: `unit ${p.slug} is already ${unit.status}` };
    const lead = String((x.store.db.query("SELECT lead_wt FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Row | null)?.lead_wt ?? "");
    const tell = (text: string) => { if (lead) x.store.request("poke", { text }, { project, squad, member: lead, by: "board", key: `unit-action-told:${(a.payload as { request?: number }).request}` }); };
    const target = { project, squad };
    if (p.action === "release") {
      if (!unit.hold) return { failed: `unit ${p.slug} is not held` };
      const wasPaused = paused(x.store, target);
      if (wasPaused) x.store.resume({ scope: "squad", project, squad });
      tell(`dev-studio board: operator: release ${p.slug}. Run the hold kind's command for it now (plan hold: ask the Thinker to drop HELD and re-register; follow-up hold: add-role … builder; reasoned hold: set-unit-hold ${p.slug} off).`);
      finishRequest(x.store, a, { ok: true, released: p.slug, resumed: wasPaused }, x.now);
      return { done: true, result: "released" };
    }
    const why = String(p.why ?? "").trim() || "cancelled";
    const deps = dependentsOf(x.store, project, squad, p.slug);
    const state = join(x.store.root, project, "squads", `${squad}.json`);
    const run = (slug: string, reason: string) => spawn([join(ROOT, "bin", "role", "squad-state.sh"), state, "cancel-unit", slug, "--why", reason], { DS_STATE_ROOT: x.store.root }, 30_000);
    for (const [slug, reason] of [[p.slug, `${why} (board)`], ...deps.map((d) => [d, `depends on ${p.slug}, cancelled from the board`])] as [string, string][]) {
      const r = await run(slug, reason);
      if (r.code !== 0) return { retry: `cancel-unit ${slug}: ${(r.err || r.out).trim().split("\n").pop()}` };
    }
    tell(`dev-studio board: operator: cancelled ${p.slug}${deps.length ? ` and, because they depended on it, ${deps.join(", ")}` : ""} — reason: ${why}. The state is updated. Close any Builder still running on them and check the plan and the squad's wrap-up.`);
    finishRequest(x.store, a, { ok: true, cancelled: [p.slug, ...deps] }, x.now);
    return { done: true, result: `cancelled ${[p.slug, ...deps].join(", ")}` };
  },
  giveUp: failRequest,
};
export default unitAction;
