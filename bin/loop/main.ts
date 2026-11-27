// main.ts — the loop daemon (Bun): one process per state root that ticks every DS_LOOP_TICK_S
// seconds (default 5). bin/loop/loop.sh starts and watches it; systemd/ds-loop.service runs it.
//
// It takes an exclusive flock on $DS_STATE_ROOT/loop.lock first: a second instance logs "loop
// already running (pid N)" to stdout and `events` and exits 0, the sweep's lock-skip. The lock goes
// with the process, so a killed loop never leaves one behind. Then it writes loop.pid, the health
// row, and ticks (bin/loop/core/tick.ts) until SIGTERM or SIGINT, finishing the tick it is in, or until
// this file is gone from its checkout (the rollback, U18), or until the checkout's HEAD moves loop code
// (core/code-watch.ts): between ticks, at most every 10 s, it reads HEAD again; a new commit whose diff
// touches `bin/**/*.ts` (not tests, not fakes) or a migration drains the actuator, logs `loop_code_changed`
// and exits 75, and systemd (Restart=on-failure) or the minutely `loop.sh --ensure` starts the new code.
// Never while update-host holds the checkout (`loop/host-update.hold`): it restarts the loop itself.
// A commit that changes only docs, tests, the page or roles is taken as the running rev, no restart. On by
// default only on the live root (the checkout's own state/); DS_LOOP_CODE_WATCH=1 forces it on, =0 off,
// DS_LOOP_CODE_ROOT (tests) names the repo to watch and DS_LOOP_CODE_CHECK_MS (tests) the interval.
//
// `--role side` (side-loop-host U3, issue #127) is the loop of a side host: only the plugins
// core/side-plugins.ts names, never the decider, and none of main's own steps (the old files' migration,
// the actuator, the squad JSON snapshots, the rollback's export and board stop). Default `main`.
//
// DS_LOOP_HANG=1 (tests only): take the lock and the pidfile and boot, then never tick — a live,
// stalled loop.
import { markStopping } from "./core/stopping.ts";
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actuator } from "./core/actuator.ts";
import { CODE_CHECK_MS, CodeWatch, codeWatchOn, headRev, hostUpdateRunning } from "./core/code-watch.ts";
import { exportForRollback } from "./db/export-json.ts";
import { stopAll } from "./fulfil/board.ts";
import { migrateLoopFiles, reconcile } from "./db/migrate-host.ts";
import { loadAll, type Role } from "./core/plugins.ts";
import { sideActuator } from "./core/side-actuator.ts";
import type { SideLink } from "../link/side.ts";
import { queuedWork } from "./messages/replay.ts";
import { now, open, ROOT, stateRoot } from "./core/store.ts";
import { RECONCILE } from "./db/reconcile-mark.ts";
import { Loop, tickSeconds } from "./core/tick.ts";
import { shell } from "./io/orca.ts";

const LOCK_EX = 2, LOCK_NB = 4;
function flock(fd: number): boolean {
  for (const lib of ["libc.so.6", "libc.so", "/usr/lib/libSystem.B.dylib"]) {
    let c;
    try { c = dlopen(lib, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }); } catch { continue; }
    return c.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0;
  }
  throw new Error("loop: no libc to flock with");
}

const ROLLBACK_DRAIN_MS = 30_000;
// A reset that changes this file removes and rewrites it (/ds-update): gone for a moment is no rollback.
const ROLLBACK_SETTLE_MS = 2_000;
async function rolledBack(): Promise<boolean> {
  if (existsSync(import.meta.path)) return false;
  await Bun.sleep(ROLLBACK_SETTLE_MS);
  return !existsSync(import.meta.path);
}

function roleArg(args: string[]): Role {
  if (!args.length) return "main";
  const m = /^--role[= ](main|side)$/.exec(args.join(" "));
  if (m) return m[1] as Role;
  console.error("usage: main.ts [--role main|side]");
  process.exit(2);
}
const role = roleArg(process.argv.slice(2)), side = role === "side";
const act = side ? sideActuator : actuator;

const root = stateRoot();
mkdirSync(root, { recursive: true });
const pidFile = join(root, "loop.pid");
const lock = openSync(join(root, "loop.lock"), "a");
if (!flock(lock)) {
  let pid = "?";
  try { pid = readFileSync(pidFile, "utf8").trim() || "?"; } catch { /* the holder has not written it yet */ }
  const line = `loop already running (pid ${pid})`;
  const s = open(root);
  s.event("loop_skip", { payload: { line, pid: Number(pid) || null } });
  s.close();
  console.log(line);
  process.exit(0);
}
if (!side) {
  migrateLoopFiles(root);
  reconcile(root);
}
writeFileSync(pidFile, `${process.pid}\n`);

let stopping = false, busy = false;
const store = open(root);
let link: SideLink | null = null;
function finish(code = 0): never {
  link?.stop();
  try { if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(pidFile); } catch { /* gone already */ }
  store.close();
  closeSync(lock);
  process.exit(code);
}
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stopping = true; markStopping(); if (!busy) finish(); });

// The commit this process runs, in full; the health row keeps the short form it always had.
const bootRev = headRev(ROOT);
const codeRepo = process.env.DS_LOOP_CODE_ROOT || ROOT;
const code = codeWatchOn(root, ROOT)
  ? new CodeWatch(codeRepo, codeRepo === ROOT ? bootRev : headRev(codeRepo), Number(process.env.DS_LOOP_CODE_CHECK_MS) || CODE_CHECK_MS,
    Date.now(), () => hostUpdateRunning(root))
  : null;
// U248: what says a Run changed (its worktrees' terminals, its unread mail), read once at the start of a tick.
async function signals() {
  const orca = shell(), [t, u] = await Promise.all([orca.run("loop-terminals", []), orca.run("inbox-unread-all", [])]);
  if (t.code !== 0 || u.code !== 0) throw new Error("signals: a read failed");
  return { terminals: t.out, unread: u.out };
}
// U254 spike, off by default: Orca reads through one long-lived helper (bin/backend/orca-client.ts), this process only.
if (process.env.DS_ORCA_CLIENT === "1") {
  try { (await import("../backend/orca-client.ts")).enableOrcaClient(true); } catch { /* no bin/backend: the CLI */ }
}
// Between ticks: true when the checkout's HEAD moved loop code and this process should end (exit 75).
async function codeChanged(): Promise<boolean> {
  const c = code?.check();
  if (c?.kind !== "restart") return false;
  // A start in flight records its worker first, as the rollback waits; bounded, so a hung one cannot hold it.
  if (!side) await Promise.race([actuator.drain(), Bun.sleep(ROLLBACK_DRAIN_MS)]);
  store.fact("loop_code_changed", [], { payload: { from_rev: c.from, to_rev: c.to, files: c.files.slice(0, 10), count: c.files.length } });
  return true;
}
const loop = new Loop(store, await loadAll(undefined, role), act, side ? { role } : { signals });
loop.boot(undefined, bootRev ? bootRev.slice(0, 7) : null);
// A side loop is this host's end of the link to main (none on a root that never joined one).
if (side) link = (await import("../link/side.ts")).startSideLink(store, root);
// Calls a crash cut short are settled with Orca before the first tick acts again.
if (!side) await actuator.boot(store, now());
if (process.env.DS_LOOP_HANG === "1") {
  setInterval(() => {}, 1 << 30);
} else {
  const every = tickSeconds() * 1000;
  for (let next = Date.now(); !stopping;) {
    busy = true;
    // `git checkout main` took this very file away: that is the rollback (U18). main knows nothing of
    // the loop, so it leaves by itself, and the unit's ConditionPathExists keeps it from coming back.
    if (await rolledBack()) {
      if (side) {
        store.event("loop_exit", { payload: { why: `${import.meta.path} is gone from its checkout` } });
        break;
      }
      // First, so that no way back to this checkout finds rows it trusts without a look at the files.
      writeFileSync(join(root, RECONCILE), "");
      // A pinned older checkout reads the files from here on: a start in flight records its worker first (bounded,
      // so a hung one cannot hold up the rollback), and what no tick exported yet is written now,
      // except over what main's scripts wrote since the checkout.
      await Promise.race([actuator.drain(), Bun.sleep(ROLLBACK_DRAIN_MS)]);
      // On the record for the operator; the re-switch gives these up (bin/loop/db/migrate-host.ts).
      store.event("loop_exit", { payload: { why: `${import.meta.path} is gone from its checkout`, held: queuedWork(store).map(({ project, squad, what }) => ({ project, squad, what })) } });
      exportForRollback(store);
      await stopAll(store, now());
      break;
    }
    if (await codeChanged()) finish(75);
    try { await loop.tick(); } catch (e) { store.event("tick_error", { payload: { error: (e as Error)?.message ?? String(e) } }); }
    link?.tick();
    busy = false;
    if (stopping) break;
    // A tick that overran starts the next one at once, not a burst of catch-up ticks.
    next = Math.max(next + every, Date.now());
    await Bun.sleep(next - Date.now());
  }
  finish();
}

