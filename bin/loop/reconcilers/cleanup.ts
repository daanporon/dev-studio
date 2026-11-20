// reconcilers/cleanup.ts — host-disk-cleanup U2: judges each `observed_cleanup` row from loop.db
// alone (KTD2) and asks for the project's Host tidy card (`cleanup.report`, fulfil/cleanup.ts).
//   keep-set (KTD8)  a worktree id or path any project's rows still name is `live member`
//   refusals         a project with squads but an empty keep-set, or a pass whose backend worktree
//                    list failed (classes c and d), reads `report only`; so does a row with no project
//   floors (R9)      a process: 10 minutes after its worktree went; Claude temp dirs and glob files:
//                    cleanup_tmp_age_h (48) by mtime; helper checkouts, orphan folders and entities
//                    (and a process in one): 24 hours from orphaned_since
// orphaned_since is set the first time a row is found unreferenced (its first_seen when it was never
// judged, so a pass that finds a 3-day-old orphan does not restart its clock) and cleared when a
// reference returns. The card's episode is a hash of its text: it is rewritten only when it changes.
// U3: with host_tidy exactly `apply` (R4) and the project neither refused nor paused (R12), one
// `cleanup.act` (fulfil/cleanup-act.ts) for the first removable row, processes first then largest;
// none while another of the project's is acted or running (KTD9), and a waiting one is asked for
// again before any other. Its episode is the row's scan (observed_at, plus a glob's pass number), so
// each scan's finding is tried once and a kept or failed row waits for the next scan.
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { limit, limitInt } from "../settings/limits.ts";
import { actionBlock } from "../pause/pause.ts";
import { wtPath } from "../observers/orca.ts";
import type { Store } from "../core/store.ts";
import { cardText } from "../fulfil/cleanup.ts";
import { CLEANUP_ACT } from "../fulfil/cleanup-act.ts";

export const CLEANUP_REPORT = "cleanup.report";
export const cleanupSubject = (project: string) => `cleanup:${project}`;
export const PROC_FLOOR_S = 600, ORPHAN_FLOOR_S = 24 * 3600;
export const VERDICTS = ["removable", "in use by pid N", "dirty", "unpushed", "detached", "locked", "too new", "live member", "not ours", "report only"] as const;

export type KeepSet = { has(x: string | null | undefined): boolean; why(x: string | null | undefined): string | null; count(project: string): number };

// KTD8 over every project's rows: a worktree any of them names is kept, by id and by path.
export function keepSet(store: Store): KeepSet {
  const why = new Map<string, string>(), per = new Map<string, number>();
  const add = (project: unknown, x: unknown, reason: string) => {
    if (typeof x !== "string" || !x) return;
    for (const k of [x, wtPath(x)]) if (k && !why.has(k)) why.set(k, reason);
    const p = String(project ?? "");
    per.set(p, (per.get(p) ?? 0) + 1);
  };
  const q = (sql: string) => store.db.query(sql).all() as Record<string, unknown>[];
  for (const r of q("SELECT project, wt FROM members WHERE wt IS NOT NULL AND NOT (COALESCE(status, '') = 'gone' AND COALESCE(want, 'gone') = 'gone')")) add(r.project, r.wt, "member");
  for (const r of q("SELECT project, lead_wt, doc FROM squads")) {
    add(r.project, r.lead_wt, "lead");
    let doc: { leftovers?: { wt?: string; path?: string }[] } = {};
    try { doc = JSON.parse(String(r.doc ?? "{}")) ?? {}; } catch { /* not JSON: no leftovers */ }
    for (const l of Array.isArray(doc.leftovers) ? doc.leftovers : []) { add(r.project, l?.wt, "leftover"); add(r.project, l?.path, "leftover"); }
  }
  for (const r of q("SELECT label AS project, studio_wt FROM projects")) add(r.project, r.studio_wt, "studio");
  for (const r of q("SELECT project, wt FROM coordinators")) add(r.project, r.wt, "coordinator");
  for (const r of q("SELECT project, builder_wt FROM units WHERE status = 'cancelled'")) add(r.project, r.builder_wt, "cancelled unit");
  for (const r of q("SELECT project, wt FROM observed_workers WHERE presence = 'running'")) add(r.project, r.wt, "running worker");
  // An action still pending or running for a worktree: every id or absolute path its JSON carries.
  for (const r of q("SELECT project, action FROM episodes WHERE kind LIKE 'action:%' AND kind NOT LIKE 'action:cleanup.%' AND state IN ('acted', 'running', 'pending')")) {
    const walk = (v: unknown): void => {
      if (typeof v === "string") { if (v.includes("::/") || v.startsWith("/")) add(r.project, v, "pending action"); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    try { walk(JSON.parse(String(r.action ?? "null"))); } catch { /* unreadable: names nothing */ }
  }
  return { has: (x) => !!x && why.has(x), why: (x) => (x ? why.get(x) ?? null : null), count: (p) => per.get(p) ?? 0 };
}

export type CleanupRow = { project: string; class: string; key: string; path: string | null; pid: number | null; size_kb: number | null;
  mtime: number | null; first_seen: number; orphaned_since: number | null; facts: string | null; verdict: string | null };
export type Facts = Record<string, unknown> & {
  wt?: string; wt_id?: string; entity?: string; slug_wt?: string; session?: string; deleted?: boolean; wt_gone_at?: number | null;
  holder?: number | null; uid?: number; partial?: boolean; exists?: boolean; git?: boolean; locked?: boolean; detached?: boolean;
  probe?: { dirty: number; unpushed: number; unique: number; detached: boolean } | null;
  count?: number; removable?: number; too_new?: number; not_ours?: number; in_use?: number; in_use_pid?: number | null };
export type Judge = { keep: KeepSet; now: number; refused: string | null; psError: string | null; tmpAgeS: number; uid: number };

// A row's verdict (one of VERDICTS, `in use by pid N` with its pid) and its orphaned_since.
export function judge(r: CleanupRow, f: Facts, j: Judge): { verdict: string; orphaned_since: number | null } {
  const keepOf = r.class === "b" ? (f.session ? [] : [f.slug_wt]) : r.class === "e" ? [] : [f.wt_id, f.wt, f.entity, r.path];
  if (!r.project || j.refused || ((r.class === "c" || r.class === "d") && j.psError)) return { verdict: "report only", orphaned_since: r.orphaned_since };
  if (keepOf.some((x) => j.keep.has(x))) return { verdict: "live member", orphaned_since: null };
  const orphaned = r.orphaned_since ?? (r.verdict === null ? r.first_seen : j.now);
  const v = (verdict: string) => ({ verdict, orphaned_since: orphaned });
  const old = (since: number | null | undefined, floor: number) => since !== null && since !== undefined && j.now - since >= floor;
  if (f.uid !== undefined && f.uid !== j.uid) return v("not ours");
  if (f.holder) return v(`in use by pid ${f.holder}`);
  switch (r.class) {
    case "a": return v(f.deleted ? (old(f.wt_gone_at ?? orphaned, PROC_FLOOR_S) ? "removable" : "too new") : old(orphaned, ORPHAN_FLOOR_S) ? "removable" : "too new");
    case "b": return v(!f.partial && r.mtime && old(r.mtime, j.tmpAgeS) ? "removable" : "too new"); // a partial walk never saw its newest file
    case "c": case "d": {
      if (r.class === "d" && f.git === false) return v("report only");
      if (f.locked) return v("locked");
      const p = f.probe;
      if (f.exists !== false && !p) return v("too new"); // not probed yet: the next pass does
      if (p && p.dirty > 0) return v("dirty");
      if (p && p.unique > 0) return v("unpushed");
      if (f.detached || p?.detached) return v("detached");
      return v(old(orphaned, ORPHAN_FLOOR_S) ? "removable" : "too new");
    }
    case "e": {
      if ((f.removable ?? 0) > 0) return v("removable");
      const kept: [number, string][] = [[f.too_new ?? 0, "too new"], [f.not_ours ?? 0, "not ours"], [f.in_use ?? 0, `in use by pid ${f.in_use_pid ?? "?"}`]];
      return v(kept.reduce((a, b) => (b[0] > a[0] ? b : a))[1]);
    }
  }
  return v("report only");
}

export function parseFacts(s: string | null): Facts {
  try { return (s ? JSON.parse(s) : {}) ?? {}; } catch { return {}; }
}

// Why the project is refused this pass: squads but nothing in the keep-set names one of its worktrees.
export function refusal(store: Store, project: string, keep: KeepSet): string | null {
  const squads = Number((store.db.query("SELECT COUNT(*) AS n FROM squads WHERE project = ?").get(project) as { n: number }).n);
  return squads > 0 && keep.count(project) === 0 ? `project ${project} has squads but nothing in loop.db names a worktree of it` : null;
}

export function lastScan(store: Store): { ps_error: string | null; loose_count: number | null; loose_kb: number | null; observed_at: number } | null {
  return store.db.query("SELECT ps_error, loose_count, loose_kb, observed_at FROM observed_cleanup_scan ORDER BY observed_at DESC LIMIT 1").get() as never;
}

// The keep-set is host-wide and the reconciler runs once per project: build it once a tick.
const keepCache = new WeakMap<Store, { tick: number; keep: KeepSet }>();
function tickKeepSet(store: Store, tick: number): KeepSet {
  const c = keepCache.get(store);
  if (c && c.tick === tick) return c.keep;
  const keep = keepSet(store);
  keepCache.set(store, { tick, keep });
  return keep;
}

export function reconcile(ctx: TickCtx, uid = process.getuid?.() ?? -1): Action[] {
  const { store, project, now } = ctx;
  const scan = lastScan(store);
  if (!scan) return [];
  const keep = tickKeepSet(store, ctx.tick);
  const j: Judge = { keep, now, refused: refusal(store, project, keep), psError: scan.ps_error, uid,
    tmpAgeS: limitInt(store, project, "cleanup_tmp_age_h", 48) * 3600 };
  const rows = store.db.query("SELECT * FROM observed_cleanup WHERE project = ? AND gone_at IS NULL").all(project) as CleanupRow[];
  const set = store.db.query("UPDATE observed_cleanup SET verdict = ?, orphaned_since = ? WHERE project = ? AND class = ? AND key = ?");
  store.tx(() => {
    for (const r of rows) {
      const { verdict, orphaned_since } = judge(r, parseFacts(r.facts), j);
      if (verdict !== r.verdict || orphaned_since !== r.orphaned_since) set.run(verdict, orphaned_since, r.project, r.class, r.key);
    }
  });
  const out: Action[] = limit(store, project, "host_tidy") === "apply" && !j.refused ? apply(store, project) : [];
  const text = cardText(store, project, { refused: j.refused, now });
  // Nothing to report and no card ever raised: no card action (a resolve per project would be noise).
  if (text === null && !store.get("episodes", { project, subject: cleanupSubject(project), kind: `action:${CLEANUP_REPORT}` })) return out;
  return [{ project, subject: cleanupSubject(project), kind: CLEANUP_REPORT, episode: `report:${text === null ? "none" : Bun.hash(text).toString(36)}`, payload: { refused: j.refused } }, ...out];
}

export const actSubject = (cls: string, key: string) => `cleanup.act:${cls}:${key}`;

// The project's next cleanup.act, or none (see the header).
function apply(store: Store, project: string): Action[] {
  const open = store.db.query(`SELECT state, action FROM episodes WHERE project = ? AND kind = 'action:${CLEANUP_ACT}' AND state IN ('acted', 'running', 'pending') AND ended_at IS NULL`).all(project) as { state: string; action: string | null }[];
  if (open.some((e) => e.state !== "pending")) return [];
  const waiting = open.map((e) => { try { return (JSON.parse(e.action ?? "null") as { action?: Action } | null)?.action ?? null; } catch { return null; } }).find(Boolean);
  if (waiting) return actionBlock(store, waiting) === "paused" ? [] : [waiting];
  const rows = store.db.query("SELECT class, key, path, facts, observed_at FROM observed_cleanup WHERE project = ? AND gone_at IS NULL AND verdict = 'removable' ORDER BY class = 'a' DESC, COALESCE(size_kb, 0) DESC, key").all(project) as
    { class: string; key: string; path: string | null; facts: string | null; observed_at: number }[];
  for (const r of rows) {
    const subject = actSubject(r.class, r.key), pass = r.class === "e" ? Number(parseFacts(r.facts).act_pass ?? 0) : 0;
    const episode = `${r.observed_at}${pass ? `:${pass}` : ""}`;
    if (store.get("episodes", { project, subject, kind: `action:${CLEANUP_ACT}` })?.episode_key === episode) continue;
    const a: Action = { project, subject, kind: CLEANUP_ACT, episode, payload: { class: r.class, key: r.key, path: r.path } };
    return actionBlock(store, a) === "paused" ? [] : [a];
  }
  return [];
}

const cleanup: Reconciler = { name: "cleanup", run: (ctx) => reconcile(ctx) };
export default cleanup;
