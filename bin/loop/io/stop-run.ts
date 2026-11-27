// io/stop-run.ts — run one group of `ds expose --stop` commands on this host (exposed-cleanup U2). Main runs it for
// an entry its own members own (fulfil/expose-stop.ts); a side host runs it for an entry one of its members owns,
// as the `expose.stop` host job (side-loop-host u8b, link/host-jobs.ts), so a side member's stop never starts a
// process on main.
//   cwd: the owner's worktree while it exists, else the project's folder in this host's state root (`cwd_fallback`),
//   the command in its own process group (tidy.ts runOnClose: TERM, wait, KILL on timeout) for `timeoutS` seconds,
//   output to <root>/<project>/loop/cleanup/expose-stop-<low>.log, whose last 2000 characters come back redacted.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envNum, runOnClose } from "./tidy.ts";
import { redact } from "../core/redact.ts";

export const TAIL_MAX = 2000;
/** The longest a stop may run, whatever expose_stop_s says. */
export const STOP_S_MAX = 100;

export type StopRun = { code: number | null; ms: number; timed_out: boolean; cwd: string; cwd_fallback: boolean; tail: string };
export type StopJob = { project: string; squad: string; cmd: string; cwd?: string | null; low: number; timeout_s: number };

function tail(log: string): string {
  try { return redact(readFileSync(log, "utf8").slice(-TAIL_MAX)); } catch { return ""; }
}

/** Run `j.cmd` here; `root` is this host's state root. */
export async function stopHere(root: string, j: StopJob): Promise<StopRun> {
  const own = j.cwd && existsSync(j.cwd) ? j.cwd : null;
  const cwd = own ?? join(root, j.project);
  mkdirSync(cwd, { recursive: true });
  const log = join(root, j.project, "loop", "cleanup", `expose-stop-${j.low}.log`);
  const timeoutS = Math.max(1, Math.min(j.timeout_s, STOP_S_MAX));
  const r = await runOnClose(j.cmd, cwd, { DS_PROJECT: j.project, DS_WORKTREE: own ?? "", DS_SQUAD: j.squad }, log, timeoutS, envNum("DS_TIDY_WAIT_MS", 10_000));
  return { code: r.code, ms: r.ms, timed_out: r.timedOut, cwd, cwd_fallback: !own, tail: tail(log) || (r.error ? redact(r.error) : "") };
}
