// shadow.ts — the shadow signals (orca-backend-alternatives U10). For every member on the Orca path
// with a generation (`members.gen`, U4), the new backend-neutral input is computed next to the old
// Orca one at each decision point, so the switch (U12) can be judged before it is made. Pure reads:
// the reconciler (reconcilers/shadow.ts) logs the disagreements, `ds shadow` reports them.
//
//   point     old input (Orca)                                     new input
//   start     view() + reality(): presence = walk or live dispatch   newView() + newReality(): the process walk alone,
//                                                                    a one-shot with a finish row of its generation stopped
//   finished  worker_done for the current dispatch, a completed     a finish row of the member's generation
//             dispatch, a tester_pass_done since the start
//   retire    Builder: unit done, PR merged, Orca state not          Builder: the same, idle read from the transcript (turnEnded)
//             working/waiting; feature Tester: Run row not live,     feature Tester: a verdict finish row of its generation
//             no dispatch, reported                                  and no agent process
//   member    the Run's worker list (run-workers, live)              a loop.db member row
//
// Each pair is two short strings; a pair whose sides differ is a disagreement. A member with no
// generation (Codex, Muse, an `--on` start) is left out. Nothing here changes what the loop does.
import { effective, paused } from "../pause/pause.ts";
import { memberUnit } from "../pause/pause-conditions.ts";
import { STANDING } from "../drivers/types.ts";
import { goneMinS, noAgentSince, reality, walkReality } from "../core/decide.ts";
import { finishOf, nameOf } from "./finish-read.ts";
import { lastStart, view } from "./member-state.ts";
import { DONE_GRACE_S, turnEnded, workerDone } from "../reconcilers/liveness.ts";
import { runWorkers, type RunWorker } from "./run-reads.ts";
import { stopping } from "./cancel.ts";
import { settledTask } from "../reconcilers/members.ts";
import type { Row, Store } from "../core/store.ts";

export const POINTS = ["start", "finished", "retire", "member"] as const;
export type Point = (typeof POINTS)[number];
export type Pair = { point: Point; subject: string; member: string; id: number | null; gen: string | null; squad: string; wt: string; old: string; new: string };

// A disagreement that agrees again within this many ticks of its first is transient and not counted.
export const TRANSIENT_TICKS = 2;

export { nameOf };

/** The members the shadow reads: the latest row per identity with a worktree and a generation, not the Studio, not gone. */
export function tracked(store: Store, project: string): Row[] {
  return store.db.query(`SELECT m.* FROM members m WHERE m.project = ? AND m.squad != '_studio' AND m.role != 'studio'
      AND m.wt IS NOT NULL AND COALESCE(m.gen, '') != '' AND COALESCE(m.status, '') NOT IN ('gone', 'closed')
      AND m.id = (SELECT MAX(id) FROM members WHERE project = m.project AND squad = m.squad AND role = m.role AND suffix IS m.suffix)
    ORDER BY m.id`).all(project) as Row[];
}

export { finishOf };

const worker = (store: Store, m: Row): Row | null => (m.wt ? store.get("observed_workers", { project: m.project, wt: m.wt }) : null);
const oneShot = (m: Row) => m.role !== "builder" && !STANDING.has(String(m.role));
const pair = (point: Point, m: Row, old: string, nw: string): Pair => ({
  point, subject: `${point}:member:${m.id}`, member: nameOf(m), id: Number(m.id), gen: (m.gen as string | null) ?? null,
  squad: String(m.squad), wt: String(m.wt ?? ""), old, new: nw,
});

// ---------------------------------------------------------------- start
/** view() with the finish row in place of the completed dispatch: a one-shot that finished reads stopped. */
export function newView(store: Store, m: Row): string | null {
  const e = effective(store, m).state;
  if (e === "running" && oneShot(m) && m.wt) return finishOf(store, m) ? "stopped" : "running";
  return view(store, m);
}

/** reality() read from the process walk alone (the live dispatch no longer holds a member running). */
export const newReality = walkReality;

// Two known lags agree, the new side taking the old one's value:
//   - running against starting (U21a pattern F): a start placed this minute that no walk has read yet,
//     while Orca already lists its dispatch; the decider does nothing for either;
//   - running against none while the old side's GONE_MIN clock runs (U21a): Orca still reads a dead
//     agent working, and the old side reads it gone GONE_MIN after the walk first found none.
export function startPair(store: Store, m: Row, now: number): Pair {
  const ov = view(store, m), nv = newView(store, m);
  const old = ov === "running" ? reality(store, m, now) : String(ov);
  const nw = nv === "running" ? newReality(store, m, now) : String(nv);
  return pair("start", m, old, startLag(store, m, old, nw, now) ? old : nw);
}
function startLag(store: Store, m: Row, old: string, nw: string, now: number): boolean {
  if (old === nw) return false;
  if ([old, nw].every((x) => x === "running" || x === "starting")) return true;
  if (old !== "running" || nw !== "none") return false;
  const w = worker(store, m), since = w ? noAgentSince(store, m, w, lastStart(m)) : null;
  return since != null && now - since < goneMinS(store, String(m.project));
}

// ---------------------------------------------------------------- finished
const doneSide = (failed: boolean) => (failed ? "failed" : "ok");

// A Builder whose unit records a PR is left out (U21a pattern B): it sends worker_done when it opens the
// PR, the loop ignores that report (liveness idleBuilder), and its finish row comes later from the babysit
// generation the phase restart starts, so the two signals answer different questions there. The PR counts
// as seen the way lifecycle.ts finds it (U21d): the unit's pr, or an observed_prs row for the member's
// branch (open, or merged), so a PR the observer has not yet written to the unit makes no pair either.
function hasPr(store: Store, m: Row): boolean {
  if (m.role !== "builder") return false;
  if (memberUnit(store, { project: String(m.project), squad: String(m.squad), role: "builder", suffix: String(m.suffix ?? ""), member: String(m.wt) })?.pr) return true;
  const branch = String(store.get("observed_worktrees", { project: m.project, wt: m.wt })?.branch ?? "");
  const sq = store.get("squads", { project: m.project, topic: m.squad });
  const nwo = sq?.repo ? (store.get("config", { project: m.project, file: "github", key: `repo:${sq.repo}` })?.value as string | undefined) : undefined;
  if (!nwo || !branch || branch === "HEAD") return false;
  return !!store.db.query("SELECT 1 FROM observed_prs WHERE project = ? AND repo = ? AND head = ? AND (state = 'MERGED' OR (state = 'OPEN' AND gone_at IS NULL)) LIMIT 1")
    .get(String(m.project), nwo, branch);
}

/** Is a one-shot or Builder finished, and how: "no", "ok" or "failed". Standing roles never finish. */
export function finishedPair(store: Store, m: Row, now: number): Pair | null {
  if (STANDING.has(String(m.role)) || hasPr(store, m)) return null;
  const w = worker(store, m);
  // workerDone with no grace: the old signal as soon as the relay has it.
  const done = w?.dispatch_id ? workerDone(store, String(m.project), String(m.squad), w.dispatch_id, Number.MAX_SAFE_INTEGER) : null;
  // U21d: the loop reads a Builder's worker_done only DONE_GRACE_S after the relay saw it (its PR may follow
  // within that time and then the report is ignored), so a younger one with no finish row is no pair yet.
  if (done && m.role === "builder" && !finishOf(store, m) && !workerDone(store, String(m.project), String(m.squad), w!.dispatch_id, now)) return null;
  let old = "no";
  if (done) old = doneSide(done.outcome === "failed");
  else if (w?.dispatch === "completed") old = "ok";
  else if (m.role === "tester" && store.db.query(`SELECT 1 FROM events WHERE kind = 'tester_pass_done' AND project = ? AND squad = ? AND member = ? AND at >= ? LIMIT 1`)
    .get(String(m.project), String(m.squad), String(m.wt), lastStart(m))) old = "ok";
  const f = finishOf(store, m);
  // finish-unit writes the row just before worker_done (U21a pattern A): the relay's lag is no
  // disagreement while the row is younger than the grace the loop gives a report.
  const nw = !f || (old === "no" && Number(f.at) > now - DONE_GRACE_S) ? "no" : doneSide(f.outcome === "failed");
  return pair("finished", m, old, nw);
}

// ---------------------------------------------------------------- retire
// A PR row the way lifecycle.ts finds it: the repo's own row, else the unit's ref.
function prState(store: Store, m: Row, u: Row): string | null {
  const n = Number(/\d+/.exec(String(u.pr ?? ""))?.[0] ?? NaN);
  if (!Number.isFinite(n)) return null;
  const sq = store.get("squads", { project: m.project, topic: m.squad });
  const nwo = sq?.repo ? (store.get("config", { project: m.project, file: "github", key: `repo:${sq.repo}` })?.value as string | undefined) : undefined;
  const r = (nwo && store.get("observed_prs", { project: m.project, ref: `${nwo}#${n}` }))
    || (store.db.query("SELECT state FROM observed_prs WHERE project = ? AND ref = ? AND pr = ?").get(String(m.project), `${m.squad}/${u.slug}`, n) as Row | null);
  return r ? String(r.state) : null;
}

/** Would the loop retire it: "retire" or "keep". A Builder and a feature squad's Tester; paused members are left out. */
// A member the loop already wants gone was retired (U21a pattern D): the new side reads its agent's
// end a tick or two after the loop acted, which is no disagreement.
export function retirePair(store: Store, m: Row, workers: RunWorker[] | null): Pair | null {
  if (m.want === "gone") return null;
  if (paused(store, { project: String(m.project), squad: String(m.squad), member: String(m.wt) })) return null;
  if (m.role === "builder") {
    const u = memberUnit(store, { project: String(m.project), squad: String(m.squad), role: "builder", suffix: String(m.suffix ?? ""), member: String(m.wt) });
    const merged = !!u && u.status === "done" && prState(store, m, u) === "MERGED";
    const w = worker(store, m);
    const busy = !!w && w.gone_at == null && ["working", "waiting"].includes(String(w.state ?? ""));
    return pair("retire", m, merged && !busy ? "retire" : "keep", merged && turnEnded(store, String(m.wt)) ? "retire" : "keep");
  }
  if (m.role !== "tester" || !workers) return null;
  const type = String(store.get("squads", { project: m.project, topic: m.squad })?.type ?? "feature");
  if (type !== "feature") return null;
  const tw = workers.find((x) => x.wt === m.wt);
  const old = !!tw && !tw.live && !tw.dispatch && tw.reported === true;
  const f = finishOf(store, m), w = worker(store, m);
  const nw = f?.outcome === "verdict" && (!w || w.gone_at != null || w.walk === "none");
  return pair("retire", m, old ? "retire" : "keep", nw ? "retire" : "keep");
}

// ---------------------------------------------------------------- member
// What members.ts does with the Run's list: a member it lists live is bound; one it lists with a task
// that did not finish (a one-shot's report, a completed dispatch) is rebound; a live worker with a
// dispatch and no member row is unbound. A member the Run does not list gets nothing: no opinion, and
// neither does one being stopped. A standing role bound through a rebind the loop settled (U89) stays
// not live with that task and is left alone: a member.
const reported = (m: Row, w: RunWorker) => (w.status === "completed" || w.reported === true) && !STANDING.has(String(m.role));

// A phase switch since its start (U21a pattern E): the stop and fresh start are in flight, Orca has
// already dropped the old dispatch, and member_stopped is logged only once the stop completes.
const phaseStop = (store: Store, m: Row) => !!store.db.query("SELECT 1 FROM events WHERE kind = 'member_phase' AND project = ? AND member = ? AND at >= ? LIMIT 1")
  .get(String(m.project), String(m.wt), lastStart(m));

/** Is it a member: "member" or "absent", per worktree. Members leaving, paused or not running are left out. */
export function memberPairs(store: Store, project: string, squad: string, workers: RunWorker[], members: Row[], now: number): Pair[] {
  const out: Pair[] = [];
  for (const m of members) {
    const wt = String(m.wt);
    if (m.squad !== squad || m.want === "gone" || effective(store, m).state !== "running" || phaseStop(store, m)
      || newReality(store, m, now) !== "running" || stopping(store, project, wt) || paused(store, { project, squad, member: wt })) continue;
    const w = workers.find((x) => x.wt === wt);
    const bound = !!w?.task && STANDING.has(String(m.role)) && settledTask(store, project, squad, wt, w.task);
    if (w?.live || bound) out.push(pair("member", m, "member", "member"));
    else if (w?.task && !reported(m, w)) out.push(pair("member", m, "absent", "member"));
  }
  // A live Run worker with a dispatch and no member row in loop.db. A worktree whose newest row has no
  // generation is left out (its member is not shadowed).
  for (const w of workers) {
    if (!w.live || !w.dispatch || stopping(store, project, w.wt) || paused(store, { project, squad, member: w.wt })) continue;
    const latest = store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? ORDER BY id DESC LIMIT 1").get(project, squad, w.wt) as Row | null;
    if (latest && (!latest.gen || latest.status !== "gone")) continue;
    out.push({ point: "member", subject: `member:wt:${w.wt}`, member: latest ? nameOf(latest) : w.wt, id: latest ? Number(latest.id) : null,
      gen: (latest?.gen as string | null) ?? null, squad, wt: w.wt, old: "member", new: "absent" });
  }
  return out;
}

/** Every pair of a project this tick. The Tester retire and the member point need this tick's Run read. */
export function pairs(store: Store, project: string, tick: number, now: number): Pair[] {
  const members = tracked(store, project), out: Pair[] = [];
  for (const m of members) {
    out.push(startPair(store, m, now));
    const f = finishedPair(store, m, now);
    if (f) out.push(f);
    const r = retirePair(store, m, runWorkers(project, String(m.squad), tick));
    if (r) out.push(r);
  }
  const squads = store.db.query("SELECT topic FROM squads WHERE project = ? ORDER BY topic").all(project) as Row[];
  for (const s of squads) {
    const workers = runWorkers(project, String(s.topic), tick);
    if (workers) out.push(...memberPairs(store, project, String(s.topic), workers, members, now));
  }
  return out;
}
