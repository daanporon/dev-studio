// ready.ts — the loop dispatches ready units' Builders (U157). Ported from the removed sweep
// step 11 (ready_cleanup, ready_pending_sweep, defer_ready, ready_nudge) at main
// 0fbb8be654cda578a94410017c6a1d8c63f2e3e3.
//
// Ready is `squad-state.sh ready-units`: planned, not held, not waiting, every dep satisfied (done,
// or cancelled into this unit, a done unit or a merged PR) and every ext dep done in its squad,
// live or archived. The loop writes one Builder member wish per ready unit — shaped like the
// Lead's `ds request builder --unit` (payload `request: true`, phase `build`) — and fulfil/member.ts
// starts it on add-role.sh's prompt while reconcilers/requests.ts tells the Lead once it started,
// failed or was rejected. No room or no `max_builders` slot leaves the wish idle (the pick's WAIT,
// U145), nothing else. The write is idempotent: a live member row (wished, starting, running,
// failed, stopped) is left alone, so a Lead's own `ds request` for the same unit in the same tick
// and a loop restart mid-start each give one Builder, a failed start waits for the Lead's
// re-request, and a stop stays stopped. A hold stops it; releasing the hold starts it.
//
// A wish that has not started follows its unit (hold-cancels-queue-undo-approval U1,
// squad/queued-builder.ts): each tick, before the new wishes, a loop wish whose unit is held, waiting,
// blocked, no longer ready or whose plan lost its approval is withdrawn (wished gone and settled gone,
// one `builder_wish_withdrawn` event), and so is any queued wish of a cancelled or done unit. A Lead's
// own `ds request` wish still bypasses hold and approval; set-unit-hold on and cancel-unit withdraw
// it in their own write. fulfil/member.ts checks the same rule again right before the spawn. A builder
// wished gone that never got a worktree is settled gone (`builder_wish_settled`), so releasing its
// unit wishes a fresh one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { alertId } from "../core/actuator.ts";
import type { Row, Store } from "../core/store.ts";
import { paused, intents } from "../pause/pause.ts";
import { queue, slot } from "../capacity/slot.ts";
import { liveSquads } from "./liveness.ts";
import { blockingForUnit, entryOf, waiting } from "../messages/questions.ts";
import { settleWithdrawn, withdrawRefused } from "../squad/queued-builder.ts";
import { approvedPlans, canonPath } from "../squad/plan-approved.ts";

type Unit = { id: number; slug: string; status: string | null; deps: string | null; ext_deps: string | null; hold: number | null;
  wait_until: number | null; superseded_by: string | null; into_merged: number | null; tier: string | null; plan: string | null };

// U3 (thinker-start-triage): a suspended feature squad's resume holds its not-started approved
// units with this reason (fulfil/squad.ts); the Thinker's check or register-plan of the approved plan frees them.
export const REVALIDATE_WHY = "revalidate after resume";
export { approvedPlans, canonPath, devRoot } from "../squad/plan-approved.ts";

// The operator's approval of a unit's plan: the Lead's old plan-approved gate (roles/lead.md),
// now on the dispatch path. An empty plan is ad-hoc/operator-directed work and always passes;
// otherwise the plan must be in the squad's approved_plans (as approve-plan records it).
// An explicit `ds request` bypasses this gate like it bypasses holds: it is the manual path.
function planApproved(store: Store, sq: Row, plan: string | null): boolean {
  if (!plan) return true;
  let doc: { approved_plans?: unknown } = {};
  try { doc = JSON.parse(String(sq.doc ?? "{}")); } catch { return false; }
  return approvedPlans(store.root, doc.approved_plans, plan);
}

const list = (j: string | null): string[] => { try { const v = JSON.parse(j ?? "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

// The archived squads' done units (squad-state.sh ext_status reads the same files).
function archivedDone(root: string, project: string, squad: string, slug: string): boolean {
  const dir = join(root, project, "archive");
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(`${squad}-`) || !f.endsWith(".json")) continue;
    try {
      const a = JSON.parse(readFileSync(join(dir, f), "utf8")) as { topic?: string; units?: { slug?: string; status?: string }[] };
      const mine = (a.topic ?? "") === squad || (!a.topic && /^\d{8}-\d{6}\.json$/.test(f.slice(squad.length + 1)));
      if (mine && (a.units ?? []).some((u) => u.slug === slug && u.status === "done")) return true;
    } catch { /* a torn archive counts for nothing */ }
  }
  return false;
}

function extDone(store: Store, project: string, ref: string): boolean {
  const i = ref.indexOf("/");
  if (i < 0) return false;
  const squad = ref.slice(0, i), slug = ref.slice(i + 1);
  const u = store.db.query("SELECT status FROM units WHERE project = ? AND squad = ? AND slug = ?").get(project, squad, slug) as { status: string | null } | null;
  return u?.status === "done" || archivedDone(store.root, project, squad, slug);
}

// squad-state.sh ready-units, for one squad's units; depsDone is its dep half alone.
export function readyUnits(store: Store, project: string, units: Unit[], now: number, questions: unknown[] = []): Unit[] {
  const done = depsDone(store, project, units);
  return units.filter((u) => u.status === "planned" && !u.hold && !blockingForUnit(questions, u.slug) && Number(u.wait_until ?? 0) <= now && done(u));
}

// The planned units ready except for a Builder seat, in the order a free seat goes to them (U146): every
// live feature squad's ready units, ranked by slot.ts queue() (urgent, blocks started work, the focus
// squad's while its key is on, dispatched, the most open dependents while the unlock key is on, then the
// oldest), the same line slot() walks.
export function readyLine(store: Store, project: string, now: number): { topic: string; id: number; slug: string }[] {
  const cand: { topic: string; id: number; slug: string }[] = [];
  for (const sq of liveSquads(store, project)) {
    const topic = String(sq.topic);
    // A paused project, squad or Lead cannot use a slot, so it would starve the rest.
    if ((sq.type ?? "feature") !== "feature" || intents(store, { project, squad: topic, role: "lead", suffix: "" }).length) continue;
    const units = store.db.query("SELECT id, slug, status, deps, ext_deps, hold, wait_until, superseded_by, into_merged FROM units WHERE project = ? AND squad = ? ORDER BY slug")
      .all(project, topic) as Unit[];
    const qs = waiting(store, project, topic).map(entryOf);
    for (const u of readyUnits(store, project, units, now, qs)) cand.push({ topic, id: u.id, slug: u.slug });
  }
  cand.sort((a, b) => a.id - b.id);
  // A unit whose Builder already waits is in the line as that member, so place it by squad + slug.
  const pos = new Map<string, number>();
  queue(store, project, now, cand.map((c) => ({ squad: c.topic, suffix: c.slug })))
    .forEach((p, i) => { const k = `${p.squad}\0${p.suffix}`; if (!pos.has(k)) pos.set(k, i); });
  return cand.sort((a, b) => (pos.get(`${a.topic}\0${a.slug}`) ?? Infinity) - (pos.get(`${b.topic}\0${b.slug}`) ?? Infinity) || a.id - b.id);
}

// The planned units a free Builder slot would go to now (U146), as `<topic>\0<slug>`; null = no limit.
// Each candidate of readyLine asks slot() with all the others in its line, so only the next ones are ready.
export function slotted(store: Store, project: string, now: number): Set<string> | null {
  if (slot(store, project, { squad: "", suffix: "" }, now).limit == null) return null;
  const cand = readyLine(store, project, now);
  const out = new Set<string>();
  const planned = cand.map((c) => ({ squad: c.topic, suffix: c.slug }));
  for (const c of cand) if (slot(store, project, { squad: c.topic, suffix: c.slug }, now, "builder", planned).ok) out.add(`${c.topic}\0${c.slug}`);
  return out;
}

export function depsDone(store: Store, project: string, units: Unit[]): (u: Unit) => boolean {
  const bySlug = new Map(units.map((u) => [u.slug, u]));
  const satisfied = (dep: string, self: string): boolean => {
    let t = dep;
    for (let n = 0; n <= 10; n++) {
      const hit = bySlug.get(t);
      if (!hit) return false;
      if (hit.status === "done") return true;
      if (hit.status !== "cancelled") return false;
      const into = hit.superseded_by ?? "";
      if (into === "") return false;
      if (into === self) return true;
      if (into.startsWith("PR#")) return !!hit.into_merged;
      t = into;
    }
    return false;
  };
  return (u) => list(u.deps).every((d) => satisfied(d, u.slug)) && list(u.ext_deps).every((r) => extDone(store, project, r));
}

// One Builder member wish for a ready unit, shaped like the Lead's `ds request builder --unit`
// (bin/commands/request.ts): fulfil/member.ts starts it, reconcilers/requests.ts tells the
// Lead. A live member row is left alone (see the header).
function ensureBuilder(store: Store, project: string, topic: string, u: Unit, now: number): void {
  const live = store.db.query("SELECT id FROM members WHERE project = ? AND squad = ? AND role = 'builder' AND suffix = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
    .get(project, topic, u.slug);
  if (live) return;
  const id = `${project}/${topic}/builder/${u.slug}`;
  store.tx(() => {
    const wanted = store.want("member", id, "running", { payload: { why: "start", request: true, unit: u.slug }, by: "loop", why: "ready" }).row;
    store.db.run("DELETE FROM picks WHERE member = ?", [wanted.id as number]);
    // No doc yet: squadDoc exports members with one, and a wt-less member in the squad doc would
    // round-trip onto every other wt-less member. The fulfiller writes it with the worktree.
    store.fact("member_requested", [{ table: "members", key: { id: wanted.id }, set: {
      phase: "build", ...(u.tier ? { tier: u.tier } : {}), status: "wanted", updated_at: now,
    } }], { project, squad: topic, member: `builder/${u.slug}`, payload: { id: wanted.id, role: "builder", suffix: u.slug, unit: u.slug, by: "loop" } });
  });
}

// One `ready_unapproved` event per unit and plan (not one per tick): a ready unit held back
// only by a missing plan approval is invisible otherwise — no Builder wish, no poke, no alert.
function noteUnapproved(store: Store, project: string, topic: string, u: Unit): void {
  const plan = String(u.plan ?? "");
  const rows = store.db.query("SELECT payload FROM events WHERE kind = 'ready_unapproved' AND project = ? AND squad = ?")
    .all(project, topic) as Row[];
  for (const r of rows) {
    try {
      const p = JSON.parse(String(r.payload ?? "{}"));
      if (String(p.unit ?? "") === String(u.slug) && canonPath(store.root, String(p.plan ?? "")) === canonPath(store.root, plan)) return;
    } catch { /* a torn payload counts for nothing */ }
  }
  store.event("ready_unapproved", { project, squad: topic, unit: String(u.slug), payload: { unit: u.slug, plan } });
}

// U46: a ref in a unit's ext_deps that names no unit (live, or done in an archive) is a typo or a squad
// that never existed: one Studio card per unit names it, and it closes when every ref resolves, the ref
// is dropped (drop-ext-dep) or the unit is no longer planned. The card is the unit's, not the tick's.
const EXT_CARD = "extdep.missing|";
function extMissing(store: Store, project: string, ref: string): boolean {
  const i = ref.indexOf("/");
  if (i < 0) return true;
  const squad = ref.slice(0, i), slug = ref.slice(i + 1);
  return !store.db.query("SELECT 1 FROM units WHERE project = ? AND squad = ? AND slug = ?").get(project, squad, slug) && !archivedDone(store.root, project, squad, slug);
}
export function extDepCards(store: Store, project: string, now = 0): Action[] {
  const actions: Action[] = [];
  const want = new Map<string, { squad: string; slug: string; refs: string[] }>();
  const rows = store.db.query("SELECT squad, slug, status, ext_deps FROM units WHERE project = ? AND ext_deps IS NOT NULL AND ext_deps != '[]'").all(project) as Row[];
  for (const u of rows) {
    if (String(u.status) !== "planned") continue;
    const refs = list(u.ext_deps as string | null).filter((r) => extMissing(store, project, r));
    if (refs.length) want.set(`${EXT_CARD}${u.squad}/${u.slug}`, { squad: String(u.squad), slug: String(u.slug), refs });
  }
  const claim = (subject: string, kind: string) => store.get("episodes", { project, subject, kind: `action:${kind}` });
  const subjects = (store.db.query("SELECT DISTINCT subject FROM episodes WHERE project = ? AND kind = 'action:alert' AND subject LIKE ?").all(project, `${EXT_CARD}%`) as Row[]).map((r) => String(r.subject));
  for (const subject of new Set([...subjects, ...want.keys()])) {
    const sent = claim(subject, "alert")?.episode_key;
    const up = typeof sent === "string" && claim(subject, "alert-clear")?.episode_key !== `cleared@${sent}` ? sent : null;
    const w = want.get(subject);
    const base = w ? `${subject}|${w.refs.join(",")}` : null;
    const ep = base ? (up && up.startsWith(`${base}@`) ? up : `${base}@${now}`) : null;
    if (up && up !== ep) actions.push({ project, squad: null, member: null, subject, kind: "alert-clear", episode: `cleared@${up}`, payload: { target: "project", id: alertId(subject, up) } });
    if (w && ep && up !== ep) actions.push({ project, squad: w.squad, member: null, subject, kind: "alert", episode: ep, payload: {
      title: `${w.squad}/${w.slug} waits on a unit that does not exist`, unit: w.slug,
      text: `${w.slug} (${w.squad}) waits on ${w.refs.join(", ")}, which no squad has. Fix the ref (squad-state add-ext-dep) or drop it (drop-ext-dep ${w.slug} <ref>); the unit starts once its refs are done.`, card: "ext_dep_missing" } });
  }
  return actions;
}

export function ready(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx;
  for (const sq of liveSquads(store, project)) {
    const topic = String(sq.topic);
    if ((sq.type ?? "feature") !== "feature") continue;
    if (paused(store, { project, squad: topic })) continue;
    // A queued Builder follows its unit (hold-cancels-queue-undo-approval U1): one whose unit is no
    // longer ready, approved or open is withdrawn before anything new is wished, and a wish-less
    // gone row is settled so the unit can be wished again.
    withdrawRefused(store, project, topic, now);
    settleWithdrawn(store, project, topic, now);
    const units = store.db.query("SELECT id, slug, status, deps, ext_deps, hold, wait_until, superseded_by, into_merged, tier, plan FROM units WHERE project = ? AND squad = ? ORDER BY slug")
      .all(project, topic) as Unit[];
    const questions = waiting(store, project, topic).map(entryOf);
    for (const u of readyUnits(store, project, units, now, questions)) {
      if (planApproved(store, sq, u.plan)) ensureBuilder(store, project, topic, u, now);
      else noteUnapproved(store, project, topic, u);
    }
  }
  return extDepCards(store, project, now);
}

export default { name: "ready", run: ready } satisfies Reconciler;
