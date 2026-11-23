// archive-debrief.ts — debrief-on-archive U1: when a squad's wish becomes `gone`, its live Lead is asked
// once for the final debrief before the squad closes; once it reads closed, one Needs-you card.
//
// Per gone wish one step (squad/archive-debrief.ts, episode kind `archive-debrief`, key <want_at>):
//   opened   the Lead is live (running wish, worker present, not paused, suspended or limited) and
//            archive_debrief_min > 0: state open, the Lead asked through wake() until one poke is sent
//   skipped  at once, with why, otherwise
//   written  the squad doc's debrief_at is at or after the step's start
//   lead-gone  the Lead's worker went away mid-step (it is never restarted: effective()'s hold)
//   timeout  archive_debrief_min minutes after the step's start
// While the step is open effective() keeps the Lead on its own wish; once it settles the Lead closes
// like every other member and the squad archives (fulfil/squad.ts archive() writes the final debrief).
import { join } from "node:path";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { ROOT } from "../core/store.ts";
import { reality } from "../core/decide.ts";
import { paused } from "../pause/pause.ts";
import { wake } from "../pause/wake.ts";
import { alertAction } from "./alerts.ts";
import { KIND, finalDebrief, limitS, parseJson, provenance, stepKey, stepOf, unitsOf, type Step, type StepState } from "../squad/archive-debrief.ts";

export const REASON = "archive-debrief";

function leadOf(store: Store, sq: Row): Row | null {
  return store.db.query(`SELECT * FROM members WHERE project = ? AND squad = ? AND role = 'lead' AND COALESCE(suffix, '') = ''
    AND COALESCE(status, '') != 'gone' ORDER BY id DESC`).get(String(sq.project), String(sq.topic)) as Row | null;
}

// Why the Lead cannot be asked, or null when it is live.
function notLive(store: Store, sq: Row, lead: Row | null, now: number): string | null {
  if (limitS(store, String(sq.project)) <= 0) return "archive_debrief_min is 0";
  if (sq.status === "suspended") return "the squad is suspended";
  if (!lead || !lead.wt) return "no Lead";
  if (lead.want !== "running") return "the Lead is not wanted running";
  if (paused(store, lead as { project: string })) return "the Lead is paused";
  if (reality(store, lead, now) !== "running") return "the Lead is not running";
  const w = store.get("observed_workers", { project: lead.project, wt: lead.wt });
  if (Number(lead.limited_until ?? 0) > now || (w?.limited != null && String(w.limited) !== "")) return "the Lead is limited";
  return null;
}

function save(store: Store, sq: Row, now: number, state: StepState, p: Partial<Omit<Step, "state" | "settled_at">>): void {
  const key = stepKey(sq), ep = store.get("episodes", key);
  const fresh = ep?.episode_key !== String(sq.want_at);
  const body: Row = { ...(fresh ? {} : parseJson(ep?.result)), ...p };
  const settles = state !== "open" && (fresh || ep?.state === "open");
  store.upsert("episodes", key, { squad: String(sq.topic), episode_key: String(sq.want_at), state, source: "loop", observed_at: now, result: JSON.stringify(body),
    ...(fresh ? { started_at: now, count: 0, ended_at: state === "open" ? null : now } : settles ? { ended_at: now } : {}) });
  if (fresh || settles) store.event("archive_debrief", { project: String(sq.project), squad: String(sq.topic), member: (body.lead_wt as string | null) ?? null,
    payload: { id: Number(sq.id), want_at: Number(sq.want_at), state, why: body.why ?? null } });
}

const isoS = (v: unknown): number => { const t = Date.parse(String(v ?? "")); return Number.isFinite(t) ? Math.floor(t / 1000) : 0; };

export function askText(store: Store, sq: Row, limitMin: number): string {
  const project = String(sq.project), topic = String(sq.topic);
  const state = join(store.root, project, "squads", `${topic}.json`);
  return `dev-studio loop: the operator archives squad ${topic}. Before it closes, write the final debrief: rewrite all six parts so they cover every unit, ` +
    `each named with its PR, and mark the units added after your done-time debrief. Save it with ${ROOT}/bin/role/squad-state.sh ${state} set-debrief --file <path> ` +
    `and change nothing else (no units, no status, no messages to your team). The archive waits up to ${limitMin} min, then closes with the old debrief.`;
}

function step(ctx: TickCtx, sq: Row): Action[] {
  const { store, now } = ctx;
  let s = stepOf(store, sq);
  if (!s) {
    const lead = leadOf(store, sq), why = notLive(store, sq, lead, now), limit = limitS(store, String(sq.project));
    if (why) { save(store, sq, now, "skipped", { asked_at: now, limit_s: limit, lead_wt: (lead?.wt as string | null) ?? null, why }); return []; }
    save(store, sq, now, "open", { asked_at: now, limit_s: limit, lead_wt: String(lead!.wt), why: null });
    s = stepOf(store, sq)!;
  }
  if (s.state !== "open") return [];
  const doc = parseJson(sq.doc);
  if (isoS(doc.debrief_at) >= s.asked_at && typeof doc.debrief === "string" && doc.debrief.trim()) { save(store, sq, now, "written", {}); return []; }
  const lead = leadOf(store, sq);
  if (!lead || lead.wt !== s.lead_wt || lead.want !== "running" || reality(store, lead, now) === "none") {
    save(store, sq, now, "lead-gone", { why: !lead || lead.wt !== s.lead_wt ? "the Lead's worktree is gone" : lead.want !== "running" ? "the Lead's wish changed" : "the Lead's agent is gone" });
    return [];
  }
  if (now >= s.asked_at + s.limit_s) { save(store, sq, now, "timeout", { why: `no debrief within ${Math.round(s.limit_s / 60)} min` }); return []; }
  if (s.poked_at != null) return [];
  const w = wake({ ...ctx, project: String(sq.project) }, String(s.lead_wt), askText(store, sq, Math.round(s.limit_s / 60)), REASON, String(sq.want_at));
  if (w.status === "sent") save(store, sq, now, "open", { poked_at: now });
  return w.actions;
}

// Once the squad reads closed: one card per step, with the debrief's first line and where it came from.
function card(ctx: TickCtx, sq: Row, step: Step): Action[] {
  let s = step;
  const { store, now } = ctx, project = String(sq.project), topic = String(sq.topic);
  // The squad closed with the step still open (its Lead's worktree went some other way): settle it first.
  if (s.state === "open") { save(store, sq, now, "lead-gone", { why: "the squad closed before the step settled" }); s = stepOf(store, sq)!; }
  const final = finalDebrief(parseJson(sq.doc), unitsOf(store, project, topic), s.state === "written");
  const out = alertAction(store, { project, squad: null, key: `debrief-${topic}`, episode: String(sq.want_at), title: `Debrief: ${topic}`,
    text: `${final.first} — ${provenance(final)}.`, option: "Mark read",
    why: s.state === "written" ? "the Lead wrote the final debrief at archive" : `the archive closed with the done-time debrief (${s.state}${s.why ? `: ${s.why}` : ""})` });
  save(store, sq, now, s.state, { carded_at: now });
  return out;
}

export function archiveDebrief(ctx: TickCtx): Action[] {
  const { store, project } = ctx, out: Action[] = [];
  const rows = store.db.query(`SELECT s.* FROM squads s WHERE s.project = ? AND s.want = 'gone' AND s.want_at IS NOT NULL
    AND (COALESCE(s.status, '') != 'closed' OR EXISTS (SELECT 1 FROM episodes e WHERE e.project = s.project AND e.subject = 'squad:' || s.id AND e.kind = ?
      AND e.episode_key = CAST(s.want_at AS TEXT) AND json_extract(e.result, '$.carded_at') IS NULL)) ORDER BY s.id`).all(project, KIND) as Row[];
  for (const sq of rows) {
    if (sq.status === "closed") { const s = stepOf(store, sq); if (s) out.push(...card(ctx, sq, s)); continue; }
    if (["archived", "gone"].includes(String(sq.status ?? ""))) continue;
    out.push(...step(ctx, sq));
  }
  return out;
}

export default { name: "archive-debrief", run(ctx: TickCtx) { return archiveDebrief(ctx); } } satisfies Reconciler;
