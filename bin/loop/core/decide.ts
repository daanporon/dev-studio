// decide.ts — the decider (U152): each tick, after the observers and before the reconcilers and
// fulfillers, every member's effective wish (member-state.ts view) is compared with its reality
// (observed_workers.presence, U149) and gives at most one act. compare() is the act table, pure:
//
//   lock held (a lifecycle claim acted/running, an Orca call sent/pending)      nothing
//   the archive's final-debrief hold (a Lead, squad/archive-debrief.ts)          nothing: no close, no start
//   stopped/archived/suspended, agent present (U155)                             close: stop
//   archived/suspended, no agent, worktree present (U155)                        close: remove
//   paused                                                                       nothing (the pause flow)
//   a pause resume its gate holds (pause-resume.ts resumeGate)                    nothing
//   unknown                                                                       nothing; one card past RECHECK_MIN
//   starting (placed, no walk since, within the spawn grace; past it: unknown)    nothing
//   running, a phase wish (or another model) not acted yet                        start (the handoff switches it)
//   running, a switch owed (switches.ts: limit, fallback, phase, pin)             stop when idle
//   working, stuck on its limit dialog (or silent past SILENT_MIN)                stop like idle
//   running, limited with nowhere to go                                           one tell ("carry on"); out of credits or login ended: none (U3)
//   running, its credits hold cleared while it still runs on that account (U3)    one tell ("works again")
//   running, its login hold cleared while it still runs on that account           one tell ("login works again", claude-login-ended U2)
//   running, reload pending and idle, no lifecycle act due (U156)                 one reload message with the ack command, once per reload_at
//   running, clear pending and idle, no lifecycle act due (U156)                  the agent's clear command once per clear_at (/clear, /new; never for Muse)
//   running                                                                       nothing
//   none, its start given up (want_result failed)                                 nothing (a new wish retries)
//   none, crash-capped (U64: third crash on one rung)                             nothing (liveness alerted)
//   none, broke again within REBREAK_MIN of a restart (not a standing role)       nothing; one card
//   none, no room (start slots, account, max_builders: the pick)                  nothing, no claim, no card
//   none                                                                          start
//
// The start is one act kind (`member`) on subject `member:<id>`, its episode the stable start key
// (member-state.ts startEpisode); fulfil/member.ts carries it out. The first tick a project's walk
// succeeds, its wishes are seeded from reality first (seed.ts).
import { existsSync } from "node:fs";
import { reconcile } from "../capacity/picks.ts";
import { graceS } from "../capacity/slot.ts";
import { crashCapped, lastStart, lastStopSent, lock, startEpisode, view, walkedGone, type View } from "../squad/member-state.ts";
import { effective, memberKey, intents, quote, type Target } from "../pause/pause.ts";
import { resumeGate } from "../reconcilers/pause-resume.ts";
import { knob, limit, stepOpen, turnEnded } from "../reconcilers/liveness.ts";
import { closeBusy } from "../squad/close-busy.ts";
import { limitStuck, switchFacts, toldAlready, type Switch } from "../capacity/switches.ts";
import { loginWorksAgain, TELL, worksAgain } from "../squad/handoff.ts";
import { HEADLESS } from "../observers/codex.ts";
import { wtPath as wtDir } from "../observers/orca.ts";
import { driftCleared, stopRetry } from "../squad/close-drift.ts";
import { wake } from "../pause/wake.ts";
import { ask as askCheckpoint, owed, pendingWhy, sweep as sweepCheckpoints } from "../pause/stop-checkpoint.ts";
import { seed } from "../db/seed.ts";
import { STANDING } from "../drivers/types.ts";
import { onContract } from "../squad/backend.ts";
import { finishOf } from "../squad/finish-read.ts";

import type { Action, Reconciler, TickCtx } from "./plugins.ts";
import { ROOT, type Row, type Store } from "./store.ts";
import { withDecideMemo } from "../capacity/walk-memo.ts";

export type Reality = "none" | "starting" | "running" | "unknown";
export type Facts = {
  view: View; lock: boolean; reality: Reality;
  hold?: boolean;          // the squad archives and its Lead writes the final debrief (effective() why archive-debrief)
  unknownS: number;        // how long reality has read unknown
  recheckS: number;        // RECHECK_MIN in seconds
  resume: boolean | null;  // a pause resume: may it start (null: none)
  switchDue: boolean;      // an unacted phase wish (reconcilers/phases.ts) on a live agent
  givenUp: boolean; capped: boolean; rebroke: boolean; room: boolean;
  stopDue?: "now" | "idle" | null;  // U153: a stop owed on a live agent (restart wish, hung, RSS)
  stopWhy?: string;
  idleOK?: boolean;        // idle, nothing undelivered, no live sub-agents
  switchStop?: Switch | null;  // U154: a switch owed on a live agent (limit, fallback, phase, pin)
  tellLimit?: string | null;   // U154: the tell key when it is limited with nowhere to go
  tellOk?: string | null;      // U3: the "works again" key once its credits hold was cleared (`login-ok|…`: its login hold)
  switchStuck?: boolean;       // U154: a working member stuck on its limit switches like an idle one
  hasWorktree?: boolean;       // U155: a worktree to remove once its agent is gone
  wt?: boolean;                // U158: a worktree id is recorded (its tree may already be gone)
  staleWtOk?: boolean;         // U158: the archived view is the squad's or its own wish, so a stale wt still removes
  closeOK?: boolean;           // U155: a live agent may be stopped now (its own wish says so, its squad is archived, or it is not working/waiting)
  reloadDue?: boolean;         // U156: reload_at newer than reloaded_at
  clearDue?: boolean;          // U156: clear_at newer than cleared_at
  clearCmd?: "/clear" | "/new" | null;  // U156: the agent's clear command (null: no signal, e.g. Muse)
  checkpoint?: string | null;  // U266: the why of an owed stop still waiting on its journal checkpoint (stop-checkpoint.ts)
};
export type Act = { act: "start" } | { act: "stop"; why: string } | { act: "checkpoint"; why: string } | { act: "tell"; why: "limit" | "credits-ok" | "login-ok" } | { act: "card"; why: "unknown" | "rebroke" }
  | { act: "reload" } | { act: "clear" } | { act: "close"; phase: "stop" | "remove"; why: string } | null;

export function compare(f: Facts): Act {
  if (f.lock || f.hold) return null;
  // U155: a stopped member is never restarted; an archived one is closed, then its worktree
  // removed. A cancelled Builder is cancel.ts's, filtered out first.
  if (f.view === "suspended") {
    // U158: a live agent is the pause flow's (checkpoint, 5 min, close); once it is gone,
    // its worktree is removed and its wt cleared, so a resume starts it fresh.
    if (f.reality === "none" && (f.hasWorktree || f.wt)) return { act: "close", phase: "remove", why: "suspended" };
    return null;
  }
  if (f.view === "stopped" || f.view === "archived") {
    // A view derived from a finished unit (its own wish still reads running) closes only
    // once the member is not working or waiting, as lifecycle step 1c gated its retire.
    if (f.reality === "running") return f.closeOK === false ? null : { act: "close", phase: "stop", why: f.view };
    if (f.view !== "stopped" && f.reality === "none" && (f.hasWorktree || (f.wt && f.staleWtOk))) return { act: "close", phase: "remove", why: f.view };
    return null;
  }
  if (f.view !== "running" || f.resume === false) return null;
  if (f.reality === "unknown") return f.unknownS >= f.recheckS ? { act: "card", why: "unknown" } : null;
  if (f.reality === "starting") return null;
  if (f.reality === "running") {
    // U266: an owed restart (idle mode), rss, fallback, pin or account (U5) stop asks for its journal checkpoint
    // first. The ask holds the room the stop will use, so a move up keeps its seat meanwhile.
    if (f.stopDue && (f.stopDue === "now" || f.idleOK) && f.room)
      return f.checkpoint && f.checkpoint === f.stopWhy ? { act: "checkpoint", why: f.checkpoint } : { act: "stop", why: f.stopWhy ?? "restart" };
    if (f.switchStop && (f.idleOK || f.switchStuck) && f.room)
      return f.checkpoint && f.checkpoint === f.switchStop.why ? { act: "checkpoint", why: f.checkpoint } : { act: "stop", why: f.switchStop.why };
    if (f.tellLimit && !f.room) return { act: "tell", why: "limit" };
    if (f.tellOk) return { act: "tell", why: f.tellOk.startsWith("login-ok|") ? "login-ok" : "credits-ok" };
    // Lifecycle acts win over the confirmation messages below: a fresh session from a start
    // satisfies a pending reload or clear by itself, and an unconfirmed message must never
    // wedge a switch start or a tell behind it.
    if (f.switchDue && f.room) return { act: "start" };
    if (f.reloadDue && f.idleOK) return { act: "reload" };
    if (f.clearDue && f.clearCmd && f.idleOK) return { act: "clear" };
    return null;
  }
  if (f.givenUp || f.capped) return null;
  if (f.rebroke) return { act: "card", why: "rebroke" };
  return f.room ? { act: "start" } : null;
}

// Reality as the decider reads it: running, none or unknown from presence (U149). A member the loop
// placed that no walk has read since (no worker row yet, or one older than the start) is "starting"
// for the spawn grace (DS_SWEEP_SPAWN_GRACE_MIN), then unknown: never a second start beside it.
// U12: a squad off Orca has no dispatch, so its reality is the process walk alone (walkReality).
export function reality(store: Store, m: Row, now: number): Reality {
  if (onContract(store, String(m.project), String(m.squad))) return walkReality(store, m, now);
  const w = m.wt ? store.get("observed_workers", { project: m.project, wt: m.wt }) : null, placed = lastStart(m);
  const unread = !w || w.gone_at != null || Number(w.account_at ?? 0) <= placed;
  // account-move-slow U2: the loop stopped it and a walk read since found no agent, while Orca's
  // dispatch for the old agent still holds presence at running: it is gone, so its start goes now.
  // Only a stop since the last start counts; a start placed after it takes the paths below.
  if (w && w.gone_at == null && w.walk === "none" && w.presence === "running") {
    const sent = lastStopSent(store, m);
    if (sent > placed && walkedGone(w, sent)) return "none";
    if (sent <= placed && deadUnderOrca(store, m, w, placed, now)) return "none";
  }
  if (w && w.gone_at == null && w.presence === "running") return "running";
  // U231: the worker went away after the last start: that is a fact, not "started, not seen yet".
  if (w && w.gone_at != null && Number(w.gone_at) > placed) return "none";
  if (placed && unread) return now - placed < graceS() ? "starting" : "unknown";
  if (!w || w.gone_at != null || w.presence === "none") return "none";
  return "unknown";
}

// U21a: after a KILL Orca can keep a member `working` (presence running) while no agent runs in its
// worktree. noAgentSince() is, for a member with a generation, when every successful walk since a time after its last start began finding
// no agent (walk_none_at, kept by the Orca observer: a failed or split walk keeps it, a walk that finds the
// agent clears it), while its transcript has not grown since and it has no finish row of its generation;
// null otherwise. It is gone once that held for GONE_MIN. The caller checks the loop did not stop it (a
// loop stop is walkedGone's).
export function noAgentSince(store: Store, m: Row, w: Row, placed: number): number | null {
  const since = Number(w.walk_none_at ?? 0);
  // Only a start that carries a generation: a Codex, Muse or `--on` start has none, and an `--on` one runs
  // on another host, where this host's walk never sees its agent (the shadow leaves them out too).
  if (!m.gen || w.walk !== "none" || !(since > placed)) return null;
  const t = store.db.query("SELECT MAX(mtime) AS t FROM observed_transcripts WHERE wt = ?").get(String(m.wt)) as { t: number | null } | null;
  if (Number(t?.t ?? 0) > since) return null;
  return finishOf(store, m) ? null : since;
}
export const goneMinS = (store: Store, project: string) => knob(store, project, "GONE_MIN", 3) * 60;
function deadUnderOrca(store: Store, m: Row, w: Row, placed: number, now: number): boolean {
  const since = noAgentSince(store, m, w, placed);
  return since != null && now - since >= goneMinS(store, String(m.project));
}

// Reality from the process walk alone (U10's new input, U12's for a squad off Orca): an agent process
// in the member's worktree is running, none is none, a failed or split walk unknown; a start no walk
// has read since is starting for the spawn grace, then unknown. A shell left open is no agent.
export function walkReality(store: Store, m: Row, now: number): Reality {
  const w = m.wt ? store.get("observed_workers", { project: m.project, wt: m.wt }) : null, placed = lastStart(m);
  const unread = !w || w.gone_at != null || Number(w.account_at ?? 0) <= placed;
  if (w && w.gone_at == null && w.walk === "running") return "running";
  if (w && w.gone_at != null && Number(w.gone_at) > placed) return "none";
  if (placed && unread) return now - placed < graceS() ? "starting" : "unknown";
  if (!w || w.gone_at != null || w.walk === "none") return "none";
  return "unknown";
}

const payloadOf = (m: Row): Row => { try { return JSON.parse(String(m.want_payload ?? "{}")) ?? {}; } catch { return {}; } };
const ACTED = ["start", undefined];
// A wish not acted yet that names another agent or model than the member runs on: written while its
// start was out (that call keeps what it first asked for), it is owed once the start settles.
const pinsOther = (m: Row, w: Row) => (!!w.model && w.model !== m.model) || (!!w.agent && w.agent !== m.agent);

// A restart of this member (not its first start) the loop made, within REBREAK_MIN, and it is gone
// again: the old liveness rule "broke again within REBREAK_MIN of a restart; auto-restart stopped".
// A wish or a --restart written since lifts it, and so does a stop the loop itself made since the restart
// (U288: phase switch, hung, rss, model switch; its `member_stopped` event): a planned stop is followed
// by a planned start, not read as a crash.
function loopStopped(store: Store, m: Row, since: number): boolean {
  return !!store.db.query(`SELECT 1 FROM events WHERE kind = 'member_stopped' AND project = ? AND at >= ?
    AND json_extract(payload, '$.id') = ? LIMIT 1`).get(String(m.project), since, Number(m.id));
}

function rebroke(store: Store, m: Row, now: number): boolean {
  if (STANDING.has(String(m.role))) return false;
  const r = store.get("episodes", { project: m.project, subject: `member:${m.id}`, kind: "restarted" });
  const at = Number(r?.started_at ?? 0);
  if (at && loopStopped(store, m, at)) return false;
  return !!at && now - at < knob(store, String(m.project), "REBREAK_MIN", 30) * 60
    && !(Number(m.restart_at ?? 0) > at) && !(Number(m.want_at ?? 0) > at && m.want_by !== "seed");
}

// How long this member's reality has read unknown: the `presence_unknown` episode, opened and
// closed here.
function unknownFor(store: Store, m: Row, r: Reality, now: number): number {
  const key = { project: m.project, subject: `member:${m.id}`, kind: "presence_unknown" };
  const row = store.get("episodes", key), open = row && row.ended_at == null;
  if (r !== "unknown") { if (open) store.upsert("episodes", key, { ended_at: now, state: "closed", observed_at: now }); return 0; }
  if (!open) { store.upsert("episodes", key, { squad: m.squad, started_at: now, ended_at: null, state: "open", source: "loop", observed_at: now }); return 0; }
  return now - Number(row.started_at);
}

// U156: the signal a clear is confirmed by — the member's newest transcript (Claude) or rollout
// (Codex) path, as the observers read it. The transcript pick mirrors memberTranscript's: a
// reviewer's headless `claude -p` file beside the member's own never counts. Muse has no signal.
function clearSignal(store: Store, m: Row): string | null {
  const wt = String(m.wt ?? "");
  if (!wt) return null;
  if (m.agent === "claude") {
    return (store.db.query(`SELECT path FROM observed_transcripts WHERE project = ? AND wt = ?
      ORDER BY CASE WHEN COALESCE(entrypoint, '') = 'sdk-cli' THEN 1 ELSE 0 END, mtime DESC LIMIT 1`)
      .get(String(m.project), wt) as { path: string } | null)?.path ?? null;
  }
  if (m.agent === "codex") {
    const cwd = wtDir(wt);
    if (!cwd) return null;
    return (store.db.query(`SELECT path FROM observed_rollouts WHERE cwd = ?
      AND COALESCE(originator, '') NOT IN (SELECT value FROM json_each(?)) ORDER BY mtime DESC LIMIT 1`)
      .get(cwd, JSON.stringify([...HEADLESS])) as { path: string } | null)?.path ?? null;
  }
  return null;
}

// U156: clear confirmation. The baseline (episodes kind `clear_baseline`) is the newest signal
// path seen for this clear_at; a different path now is the agent's fresh transcript or rollout
// after the clear, so cleared_at is written with one event. True while the clear is still due.
function watchClear(store: Store, m: Row, clearAt: number, now: number): boolean {
  const key = { project: String(m.project), subject: `member:${m.id}`, kind: "clear_baseline" };
  const base = String(store.get("episodes", key)?.episode_key ?? "");
  if (!base.startsWith(`${clearAt}:`)) {
    store.upsert("episodes", key, { squad: String(m.squad), episode_key: `${clearAt}:${clearSignal(store, m) ?? ""}`,
      started_at: now, ended_at: null, state: "watching", source: "loop", observed_at: now });
    return true;
  }
  const path = clearSignal(store, m);
  if (path != null && path !== base.slice(String(clearAt).length + 1)) {
    store.upsert("members", { id: m.id }, { cleared_at: now });
    store.event("cleared", { project: String(m.project), squad: String(m.squad), member: (m.wt as string | null) ?? null,
      payload: { id: m.id, at: now, from: base, path } });
    m.cleared_at = now;
    return false;
  }
  return true;
}

function clearFacts(store: Store, m: Row, now: number): Pick<Facts, "reloadDue" | "clearDue" | "clearCmd"> {
  const reloadDue = Number(m.reload_at ?? 0) > Number(m.reloaded_at ?? 0);
  const clearAt = Number(m.clear_at ?? 0);
  const clearDue = clearAt > Number(m.cleared_at ?? 0) && watchClear(store, m, clearAt, now);
  return { reloadDue, clearDue, clearCmd: m.agent === "claude" ? "/clear" : m.agent === "codex" ? "/new" : null };
}

type Seen = { m: Row; f: Omit<Facts, "room">; resume: Row | null };

// Every member the compare looks at: the latest row per identity, not the Studio, wanted running,
// stopped or archived (U155), or of a suspended/archived squad; off the roster (status gone or
// closed) only when a pause resume asks for it. A pre-U159 wish still carrying a script replay is
// a plain wish: no script runs it anymore, so the compare reads its want like any other.
// Oldest wish first.
function members(store: Store): Row[] {
  return store.db.query(`SELECT m.* FROM members m LEFT JOIN squads s ON s.project = m.project AND s.topic = m.squad
    WHERE m.role != 'studio'
      AND (COALESCE(m.status, '') NOT IN ('gone', 'closed') OR EXISTS (SELECT 1 FROM pause_members p WHERE p.project = m.project
        AND p.squad = m.squad AND p.role = m.role AND p.suffix = COALESCE(m.suffix, '') AND p.state = 'resuming'))
      AND (m.want IN ('running', 'stopped', 'gone')
        OR COALESCE(s.want, s.status) IN ('suspended', 'gone', 'closed', 'archived') OR s.status IN ('suspended', 'gone', 'closed', 'archived'))
      AND m.id = (SELECT MAX(id) FROM members WHERE project = m.project AND squad = m.squad AND role = m.role AND suffix = m.suffix)
    ORDER BY m.want_at IS NULL, m.want_at, m.id`).all() as Row[];
}

// A cancelled Builder is cancel.ts's own close (it also closes the PR): never the decider's.
export function isCancel(store: Store, m: Row): boolean {
  try { if ((JSON.parse(String(m.want_payload ?? "{}")) as Row)?.cancel) return true; } catch { /* no payload */ }
  if (m.role !== "builder") return false;
  const u = m.suffix ? store.get("units", { project: m.project, squad: m.squad, slug: m.suffix }) : null;
  if (u?.status === "cancelled") return true;
  return !!m.wt && !!store.db.query("SELECT 1 FROM units WHERE project = ? AND squad = ? AND builder_wt = ? AND status = 'cancelled'").get(String(m.project), String(m.squad), String(m.wt));
}

// U153 stop facts on a live agent: a restart wish newer than the process start, a hung agent
// (liveness's signals: working, no output for HUNG_MIN, not a long step, not a dialog), or an
// idle agent over restart_rss_gb (at most once per 60 min). Pause wins via view() in compare().
function stopFacts(store: Store, m: Row, now: number): Pick<Facts, "stopDue" | "stopWhy" | "idleOK"> {
  const w = m.wt ? store.get("observed_workers", { project: m.project, wt: m.wt }) : null;
  if (!w || w.presence !== "running") return { stopDue: null };
  const procStart = Number(w.started_at ?? 0) || lastStart(m);
  const idleOK = (w.state === "idle" || w.state === "done") && w.sub_agents == null
    && !store.db.query("SELECT 1 FROM deliveries WHERE project = ? AND member = ? AND state = 'accepted' LIMIT 1").get(String(m.project), String(m.wt));
  // A fresh session satisfies pending reload/clear wishes too. The row is mutated alongside
  // the write so clearFacts on the same tick sees the wish as met (else the tick still types it).
  for (const k of ["reload", "clear"] as const) {
    const at = Number(m[`${k}_at`] ?? 0), met = Number(m[`${k === "reload" ? "reloaded" : "cleared"}_at`] ?? 0);
    if (at && procStart > at && met < procStart) {
      store.upsert("members", { id: m.id }, { [`${k === "reload" ? "reloaded" : "cleared"}_at`]: procStart });
      m[`${k === "reload" ? "reloaded" : "cleared"}_at`] = procStart;
    }
  }
  // A loop-made restart wish expires after 60 minutes; an operator's never does.
  let restartAt = Number(m.restart_at ?? 0);
  if (restartAt && m.restart_by === "loop" && now - restartAt > 3600) {
    store.upsert("members", { id: m.id }, { restart_at: null, restart_mode: null });
    store.event("wish_expired", { project: String(m.project), squad: String(m.squad), member: (m.wt as string | null) ?? null, payload: { id: m.id, field: "restart_at", at: restartAt } });
    restartAt = 0;
  }
  // U156: a loop-made clear wish expires after 60 minutes the same way; an operator's never
  // does (the board shows its age). A reload wish never expires, whoever wrote it.
  if (Number(m.clear_at ?? 0) > Number(m.cleared_at ?? 0) && m.clear_by === "loop" && now - Number(m.clear_at) > 3600) {
    store.upsert("members", { id: m.id }, { clear_at: null });
    store.event("wish_expired", { project: String(m.project), squad: String(m.squad), member: (m.wt as string | null) ?? null, payload: { id: m.id, field: "clear_at", at: Number(m.clear_at) } });
    m.clear_at = null;
  }
  if (restartAt > procStart) return { stopDue: m.restart_mode === "now" ? "now" : "idle", stopWhy: "restart", idleOK };
  // Hung: one stop per break, none within REBREAK_MIN of the last loop restart.
  const out = Number(w.last_output_at ?? 0), hungMin = knob(store, String(m.project), "HUNG_MIN", 30);
  const lastRestart = Number(store.get("episodes", { project: m.project, subject: `member:${m.id}`, kind: "restarted" })?.started_at ?? 0);
  if (w.state === "working" && out > 0 && now - out >= hungMin * 60 && !(now - lastRestart < knob(store, String(m.project), "REBREAK_MIN", 30) * 60 && lastRestart > 0)
    && !/What do you want to do\?/.test(String(w.tail ?? "")) && !(stepOpen(store, String(m.wt)) && now - out < (Number(limit(store, String(m.project), "long_step_min") ?? 60) || 60) * 60 + hungMin * 60)
    && !turnEnded(store, String(m.wt)))
    return { stopDue: "now", stopWhy: "hung", idleOK };
  const rssGb = limit(store, String(m.project), "restart_rss_gb");
  const gb = rssGb && rssGb !== "-" ? Number(rssGb) : NaN;
  if (Number.isFinite(gb) && gb > 0 && Number(w.rss_kb ?? 0) > gb * 1024 * 1024) {
    const last = Number(store.get("episodes", { project: m.project, subject: `member:${m.id}`, kind: "rss_restart" })?.started_at ?? 0);
    // Not within REBREAK_MIN of the last restart: rebroke() would refuse its start (as the hung stop guards).
    if (now - last >= 3600 && !(lastRestart > 0 && now - lastRestart < knob(store, String(m.project), "REBREAK_MIN", 30) * 60)) return { stopDue: "idle", stopWhy: "rss", idleOK };
  }
  return { stopDue: null, idleOK };
}

function look(store: Store, m: Row, now: number): Seen {
  const r = reality(store, m, now), resume = store.get("pause_members", memberKey(m as Target));
  const resuming = resume?.state === "resuming" && !intents(store, m as Target).length;
  const w = payloadOf(m);
  const sw = switchFacts(store, m, now), stops = stopFacts(store, m, now);
  const tree = m.wt ? store.get("observed_worktrees", { project: m.project, wt: m.wt }) : null;
  const why = effective(store, m).why;
  const wtPath = tree?.path ? String(tree.path) : m.wt && String(m.wt).includes("::") ? String(m.wt).split("::").at(-1)! : "";
  return { m, resume: resuming ? resume : null, f: {
    view: view(store, m), lock: lock(store, m), reality: r, hold: why === "archive-debrief", switchStuck: limitStuck(store, m, now),
    closeOK: ["stopped", "gone"].includes(String(m.want ?? "")) || why === "squad" || !closeBusy(store, m),
    hasWorktree: !!m.wt && ((!!tree && tree.gone_at == null) || (!!wtPath && existsSync(wtPath))),
    wt: !!m.wt,
    staleWtOk: why === "squad" || m.want === "gone",
    unknownS: unknownFor(store, m, r, now), recheckS: knob(store, String(m.project), "RECHECK_MIN", 5) * 60,
    resume: resuming ? resumeGate(store, m, resume!) : null,
    switchDue: m.want_result == null && (!ACTED.includes(w.why as string | undefined) || pinsOther(m, w)),
    givenUp: String(m.want_result ?? "").startsWith("failed"), capped: crashCapped(store, m), rebroke: rebroke(store, m, now),
    switchStop: sw.stop, tellLimit: sw.tell, tellOk: sw.ok,
    ...stops, checkpoint: pendingWhy(store, m, { ...stops, switchStop: sw.stop }),
    ...clearFacts(store, m, now),
  } };
}

// The members that would act if there were room: the pick (picks.ts) places these, in this order.
// `moves` (U180): those whose act would be the fallback stop, whose pick must land above their rung.
export type Wanting = { eligible: Row[]; moves: Map<number, Switch> };
function wanting(seen: Seen[]): Wanting {
  const acts = seen.map((s) => ({ s, a: compare({ ...s.f, room: true }) })).filter(({ a }) => a?.act === "start" || a?.act === "stop" || a?.act === "checkpoint");
  return { eligible: acts.map(({ s }) => s.m),
    moves: new Map(acts.filter(({ a }) => a?.act !== "start" && a?.why === "fallback").map(({ s }) => [Number(s.m.id), s.f.switchStop!])) };
}
export function candidates(store: Store, now: number): Wanting {
  return wanting(members(store).filter((m) => !isCancel(store, m)).map((m) => look(store, m, now)));
}

const who = (m: Row) => `${m.role}${m.suffix ? ` ${m.suffix}` : ""} of ${m.squad}`;
// U20a: one rebroke card per member while its starts keep breaking. The loop starts it again once
// REBREAK_MIN has passed, so each break would open a new card under `rebroke:<restart time>`; the
// `rebroke-run` episode keeps the first break's time (the card's key), the tries so far (count) and the
// last restart counted (ended_at). A break whose restart came right after the last card's window joins the
// run; a start that survived REBREAK_MIN leaves a gap longer than half of it, so the next break is a new run.
function rebreakRun(store: Store, m: Row, restart: number, now: number): { first: number; tries: number } {
  const key = { project: m.project, subject: `member:${m.id}`, kind: "rebroke-run" };
  const r = store.get("episodes", key), gap = knob(store, String(m.project), "REBREAK_MIN", 30) * 30;
  let first = restart, tries = 1;
  if (r && Number(r.ended_at) === restart) { first = Number(r.started_at); tries = Number(r.count ?? 1); }   // the same break, seen again
  else if (r && restart > Number(r.ended_at) && restart - Number(r.observed_at) <= gap) { first = Number(r.started_at); tries = Number(r.count ?? 1) + 1; }
  store.upsert("episodes", key, { squad: m.squad, started_at: first, ended_at: restart, count: tries, state: "open", source: "loop", observed_at: now });
  return { first, tries };
}

function card(m: Row, why: "unknown" | "rebroke", f: Omit<Facts, "room">, store: Store, now: number): Action {
  const since = store.get("episodes", { project: m.project, subject: `member:${m.id}`, kind: why === "unknown" ? "presence_unknown" : "restarted" })?.started_at;
  const mins = Math.round(knob(store, String(m.project), "REBREAK_MIN", 30));
  const run = why === "rebroke" ? rebreakRun(store, m, Number(since ?? 0), now) : null;
  const text = why === "unknown"
    ? `The loop cannot tell whether the ${who(m)} runs (${m.wt}): the process walk has read unknown for ${Math.round(f.unknownS / 60)} min. It starts nothing until it can tell.`
    : `The ${who(m)} (${m.wt}) is gone again within ${mins} min of a restart (${run!.tries} ${run!.tries === 1 ? "try" : "tries"} so far). The loop tries again every ${mins} min and keeps this one card until a start lasts.`;
  return { project: String(m.project), squad: String(m.squad), member: (m.wt as string | null) ?? null, subject: `member:${m.id}`, kind: "alert",
    episode: `${why}:${run ? run.first : (since ?? 0)}`, payload: { title: why === "unknown" ? "Agent presence unknown" : "Agent broke again", ...(why === "rebroke" ? { card: "agent_rebroke" } : {}), text,
      option: why === "unknown" ? "look at the worktree's processes (orca.sh agent-accounts)" : "look at it, then restart it by hand (ds want member <id> --restart)",
      why: why === "unknown" ? "a start beside a live agent would make a second session" : "a start that breaks again within the window is retried, not forgotten" } };
}

function stopCard(m: Row, tries: number, store: Store): Action {
  return { project: String(m.project), squad: String(m.squad), member: (m.wt as string | null) ?? null, subject: `member:${m.id}`, kind: "alert",
    episode: `stopfail:${Number(m.want_at ?? 0)}`, payload: { title: "Agent did not stop",
      text: `The ${who(m)} (${m.wt}) still runs after ${tries} stops that reported done. The loop stops asking.`,
      option: "look at the worktree's terminals and processes, stop it by hand (orca.sh worker-stop)",
      why: "its squad cannot close while the agent runs" } };
}

// U156: the reload instruction typed into an idle member's terminal. It carries the ack command
// with its own address, so the member confirms from the terminal that received it.
export function reloadText(store: Store, m: Row): string {
  const cmd = `DS_STATE_ROOT=${quote(store.root)} ${[`${ROOT}/bin/ds`, "reload", "ack",
    String(m.project), String(m.squad), String(m.role), String(m.suffix || "-")].map(quote).join(" ")}`;
  return `dev-studio reload: re-read ${ROOT}/AGENTS.md and your ${ROOT}/roles/${m.role}.md, and have your role children re-read theirs, then continue. ` +
    `Confirm ONLY from this terminal with: ${cmd}. This is not worker_done.`;
}

// `credits-ok|<agent>/<account>|<notice>@<started>` -> [agent, account].
function splitAccount(key: string): [string, string] {
  const acct = key.split("|")[1] ?? "", i = acct.indexOf("/");
  return [acct.slice(0, i), acct.slice(i + 1)];
}

// Host scope: seed, compare, pick, act. Every pick() of one decide reads the limits rows and the machine sample
// once (walk-memo.ts withDecideMemo; the picks walk keeps more, withWalkMemo).
export function decide(ctx: TickCtx): Action[] {
  return withDecideMemo(ctx.store, ctx.now, () => decideNow(ctx));
}
function decideNow(ctx: TickCtx): Action[] {
  const { store, now } = ctx;
  seed(ctx);
  const seen = members(store).filter((m) => !isCancel(store, m)).filter((m) => !driftCleared(store, m, now)).map((m) => look(store, m, now));
  const room = reconcile(ctx, wanting(seen));
  const out: Action[] = [];
  sweepCheckpoints(ctx, new Map(seen.map((s) => [Number(s.m.id), { m: s.m, owed: owed(store, s.m, s.f), idle: !!s.f.idleOK || s.f.reality === "none" }])));
  for (const s of seen) {
    let act = compare({ ...s.f, room: room.has(Number(s.m.id)) });
    if (!act) continue;
    if (act.act === "checkpoint") {
      // One step of the checkpoint; once it settled (proved or timed out) the stop goes this tick.
      const step = askCheckpoint(ctx, s.m, owed(store, s.m, s.f)!);
      if (!step.settled) { out.push(...step.actions); continue; }
      act = { act: "stop", why: act.why };
    }
    if (act.act === "card") { out.push(card(s.m, act.why, s.f, store, now)); continue; }
    if (act.act === "tell") {
      // U3's "works again" names the account its credits episode was on (`<agent>/<account>|<notice>`).
      const wt = String(s.m.wt ?? ""), project = String(s.m.project), key = act.why === "limit" ? s.f.tellLimit! : s.f.tellOk!;
      const text = act.why === "limit" ? TELL : act.why === "login-ok" ? loginWorksAgain : worksAgain(...splitAccount(key));
      if (wt && !toldAlready(store, project, wt, key, act.why))
        out.push(...wake({ ...ctx, project }, wt, text, act.why, key, { allowLimited: true, cap: 1 }).actions);
      continue;
    }
    // U156: the reload instruction (carrying the ack command, once per reload_at) and the
    // agent's clear command (once per clear_at) go through wake, so its backoff and cap hold
    // while the member stays idle. No room is needed: these are pokes, not starts.
    if (act.act === "reload" || act.act === "clear") {
      const wt = String(s.m.wt ?? ""), project = String(s.m.project);
      if (!wt) continue;
      const at = Number(s.m[`${act.act}_at`] ?? 0);
      const text = act.act === "reload" ? reloadText(store, s.m) : String(s.f.clearCmd);
      out.push(...wake({ ...ctx, project }, wt, text, act.act, `${act.act}:${at}`).actions);
      continue;
    }
    if (act.act === "close") {
      let episode = `close:${act.phase}:${act.why}:${Number(s.m.want_at ?? 0)}`;
      if (act.phase === "stop") {
        // U231: a stop is checked, not assumed. One reported done while the agent still runs is
        // asked again under a new episode; the third unanswered one raises a card.
        const r = stopRetry(store, s.m, episode, now);
        if (r.wait) continue;
        if (r.card) { out.push(stopCard(s.m, r.tries, store)); continue; }
        episode = r.episode;
      }
      out.push({ project: String(s.m.project), squad: String(s.m.squad), member: (s.m.wt as string | null) ?? null, subject: `member:${s.m.id}`, kind: "member.close",
        episode, payload: { id: Number(s.m.id), phase: act.phase, why: act.why } });
      continue;
    }
    if (act.act === "stop") {
      // U154 switch stops carry their stable episode (one stop per limit, rung pair, phase
      // event, pin); U153 stops key off the restart wish or the last output.
      const sw = s.f.switchStop;
      const episode = sw && sw.why === act.why ? sw.episode
        : `stop:${act.why}:${Number(s.m.restart_at ?? 0) || Math.floor(Number(store.get("observed_workers", { project: s.m.project, wt: s.m.wt })?.last_output_at ?? 0))}`;
      out.push({ project: String(s.m.project), squad: String(s.m.squad), member: (s.m.wt as string | null) ?? null, subject: `member:${s.m.id}`, kind: "member",
        episode, payload: { id: Number(s.m.id), stop: true, why: act.why } });
      continue;
    }
    out.push({ project: String(s.m.project), squad: String(s.m.squad), member: (s.m.wt as string | null) ?? null, subject: `member:${s.m.id}`, kind: "member",
      episode: s.f.switchDue && s.f.reality === "running" ? `switch:${s.m.want_at}` : startEpisode(store, s.m), payload: { id: Number(s.m.id) } });
  }
  return out;
}

const decider: Reconciler = { name: "decide", scope: "host", run: decide };
export default decider;
