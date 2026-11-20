// compaction.ts — sweep step 6 as a reconciler (U10, R17). Ported from the removed sweep on main at
// 0fbb8be654cda578a94410017c6a1d8c63f2e3e8 (compact_idle, studio_ctx, live_ctx).
//
// An idle/done Lead, Thinker or Builder (observed_workers; never working or waiting) quiet for
// compact_idle_min (default 55: the 1-hour prompt cache, U104) whose live context is at context_compact_<role> (else context_compact) gets
// `/<mode>` typed through wake() (reason `compact`), at most once per compact_cooldown_min: the
// last compaction is the newest of compacted.tsv (observed_compacted), the sweep's imported
// `compacted` episodes and the loop's own `wake:compact` episode, the compacted.tsv equivalent.
// mode = compact_mode_<role>: compact (default), clear, or off (never). Skipped: a Thinker with an
// open operator question it asked, and a Thinker of a squad still planning (running, no unit
// dispatched or done). clear stays clear only for a Lead with nothing in flight (no dispatched unit,
// no open question, no unread mail), or a Thinker with nothing open (clearThinker below); otherwise it
// is compact. The actuator re-reads the state
// before it types (a turn may have started since).
//
// U156: mode clear no longer types. It writes a loop `clear_at` wish instead (compaction never
// clears a Muse member: no signal confirms it); the decider types the agent's clear command once
// and a fresh transcript or rollout after it confirms the clear. The cooldown for a confirmed
// clear is cleared_at; while a clear is pending nothing is written again.
//
// The Studio (U263, compactStudio below) is typed into only through its adopted terminal handle, and
// only when studioReady() holds; otherwise, or with compact_mode_studio off, it gets ONE project alert
// (key studio.ctx) per episode; the episode ends with an `alert-clear` action once its context
// drops below, and the next rise is a new episode.
//
// Live context (live_ctx): the newest usage record in the worker's newest transcript (the last 300
// lines), input + cache_read + cache_creation; a compact_boundary after it is 0 (compacted, no
// reply since). Members' transcripts come from observed_transcripts; the Studio, which has none,
// from the newest *.jsonl in DS_TOKEN_DIR (~/.claude/projects)/<mangled path>.
import { paused } from "../pause/pause.ts";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { limit, limitInt } from "../settings/limits.ts";
import { mangle, wtPath } from "../observers/orca.ts";
import { newestJsonl, tailOf } from "../observers/state.ts";
import { studioReady, studioView } from "../squad/studio.ts";
import { envInt } from "../core/tick.ts";
import { wake } from "../pause/wake.ts";
import { alertAction } from "./alerts.ts";
import { tokenDir } from "./tokens.ts";

const ROLES = ["lead", "thinker", "builder"];
const memo = new Map<string, number | null>(); // `<path>|<mtime>|<size>` -> its live context

// live_ctx over a transcript's last 300 lines; null when no usage record is there.
export function contextOf(text: string): number | null {
  let ctx: number | null = null;
  for (const line of text.split("\n").slice(-300)) {
    let e: Row;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== "object") continue;
    const m = e.message as Row | undefined;
    if (e.type === "system" && e.subtype === "compact_boundary") ctx = 0;
    else if (e.type === "assistant" && m?.usage && m.model !== "<synthetic>") {
      const u = m.usage as Row;
      ctx = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
    }
  }
  return ctx;
}

export function liveCtx(store: Store, wt: string): number | null {
  const t = (store.db.query("SELECT path, mtime, size FROM observed_transcripts WHERE wt = ? ORDER BY mtime DESC").get(wt) as { path: string; mtime: number; size: number } | null)
    ?? newestJsonl(join(tokenDir(), mangle(wtPath(wt) ?? wt)));
  if (!t) return null;
  const k = `${t.path}|${t.mtime}|${t.size}`;
  if (!memo.has(k)) {
    if (memo.size > 500) memo.clear(); // gone workers' transcripts
    for (const old of memo.keys()) if (old.startsWith(`${t.path}|`)) memo.delete(old);
    memo.set(k, contextOf(tailOf(t.path, 4 * 1024 * 1024)));
  }
  return memo.get(k) ?? null;
}

// The newest compaction of a worktree: compacted.tsv, the sweep's imported rows, the loop's own.
function lastCompacted(store: Store, project: string, wt: string): number {
  const a = store.db.query("SELECT MAX(at) AS t FROM observed_compacted WHERE project = ? AND wt = ?").get(project, wt) as { t: number | null };
  // A poke the actuator did not send (U263: the Studio's guard failed at the last moment) is no compaction.
  const b = store.db.query("SELECT MAX(started_at) AS t FROM episodes WHERE project = ? AND subject = ? AND kind IN ('compacted', 'wake:compact') AND COALESCE(state, '') != 'unsent'").get(project, wt) as { t: number | null };
  return Math.max(a.t ?? 0, b.t ?? 0);
}

function squadDoc(store: Store, project: string, squad: string): { status: string | null; open: Row[] } {
  const s = store.db.query("SELECT status, doc FROM squads WHERE project = ? AND topic = ?").get(project, squad) as { status: string | null; doc: string | null } | null;
  let doc: Row = {};
  try { doc = JSON.parse(s?.doc ?? "{}") ?? {}; } catch { /* a torn doc: no questions */ }
  const open = Array.isArray(doc.waiting_on_you) ? (doc.waiting_on_you as Row[]).filter((q) => q && typeof q === "object") : [];
  return { status: s?.status ?? (doc.status as string) ?? null, open };
}

// A Thinker may be cleared (U144) only with no live work: every plan file of the squad approved, no
// file of its transcript dir (the session .jsonl and its subagents/) written inside the idle window,
// and nothing unread. The open-question and still-planning skips are checked by the caller.
export function clearThinker(store: Store, project: string, squad: string, wt: string, approved: unknown, unread: unknown, now: number, idleS: number): boolean {
  if (Number(unread ?? 0) > 0) return false;
  const have = new Set((Array.isArray(approved) ? approved : []).map((a) => basename(String(a))));
  try {
    for (const f of readdirSync(join(store.root, project, "squads")))
      if (f.startsWith(`${squad}-`) && f.endsWith("-plan.md") && !have.has(f)) return false;
  } catch { /* no squads dir: no plan files */ }
  const t = store.db.query("SELECT path FROM observed_transcripts WHERE wt = ? ORDER BY mtime DESC").get(wt) as { path: string } | null
    ?? newestJsonl(join(tokenDir(), mangle(wtPath(wt) ?? wt)));
  if (!t) return false; // no transcript to judge: stay with /compact
  const dir = dirname(t.path), base = basename(t.path, ".jsonl");
  const recent = (d: string): boolean => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return false; }
    for (const n of names) {
      try {
        const st = statSync(join(d, n));
        if (st.isDirectory() ? recent(join(d, n)) : now - st.mtimeMs / 1000 < idleS) return true;
      } catch { /* gone meanwhile */ }
    }
    return false;
  };
  // The session file and its <session>/ dir (subagents/, tool results); other sessions' files in the
  // directory are older conversations of the worktree.
  try { return !(recent(join(dir, base)) || now - statSync(t.path).mtimeMs / 1000 < idleS); } catch { return false; } // gone meanwhile: stay with /compact
}

const idle = (s: unknown) => s === "idle" || s === "done";

export function compactIdle(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx, out: Action[] = [];
  const ctxCompact = limitInt(store, project, "context_compact", 150_000);
  const idleS = limitInt(store, project, "compact_idle_min", 55) * 60, coolS = limitInt(store, project, "compact_cooldown_min", 30) * 60;
  // The latest row per slot (U152's rule): a wish is written where the decider reads it,
  // never on a stale twin sharing the worktree.
  const members = store.db.query(`SELECT id, squad, role, suffix, wt, agent, clear_at, cleared_at FROM members m WHERE project = ? AND wt IS NOT NULL AND COALESCE(status, '') != 'gone'
    AND role IN (${ROLES.map(() => "?").join(", ")}) AND m.id = (SELECT MAX(id) FROM members
      WHERE project = m.project AND squad = m.squad AND role = m.role AND suffix = m.suffix) ORDER BY squad, ord, id`).all(project, ...ROLES) as
    { id: number; squad: string; role: string; suffix: string; wt: string; agent: string | null; clear_at: number | null; cleared_at: number | null }[];
  for (const m of members) {
    if (paused(store, { project, ...m })) continue;
    const w = store.db.query("SELECT state, since, unread FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, m.wt) as Row | null;
    if (!w || !idle(w.state) || typeof w.since !== "number" || now - w.since < idleS) continue;
    let mode = limit(store, project, `compact_mode_${m.role}`) ?? "compact";
    if (mode === "off") continue;
    const c = liveCtx(store, m.wt);
    if (c === null) continue;
    const thr = limitInt(store, project, `context_compact_${m.role}`, ctxCompact);
    if (c < thr) continue;
    const last = lastCompacted(store, project, m.wt);
    if (last && now - last < coolS) continue;
    const sq = squadDoc(store, project, m.squad);
    if (m.role === "thinker") {
      // A Thinker idle on the operator, or one still planning, holds unwritten detail.
      if (sq.open.some((q) => String(q.asker ?? "").startsWith("thinker"))) continue;
      const started = store.db.query("SELECT COUNT(*) AS n FROM units WHERE project = ? AND squad = ? AND status IN ('dispatched', 'done')").get(project, m.squad) as { n: number };
      if (sq.status === "running" && started.n === 0) continue;
    }
    if (mode === "clear") {
      const inFlight = store.db.query("SELECT COUNT(*) AS n FROM units WHERE project = ? AND squad = ? AND status = 'dispatched'").get(project, m.squad) as { n: number };
      if (m.role === "thinker") {
        const doc = store.db.query("SELECT doc FROM squads WHERE project = ? AND topic = ?").get(project, m.squad) as { doc: string | null } | null;
        let approved: unknown = [];
        try { approved = JSON.parse(doc?.doc ?? "{}")?.approved_plans; } catch { /* torn doc */ }
        if (!clearThinker(store, project, m.squad, m.wt, approved, w.unread, now, idleS)) mode = "compact";
      } else if (m.role !== "lead" || inFlight.n > 0 || sq.open.length > 0 || Number(w.unread ?? 0) > 0) mode = "compact";
    }
    // U156: a clear is a wish, not a poke. The loop writes clear_at (by the loop: it expires
    // after 60 minutes; an operator's never does) and the decider types the agent's clear
    // command once the member is idle, confirmed by a fresh transcript or rollout. Nothing is
    // typed here. Muse has no clear signal, so a Muse member is never cleared. A clear still
    // pending, or one confirmed inside the cooldown, writes nothing.
    if (mode === "clear") {
      if (m.agent === "muse") continue;
      if (m.clear_at != null && Number(m.clear_at) > Number(m.cleared_at ?? 0)) continue;
      if (m.cleared_at != null && now - Number(m.cleared_at) < coolS) continue;
      store.wishOnce(String(m.id), "clear", { by: "loop", why: `context ${c} >= ${thr}` });
      continue;
    }
    const r = wake(ctx, m.wt, `/${mode}`, "compact", `${mode}@${now}`);
    for (const a of r.actions) out.push(a.kind === "poke" ? { ...a, payload: { ...(a.payload as Row), mode, ctx: c, thr, requireIdle: true } } : a);
  }
  return out;
}

// U263: how long the guard may keep an idle Studio over its threshold from /compact before the
// studio.ctx card asks the operator instead (seconds).
const studioHoldS = () => envInt("DS_LOOP_STUDIO_COMPACT_HOLD_S", 600);
const HOLD = { subject: "studio.compact", kind: "studio:hold" };

// The studio.ctx card's episode: one per rise; an alert-clear ends it, the next rise is a new one.
// why null: clear the card (the context dropped below); else raise it with that reason.
function studioCard(store: Store, project: string, wt: string, c: number, thr: number, why: string | null): Action[] {
  const key = "studio.ctx";
  const cleared = store.get("episodes", { project, subject: key, kind: "action:alert-clear" });
  const alerted = store.get("episodes", { project, subject: key, kind: "action:alert" }) ?? store.get("episodes", { project, subject: key, kind: "alerted" });
  if (why === null) {
    if (!alerted || (cleared && Number(cleared.started_at) >= Number(alerted.started_at))) return [];
    return [{ project, squad: null, subject: key, kind: "alert-clear", episode: `cleared@${alerted.started_at}`, payload: { target: "project", prefix: `sweep-${key}-` } }];
  }
  // A cleared episode is over: the next rise is a new one (the sweep's first episode is ctx|<wt>).
  const episode = cleared ? `ctx|${wt}|${cleared.started_at}` : `ctx|${wt}`;
  // A sweep still running beside the loop alerts each rise as ctx|<wt>: one it marked after our clear is filed.
  const sweep = store.get("episodes", { project, subject: key, kind: "alerted" });
  if (cleared && sweep && Number(sweep.observed_at) > Number(cleared.started_at) && String(sweep.state ?? "").includes(JSON.stringify(`ctx|${wt}`))) return [];
  return alertAction(store, { project, squad: null, key, episode, idEpisode: `ctx|${wt}`, title: "Studio context is high",
    text: `Studio context is ${c} (>= ${thr}) — ${why}; type /compact in the Studio when you reach a good point`,
    option: "done — I compacted the Studio", why: "type /compact in the Studio when you reach a good point" });
}

// The guard's hold on an idle Studio over its threshold: opens it if none is open, returns when it started.
function openHold(store: Store, project: string, now: number): number {
  const h = store.get("episodes", { project, ...HOLD });
  if (h && h.ended_at == null) return Number(h.started_at);
  store.upsert("episodes", { project, ...HOLD }, { started_at: now, ended_at: null, state: "holding", source: "loop", observed_at: now });
  return now;
}
function endHold(store: Store, project: string, now: number) {
  const h = store.get("episodes", { project, ...HOLD });
  if (h && h.ended_at == null) store.upsert("episodes", { project, ...HOLD }, { ended_at: now, state: "ended", observed_at: now });
}

// The Studio (U263, R8/R9). Over context_compact_studio, with compact_mode_studio compact (default)
// and an adopted terminal (members.handle, U261), the loop types `/compact` into that one handle
// through wake() (reason `compact`, the same episode and cooldown accounting as compactIdle) once
// studioReady() holds with compact_idle_min as its quiet window: no output on the handle and no
// transcript write for that long, an empty prompt row, no unread mail, no request for the Studio and
// no open question it asked. A busy Studio is the operator at work: nothing happens. Any other block
// (a draft at the prompt, unread mail, a waiting request, an open question, no prompt on screen)
// starts the hold; after DS_LOOP_STUDIO_COMPACT_HOLD_S (600) of it the studio.ctx card asks the
// operator, naming why. With compact_mode_studio off, or no adopted terminal, it is the card alone,
// as before U263: once the Studio is idle (observed_workers). The card clears once the context drops.
export function compactStudio(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx;
  const v = studioView(store, project);
  if (!v) return [];
  const c = liveCtx(store, v.wt);
  if (c === null) return [];
  const thr = limitInt(store, project, "context_compact_studio", limitInt(store, project, "context_compact", 150_000));
  if (c < thr) { endHold(store, project, now); return studioCard(store, project, v.wt, c, thr, null); }
  const mode = limit(store, project, "compact_mode_studio") ?? "compact";
  const handle = (v.member?.handle as string | null) || null;
  if (mode === "off" || !handle) {
    const w = store.db.query("SELECT state FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, v.wt) as { state: string | null } | null;
    if (!w || !idle(w.state)) return [];
    return studioCard(store, project, v.wt, c, thr, mode === "off" ? "compact_mode_studio is off, so the loop does not type there" : "the loop holds no Studio terminal to type /compact into");
  }
  const idleS = limitInt(store, project, "compact_idle_min", 55) * 60, coolS = limitInt(store, project, "compact_cooldown_min", 30) * 60;
  const last = lastCompacted(store, project, v.wt);
  if (last && now - last < coolS) return [];
  const r = studioReady(store, project, now, idleS);
  if (r.why.startsWith("busy")) { endHold(store, project, now); return []; }
  if (!r.ready) return now - openHold(store, project, now) < studioHoldS() ? [] : studioCard(store, project, v.wt, c, thr, `the loop could not compact it: ${r.why}`);
  endHold(store, project, now);
  const w = wake(ctx, v.wt, "/compact", "compact", `compact@${now}`, { handle });
  return w.actions.map((a) => a.kind === "poke" ? { ...a, payload: { ...(a.payload as Row), mode: "compact", ctx: c, thr, handle, quietS: idleS } } : a);
}

export default {
  name: "compaction",
  run(ctx: TickCtx) {
    return [...compactIdle(ctx), ...compactStudio(ctx)];
  },
} satisfies Reconciler;
