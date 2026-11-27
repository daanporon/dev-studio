// fulfil/expose-stop.ts — kind `expose.stop` (exposed-cleanup U2): run one group of queued stop commands
// (`ds expose --stop`) once. The reconciler (reconcilers/exposed.ts) groups the queued rows; here
//   1. the rows of `ids` still queued (none: done, a replay or a skip got there first),
//   2. claimed queued → running with stop_at, in one transaction (none claimed: done),
//   3-4 (io/stop-run.ts stopHere): cwd: the owner's worktree while it exists, else the project's state folder
//      (`cwd_fallback`), never another member's worktree; the command in its own process group (tidy.ts runOnClose: TERM, wait, KILL on timeout) for
//      min(expose_stop_s, 100) s, output to <root>/<project>/loop/cleanup/expose-stop-<lowest id>.log,
//   5. every claimed row settles done (exit 0), timeout or failed with its stop_result
//      ({ids, code, ms, timed_out, cwd, cwd_fallback, tail}, the log's last 2000 characters redacted),
//   6. one `expose_stop` event.
// A row the loop left `running` (a restart mid-run) is never run again: the reconciler settles it lost.
// side-loop-host u8b: the stop of an entry a side member owns (payload `host`) runs on that host as the `expose.stop`
// host job (link/host-jobs.ts exposeStopOn), never on main. While the host is unreachable nothing is claimed (wait);
// a host that is gone or fenced settles the rows lost; a link that breaks mid-run settles the claimed rows lost.
import type { Action } from "../core/plugins.ts";
import type { Exec, Fulfiller, Result } from "../core/actuator.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";
import { limitInt } from "../settings/limits.ts";
import { STOP_S_MAX, stopHere, type StopRun } from "../io/stop-run.ts";
import { settleStops, sideStopGate } from "../squad/exposed.ts";
import { onSide } from "../squad/backend.ts";
import { exposeStopOn } from "../../link/host-jobs.ts";

type P = ActionPayload<"expose.stop">;

function lost(a: Action, x: Exec, ids: number[], from: string, why: string, host: string): Result {
  const got = settleStops(x.store, ids, from, "lost", { ids, why, host });
  if (got.length) x.store.event("expose_stop", { project: a.project, squad: a.squad ?? null, payload: { ids: got, state: "lost", host, why } });
  return { done: true, result: `stop lost: ${why}` };
}

async function stop(a: Action, x: Exec, p: P): Promise<Result> {
  const { store } = x;
  const queued = p.ids.filter((id) => (store.db.query("SELECT stop_state FROM exposed WHERE id = ?").get(id) as { stop_state: string | null } | null)?.stop_state === "queued");
  if (!queued.length) return { done: true, result: "nothing queued" };
  const side = onSide(p.host) ? String(p.host) : null;
  if (side) {
    const owner = (store.db.query("SELECT owner_wt FROM exposed WHERE id = ?").get(queued[0]) as { owner_wt: unknown } | null)?.owner_wt;
    const gate = sideStopGate(store, a.project, owner, side);
    if ("hold" in gate) return { wait: gate.hold };
    if ("lost" in gate) return lost(a, x, queued, "queued", gate.lost, side);
  }
  const ids = settleStops(store, queued, "queued", "running", { ids: queued }, x.now);
  if (!ids.length) return { done: true, result: "claimed elsewhere" };
  const job = { project: a.project, squad: String(a.squad ?? ""), cmd: p.cmd, low: Math.min(...p.ids),
    timeout_s: Math.max(1, Math.min(limitInt(store, a.project, "expose_stop_s", 90), STOP_S_MAX)), ...(p.cwd ? { cwd: p.cwd } : {}) };
  let r: StopRun;
  try {
    r = side ? await exposeStopOn(side, job, { root: store.root, ...x.act?.hostJobs() }) : await stopHere(store.root, job);
  } catch (e) {
    if (!side) throw e;
    return lost(a, x, ids, "running", `the stop on host ${side} did not answer: ${(e as Error).message}`.slice(0, 300), side);
  }
  const state = r.timed_out ? "timeout" : r.code === 0 ? "done" : "failed";
  const result = { ids, ...r, ...(side ? { host: side } : {}) };
  settleStops(store, ids, "running", state, result);
  store.event("expose_stop", { project: a.project, squad: a.squad ?? null, payload: { ids, state, code: r.code, ms: r.ms, tail: r.tail.slice(-500), ...(side ? { host: side } : {}) } });
  return { done: true, result: `stop ${state}${r.code != null ? ` (exit ${r.code})` : ""}${side ? ` on ${side}` : ""}` };
}

const exposeStop: Fulfiller = {
  name: "expose-stop",
  kinds: ["expose.stop"],
  run: () => [],
  exec(a, x) {
    const p = payloadOf<"expose.stop">(a);
    if (!a.project || !Array.isArray(p.ids) || !p.ids.length || !p.cmd) return { failed: "a stop needs a project, entry ids and a command" };
    return { background: stop(a, x, p) };
  },
};
export default exposeStop;
