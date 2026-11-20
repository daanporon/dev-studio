import { blockingForUnit, entryOf, waiting } from "../messages/questions.ts";
import type { Prerequisite, Target } from "./pause.ts";
import type { Row, Store } from "../core/store.ts";
import { basename } from "node:path";
import { approvedPlans } from "../squad/plan-approved.ts";

export function memberUnit(store: Store, t: Target): Row | null {
  if (t.role !== "builder") return null;
  // The slug match wins. A worktree matches only when the target has one: an empty one would hit
  // every unit with no `builder_wt` yet.
  const wt = String(t.member ?? (t as Row).wt ?? "");
  const bySlug = t.suffix ? store.get("units", { project: t.project, squad: t.squad ?? "", slug: t.suffix }) : null;
  if (bySlug) return bySlug;
  if (!wt) return null;
  return (store.db.query("SELECT * FROM units WHERE project = ? AND squad = ? AND builder_wt = ? ORDER BY id DESC")
    .get(t.project, t.squad ?? "", wt) as Row | null);
}
export function mergedUnit(store: Store, unit: Row): boolean {
  if (unit.status === "done") return true;
  if (!unit.pr) return false;
  const squad = store.get("squads", { project: unit.project, topic: unit.squad });
  const nwo = store.get("config", { project: unit.project, file: "github", key: `repo:${squad?.repo}` })?.value;
  const n = String(unit.pr).match(/\d+$/)?.[0];
  const pr = store.get("observed_prs", { project: unit.project, ref: `${unit.squad}/${unit.slug}` })
    ?? (nwo && n ? store.get("observed_prs", { project: unit.project, ref: `${nwo}#${n}` }) : null);
  return !!pr && pr.gone_at == null && pr.state === "MERGED" && String(pr.pr) === n;
}
// A revoked plan's wait (squad-state revoke-plan): resolved once the plan is in its squad's approved_plans again.
function planApprovedNow(store: Store, p: Extract<Prerequisite, { kind: "plan" }>): boolean {
  const sq = store.get("squads", { project: p.project, topic: p.squad });
  if (!sq) return true;   // the squad is gone: nothing left to wait for
  let doc: { approved_plans?: unknown } = {};
  try { doc = JSON.parse(String(sq.doc ?? "{}")); } catch { return false; }
  return approvedPlans(store.root, doc.approved_plans, p.plan);
}
export function dependencyReasons(store: Store, t: Target, refs: Prerequisite[]): string[] {
  const reasons: string[] = [];
  for (const p of refs) {
    if (p.kind === "plan") {
      if (!planApprovedNow(store, p)) reasons.push(`plan not approved: ${basename(p.plan)}`);
      continue;
    }
    const row = p.kind === "unit" ? store.get("units", { project: p.project, squad: p.squad, slug: p.slug })
      : store.get("observed_prs", { project: p.project, ref: p.ref });
    const name = p.kind === "unit" ? `${p.project}/${p.squad}/${p.slug}` : p.ref;
    if (!row || row.gone_at != null || (p.kind === "unit" ? ["cancelled", "closed", "gone"].includes(String(row.status)) || !mergedUnit(store, row) : row.state !== "MERGED"))
      reasons.push(`prerequisite unresolved: ${name}`);
  }
  const m = store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix = ? ORDER BY id DESC")
    .get(t.project, t.squad ?? "", t.role ?? "", t.suffix ?? "") as Row | null;
  let owns: string[] = []; try { owns = JSON.parse(String(m?.doc ?? "{}" )).owns ?? []; } catch {}
  const u = memberUnit(store, t);
  const slugs = new Set([...owns, ...(u ? [String(u.slug)] : [])]);
  for (const slug of slugs) {
    const unit = store.get("units", { project: t.project, squad: t.squad, slug });
    if (unit?.hold) reasons.push(`unit hold: ${slug}`);
    if (blockingForUnit(waiting(store, t.project, t.squad ?? "").map(entryOf), slug)) reasons.push(`blocking ruling: ${slug}`);
  }
  return reasons;
}
