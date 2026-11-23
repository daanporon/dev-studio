// member-state.ts — what the decider (decide.ts) and the readers that must agree with it share (U152):
//   lock(m)          one lock per member: a lifecycle claim on it acted or running, or a lifecycle Orca
//                    call for its worktree sent or pending. Legacy kinds (role replays, retire,
//                    rebind) count too; run-switch rows are inert since U154 removed their fulfiller.
//                    Nothing new starts, rebinds or switches it meanwhile.
//   view(m)          its effective wish: pause.ts effective() (archived, suspended, paused, own wish),
//                    plus a Builder whose unit is done, merged or cancelled reads archived, and a
//                    one-shot role (not standing, not a Builder) whose task dispatch completed reads
//                    stopped (U12: off Orca, one with a finish row of its generation). A view only.
//   lastStart(m)     the newest start of this member the loop knows (placed_at, started), epoch s.
//   walkedGone(w, t) a walk read after a stop's call at t found no agent (account-move-slow U2).
//   startEpisode(m)  the start act's episode: stable across wish edits (a model write mid-start keeps
//                    the call's retry id), new after each start, and new once a given-up start's wish
//                    is written again.
import { effective, startSent } from "../pause/pause.ts";
import { memberUnit, mergedUnit } from "../pause/pause-conditions.ts";
import { STANDING } from "../drivers/types.ts";
import { onContract } from "./backend.ts";
import { finishOf } from "./finish-read.ts";
import type { Row, Store } from "../core/store.ts";

export const LOCK_KINDS = ["member", "member.close", "role", "request-restart", "request-switch",
  "pause-control", "cancel.stop", "rebind", "unbind", "duplicate"].map((k) => `action:${k}`);
export const LOCK_OPS = ["worker-start", "worker-resume", "role-start", "terminal-create", "terminal-close",
  "terminal-close-worktree", "pause-close", "pause-release", "dispatch-abandon", "worker-stop", "worker-release",
  "terminal.create", "terminal.close"];   // U11: a contract backend's start and stop (core/actuator.ts contractStart)

const who = (m: Row) => `${m.role}${m.suffix ? `-${m.suffix}` : ""}`;
const iso = (v: unknown) => (v ? Math.floor(Date.parse(String(v)) / 1000) : NaN);

// `except`: claim kinds the caller holds itself (rebind checks the lock from inside its own claim).
export function lock(store: Store, m: Row, except: string[] = []): boolean {
  const p = String(m.project), wt = String(m.wt ?? ""), kinds = LOCK_KINDS.filter((k) => !except.includes(k));
  if (wt && store.db.query(`SELECT 1 FROM orca_calls WHERE project = ? AND member = ? AND state IN ('sent', 'pending')
      AND (op IN (SELECT value FROM json_each(?)) OR (? AND key LIKE 'rebind%')) LIMIT 1`).get(p, wt, JSON.stringify(LOCK_OPS), kinds.includes("action:rebind") ? 1 : 0)) return true;
  return !!store.db.query(`SELECT 1 FROM episodes WHERE project = ? AND state IN ('acted', 'running') AND kind IN (SELECT value FROM json_each(?))
      AND (subject IN (?, ?, ?) OR (json_valid(action) AND (json_extract(action, '$.action.payload.id') = ? OR (? != '' AND json_extract(action, '$.action.member') = ?)))) LIMIT 1`)
    .get(p, JSON.stringify(kinds), `member:${m.id}`, `${m.squad}.${who(m)}`, wt || `member:${m.id}`, Number(m.id), wt, wt);
}

export type View = "running" | "stopped" | "archived" | "paused" | "suspended" | null;
export function view(store: Store, m: Row): View {
  const e = effective(store, m).state as View;
  if (e !== "running" && e !== "stopped") return e;
  if (m.role === "builder") {
    const u = memberUnit(store, { project: String(m.project), squad: String(m.squad), role: "builder", suffix: String(m.suffix ?? ""), member: (m.wt as string | null) ?? null });
    if (u && (u.status === "cancelled" || u.status === "merged" || mergedUnit(store, u))) return "archived";
  } else if (e === "running" && !STANDING.has(String(m.role)) && m.wt) {
    // U12: off Orca there is no dispatch; a finish row of the member's generation ends the one-shot.
    if (onContract(store, String(m.project), String(m.squad))) return finishOf(store, m) ? "stopped" : e;
    const w = store.get("observed_workers", { project: m.project, wt: m.wt });
    if (w?.dispatch === "completed") return "stopped";
  }
  return e;
}

export function lastStart(m: Row): number {
  return Math.max(Number(m.placed_at ?? 0) || 0, iso(m.started) || 0);
}

// account-move-slow U2: a process walk read after a stop's worker-stop call went out (`sentAt`, its
// tick) that found no agent proves the agent gone, whatever Orca's dispatch still says. A walk from
// the stop's own tick ran before the call, so only a later one counts.
export function walkedGone(w: Row | null | undefined, sentAt: number): boolean {
  return !!w && sentAt > 0 && w.walk === "none" && Number(w.account_at ?? 0) > sentAt;
}

// The `sent_at` of this member's newest stop the loop finished in its worktree (its `member_stopped`
// event, found through events_kind_member).
export function lastStopSent(store: Store, m: Row): number {
  const r = store.db.query(`SELECT json_extract(payload, '$.sent_at') AS s FROM events WHERE kind = 'member_stopped' AND project = ? AND squad = ?
    AND member = ? AND json_extract(payload, '$.id') = ? ORDER BY id DESC LIMIT 1`).get(String(m.project), String(m.squad), String(m.wt ?? ""), Number(m.id)) as { s: number | null } | null;
  return Number(r?.s ?? 0) || 0;
}

export function startEpisode(store: Store, m: Row): string {
  const base = `start:${lastStart(m)}`;
  const c = store.get("episodes", { project: m.project, subject: `member:${m.id}`, kind: "action:member" });
  const key = String(c?.episode_key ?? "");
  // The last try on this base settled (given up, dropped, or done with no new start, as a `tell`)
  // and the wish asks again: a new try. A given-up wish asks again once it is written again.
  const over = c && (key === base || key.startsWith(`${base}:`)) && (c.state === "failed" || c.state === "done" || (c.state === "dropped" && c.result !== "generation changed"));
  return over && !String(m.want_result ?? "").startsWith("failed") ? `${base}:${Number(c.started_at)}` : key.startsWith(`${base}:`) ? key : base;
}

// The orca_calls key of one op of a member stop (fulfil/member.ts), per member id and action episode.
export const stopCallKey = (id: number, episode: string, op: string) => `stop:${id}:${episode}:${op}`;

// A stop of this member waits on reality: its member action's episode has not ended and that
// episode's worker-stop call (U11: its terminal.close, on a contract backend) went out (its last row not
// failed). Only then can the old agent's dispatch settle any tick now, so the Orca observer reads its Run
// every tick (account-move-slow U1).
export function stopOpen(store: Store, project: string, id: number): boolean {
  const ep = store.get("episodes", { project, subject: `member:${id}`, kind: "action:member" });
  if (!ep || ep.ended_at != null || ["done", "dropped", "failed"].includes(String(ep.state))) return false;
  const call = store.db.query("SELECT state FROM orca_calls WHERE key IN (?, ?) ORDER BY id DESC LIMIT 1")
    .get(stopCallKey(id, String(ep.episode_key), "worker-stop"), stopCallKey(id, String(ep.episode_key), "terminal.close")) as Row | null;
  return !!call && call.state !== "failed";
}

// A start of this member in flight (the pause flow waits for it): its start call sent under the
// current start key, an open start call on its worktree, or a start claim running.
export function startInFlight(store: Store, m: Row): boolean {
  if (m.want === "running" && startSent(store, m.id, startEpisode(store, m))) return true;
  const p = String(m.project), wt = String(m.wt ?? "");
  return !!store.db.query("SELECT 1 FROM orca_calls WHERE project = ? AND member = ? AND op IN ('worker-start', 'worker-resume', 'role-start', 'terminal.create') AND state IN ('sent', 'pending')").get(p, wt)
    || !!store.db.query(`SELECT 1 FROM episodes WHERE project = ? AND state = 'running' AND
        kind IN ('action:member', 'action:role') AND (subject = ? OR json_extract(action, '$.action.payload.id') = ?)`).get(p, `member:${m.id}`, Number(m.id));
}

// The crash streak liveness keeps for a standing role (U64): three in a row on one rung and no new
// wish written since (by anyone but the seed) caps it.
export function crashCapped(store: Store, m: Row): boolean {
  const c = store.get("episodes", { project: m.project, subject: `${m.squad}.${who(m)}`, kind: "crash" });
  return !!c && Number(c.count ?? 0) > 2 && !(Number(m.want_at ?? 0) > Number(c.observed_at ?? 0) && m.want_by !== "seed");
}
