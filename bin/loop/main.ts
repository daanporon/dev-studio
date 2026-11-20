// main.ts — the loop daemon (Bun): one process per state root that ticks every DS_LOOP_TICK_S
// seconds (default 5). bin/loop/loop.sh starts and watches it; systemd/ds-loop.service runs it.
//
// It takes an exclusive flock on $DS_STATE_ROOT/loop.lock first: a second instance logs "loop
// already running (pid N)" to stdout and `events` and exits 0, the sweep's lock-skip. The lock goes
// with the process, so a killed loop never leaves one behind. Then it writes loop.pid, the health
// row, and ticks (bin/loop/core/tick.ts) until SIGTERM or SIGINT, finishing the tick it is in, or until
// this file is gone from its checkout (the rollback, U18).
//
// DS_LOOP_HANG=1 (tests only): take the lock and the pidfile and boot, then never tick — a live,
// stalled loop.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actuator } from "./core/actuator.ts";
import { exportForRollback } from "./db/export-json.ts";
import { stopAll } from "./fulfil/board.ts";
import { migrateLoopFiles, reconcile } from "./db/migrate-host.ts";
import { loadAll } from "./core/plugins.ts";
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
migrateLoopFiles(root);
reconcile(root);
writeFileSync(pidFile, `${process.pid}\n`);

let stopping = false, busy = false;
const store = open(root);
function finish(): never {
  try { if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(pidFile); } catch { /* gone already */ }
  store.close();
  closeSync(lock);
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stopping = true; if (!busy) finish(); });

const git = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
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
const loop = new Loop(store, await loadAll(), actuator, { signals });
loop.boot(undefined, git.exitCode === 0 ? git.stdout.toString().trim() : null);
// Calls a crash cut short are settled with Orca before the first tick acts again.
await actuator.boot(store, now());
if (process.env.DS_LOOP_HANG === "1") {
  setInterval(() => {}, 1 << 30);
} else {
  const every = tickSeconds() * 1000;
  for (let next = Date.now(); !stopping;) {
    busy = true;
    // `git checkout main` took this very file away: that is the rollback (U18). main knows nothing of
    // the loop, so it leaves by itself, and the unit's ConditionPathExists keeps it from coming back.
    if (await rolledBack()) {
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
    try { await loop.tick(); } catch (e) { store.event("tick_error", { payload: { error: (e as Error)?.message ?? String(e) } }); }
    busy = false;
    if (stopping) break;
    // A tick that overran starts the next one at once, not a burst of catch-up ticks.
    next = Math.max(next + every, Date.now());
    await Bun.sleep(next - Date.now());
  }
  finish();
}
