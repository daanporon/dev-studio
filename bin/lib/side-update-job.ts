// side-update-job.ts — side-loop-host U24: the side host's half of main's `update` host job. The job starts
// `bin/host/update-host.sh --side <commit>` outside the side loop (that run restarts the loop, which would kill a
// child of it) and answers at once; main asks again until it reads `done` or `failed`. One record per host,
// <state root>/link/update.json: this module writes it `running` before the launch, the run itself writes its pid
// and then its last state (bin/commands/update-host-ts.ts), and the run's output goes to link/update.log.
// Asking again for the same run never starts a second one. DS_SIDE_UPDATE_HOST_SH names another script.
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../loop/core/store.ts";
import { hostUpdateRunning } from "../loop/core/code-watch.ts";
import { redact } from "../loop/core/redact.ts";
import { SIDE_UNIT } from "./loop-unit.ts";
import { readRecord, sideUpdateFiles, writeRecord, type SideUpdateRecord, type SideUpdateState } from "./side-update-record.ts";
import { chomp } from "./shared.ts";

/** What the job answers: `rev` is the commit the checkout is on now (full), `log` the run's last lines. */
export type SideUpdateAnswer = { state: SideUpdateState; rev: string; line: string; log: string };

export type SideUpdateDeps = {
  now?: () => number;
  head?: () => string;
  inService?: () => boolean;
  launch?: (job: { commit: string; unit: string | null; log: string; env: Record<string, string> }) => { pid: number | null };
  alive?: (rec: SideUpdateRecord) => boolean;
};

// The run has not written its pid this long after the launch, and nothing runs: it never started.
const LAUNCH_GRACE_S = 60;
const TAIL_LINES = 20, TAIL_CHARS = 3000;

export function logTail(file: string): string {
  try { return redact(chomp(readFileSync(file, "utf8")).split("\n").slice(-TAIL_LINES).join("\n")).slice(-TAIL_CHARS); } catch { return ""; }
}

const headHere = () => {
  const r = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
};
const inSideService = () => {
  try { return readFileSync("/proc/self/cgroup", "utf8").split("\n").some((l) => l.endsWith(`/${SIDE_UNIT}`) || l.includes(`/${SIDE_UNIT}/`)); } catch { return false; }
};
const script = () => process.env.DS_SIDE_UPDATE_HOST_SH || join(ROOT, "bin", "host", "update-host.sh");

function launchHere(job: { commit: string; unit: string | null; log: string; env: Record<string, string> }): { pid: number | null } {
  const argv = [script(), "--side", job.commit];
  if (job.unit) {
    const keep = ["DS_STATE_ROOT", "PATH", "HOME", "XDG_RUNTIME_DIR"];
    const r = Bun.spawnSync(["systemd-run", "--user", "--collect", "--quiet", `--unit=${job.unit}`,
      `--property=StandardOutput=append:${job.log}`, `--property=StandardError=append:${job.log}`,
      ...keep.flatMap((k) => job.env[k] ? [`--setenv=${k}=${job.env[k]}`] : []), ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    if (r.exitCode !== 0) throw new Error(`systemd-run: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
    return { pid: null };
  }
  const setsid = Bun.which("setsid");
  const log = openSync(job.log, "a");
  try {
    const p = Bun.spawn([...(setsid ? [setsid] : []), ...argv], { cwd: ROOT, stdin: "ignore", stdout: log, stderr: log, env: job.env });
    p.unref();
    return { pid: p.pid };
  } finally { closeSync(log); }
}

function runAlive(rec: SideUpdateRecord): boolean {
  if (rec.pid && rec.pid > 0) {
    try { if (readFileSync(`/proc/${rec.pid}/cmdline`, "utf8").includes("update-host")) return true; } catch { /* gone */ }
  }
  if (!rec.unit) return false;
  const r = Bun.spawnSync(["systemctl", "--user", "is-active", rec.unit], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  return ["active", "activating", "deactivating", "reloading"].includes(r.stdout.toString().trim());
}

/** Start the update to `commit` unless `run` was started before, and say where it is. */
export function sideUpdate(root: string, job: { commit: string; run: string }, deps: SideUpdateDeps = {}): SideUpdateAnswer {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const head = deps.head ?? headHere, alive = deps.alive ?? runAlive;
  const { log } = sideUpdateFiles(root);
  const answer = (state: SideUpdateState, line: string): SideUpdateAnswer => ({ state, rev: head(), line, log: logTail(log) });

  let rec = readRecord(root);
  const mine = rec?.run === job.run && rec.commit === job.commit;
  if (rec?.state === "running") {
    const young = !rec.pid && now() - rec.started_at < LAUNCH_GRACE_S;
    if (young || alive(rec)) return answer("running", mine ? "updating" : `an update to ${rec.commit.slice(0, 12)} runs first`);
    // It may have written its last state just now.
    rec = readRecord(root);
    if (rec?.state === "running") {
      rec = { ...rec, state: "failed", line: "the update ended with no result" };
      writeRecord(root, rec);
    }
  }
  if (mine && rec && rec.state !== "running") return answer(rec.state, rec.line ?? rec.state);
  if (hostUpdateRunning(root)) return answer("running", "another update holds the checkout");

  const unit = (deps.inService ?? inSideService)() ? `ds-side-update-${job.run.replace(/[^A-Za-z0-9]/g, "-")}-${now()}` : null;
  const start: SideUpdateRecord = { commit: job.commit, run: job.run, state: "running", started_at: now(), pid: null, unit };
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, "");
  writeRecord(root, start);   // before the launch: asking again now waits, never starts a second
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "DS_NOW") env[k] = v;
  env.DS_STATE_ROOT = root;
  try {
    const { pid } = (deps.launch ?? launchHere)({ commit: job.commit, unit, log, env });
    // The run writes its own pid; this one only covers the moment before, and never over a state it wrote.
    const cur = readRecord(root);
    if (cur?.run === job.run && cur.state === "running" && !cur.pid && pid) writeRecord(root, { ...cur, pid });
  } catch (e) {
    const line = `could not start the update: ${(e as Error)?.message ?? e}`;
    writeRecord(root, { ...start, state: "failed", line });
    return answer("failed", line);
  }
  return answer("running", "started");
}
