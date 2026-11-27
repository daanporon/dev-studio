import { ladder, placeRung, rungTag } from "../capacity/pick.ts";
import { stopping } from "../squad/cancel.ts";
// liveness.ts — broken members. Ported from the removed sweep at
// main 0fbb8be654cda578a94410017c6a1d8c63f2e3e8: step 2 (broken agents: check_agent, broken,
// poke_agent, quiet_nudge, handle, in_spawn_grace).
//
// A member is broken when it is
//   dead            no observed worker (outside the spawn grace)              episode gone|<wt>
//   hung            working with no output for HUNG_MIN                       hung|<wt>|<last output>
//                   (not when its transcript's last turn ended or was interrupted: turnEnded)
//   exited          not working and no agent left in its worktree (outside the spawn grace)
//                                                                             exited|<wt>
//   not responding  a Lead idle or done with Run mail unread for SILENT_MIN   silent|<wt>|<first unread>
// A dead or exited member (outside the Studio) is the decider's (decide.ts, U152): its standing wish
// starts it again, so here it gets only the `req` marker that held pokes wait on.
// Not responding gets POKES pokes RECHECK_MIN apart first; hung, and a Lead the pokes did not
// wake, get one restart request per episode (`request.file`, the sweep's file and text) to the one
// above: a Builder's Lead (requests/<topic>/), the Studio for a Lead or Thinker (requests/_studio/),
// and the operator (a project alert) for the Studio, or for anything whose one above is broken
// too. RECHECK_MIN after a request with the member still broken: one alert; a new break within
// REBREAK_MIN of a request: one alert and no request. A working member silent for quiet_nudge_min
// (but not yet hung) is asked once per output episode whether it is stuck.
//
// The episodes rows reuse the sweep's marker keys (import-markers.ts), so the loop never repeats
// what the sweep already sent: subject <topic>.<who> (the Studio's is _studio), kinds `poke`
// (count = pokes this episode, started_at = the last one), `req` (started_at = the request),
// `alerted` (state = the JSON list of alerted episodes); <subject>.quiet for the quiet nudge.
// The first sight of unread mail is kept as kind `unread` (subject = the worktree), since the
// observers carry an unread count and not the message's time.
//
// A usage-limited member is U8's: it is skipped here (and counts as unable to act), except a dead
// one. Knobs keep the sweep's names: DS_SWEEP_HUNG_MIN (30), DS_SWEEP_SILENT_MIN (10),
// DS_SWEEP_RECHECK_MIN (5), DS_SWEEP_REBREAK_MIN (30), DS_SWEEP_SPAWN_GRACE_MIN (5),
// DS_SWEEP_POKES (2); a limits.conf row of the lower-case name (hung_min, …) stands in for an
// unset one, and quiet_nudge_min (12) is a limits.conf row only (conventions/limits.conf's default).
//
// A crash (U64): a standing role (Lead, Thinker) lives across turns, so its dispatch settling (the
// observer's run-dispatches status: completed, failed, canceled) or its agent exiting within
// CRASH_WINDOW_MIN (10) of a start (members.started, else since) is not a clean finish. A settle
// the loop did itself after its own rebind (U89) is the bind taking, not a crash. Kind `crash` (subject
// <topic>.<who>) holds the streak: episode_key = the <agent>:<model> it crashed on, count = crashes in
// a row there, started_at = the start that crashed, state = the cause (settled, exited). An exited
// one the decider starts again (U152); a settled one gets a restart request, as a break did. The
// second in a row on one rung also raises one alert
// (the member, the rung, its last output); the next start may use that rung again, since two stops
// usually blame an account, a limit or Orca, not the model. A third crash on the same rung
// gets an alert and no request: the loop never restarts a member into the same crash more than twice.
//
// An idle Builder (U69, U267): a dispatched unit with no open PR, whose Builder sits idle or done for
// stale_min minutes (a limits.conf row, default 20; 0 = off) with nothing in the terminal, gets a
// nudge; stale_min later, idle again on the same branch head, a second; stale_min after that its Lead
// gets one request naming it, the unit, the idle time and its last line. The episode is the unit, the
// Builder and its branch head (`idle|<slug>|<wt>|<head>`, one `git rev-parse HEAD` per due Builder):
// answering a nudge is output, not progress, so it does not start over; a commit does. Kind `idle`,
// subject <topic>.<who>.idle, state nudged (count = nudges)|reported|waiting. A Builder with an
// unresolved current question or a unit `waiting_on` is only marked `waiting` (the board lists it);
// a held unit's Builder gets the report at once, with no nudge. A Builder whose current dispatch ended
// with its own worker_done while the unit has no PR is never nudged: two minutes on, its Lead gets one
// `failed report` request (`report with no PR` for any other outcome) carrying the first lines of that
// body (episode `failed|<slug>|<dispatch>`, state failed_report, which the board shows as the unit
// waiting on the Lead) until a new dispatch, a PR, a split or a cancel. Each step writes a `builder_stall` event (step poked|reported|failed_report, head).
//
// A Builder at its prompt (builder-idle-no-pr-card U1): Orca reads it `working`, but its newest
// transcript has not moved for prompt_wait_min (a limits.conf row, default 20; 0 = off), its worktree's
// CPU is under 5 %, no review runs on its unit and the only thing open is a background task
// (`atPrompt`). With no open PR it walks the same ladder, counted from its last transcript write: a
// nudge naming the command (typed while it reads `working`), a second stale_min later, then the
// Lead's report; its builder_stall events carry cause `at-prompt`, since and command. Kind
// `at-prompt`, subject <topic>.<who>.prompt, holds the spell for the board: opened (state open,
// started_at = the transcript's mtime) on the first tick it holds, ended (state cleared) when the
// transcript moves, the Builder stops working, the unit gets a PR or is no longer dispatched. While
// it is open the Builder gets no U82 quiet poke.
//
// A long step (U82): a working member whose transcript ends in a tool_use with no result yet, or
// that has a background task still running, is running a command, not stuck. It is neither
// quiet-poked nor called hung while that step has been quiet for less than long_step_min (a
// limits.conf row, default 60; 0 = off). Past it, the quiet poke goes out once (an output episode
// is poked once; the hung restart waits HUNG_MIN more), so a truly stuck command is not hidden. A skip writes no event and no card.
//
// U11 reports a poke that never landed by setting the poke action's episodes row
// (subject = the worktree, kind `action:poke`) to state `failed`; a failed not-responding poke
// escalates to the request at once, as the sweep's did.
import { statSync } from "node:fs";
import { paused } from "../pause/pause.ts";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { tailOf } from "../observers/state.ts";
import { redact } from "../core/redact.ts";
import { INTERRUPTED } from "../chat/turns.ts";
import { wake } from "../pause/wake.ts";
import { settledDispatch } from "./members.ts";
import { RESTART_STUDIO, STUDIO_CARD_TITLE, STUDIO_FINE, studioBackend, studioView } from "../squad/studio.ts";
import { memo } from "../capacity/walk-memo.ts";
import { onContract, wtHost } from "../squad/backend.ts";
import { hostUnreachable } from "../squad/host-reach.ts";
import { finishOf } from "../squad/finish-read.ts";
import { UNREAD } from "../messages/messages.ts";

export const POKE_TEXT = "dev-studio loop: you went quiet with unread messages. Check your inbox now and carry on with your work.";
export const QUIET_POKE_TEXT = "dev-studio loop: you have been working with no output for a while — are you stuck? If you are, ask your Lead; if not, carry on with your work.";

// A limits.conf value: the project's row over the conventions' one.
export function limit(store: Store, project: string, key: string): string | null {
  const r = store.db.query("SELECT value FROM config WHERE file = 'limits.conf' AND key = ? AND project IN (?, '') ORDER BY project = '' LIMIT 1")
    .get(key, project) as { value: string | null } | null;
  return r?.value ?? null;
}
function int(v: string | null | undefined): number | null {
  return v != null && /^\d+$/.test(v.trim()) ? Number(v) : null;
}
// DS_SWEEP_<NAME>, else the limits.conf row <name>, else the sweep's default.
export function knob(store: Store, project: string, name: string, dflt: number): number {
  return int(process.env[`DS_SWEEP_${name}`]) ?? int(limit(store, project, name.toLowerCase())) ?? dflt;
}

// The squads the sweep walks: not suspended, on hold, done, failed or closed.
export function liveSquads(store: Store, project: string): Row[] {
  return store.db.query(`SELECT * FROM squads WHERE project = ? AND COALESCE(status, 'running') NOT IN ('suspended', 'on-hold', 'done', 'failed', 'closed', 'gone')
    ORDER BY topic`).all(project) as Row[];
}
export function leadOf(store: Store, sq: Row): string | null {
  if (sq.lead_wt) return String(sq.lead_wt);
  const m = store.db.query("SELECT wt FROM members WHERE project = ? AND squad = ? AND role = 'lead' AND wt IS NOT NULL AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
    .get(String(sq.project), String(sq.topic)) as { wt: string } | null;
  return m?.wt ?? null;
}

// Shared with the observer: only an eligible U69 question decision needs an immediate binding read.
export type IdleUnit = { squad: string; slug: string; pr: string | null; hold: number | null };
export function idleBuilderDue(store: Store, project: string, wt: string, now: number, u: IdleUnit, w: Row): boolean {
  return idleBuilderState(store, project, wt, now, u, w) !== null;
}
// Why an idle-ladder Builder is due: idle or done for stale_min (U69), or at its prompt (atPrompt).
type IdleState = { since: number; prompt: { command: string } | null };
function idleBuilderState(store: Store, project: string, wt: string, now: number, u: IdleUnit, w: Row): IdleState | null {
  const stale = knob(store, project, "STALE_MIN", 20), out = Number(w.last_output_at ?? 0);
  const idle = (w.state === "idle" || w.state === "done") && out > 0 && !!stale;
  if (!idle && w.state !== "working") return null;
  const m = store.db.query("SELECT COALESCE(started, since) AS since FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(project, wt) as Row | null;
  const start = m?.since ? Date.parse(String(m.since)) / 1000 : NaN;
  if (start > now - knob(store, project, "SPAWN_GRACE_MIN", 5) * 60 || (idle && now - out < stale * 60 && !u.hold)) return null;
  if (!noOpenPr(store, project, u)) return null;
  if (idle) return { since: out, prompt: null };
  const p = atPrompt(store, project, u.squad, u.slug, wt, now, w);
  return p ? { since: p.since, prompt: { command: p.command } } : null;
}
// The unit has no PR the Builder could be waiting on: none, a merged or closed one, or the unit is held.
function noOpenPr(store: Store, project: string, u: { pr: string | null; hold: number | null }): boolean {
  return !!u.hold || !u.pr || !!store.db.query("SELECT 1 FROM observed_prs WHERE project = ? AND pr = ? AND state IN ('MERGED', 'CLOSED')")
    .get(project, Number(/\d+/.exec(String(u.pr))?.[0] ?? -1));
}

// U267 (1): the Builder's own worker_done for its current dispatch, as Run mail the loop relayed at
// least DONE_GRACE_S ago (finish-unit records the PR just before it sends, so a PR seen late is no report).
// Its outcome and the first lines of its body, for the Lead's report.
export const DONE_GRACE_S = 120;
export function workerDone(store: Store, project: string, squad: string, dispatch: unknown, now: number): { outcome: string; text: string } | null {
  if (!dispatch) return null;
  const r = store.db.query(`SELECT subject, body, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.outcome') END AS outcome FROM relayed
    WHERE project = ? AND squad = ? AND type = 'worker_done' AND json_valid(payload) AND json_extract(payload, '$.dispatchId') = ? AND seen_at <= ?
    ORDER BY seen_at DESC LIMIT 1`)
    .get(project, squad, String(dispatch), now - DONE_GRACE_S) as { subject: string | null; body: string | null; outcome: string | null } | null;
  if (!r) return null;
  return { outcome: r.outcome || "unknown", text: reportText([r.subject, ...String(r.body ?? "").split("\n")]) };
}

// A report's first three non-empty lines, joined, at most 400 characters.
function reportText(lines: unknown[]): string {
  const text = lines.map((l) => String(l ?? "").trim()).filter(Boolean).slice(0, 3).join(" / ");
  return text.length > 400 ? `${text.slice(0, 399)}…` : text || "(no body)";
}

// U12: workerDone for a squad off Orca: the failed or no-PR finish row of the worktree's member's
// current generation, read once DONE_GRACE_S old (as the relayed worker_done is), with its generation.
export function finishDone(store: Store, project: string, squad: string, wt: string, now: number): { outcome: string; text: string; gen: string } | null {
  const m = store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? ORDER BY id DESC LIMIT 1").get(project, squad, wt) as Row | null;
  const f = m ? finishOf(store, m) : null;
  if (!f || (f.outcome !== "failed" && f.outcome !== "no-pr") || Number(f.at) > now - DONE_GRACE_S) return null;
  return { outcome: String(f.outcome), text: reportText(String(f.body ?? "").split("\n")), gen: String(m!.gen) };
}

// U267 (2): a Builder's branch head, read with one `git rev-parse HEAD` in its worktree when it is due.
// Kept per worktree until its last output moves (a commit is made by a running agent, which writes).
// Tests replace `read`.
const heads = new Map<string, { out: number; head: string | null }>();
export const builderHead = {
  read(store: Store, project: string, wt: string, out: number): string | null {
    const kept = heads.get(wt);
    if (kept && kept.out === out) return kept.head;
    const path = String(store.get("observed_worktrees", { project, wt })?.path ?? "") || wt.split("::").slice(1).join("::");
    let head: string | null = null;
    if (path) {
      const r = Bun.spawnSync(["git", "-C", path, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
      head = r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
    }
    heads.set(wt, { out, head });
    return head;
  },
};

// Payload is a hint to check ownership, not binding evidence. A successful newer snapshot can
// rule out an old terminal question; an unavailable snapshot cannot rule out a newly seen one.
// Before a first successful read, an unclaimed dispatch sender is a candidate, not a proven owner.
export function builderQuestions(store: Store, project: string, squad: string, wt: string, now: number): { candidate: boolean; current: boolean } {
  const row = store.db.query(`SELECT COUNT(*) AS candidates, MAX(CASE WHEN r.from_handle = 'dispatch:' || NULLIF(w.dispatch_id, '') OR
      NULLIF(CASE WHEN json_valid(r.payload) THEN json_extract(r.payload, '$.dispatchId') END, '') IS NULLIF(w.dispatch_id, '') THEN 1 ELSE 0 END) AS current
    FROM relayed r
    JOIN squads s ON s.project = r.project AND s.topic = r.squad AND s.run_id = r.run_id
    JOIN members m ON m.project = r.project AND m.squad = r.squad AND m.wt = ? AND m.role = 'builder'
      AND COALESCE(m.status, '') != 'gone' AND COALESCE(m.want, '') != 'gone'
      AND m.id = (SELECT MAX(id) FROM members WHERE project = m.project AND squad = m.squad AND role = m.role AND suffix IS m.suffix)
    JOIN observed_workers w ON w.project = m.project AND w.wt = m.wt AND w.gone_at IS NULL AND w.observed_at = ?
    WHERE r.project = ? AND r.squad = ? AND r.type = 'question'
      AND (r.from_handle = 'dispatch:' || NULLIF(w.dispatch_id, '') OR EXISTS (
        SELECT 1 FROM observed_terminals t WHERE t.project = r.project AND t.wt = m.wt AND t.handle = r.from_handle
          AND t.gone_at IS NULL AND t.observed_at = w.observed_at AND json_extract(t.doc, '$.newest') = 1
          AND (NULLIF(CASE WHEN json_valid(r.payload) THEN json_extract(r.payload, '$.dispatchId') END, '') IS NULLIF(w.dispatch_id, '')
            OR w.dispatch_seen_at IS NULL OR r.seen_at >= w.dispatch_seen_at))
        OR (r.from_handle LIKE 'dispatch:%' AND w.dispatch_seen_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM observed_workers o WHERE o.project = r.project AND o.gone_at IS NULL AND o.wt != m.wt
            AND r.from_handle = 'dispatch:' || NULLIF(o.dispatch_id, ''))))
      AND NOT EXISTS (SELECT 1 FROM requests q WHERE q.kind = 'reply' AND q.project = r.project AND q.squad = r.squad
        AND q.done_at IS NOT NULL AND json_type(q.result, '$.ok') = 'true'
        AND json_extract(q.payload, '$.id') = r.msg_id AND json_extract(q.payload, '$.run') = r.run_id)`)
    .get(wt, now, project, squad) as { candidates: number; current: number | null };
  return { candidate: row.candidates > 0, current: row.current === 1 };
}

// True when the actuator marked this poke action (by its episode) as never landed.
export function pokeFailed(store: Store, project: string, member: string, episode: string): boolean {
  const r = store.get("episodes", { project, subject: member, kind: "action:poke" });
  return r?.episode_key === episode && r.state === "failed";
}

// The same episode as `prev` (a row's episode_key). A row the sweep wrote (import-markers) keys
// hung/quiet on the terminal activity in ms (the loop: the same time in whole seconds) and silent on
// the oldest unread message's id, which the loop never sees: a sweep silent row counts as this
// episode only when it was written at or after `spell` (the earliest time this unread spell can
// have been poked or reported).
export function sameEp(prev: Row | null | undefined, ep: string, key = prev?.episode_key, spell = Infinity): boolean {
  if (key == null) return false;
  if (key === ep) return true;
  if (prev?.source !== "sweep") return false;
  const recheck = (e: string) => e.endsWith("|recheck");
  const k = String(key).split("|"), e = ep.split("|");
  if (recheck(String(key)) !== recheck(ep) || k[0] !== e[0] || k[1] !== e[1]) return false;
  if (e[0] === "hung" || e[0] === "quiet") return /^\d+$/.test(k[2] ?? "") && String(Math.floor(Number(k[2]) / 1000)) === e[2];
  return e[0] === "silent" && Number(prev.started_at ?? 0) >= spell;
}
const hhmm = (t: number) => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const who = (m: { role: string; suffix?: string | null }) => m.role + (m.suffix ? `-${m.suffix}` : "");

// Is the newest transcript of `wt` in a command: its last tool_use has no tool_result yet, or a
// background Bash task it started has not reported done? false when it can't be read.
export function stepOpen(store: Store, wt: string): boolean {
  const c = openCalls(store, wt);
  return !!c && (c.foreground || c.background.length > 0);
}
// U203: only the foreground part: is the last tool_use of the newest transcript without a result?
// Background tasks do not count. null when no transcript can be read (callers treat it as busy).
export function foregroundOpen(store: Store, wt: string): boolean | null {
  const t = store.db.query("SELECT path FROM observed_transcripts WHERE wt = ? ORDER BY mtime DESC").get(wt) as { path: string } | null;
  if (!t) return null;
  try { statSync(t.path); } catch { return null; }
  return openCalls(store, wt)?.foreground ?? false;
}
// Did the last turn of these transcript lines end (studio-hung-agent-broken U1)? The newest record that
// says where a turn stands decides: an Esc (a user record starting `[Request interrupted by user`) or a turn
// end (system `stop_hook_summary` / `turn_duration`) ends it; an assistant record, a tool result or any
// other user line (a prompt, a typed loop line, a task notification, a slash command, Stop hook feedback)
// opens it. Records that say nothing about the turn are skipped: meta and compaction-summary user records,
// a local command's output, other system records (away_summary, compact_boundary) and the bookkeeping
// types (attachments, snapshots, queue operations). Read from the end, so it stops at the first such record.
const LOCAL_OUTPUT = /^\s*<local-command-/;
export function linesEnded(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"assistant"') && !line.includes('"user"') && !line.includes('"system"')) continue;
    let j: Row;
    try { j = JSON.parse(line); } catch { continue; } // the cut first line, a half-written last one
    if (j?.type === "assistant") return false;
    if (j?.type === "system") {
      if (j.subtype === "stop_hook_summary" || j.subtype === "turn_duration") return true;
      continue;
    }
    if (j?.type !== "user" || j.isMeta === true || j.isCompactSummary === true) continue;
    const c = (j.message as Row | undefined)?.content;
    const texts = typeof c === "string" ? [c] : Array.isArray(c) ? (c as Row[]).filter((x) => x?.type === "text").map((x) => String(x.text ?? "")) : [];
    if (texts.some((s) => INTERRUPTED.test(s))) return true;
    if (Array.isArray(c) && (c as Row[]).some((x) => x?.type === "tool_result")) return false;
    if (texts.length && texts.every((s) => LOCAL_OUTPUT.test(s))) continue;
    return false;
  }
  return false;
}

// One parse of the newest transcript's last MB: is a foreground tool call open, which background tasks it
// started have not reported done (oldest first, with the command each ran), and did its last turn end
// (`linesEnded`). null with no transcript row. One decide parses each worktree's transcript once (walk-memo.ts
// withDecideMemo: its look() asks up to three times per member, through the switch and stop checks).
export type OpenCalls = { foreground: boolean; background: { id: string; command: string }[]; ended: boolean };
export function openCalls(store: Store, wt: string): OpenCalls | null {
  return memo(store, null, "open-calls", wt, () => openCallsRead(store, wt));
}
function openCallsRead(store: Store, wt: string): OpenCalls | null {
  const t = store.db.query("SELECT path FROM observed_transcripts WHERE wt = ? ORDER BY mtime DESC").get(wt) as { path: string } | null;
  if (!t) return null;
  const lines = tailOf(t.path, 1024 * 1024).split("\n");
  const ended = linesEnded(lines);
  const results = new Set<string>(), bg = new Map<string, string>(), bgIds = new Map<string, string>();
  let last: string | null = null;
  for (const line of lines) {
    if (!line.includes("tool_") && !line.includes("task-notification") && !line.includes("run_in_background")) continue;
    let j: Row;
    try { j = JSON.parse(line); } catch { continue; } // the cut first line, a half-written last one
    const c = j?.message?.content;
    const done = (text: string) => { if (text.includes("<task-notification>")) for (const [bid] of bgIds) if (text.includes(bid) && /<status>(completed|failed|killed|stopped)/.test(text)) bgIds.delete(bid); };
    done(line); // queue-operation and attachment records carry the notice outside message.content
    if (typeof c === "string") continue;
    if (!Array.isArray(c)) continue;
    for (const x of c as Row[]) {
      if (x?.type === "tool_use") {
        last = String(x.id);
        if ((x.input as Row | undefined)?.run_in_background === true) bg.set(String(x.id), String((x.input as Row).command ?? ""));
        if (x.name === "TaskStop" || x.name === "KillShell") {
          const target = String((x.input as Row | undefined)?.task_id ?? (x.input as Row | undefined)?.shell_id ?? "");
          bgIds.delete(target);
        }
      } else if (x?.type === "tool_result") {
        const id = String(x.tool_use_id);
        results.add(id);
        const txt = JSON.stringify(x.content ?? "");
        const m = /(?:running in background with ID|background (?:task|shell) (?:id|ID)):? ?([A-Za-z0-9_-]+)/.exec(txt);
        if (m && bg.has(id)) bgIds.set(m[1], id);
      } else if (x?.type === "text" && typeof x.text === "string" && x.text.includes("<task-notification>")) {
        done(x.text);
      }
    }
  }
  return { foreground: last !== null && !results.has(last), background: [...bgIds].map(([id, use]) => ({ id, command: bg.get(use) ?? "" })), ended };
}

// studio-hung-agent-broken U1: is a Claude member Orca reads `working` really at its prompt? Its newest
// transcript's last turn ended or was interrupted (Esc runs no Stop hook, so Orca keeps `working` until the
// next turn ends). false with no transcript (Codex, Muse, none yet), one that can't be read, or one last
// written before the member's process started (a new session that has not written its own yet).
export function turnEnded(store: Store, wt: string): boolean {
  const t = store.db.query("SELECT mtime FROM observed_transcripts WHERE wt = ? ORDER BY mtime DESC").get(wt) as { mtime: number | null } | null;
  if (!t) return false;
  const w = store.db.query("SELECT started_at FROM observed_workers WHERE wt = ? AND gone_at IS NULL").get(wt) as { started_at: number | null } | null;
  if (w?.started_at && t.mtime != null && Number(t.mtime) < Number(w.started_at)) return false;
  return openCalls(store, wt)?.ended ?? false;
}

// A Builder at its prompt (builder-idle-no-pr-card U1): Orca reads it `working`, but its turn ended
// prompt_wait_min ago (its newest transcript has not moved since), its worktree's CPU is under
// PROMPT_CPU_PCT, no review is running on its unit, and the only thing open is a background task
// (U4 of public-readiness-audit sat 3 h at its prompt on a self-matching `until ! pgrep -f …` loop).
// `since` is the transcript's mtime; `command` the newest open task's command, redacted and cut to 80.
// Cheap rows first; the transcript parse last. null = not at its prompt.
const PROMPT_CPU_PCT = 5;
export function atPrompt(store: Store, project: string, squad: string, slug: string, wt: string, now: number, w: Row): { since: number; command: string } | null {
  const wait = knob(store, project, "PROMPT_WAIT_MIN", 20);
  if (!wait || w.state !== "working") return null;
  const t = store.db.query("SELECT mtime FROM observed_transcripts WHERE wt = ? ORDER BY mtime DESC").get(wt) as { mtime: number | null } | null;
  const since = Number(t?.mtime ?? 0);
  if (!since || since > now - wait * 60) return null;
  const cpu = store.db.query("SELECT COALESCE(cpu_cg_pct, cpu_pct) AS cpu FROM observed_procs WHERE project = ? AND wt = ?").get(project, wt) as { cpu: number | null } | null;
  if (cpu?.cpu == null || cpu.cpu >= PROMPT_CPU_PCT) return null;
  if (store.db.query("SELECT 1 FROM observed_reviews WHERE project = ? AND squad = ? AND slug = ? AND state = 'reviewing'").get(project, squad, slug)) return null;
  const c = openCalls(store, wt);
  if (!c || c.foreground || !c.background.length) return null;
  const cmd = redact(c.background[c.background.length - 1].command.replace(/\s+/g, " ").trim());
  return { since, command: cmd.length > 80 ? `${cmd.slice(0, 79)}…` : cmd };
}

type Broken = { cause: string; since: number; ep: string };
// A dispatch status that means the dispatch is over (worker-list's dispatchStatus or workerState).
export const SETTLED = new Set(["completed", "succeeded", "failed", "canceled", "cancelled"]);

// A standing role's dispatch word from the loop's own verdict (U100): `open` (its dispatch is still
// open), `settled` (any other dispatch in SETTLED), `rebound` (the newest dispatch is one the loop
// settled itself during a U89 rebind — the bind taking, not a crash), or `unknown` (no row, no
// dispatch on it, or the last read older than 2 × DISPATCH_READ_MIN — the display then keeps the
// agent state, as before U96). The crash check uses it, and the display reads it through
// `bin/ds members`.
export type DispatchVerdict = "open" | "settled" | "rebound" | "unknown";
export function dispatchVerdict(store: Store, project: string, squad: string, wt: string, now: number): DispatchVerdict {
  const w = store.db.query("SELECT dispatch, dispatch_id, dispatch_seen_at FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL")
    .get(project, wt) as Row | null;
  if (!w || w.dispatch == null || w.dispatch === "") return "unknown";
  const seen = Number(w.dispatch_seen_at ?? NaN);
  if (!Number.isFinite(seen) || now - seen > 2 * knob(store, project, "DISPATCH_READ_MIN", 5) * 60) return "unknown";
  if (w.dispatch_id != null && w.dispatch_id !== "" && settledDispatch(store, project, squad, wt, String(w.dispatch_id))) return "rebound";
  return SETTLED.has(String(w.dispatch)) ? "settled" : "open";
}

export function workerLimited(store: Store, project: string, wt: string, w: Row | null, now: number): boolean {
  const m = store.db.query("SELECT limited_until FROM members WHERE project = ? AND wt = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
    .get(project, wt) as { limited_until: number | null } | null;
  return !!w && (Number(m?.limited_until ?? 0) > now || !!w.limited);
}
// The member's last start within SPAWN_GRACE_MIN of now: the observed process start (U149)
// when a walk has read it, else the member's since (its first spawn).
export function spawnGrace(store: Store, project: string, wt: string, now: number): boolean {
  const grace = knob(store, project, "SPAWN_GRACE_MIN", 5);
  const w = store.db.query("SELECT started_at FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, wt) as { started_at: number | null } | null;
  if (w?.started_at) return w.started_at > now - grace * 60;
  const m = store.db.query("SELECT COALESCE(started, since) AS since FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(project, wt) as { since: string | null } | null;
  const t = m?.since ? Date.parse(String(m.since)) / 1000 : NaN;
  return Number.isFinite(t) && t > now - grace * 60;
}
// U82: a command is running and has been quiet for less than the long cap.
// `extra` seconds past the cap still count (the hung restart waits that much longer than the one poke).
export function longStepOpen(store: Store, project: string, wt: string, now: number, out: number, extra = 0): boolean {
  const cap = int(limit(store, project, "long_step_min")) ?? 60;
  return cap > 0 && now - out < cap * 60 + extra && stepOpen(store, wt);
}

// U12b: the unread mail of a member of a squad off Orca (no Run, no inbox count on its worker row): its
// unread `messages` rows (UNREAD). null for a member on Orca, whose worker row's `unread` is Orca's count.
export function rowsUnread(store: Store, project: string, wt: string): number | null {
  const m = store.db.query("SELECT squad, role, suffix FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(project, wt) as Row | null;
  if (!m || !onContract(store, project, String(m.squad), m.host)) return null;
  const r = store.db.query(`SELECT COUNT(*) AS n FROM messages m WHERE m.project = ? AND m.squad = ? AND m.to_role = ? AND m.to_suffix = ? AND ${UNREAD}`)
    .get(project, String(m.squad), String(m.role), String(m.suffix ?? "")) as { n: number };
  return r.n;
}

// The board's read of a Lead: the verdict liveness.broken() would reach for it, from the rows
// alone (writes nothing). null = nothing wrong (or a case the reconciler also leaves alone).
export type LeadVerdict = { verdict: "not responding" | "hung"; since: number };
export function leadVerdict(store: Store, project: string, wt: string, now: number): LeadVerdict | null {
  const sq = store.db.query("SELECT run_id, topic FROM squads WHERE project = ? AND lead_wt = ? ORDER BY rowid DESC").get(project, wt) as { run_id: string | null; topic: string } | null;
  if (sq && !sq.run_id && !onContract(store, project, sq.topic)) return null;
  const w = store.db.query("SELECT * FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, wt) as Row | null;
  if (!w || spawnGrace(store, project, wt, now) || workerLimited(store, project, wt, w, now)) return null;
  const hung = knob(store, project, "HUNG_MIN", 30) * 60, silent = knob(store, project, "SILENT_MIN", 10) * 60;
  if (w.state === "working") {
    const out = Number(w.last_output_at ?? 0);
    if (out > 0 && now - out >= hung && !longStepOpen(store, project, wt, now, out, hung) && !turnEnded(store, wt)) return { verdict: "hung", since: out };
    return null;
  }
  if (w.state !== "idle" && w.state !== "done") return null;
  const ep = store.get("episodes", { project, subject: wt, kind: "unread" });
  if (!ep || ep.ended_at != null || ep.started_at == null || (rowsUnread(store, project, wt) ?? Number(w.unread ?? 0)) <= 0) return null;
  const since = Number(ep.started_at);
  return now - since >= silent ? { verdict: "not responding", since } : null;
}

// broken()'s `run` for a Lead off Orca: its mail is its `messages` rows (U12b).
const ROWS = "\u0000rows";

class Pass {
  readonly actions: Action[] = [];
  readonly store: Store;
  readonly project: string;
  readonly now: number;
  readonly k: { hung: number; silent: number; recheck: number; rebreak: number; grace: number; pokes: number; quiet: number; crash: number };

  constructor(readonly ctx: TickCtx) {
    this.store = ctx.store; this.project = ctx.project; this.now = ctx.now;
    const kn = (n: string, d: number) => knob(this.store, this.project, n, d);
    this.k = { hung: kn("HUNG_MIN", 30), silent: kn("SILENT_MIN", 10), recheck: kn("RECHECK_MIN", 5), rebreak: kn("REBREAK_MIN", 30),
      grace: kn("SPAWN_GRACE_MIN", 5), pokes: kn("POKES", 2), quiet: int(limit(this.store, this.project, "quiet_nudge_min")) ?? 12,
      crash: kn("CRASH_WINDOW_MIN", 10) };
  }

  // sameEp, with the window a sweep silent row must fall in: the spell's first sight, less the
  // SILENT_MIN the sweep waited, its pokes and a request's REBREAK_MIN.
  same(prev: Row | null | undefined, ep: string, key = prev?.episode_key): boolean {
    const first = ep.startsWith("silent|") ? Number(ep.split("|")[2]) : NaN;
    const spell = Number.isFinite(first) ? first - (this.k.silent + this.k.pokes * this.k.recheck + this.k.rebreak) * 60 : Infinity;
    return sameEp(prev, ep, key, spell);
  }

  worker(wt: string): Row | null {
    return this.store.db.query("SELECT * FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(this.project, wt) as Row | null;
  }
  // The worktree's agent count from `ps`; null when unknown (no exited guess then).
  agents(wt: string): number | null {
    const r = this.store.db.query("SELECT doc FROM observed_worktrees WHERE project = ? AND wt = ? AND gone_at IS NULL").get(this.project, wt) as { doc: string | null } | null;
    try { const n = JSON.parse(r?.doc ?? "null")?.agents; return typeof n === "number" ? n : null; } catch { return null; }
  }
  limited(wt: string, w: Row | null): boolean { return workerLimited(this.store, this.project, wt, w, this.now); }
  // The member's last start within SPAWN_GRACE_MIN of now (see spawnGrace).
  inGrace(wt: string): boolean { return spawnGrace(this.store, this.project, wt, this.now); }

  // Unread Run mail first seen while idle or done. It ends when the mail is gone or the count
  // falls (the member read some); a turn that leaves the same mail unread keeps the clock (the
  // sweep keys the episode on the oldest unread message, which a turn does not change).
  // U12b: off Orca the count is the member's unread `messages` rows (rowsUnread).
  unreadSince(wt: string, w: Row, rows: number | null = null): number | null {
    const key = { project: this.project, subject: wt, kind: "unread" };
    const row = this.store.get("episodes", key), unread = rows ?? Number(w.unread ?? 0);
    const open = row && row.ended_at == null && row.started_at != null;
    if (open && (unread === 0 || unread < Number(row!.count ?? 0))) {
      this.store.upsert("episodes", key, { ended_at: this.now, state: "read", observed_at: this.now });
    } else if (open) {
      if (unread !== Number(row!.count ?? 0)) this.store.upsert("episodes", key, { count: unread, observed_at: this.now });
      return w.state === "idle" || w.state === "done" ? Number(row!.started_at) : null;
    }
    if (unread > 0 && (w.state === "idle" || w.state === "done")) {
      this.store.upsert("episodes", key, { started_at: this.now, ended_at: null, count: unread, state: "unread", source: "loop", observed_at: this.now });
      return this.now;
    }
    return null;
  }

  broken(wt: string, run: string | null, grace: boolean): Broken | null {
    const w = this.worker(wt), n = this.now;
    // `run`: the Lead's mail is read: its Run's inbox, or ROWS (a squad off Orca) its `messages` rows.
    const rows = w && run === ROWS ? rowsUnread(this.store, this.project, wt) : null;
    const first = w && run && (run !== ROWS || rows != null) ? this.unreadSince(wt, w, rows) : null;
    if (!w) return grace && this.inGrace(wt) ? null : { cause: "dead", since: n, ep: `gone|${wt}` };
    if (w.state === "working") {
      const out = Number(w.last_output_at ?? 0);
      if (!(out > 0 && n - out >= this.k.hung * 60)) return null;
      if (this.longStep(wt, out, this.k.hung * 60)) return null;
      // U1: Esc (or a turn end Orca has not caught up with) leaves the member at its prompt, not hung.
      if (turnEnded(this.store, wt)) return null;
      return { cause: "hung", since: out, ep: `hung|${wt}|${out}` };
    }
    if (this.agents(wt) === 0) return grace && this.inGrace(wt) ? null : { cause: "exited", since: n, ep: `exited|${wt}` };
    return first != null && n - first >= this.k.silent * 60 ? { cause: "not responding", since: first, ep: `silent|${wt}|${first}` } : null;
  }

  // U82: a command is running and has been quiet for less than the long cap.
  // `extra` seconds past the cap still count (the hung restart waits that much longer than the one poke).
  longStep(wt: string, out: number, extra = 0): boolean { return longStepOpen(this.store, this.project, wt, this.now, out, extra); }

  alert(squad: string | null, key: string, ep: string, text: string, to: "squad" | "@project",
    option = "look at it, then restart it by hand (restart-role.sh)", why = "the loop does not restart an agent twice in a row or one that did not come back",
    card: { title?: string; fields?: Record<string, unknown> } = {}): void {
    const k = { project: this.project, subject: key, kind: "alerted" };
    const row = this.store.get("episodes", k);
    let seen: string[] = [];
    try { seen = JSON.parse(String(row?.state ?? "[]")); } catch { /* a torn row: alert again */ }
    if (seen.some((e) => this.same(row, ep, e))) return;
    seen.push(ep);
    this.store.upsert("episodes", k, { squad, started_at: this.now, episode_key: ep, count: seen.length, state: JSON.stringify(seen), source: "loop", observed_at: this.now });
    this.actions.push({ project: this.project, squad, subject: key, kind: "alert", episode: ep,
      payload: { title: card.title ?? "Agent broken", card: "agent_broken", text, option, why, to, ...(card.fields ? { fields: card.fields } : {}) } });
  }

  // studio-hung-agent-broken U2: the Studio's own card. It names the project's Studio terminal and, with an
  // adopted handle, offers Restart Studio (fulfil/studio.ts records the approval, reconcilers/studio.ts
  // files the restart). The text keeps starting `studio (<cause> since `, which alertGone (alerts.ts) clears on.
  studioAlert(key: string, b: Broken, what: string): void {
    const v = studioView(this.store, this.project), handle = (v?.member?.handle as string | null) || null;
    const term = handle ? v!.terms.find((t) => t.handle === handle) : undefined;
    const where = handle ? `your cockpit terminal ${term?.title || "untitled"}, ${handle}` : "your cockpit terminal; the loop has adopted none";
    // U51: a Studio off Orca names its own backend.
    const on = studioBackend(this.store.get("projects", { label: this.project }));
    const reader = on === "orca" ? "while Orca reads it as working" : `while ${on} reads it as working`;
    const state = b.cause === "hung" ? `has shown no output for ${Math.max(0, Math.round((this.now - b.since) / 60))} min ${reader}`
      : b.cause === "exited" ? "has no agent running in its worktree" : b.cause === "dead" ? `is no longer listed by ${on === "orca" ? "Orca" : on}` : `is ${b.cause}`;
    const text = `${what} — the ${this.project} Studio (${where}) ${state}`;
    const why = "The loop never restarts the Studio on its own.";
    // No handle, nothing to restart through: the one acknowledgement, as before.
    if (!handle) { this.alert(null, key, b.ep, text, "@project", "look at it, then restart it by hand", why, { title: STUDIO_CARD_TITLE }); return; }
    this.alert(null, key, b.ep, text, "@project", "", why,
      { title: STUDIO_CARD_TITLE, fields: { restart: true, handle, options: [RESTART_STUDIO, STUDIO_FINE] } });
  }

  // handle: one request per episode; a RECHECK_MIN recheck; a second break within REBREAK_MIN goes up.
  handle(squad: string | null, key: string, target: string, member: string, topic: string, b: Broken): void {
    const what = `${member}${topic ? ` of ${topic}` : ""} (${b.cause} since ${hhmm(b.since)})`;
    const to = squad ? "squad" : "@project";
    if (target === "_operator" && key === "_studio") { this.studioAlert(key, b, what); return; }
    if (target === "_operator") { this.alert(squad, key, b.ep, `${what} — nobody above it can restart it`, to); return; }
    const k = { project: this.project, subject: key, kind: "req" };
    const req = this.store.get("episodes", k), t = Number(req?.started_at ?? 0);
    if (t && this.same(req, b.ep)) {
      if (this.now - t >= this.k.recheck * 60) this.alert(squad, key, `${b.ep}|recheck`, `${what} — not back ${this.k.recheck} min after the restart request`, to);
      return;
    }
    if (t && this.now - t < this.k.rebreak * 60) {
      this.alert(squad, key, b.ep, `${what} — broke again within ${this.k.rebreak} min of a restart; auto-restart stopped`, to);
      return;
    }
    this.store.upsert("episodes", k, { squad, started_at: this.now, ended_at: null, count: 1, episode_key: b.ep, state: "sent", source: "loop", observed_at: this.now });
    this.actions.push({ project: this.project, squad, member, subject: key, kind: "request.file", episode: b.ep,
      payload: { target, path: `requests/${target}/${key}-${this.now}.txt`, text: `restart ${what}\n` } });
  }

  // The `req` marker of a break the decider restarts (no request): heldPokes reads it.
  marker(squad: string, key: string, ep: string): void {
    const k = { project: this.project, subject: key, kind: "req" };
    if (this.store.get("episodes", k)?.episode_key !== ep)
      this.store.upsert("episodes", k, { squad, started_at: this.now, ended_at: null, count: 1, episode_key: ep, state: "marked", source: "loop", observed_at: this.now });
  }

  // U92 (6): pokes/mail that could not be delivered while the Builder was gone, sent once it is back.
  heldPokes(squad: string, key: string, wt: string): void {
    const req = this.store.get("episodes", { project: this.project, subject: key, kind: "req" });
    if (!req) return;
    const w = this.worker(wt);
    if (!w || (w.state !== "idle" && w.state !== "done")) return;
    const held = this.store.db.query("SELECT * FROM deliveries WHERE project = ? AND member = ? AND state = 'accepted' ORDER BY id").all(this.project, wt) as Row[];
    for (const d of held) {
      const r = wake(this.ctx, wt, String(d.text), "held", `held|${wt}|${d.id}`);
      this.actions.push(...r.actions);
    }
    // Unread Run mail is visible again now the Builder is back: one silent-style poke.
    if (Number(w.unread ?? 0) > 0) {
      const r = wake(this.ctx, wt, POKE_TEXT, "held", `held|${wt}|unread`);
      this.actions.push(...r.actions);
    }
  }

  // A standing member that crashed (see the header): true when this start crashed, handled here —
  // past the window too, so the generic break path never restarts it into the same crash again
  // (a third crash stays parked) until a new start. Any other start past the window ends the
  // streak.
  crash(squad: string, key: string, above: string, member: string, wt: string): boolean {
    const m = this.store.db.query("SELECT id, role, tier, phase, agent, model, account, started, since, placed_at, restart_at FROM members WHERE project = ? AND wt = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
      .get(this.project, wt) as Row | null;
    // The crash window reads the observed process start (U149) when a walk has read one, else
    // the member's recorded start (started, else since).
    const proc = this.store.db.query("SELECT started_at FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(this.project, wt) as { started_at: number | null } | null;
    const start = proc?.started_at ?? ((m?.started || m?.since) ? Math.floor(Date.parse(String(m!.started || m!.since)) / 1000) : NaN);
    if (!m || !Number.isFinite(start) || !start) return false;
    // U153: the loop's own restart stop is no crash: a restart wish newer than this start stands
    // the rule down only inside the crash window, so a satisfied wish never silences later crashes.
    if (Number(m.restart_at ?? 0) > start && this.now - Number(m.restart_at) < this.k.crash * 60) return false;
    const place = { agent: String(m.agent || "claude"), model: String(m.model ?? ""), account: (m.account as string | null) ?? null };
    const lad = ladder(this.store, { project: this.project, squad, role: String(m.role), tier: m.tier as string | null, phase: m.phase as string | null },
      (this.store.get("squads", { project: this.project, topic: squad })?.repo as string | null) ?? null);
    const at = lad ? placeRung(this.store, lad.rungs, place) : null;
    const rung = rungTag(at !== null ? lad!.rungs[at] : place), k = { project: this.project, subject: key, kind: "crash" };
    const row = this.store.get("episodes", k), w = this.worker(wt);
    if (this.now - start >= this.k.crash * 60) {
      if (row && Number(row.count ?? 0) > 0 && Number(row.started_at) === start) return true;
      if (row && Number(row.count ?? 0) > 0) this.store.upsert("episodes", k, { count: 0, ended_at: this.now, observed_at: this.now });
      return false;
    }
    // U100: the settle cause is the loop's own verdict — a rebound-settled dispatch is the bind
    // taking, not this start crashing. dispatch_at still dates the settle to this start (U64).
    const cause = w && dispatchVerdict(this.store, this.project, squad, wt, this.now) === "settled"
      && w.dispatch_at != null && Number(w.dispatch_at) >= start ? "settled"
      : (!w || this.agents(wt) === 0) && !this.inGrace(wt) ? "exited" : null;
    if (!cause) return false;
    if (Number(row?.started_at) === start) return true;   // this start's crash is already handled
    const n = (row?.episode_key === rung ? Number(row.count ?? 0) : 0) + 1, ep = `crash|${wt}|${start}`;
    this.store.upsert("episodes", k, { squad, started_at: start, ended_at: null, episode_key: rung, count: n, state: cause, source: "loop", observed_at: this.now });
    const what = `${member} of ${squad} (crashed: ${cause} ${Math.max(0, Math.round((this.now - start) / 60))} min after a start on ${rung})`;
    const said = String(w?.said ?? "").trim() || String(w?.tail ?? "").trim().split("\n").pop() || "(none)";
    if (n === 2) {
      this.alert(squad, key, ep, `${what} — the second crash in a row on ${rung}; the next start may use it again. Last output: ${said}`, "squad",
        `if it keeps crashing, pin another model on the board (or restart-role.sh --agent/--model)`, "a standing role must stay running between turns; this one keeps ending on the same agent and model");
    }
    if (n > 2) {
      this.alert(squad, key, ep, `${what} — crash ${n} in a row on ${rung}; not restarted again. Last output: ${said}`, "squad");
      return true;
    }
    // Exited: the decider (U152) starts it again on its standing wish (the second crash's start may use
    // the rung again). Settled with its agent still there: presence reads running, so one above restarts it.
    if (cause === "exited") { this.marker(squad, key, ep); return true; }
    this.store.upsert("episodes", { project: this.project, subject: key, kind: "req" }, { squad, started_at: this.now, ended_at: null, count: 1, episode_key: ep, state: "sent", source: "loop", observed_at: this.now });
    this.actions.push({ project: this.project, squad, member, subject: key, kind: "request.file", episode: ep,
      payload: { target: above, path: `requests/${above}/${key}-${this.now}.txt`, text: `restart ${what}\n` } });
    return true;
  }

  // poke_agent: true = handled by poking (poked now, or the last poke is still within `every`);
  // false = pokes used up, or a poke failed — the caller escalates.
  poke(squad: string, key: string, wt: string, reason: string, ep: string, every: number, max: number, text: string, allowWorking = false): boolean {
    const k = { project: this.project, subject: key, kind: "poke" };
    const row = this.store.get("episodes", k), same = this.same(row, ep);
    const n = same ? Number(row!.count ?? 0) : 0;
    if (same && (row!.state === "failed" || n === -1)) return false;
    if (n > 0 && pokeFailed(this.store, this.project, wt, `${reason}:${ep}#${n}`)) {
      this.store.upsert("episodes", k, { state: "failed", observed_at: this.now });
      return false;
    }
    if (n > 0 && this.now - Number(row!.started_at ?? 0) < every * 60) return true;
    if (max > 0 && n >= max) return false;
    const r = wake(this.ctx, wt, text, reason, ep, { allowWorking });
    this.actions.push(...r.actions);
    if (r.status === "sent") {
      this.store.upsert("episodes", k, { squad, started_at: this.now, ended_at: null, episode_key: ep, count: n + 1, state: "poked", source: "loop", observed_at: this.now });
      return true;
    }
    return r.status !== "skipped:capped";
  }

  // check_agent: true when the member cannot act on requests now (restart requested, being poked,
  // usage-limited), so what sits below it goes one level up.
  check(squad: string, key: string, above: string, member: string, wt: string, run: string | null = null, standing = false): { cannot: boolean; parked: boolean } {
    if (paused(this.store, { project: this.project, squad, member: wt })) return { cannot: true, parked: true };
    // side-loop-host U13: a member on an unreachable side host is unknown, never dead, hung or idle: left alone.
    if (hostUnreachable(this.store, wtHost(this.store, wt))) return { cannot: true, parked: true };
    const w = this.worker(wt);
    if (this.limited(wt, w)) return { cannot: true, parked: true };
    if (standing && above !== "_operator" && this.crash(squad, key, above, member, wt)) return { cannot: true, parked: false };
    const b = this.broken(wt, run, true);
    if (!b) {
      if (w?.state === "working") {
        const out = Number(w.last_output_at ?? 0);
        // A Builder at its prompt gets the idle ladder's nudges instead (idleBuilder).
        if (out > 0 && this.now - out >= this.k.quiet * 60 && !this.longStep(wt, out) && !this.promptOpen(key)) {
          this.poke(squad, `${key}.quiet`, wt, "quiet", `quiet|${wt}|${out}`, this.k.quiet, 1, QUIET_POKE_TEXT, true);
        }
      }
      return { cannot: false, parked: false };
    }
    if (b.cause === "not responding" && this.poke(squad, key, wt, "silent", b.ep, this.k.recheck, this.k.pokes, POKE_TEXT)) return { cannot: true, parked: false };
    // U152/U153: a dead, exited or hung member is the decider's (decide.ts): its standing wish
    // starts it again, a hung one is stopped first. Only the `req` marker is kept, so held
    // pokes go out once it is back. No restart request to the Lead any more.
    if (b.cause === "dead" || b.cause === "exited" || b.cause === "hung") { this.marker(squad, key, b.ep); return { cannot: true, parked: false }; }
    this.handle(squad, key, above, member, squad, b);
    return { cannot: true, parked: false };
  }

  // U69 + U267: see the header. `above` is whoever the Builder's requests go to (its Lead, or the one above).
  idleBuilder(squad: string, key: string, above: string, member: string, wt: string, u: { slug: string; pr: string | null; hold: number | null; doc: string | null }): void {
    const stale = knob(this.store, this.project, "STALE_MIN", 20), w = this.worker(wt);
    const k = { project: this.project, subject: `${key}.idle`, kind: "idle" };
    if (!w) return;
    const row = this.store.get("episodes", k);
    let recorded = false;
    try { recorded = !!JSON.parse(u.doc ?? "{}")?.waiting_on; } catch { /* a torn doc: not waiting */ }
    let cause: Record<string, unknown> = {};
    const stall = (step: string, head: string | null) => this.store.event("builder_stall", { project: this.project, squad, unit: u.slug, member: wt, payload: { step, head, name: member, ...cause } });
    const file = (ep: string, text: string) => this.actions.push({ project: this.project, squad, member, subject: `${key}.idle`, kind: "request.file", episode: ep,
      payload: { target: above, path: `requests/${above}/${key}.idle-${this.now}.txt`, text } });
    // (1) The task ended through the Builder's own worker_done with no PR: one report, never a poke.
    // U12: off Orca, its failed or no-PR finish row of this generation is that report.
    const contract = onContract(this.store, this.project, squad);
    const fin = !u.pr && contract ? finishDone(this.store, this.project, squad, wt, this.now) : null;
    const done = u.pr ? null : contract ? fin : workerDone(this.store, this.project, squad, w.dispatch_id, this.now);
    if (done) {
      const ep = `failed|${u.slug}|${fin ? `gen:${fin.gen}` : w.dispatch_id}`;
      if (recorded || (row?.episode_key === ep && row.state === "failed_report")) return;
      this.store.upsert("episodes", k, { squad, started_at: this.now, ended_at: null, count: 1, episode_key: ep, state: "failed_report", source: "loop", observed_at: this.now });
      stall("failed_report", null);
      file(ep, `${done.outcome === "failed" ? "failed report" : "report with no PR"}: ${member} of ${squad} ended its task on unit ${u.slug} with no PR (${contract ? "ds finish" : "worker_done"}, outcome ${done.outcome}): ${done.text}. Answer it, mark the unit done, dispatch it again, split it or cancel it.\n`);
      return;
    }
    // A failed report is over once a new dispatch (or a PR) replaced the one it named.
    if (row?.state === "failed_report" && row.ended_at == null) this.store.upsert("episodes", k, { ended_at: this.now, state: "cleared", observed_at: this.now });
    const due = idleBuilderState(this.store, this.project, wt, this.now, { ...u, squad }, w);
    if (!due) return;
    const prompt = due.prompt, idle = this.now - due.since, held = !!u.hold;
    if (prompt) {
      this.openPrompt(squad, key, u.slug, wt, due.since);
      cause = { cause: "at-prompt", since: due.since, command: prompt.command };
    }
    let waiting = recorded;
    if (!waiting) {
      const questions = builderQuestions(this.store, this.project, squad, wt, this.now);
      // A failed binding read defers this decision without changing its episode or answering anything.
      if (questions.candidate && w.dispatch_seen_at !== this.now) return;
      waiting = questions.current;
    }
    // (2) The episode is the unit, the Builder and its branch head: output is no progress, a commit is.
    const head = builderHead.read(this.store, this.project, wt, due.since);
    const ep = `idle|${u.slug}|${wt}|${head ?? "?"}`, same = row?.episode_key === ep && row.ended_at == null;
    const mark = (state: string, count: number) => this.store.upsert("episodes", k, { squad, started_at: this.now, ended_at: null, count, episode_key: ep, state, source: "loop", observed_at: this.now });
    if (waiting) { if (!same || row!.state !== "waiting") mark("waiting", 0); return; }
    if (same && row!.state === "reported") return;
    const report = () => {
      const said = String(w.said ?? "").trim() || String(w.tail ?? "").trim().split("\n").pop() || "(none)";
      mark("reported", Number(row?.count ?? 0));
      stall("reported", head);
      const poked = same && Number(row!.count ?? 0) > 0 ? `, nudged ${Number(row!.count)} times with no new commit` : "";
      const isHeld = held ? " (the unit is held)" : "";
      file(ep, prompt
        ? `idle: ${member} of ${squad} has sat at its prompt on unit ${u.slug} for ${Math.round(idle / 60)} min (turn ended ${hhmm(due.since)}) with only a background command running (\`${prompt.command}\`) and no PR${isHeld}${poked}. Wake it, stop the command, release the unit, or close it.\n`
        : `idle: ${member} of ${squad} has sat idle on unit ${u.slug} for ${Math.round(idle / 60)} min with no PR${isHeld}${poked}. Last output: ${said}. Wake it, release the unit, or close it.\n`);
    };
    if (held) { report(); return; }
    const pokes = same && row!.state === "nudged" ? Number(row!.count ?? 1) : 0;
    // stale_min spaces the nudges; with it off, an at-prompt ladder steps by prompt_wait_min.
    if (pokes && this.now - Number(row!.started_at ?? 0) < (stale || knob(this.store, this.project, "PROMPT_WAIT_MIN", 20)) * 60) return;
    if (pokes >= 2) { report(); return; }
    const r = prompt
      ? wake(this.ctx, wt, `dev-studio loop: your turn ended at ${hhmm(due.since)} and only a background command is still running: \`${prompt.command}\`. If it is stuck, stop it. If the unit is done, open the PR. If you are waiting on something, say what with \`ask\`.`,
        "stale", `${ep}|${pokes + 1}`, { allowWorking: true })
      : wake(this.ctx, wt, "dev-studio loop: your unit is still open: carry on, or say what you are waiting on with `ask`.", "stale", `${ep}|${pokes + 1}`);
    this.actions.push(...r.actions);
    // A nudge that cannot land (no member row, a dialog on screen, capped) will not land twice: the report follows stale_min later.
    if (r.status !== "skipped:tick") { mark("nudged", r.status === "sent" ? pokes + 1 : 2); stall("poked", head); }
  }

  // The at-prompt episode (see the header): opened on the first tick atPrompt holds, ended by endPrompts.
  // Written only when it opens or ends.
  openPrompt(squad: string, key: string, slug: string, wt: string, since: number): void {
    const k = { project: this.project, subject: `${key}.prompt`, kind: "at-prompt" }, row = this.store.get("episodes", k);
    if (row && row.ended_at == null && Number(row.started_at) === since) return;
    this.store.upsert("episodes", k, { squad, started_at: since, ended_at: null, count: 1, episode_key: `prompt|${slug}|${wt}`, state: "open", source: "loop", observed_at: this.now });
  }
  promptOpen(key: string): boolean {
    const row = this.store.get("episodes", { project: this.project, subject: `${key}.prompt`, kind: "at-prompt" });
    return !!row && row.ended_at == null;
  }
  // An open at-prompt episode ends when its transcript moves, its Builder is no longer working, its unit
  // has a PR or is no longer dispatched. Row reads only, no transcript parse.
  endPrompts(): void {
    const open = this.store.db.query("SELECT subject, squad, started_at, episode_key FROM episodes WHERE project = ? AND kind = 'at-prompt' AND ended_at IS NULL")
      .all(this.project) as { subject: string; squad: string; started_at: number; episode_key: string }[];
    for (const e of open) {
      const [, slug, wt] = /^prompt\|([^|]*)\|(.*)$/.exec(e.episode_key) ?? [];
      const u = this.store.db.query("SELECT status, pr, hold FROM units WHERE project = ? AND squad = ? AND slug = ?").get(this.project, e.squad, slug ?? "") as Row | null;
      const t = wt ? this.store.db.query("SELECT mtime FROM observed_transcripts WHERE wt = ? ORDER BY mtime DESC").get(wt) as { mtime: number | null } | null : null;
      const live = !!u && u.status === "dispatched" && noOpenPr(this.store, this.project, u as { pr: string | null; hold: number | null })
        && this.worker(wt ?? "")?.state === "working" && Number(t?.mtime ?? 0) === Number(e.started_at);
      if (!live) this.store.upsert("episodes", { project: this.project, subject: e.subject, kind: "at-prompt" }, { ended_at: this.now, state: "cleared", observed_at: this.now });
    }
  }

  run(): Action[] {
    const { store, project } = this;
    // No fresh Orca observation this tick: every member would read dead. The sweep exits then.
    const seen = store.db.query("SELECT MAX(observed_at) AS t FROM observed_workers WHERE project = ?").get(project) as { t: number | null };
    if (!seen.t || seen.t < this.now) return [];
    this.endPrompts();

    // The Studio: only the operator is above it.
    const studio = (store.get("projects", { label: project })?.studio_wt as string | null) ?? null;
    let aboveLead = "_studio";
    if (studio && !this.limited(studio, this.worker(studio))) {
      const b = this.broken(studio, null, false);
      if (b) { aboveLead = "_operator"; this.handle(null, "_studio", "_operator", "studio", "", b); }
    }

    for (const sq of liveSquads(store, project)) {
      const topic = String(sq.topic), lead = leadOf(store, sq);
      if (paused(store, { project, squad: topic })) continue;
      let aboveBuilder = topic;
      const mail = (sq.run_id as string | null) ?? (onContract(store, project, topic) ? ROWS : null);
      if (lead && this.check(topic, `${topic}.lead`, aboveLead, "lead", lead, mail, true).cannot) aboveBuilder = aboveLead;
      const members = store.db.query("SELECT role, suffix, wt FROM members WHERE project = ? AND squad = ? AND wt IS NOT NULL AND COALESCE(want, '') != 'gone' AND COALESCE(status, '') != 'gone' ORDER BY id")
        .all(project, topic) as { role: string; suffix: string; wt: string }[];
      for (const m of members.filter((x) => x.role === "thinker")) this.check(topic, `${topic}.${who(m)}`, aboveLead, who(m), m.wt, null, true);
      const byWt = new Map(members.map((m) => [m.wt, m]));
      const units = store.db.query("SELECT id, slug, status, builder_wt, pr, hold, doc FROM units WHERE project = ? AND squad = ? AND status IN ('dispatched', 'done') AND COALESCE(builder_wt, '') != '' ORDER BY slug")
        .all(project, topic) as { id: number; slug: string; status: string; builder_wt: string; pr: string | null; hold: number | null; doc: string | null }[];
      for (const u of units) {
        if (stopping(store, project, u.builder_wt) || paused(store, { project, squad: topic, member: u.builder_wt })) continue;
        const m = byWt.get(u.builder_wt), name = m ? who(m) : `builder-${u.slug}`, key = `${topic}.${name}`;
        // A done unit's Builder still around: only the hung check (a GONE one needs no restart).
        if (u.status === "done") {
          if (!m || this.worker(u.builder_wt)?.state !== "working") continue;
          this.check(topic, key, aboveBuilder, name, u.builder_wt);
          continue;
        }
        const c = this.check(topic, key, aboveBuilder, name, u.builder_wt);
        // U92 (6): held pokes go out once a restarted Builder is back.
        if (!c.cannot) this.heldPokes(topic, key, u.builder_wt);
        if (!c.cannot && !c.parked) this.idleBuilder(topic, key, aboveBuilder, name, u.builder_wt, { slug: u.slug, pr: u.pr, hold: u.hold, doc: u.doc });
      }
    }
    return this.actions;
  }
}

export function liveness(ctx: TickCtx): Action[] { return new Pass(ctx).run(); }

export default { name: "liveness", run: liveness } satisfies Reconciler;
