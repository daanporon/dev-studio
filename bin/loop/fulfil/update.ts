// fulfil/update.ts — kind `update` (board-actions-as-wishes U1): run a dev-studio update for a project
// without the Studio. `ds update <project>` (and, later, the board's Update) files the request; this module
// starts `ds update-run <id> <project>` (bin/commands/update-run.ts: update-host.sh, then update-squads.sh
// --auto) as a job outside the loop, watches its result file and finishes the request from it.
//
// Outside the loop because update-host stops the loop: under ds-loop.service that kills every process in the
// unit, so the job is a transient `systemd-run --user` unit when the loop runs in the service, else a setsid
// process. Whichever loop is running when the job ends (the old one, or the new one after the restart) copies
// the result file into the request's `result` and finishes it.
//
// One at a time on the host: the oldest open update goes first, a later one (another project's) waits and
// then reads "already current" and only refreshes its squads. Nothing starts while host-update.hold names a
// live pid (a Studio /ds-update running). A job starts only on the live state root, or when the tests' fake
// scripts are named (DS_UPDATE_HOST_SH and DS_UPDATE_SQUADS_SH); elsewhere the request fails, so no test
// tick ever runs the real update-host on a worktree. The `starting` record (with its log, result file and
// unit) is written before the launch, so a loop that restarts mid-launch watches the job and never starts
// a second. A job gone with no final state is `lost`; one over update_run_max_min is stopped, then failed.
//
// The request's `result` while it is open: {state: "waiting", why} | {state: "starting"|"pulling"|
// "refreshing", log, out, unit?, pid?, started_at, ...the job's fields}; done: the job's file with ok: true;
// failed: ok: false, error. Each finish logs one `update_run` event.
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { finishRequest, failRequest, requestActions, type Exec, type Fulfiller } from "../core/actuator.ts";
import type { Action } from "../core/plugins.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import { hostUpdateRunning } from "../core/code-watch.ts";
import { limitInt } from "../settings/limits.ts";
import { updateDir, updateFiles, type UpdateFile } from "../../lib/update-job.ts";

export const LOOP_UNIT = "ds-loop.service";
export const unitName = (id: number) => `ds-update-${id}`;
// The job's file has not appeared this long after the launch, and nothing runs: lost.
const LAUNCH_GRACE_S = 60;
const CHECK_S = 5;
const RUNNING = new Set(["starting", "pulling", "refreshing"]);

type Launch = { unit: string | null; pid: number | null };
export type Job = {
  id: number; project: string; root: string; log: string; out: string;
  env: Record<string, string | undefined>;
};
export type UpdateOpts = {
  live?: (root: string) => boolean;            // the loop runs on the checkout's own state root
  inService?: () => boolean;                   // the loop itself runs in ds-loop.service
  launch?: (job: Job, systemd: boolean) => Launch | Promise<Launch>;
  alive?: (rec: Rec) => boolean | Promise<boolean>;
  stop?: (rec: Rec) => void | Promise<void>;
};
type Rec = Record<string, unknown> & { state?: string; unit?: string | null; pid?: number | null; started_at?: number; log?: string; out?: string };

const parse = (s: unknown): Rec => { try { return s ? JSON.parse(String(s)) : {}; } catch { return {}; } };
const fakes = (env = process.env) => !!env.DS_UPDATE_HOST_SH && !!env.DS_UPDATE_SQUADS_SH;
export const liveRoot = (root: string) => resolve(root) === resolve(join(ROOT, "state"));

export function inLoopService(cgroup = "/proc/self/cgroup"): boolean {
  try { return readFileSync(cgroup, "utf8").split("\n").some((l) => l.endsWith(`/${LOOP_UNIT}`) || l.includes(`/${LOOP_UNIT}/`)); } catch { return false; }
}

const jobArgv = (j: Job) => [process.execPath, join(ROOT, "bin", "ds.ts"), "update-run", String(j.id), j.project];

/** The transient unit's command: its name, the loop's state root, PATH, HOME and Orca data path, output to the log. */
export function systemdArgv(j: Job): string[] {
  const keep = ["DS_STATE_ROOT", "PATH", "HOME", "ORCA_USER_DATA_PATH", "XDG_RUNTIME_DIR", "DS_UPDATE_HOST_SH", "DS_UPDATE_SQUADS_SH"];
  const env = keep.flatMap((k) => j.env[k] ? [`--setenv=${k}=${j.env[k]}`] : []);
  return ["systemd-run", "--user", "--collect", "--quiet", `--unit=${unitName(j.id)}`,
    `--property=StandardOutput=append:${j.log}`, `--property=StandardError=append:${j.log}`, ...env, ...jobArgv(j)];
}

function launchJob(j: Job, systemd: boolean): Launch {
  if (systemd) {
    const r = Bun.spawnSync(systemdArgv(j), { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    if (r.exitCode !== 0) throw new Error(`systemd-run: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
    return { unit: unitName(j.id), pid: null };
  }
  // As loop-ts.ts starts the loop: a new session, nobody's child, stdio on the log.
  const setsid = Bun.which("setsid");
  const log = openSync(j.log, "a");
  try {
    const p = Bun.spawn([...(setsid ? [setsid] : []), ...jobArgv(j)], { cwd: ROOT, stdin: "ignore", stdout: log, stderr: log, env: j.env as Record<string, string> });
    p.unref();
    return { unit: null, pid: p.pid };
  } finally { closeSync(log); }
}

const pidAlive = (pid: number) => {
  try { if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("update-run")) return false; } catch { return false; }
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
};
function unitActive(unit: string): boolean {
  const r = Bun.spawnSync(["systemctl", "--user", "is-active", unit], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  return ["active", "activating", "deactivating", "reloading"].includes(r.stdout.toString().trim());
}
function jobAlive(rec: Rec): boolean {
  // The job's own pid first (a /proc read); systemctl only before the job wrote its file, or after it died.
  if (typeof rec.pid === "number" && rec.pid > 0 && pidAlive(rec.pid)) return true;
  return !!rec.unit && unitActive(String(rec.unit));
}
function stopJob(rec: Rec): void {
  if (rec.unit) Bun.spawnSync(["systemctl", "--user", "stop", String(rec.unit)], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 30_000 });
  // setsid made the job its own process group: the scripts it runs go with it.
  if (typeof rec.pid === "number" && rec.pid > 0 && pidAlive(rec.pid)) {
    try { process.kill(-rec.pid, "SIGTERM"); } catch { try { process.kill(rec.pid, "SIGTERM"); } catch { /* gone */ } }
  }
}

function readJob(out: string): UpdateFile | null {
  try { return JSON.parse(readFileSync(out, "utf8")) as UpdateFile; } catch { return null; }
}

const setResult = (store: Store, id: number, r: Rec) => store.upsert("requests", { id }, { result: JSON.stringify(r) });

function logRun(x: Exec, a: Action, outcome: string, rec: Rec): void {
  const id = (a.payload as { request?: number }).request;
  const row = id == null ? null : x.store.get("requests", { id }) as Row | null;
  const by = (a.payload as { by?: string }).by ?? (row?.requested_by as string | null) ?? null;
  x.store.event("update_run", { project: a.project || null, payload: { id: id ?? null, outcome, need: rec.need ?? null, by, line: rec.line ?? rec.error ?? null } });
}

export function update(opts: UpdateOpts = {}): Fulfiller {
  const live = opts.live ?? liveRoot, inService = opts.inService ?? (() => inLoopService());
  const launch = opts.launch ?? launchJob, alive = opts.alive ?? jobAlive, stop = opts.stop ?? stopJob;

  const fail = (a: Action, x: Exec, rec: Rec, why: string) => {
    finishRequest(x.store, a, { ...rec, ok: false, error: why }, x.now);
    logRun(x, a, "failed", { ...rec, error: why });
    return { done: true as const, result: `failed: ${why}` };   // not `failed`: the request is told, so no giveUp and no card
  };

  return {
    name: "update",
    scope: "host",
    kinds: ["update"],
    run: (ctx) => requestActions(ctx, ["update"]),
    async exec(a, x) {
      const id = Number((a.payload as { request?: number }).request);
      const row = x.store.get("requests", { id }) as Row | null;
      if (!row) return { dropped: "no such request" };
      if (row.done_at != null) return { done: true, result: "already done" };
      if (!a.project) return fail(a, x, {}, "an update needs a project");
      const rec = parse(row.result);
      const root = x.store.root;

      if (!rec.state || rec.state === "waiting") {
        const wait = (why: string) => {
          if (rec.why !== why) setResult(x.store, id, { state: "waiting", why });
          return { wait: `waiting: ${why}`, at: x.now + CHECK_S };
        };
        const older = x.store.db.query("SELECT id FROM requests WHERE kind = 'update' AND done_at IS NULL AND id < ? ORDER BY id LIMIT 1").get(id) as Row | null;
        if (older) return wait(`update #${older.id} runs first`);
        if (hostUpdateRunning(root)) return wait("another update holds the checkout (state/loop/host-update.hold)");
        if (!live(root) && !fakes()) return fail(a, x, {}, "not the live state root");
        const { out, log } = updateFiles(root, id);
        mkdirSync(updateDir(root), { recursive: true });
        const systemd = inService();
        const env: Record<string, string | undefined> = { ...process.env, DS_STATE_ROOT: root };
        delete env.DS_NOW;
        const start: Rec = { state: "starting", log, out, unit: systemd ? unitName(id) : null, pid: null, started_at: x.now, at: x.now };
        setResult(x.store, id, start);   // before the launch: a loop that restarts now watches, never launches again
        let l: Launch;
        try { l = await launch({ id, project: a.project, root, log, out, env }, systemd); }
        catch (e) { return fail(a, x, start, `could not start the update job: ${(e as Error)?.message ?? e}`); }
        setResult(x.store, id, { ...start, unit: l.unit, pid: l.pid });
        return { wait: "running: starting", at: x.now + CHECK_S };
      }

      if (!RUNNING.has(String(rec.state))) return fail(a, x, rec, `unknown update state '${rec.state}'`);
      const base: Rec = { log: rec.log, out: rec.out, unit: rec.unit ?? null, started_at: rec.started_at };
      const job = readJob(String(rec.out ?? updateFiles(root, id).out));
      // started_at stays the loop's (its clock times the limit); the job's own is job_started_at.
      const cur: Rec = job ? { ...base, ...job, job_started_at: job.started_at, started_at: rec.started_at, pid: job.pid ?? rec.pid ?? null } : { ...rec };
      if (job && JSON.stringify(cur) !== JSON.stringify(rec)) setResult(x.store, id, cur);

      if (job?.state === "done") {
        finishRequest(x.store, a, { ...cur, ok: true }, x.now);
        logRun(x, a, String(job.outcome ?? "done"), cur);
        return { done: true, result: job.squads_line ?? job.line ?? "done" };
      }
      if (job?.state === "failed") return fail(a, x, cur, String(job.error ?? job.line ?? "update failed"));

      const started = Number(rec.started_at ?? x.now);
      const maxMin = limitInt(x.store, a.project, "update_run_max_min", 20);
      if (x.now - started > maxMin * 60) {
        await stop(cur);
        return fail(a, x, cur, `timeout: the update job ran past ${maxMin} min and was stopped; see ${cur.log}`);
      }
      if (!(await alive(cur))) {
        // It may have written its last state just now.
        const last = readJob(String(cur.out));
        if (last && (last.state === "done" || last.state === "failed")) return { wait: "running: finishing", at: x.now };
        if (job || x.now - started >= LAUNCH_GRACE_S) return fail(a, x, cur, `lost: the update job ended with no result; see ${cur.log}`);
      }
      return { wait: `running: ${cur.state}`, at: x.now + CHECK_S };
    },
    giveUp(a, x, why) {
      logRun(x, a, "failed", { error: why });
      return failRequest(a, x, why);
    },
  };
}

export default update();
