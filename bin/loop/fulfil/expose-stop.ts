// fulfil/expose-stop.ts — kind `expose.stop` (exposed-cleanup U2): run one group of queued stop commands
// (`ds expose --stop`) once. The reconciler (reconcilers/exposed.ts) groups the queued rows; here
//   1. the rows of `ids` still queued (none: done, a replay or a skip got there first),
//   2. claimed queued → running with stop_at, in one transaction (none claimed: done),
//   3. cwd: the owner's worktree while it exists, else the project's state folder (`cwd_fallback`),
//      never another member's worktree,
//   4. the command in its own process group (tidy.ts runOnClose: TERM, wait, KILL on timeout) for
//      min(expose_stop_s, 100) s, output to <root>/<project>/loop/cleanup/expose-stop-<lowest id>.log,
//   5. every claimed row settles done (exit 0), timeout or failed with its stop_result
//      ({ids, code, ms, timed_out, cwd, cwd_fallback, tail}, the log's last 2000 characters redacted),
//   6. one `expose_stop` event.
// A row the loop left `running` (a restart mid-run) is never run again: the reconciler settles it lost.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Action } from "../core/plugins.ts";
import type { Exec, Fulfiller, Result } from "../core/actuator.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";
import { limitInt } from "../settings/limits.ts";
import { envNum, runOnClose } from "../io/tidy.ts";
import { redact } from "../core/redact.ts";
import { settleStops } from "../squad/exposed.ts";

type P = ActionPayload<"expose.stop">;
export const TAIL_MAX = 2000;

function tail(log: string): string {
  try { return redact(readFileSync(log, "utf8").slice(-TAIL_MAX)); } catch { return ""; }
}

async function stop(a: Action, x: Exec, p: P): Promise<Result> {
  const { store } = x;
  const queued = p.ids.filter((id) => (store.db.query("SELECT stop_state FROM exposed WHERE id = ?").get(id) as { stop_state: string | null } | null)?.stop_state === "queued");
  if (!queued.length) return { done: true, result: "nothing queued" };
  const ids = settleStops(store, queued, "queued", "running", { ids: queued }, x.now);
  if (!ids.length) return { done: true, result: "claimed elsewhere" };
  const low = Math.min(...p.ids);
  const own = p.cwd && existsSync(p.cwd) ? p.cwd : null;
  const cwd = own ?? join(store.root, a.project);
  mkdirSync(cwd, { recursive: true });
  const log = join(store.root, a.project, "loop", "cleanup", `expose-stop-${low}.log`);
  const timeoutS = Math.min(limitInt(store, a.project, "expose_stop_s", 90), 100);
  const r = await runOnClose(p.cmd, cwd, { DS_PROJECT: a.project, DS_WORKTREE: own ?? "", DS_SQUAD: String(a.squad ?? "") }, log, timeoutS, envNum("DS_TIDY_WAIT_MS", 10_000));
  const state = r.timedOut ? "timeout" : r.code === 0 ? "done" : "failed";
  const out = tail(log) || (r.error ? redact(r.error) : "");
  const result = { ids, code: r.code, ms: r.ms, timed_out: r.timedOut, cwd, cwd_fallback: !own, tail: out };
  settleStops(store, ids, "running", state, result);
  store.event("expose_stop", { project: a.project, squad: a.squad ?? null, payload: { ids, state, code: r.code, ms: r.ms, tail: out.slice(-500) } });
  return { done: true, result: `stop ${state}${r.code != null ? ` (exit ${r.code})` : ""}` };
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
