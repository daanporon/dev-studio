// ds loop-ts — start, watch and stop the loop daemon (bin/loop/main.ts) of a state root (U273): what
// bin/loop/loop.sh runs. The .sh stays at its path because the cron watchdog line calls it.
//   --ensure   start it unless it runs (cron calls this every minute). A live loop whose last tick is
//              older than DS_LOOP_STALE_TICKS ticks (default 12) is stopped and started again and a
//              loop_restart event recorded (bin/loop/core/watchdog.ts). No Studio card: the board shows the
//              restarts on its loop line and a keeps-stalling banner.
//   --status   whether it runs, and its health row; exits 3 when it does not run
//   --stop     stop it
// Under systemd (systemd/ds-loop.service, installed by bin/host/install.sh) when that unit is installed for
// this state root and `systemctl --user` works; otherwise as a detached process of its own, logging to
// $DS_STATE_ROOT/loop.log. DS_LOOP_SYSTEMD=0 forces the latter. Either way the loop writes
// $DS_STATE_ROOT/loop.pid itself once it holds the state root's lock.
// On a side root (`ds join` wrote <root>/link/host.json) the loop is `main.ts --role side`, its unit
// ds-side-loop.service.
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, chomp, readJson, run as sh, stateRoot, writeErr, writeOut } from "../lib/shared";
import { inherit } from "../lib/upkeep";
import { loopUnit, loopArgs } from "../lib/loop-unit.ts";

export const help = "--ensure | --status | --stop — start, watch and stop the loop daemon (loop.sh)";

const USAGE = `# loop.sh — start, watch and stop the loop daemon (bin/loop/main.ts) of a state root.
#   loop.sh --ensure   start it unless it runs (cron calls this every minute). A live loop whose
#                      last tick is older than DS_LOOP_STALE_TICKS ticks (default 12) is stopped and
#                      started again and a loop_restart event recorded (bin/loop/core/watchdog.ts). No Studio
#                      card: the board shows the restarts on its loop line and a keeps-stalling banner.
#   loop.sh --status   whether it runs, and its health row; exits 3 when it does not run
`;

const nonEmpty = (v: string | undefined): string | undefined => (v ? v : undefined);

// ---- jq's semantics, as far as the --status lines use them: a step that jq would fail on throws, and the
// line is then left out (the shell's `2>/dev/null || true`).

/** `\(v)` in a jq string: strings raw, null as null, anything else as compact JSON. */
function interp(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
/** `a // b`: b when a is null or false. */
const alt = (v: unknown, d: unknown): unknown => (v === undefined || v === null || v === false ? d : v);
/** `.k`: null on null, the field on an object, an error on anything else. */
function field(v: unknown, k: string): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "object" && !Array.isArray(v)) return (v as Record<string, unknown>)[k] ?? null;
  throw new Error(`cannot index ${typeof v} with ${k}`);
}
function length(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (typeof v === "number") return Math.abs(v);
  if (typeof v === "object") return Object.keys(v).length;
  throw new Error("boolean has no length");
}
function arr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v !== null && typeof v === "object") return Object.values(v);
  throw new Error("cannot iterate");
}
function entries(v: unknown): Array<[string, unknown]> {
  if (Array.isArray(v)) return v.map((x, i): [string, unknown] => [String(i), x]);
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return Object.entries(v as Record<string, unknown>);
  throw new Error("has no keys");
}
function slice(v: unknown, n: number): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.slice(0, n);
  throw new Error("cannot slice");
}
/** `todate`: ISO 8601 without the milliseconds. */
function todate(v: unknown): string {
  if (typeof v !== "number") throw new Error("todate needs a number");
  return new Date(Math.floor(v) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
/** One --status line, or nothing when jq would have failed. */
function line(f: () => string | undefined): void {
  let s: string | undefined;
  try { s = f(); } catch { return; }
  if (s !== undefined) writeOut(s + "\n");
}

/** U234: the last tick_slow (a tick over its interval, at most one per 10 min): how slow, and which step. */
export function tickSlowLine(events: unknown): string | undefined {
  if (!Array.isArray(events)) throw new Error("not a list");
  const e = events[0];
  if (e === undefined || e === null) return undefined;
  const raw = field(e, "payload");
  const p = typeof raw === "string" ? JSON.parse(raw) : raw;
  const slowest = field(p, "slowest");
  const top = slice(alt(field(p, "top"), alt(slowest, null) === null ? [] : [slowest]), 3);
  return `last tick_slow: ${todate(field(e, "at"))}: ${interp(field(p, "slow"))} of ${interp(field(p, "ticks"))} ticks over ${interp(field(p, "tick_s"))}s, average ${interp(field(p, "avg_ms"))} ms, slowest ${interp(field(p, "max_ms"))} ms; slowest step ${interp(alt(field(slowest, "step"), "-"))} (${interp(alt(field(slowest, "avg_ms"), 0))} ms a tick); top 3: ${top.map((t) => `${interp(field(t, "step"))} ${interp(field(t, "avg_ms"))} ms`).join(", ")}`;
}

/** U244/U248/U252: the last tick's Orca CLI spawns, bun starts, Runs read again against kept, dropped copies, top callers. */
export function orcaSpawnsLine(d: unknown): string {
  const kv = (o: unknown) => entries(o).map(([k, v]) => `${k} ${interp(v)}`).join(", ");
  let s = `orca spawns, tick ${interp(field(d, "tick"))}: ${interp(field(d, "total"))}`;
  const top = field(d, "top");
  if (length(top) > 0) s += " (" + arr(top).map((t) => `${interp(field(t, "verb"))} ${interp(field(t, "n"))}`).join(", ") + ")";
  const bun = field(d, "bun");
  if (bun !== null) s += `; bun starts ${interp(bun)}`;
  const runs = field(d, "runs");
  if (runs !== null) {
    s += `; Runs read again ${interp(field(runs, "reread"))}, kept ${interp(field(runs, "kept"))}`;
    const why = field(runs, "why");
    if (length(why) > 0) s += ` (${kv(why)})`;
  }
  const dropped = alt(field(d, "dropped_by"), {});
  if (length(dropped) > 0) s += `; kept copies dropped by ${kv(dropped)}`;
  const by = alt(field(d, "by_caller"), []);
  if (length(by) > 0) s += "; by caller: " + slice(by, 5).map((c) => `${interp(field(c, "caller"))} ${interp(field(c, "verb"))} ${interp(field(c, "kind"))} ${interp(field(c, "n"))}`).join(", ");
  return s;
}

/** U249: background actions turned down for a busy slot or subject (bg_deferred), by kind, since the loop started. */
export function bgDeferredLine(d: unknown): string {
  const kv = (o: unknown) => entries(o).map(([k, v]) => `${k} ${interp(v)}`).join(", ");
  return `bg_deferred, tick ${interp(field(d, "tick"))}: ${kv(field(d, "last"))}; since start: ${kv(field(d, "total"))}`;
}

/** U253: test-named projects under state/ that the loop never ticks (a test leaked them): shown once. */
export function skippedLine(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  return `skipped test projects (not ticked): ${names.length}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`;
}

export async function run(argv: string[]): Promise<number> {
  const STATE_ROOT = stateRoot();
  const UNIT = loopUnit(STATE_ROOT);
  const PIDF = join(STATE_ROOT, "loop.pid");
  const UNIT_FILE = join(nonEmpty(process.env.XDG_CONFIG_HOME) ?? join(process.env.HOME ?? "", ".config"), "systemd", "user", UNIT);
  const bun = process.execPath;
  const ds = join(ROOT, "bin", "ds");
  // DS_ROOT is only how loop.sh named this checkout for this command (ROOT holds it); the shell version passed
  // none on, so neither the loop nor anything else started here gets it.
  delete process.env.DS_ROOT;
  // cron runs without the login session's XDG_RUNTIME_DIR, where `systemctl --user` finds its bus.
  const uid = process.getuid?.() ?? 0;
  if (!process.env.XDG_RUNTIME_DIR && existsSync(`/run/user/${uid}`)) process.env.XDG_RUNTIME_DIR = `/run/user/${uid}`;

  let systemd: boolean | undefined;
  const useSystemd = async (): Promise<boolean> => {
    if (systemd !== undefined) return systemd;
    let unitHasRoot = false;
    try { unitHasRoot = readFileSync(UNIT_FILE, "utf8").split("\n").includes(`Environment="DS_STATE_ROOT=${STATE_ROOT}"`); } catch { /* no unit */ }
    systemd = (process.env.DS_LOOP_SYSTEMD ?? "1") !== "0" && unitHasRoot
      && (await sh(["systemctl", "--user", "show-environment"])).rc === 0;
    return systemd;
  };

  // The loop's pid: the pidfile's, alive and running bin/loop/main.ts (not a reused pid).
  const loopPid = async (): Promise<number | undefined> => {
    let raw = "";
    try { raw = chomp(readFileSync(PIDF, "utf8")); } catch { return undefined; }
    if (!/^[0-9]+$/.test(raw)) return undefined;
    const pid = Number(raw);
    if (!alive(pid)) return undefined;
    let args: string;
    try { args = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); }
    catch { args = (await sh(["ps", "-p", String(pid), "-o", "args="])).out; }
    return /bin\/loop\/main\.ts/.test(args) ? pid : undefined;
  };

  // stopPid: TERM (the loop finishes its tick), KILL after 5 s.
  const stopPid = async (pid: number): Promise<void> => {
    let i = 0;
    if (!signal(pid, "SIGTERM")) return;
    while (alive(pid) && i < 50) { await Bun.sleep(100); i++; }
    signal(pid, "SIGKILL");
    while (alive(pid) && i < 70) { await Bun.sleep(100); i++; }
  };

  // start [old]: start it and wait (10 s) for a loop other than <old> to hold the lock.
  const start = async (old?: number): Promise<number> => {
    mkdirSync(STATE_ROOT, { recursive: true });
    if (await useSystemd()) {
      const rc = await inherit(["systemctl", "--user", "start", UNIT]);
      if (rc !== 0) return rc;
    } else {
      // Detached so the loop is nobody's child; DS_NOW pins the clock of a test's shell, not the loop's.
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.DS_NOW;
      const setsid = Bun.which("setsid");
      const log = openSync(join(STATE_ROOT, "loop.log"), "a");
      try {
        const p = Bun.spawn([setsid ?? Bun.which("nohup") ?? "nohup", bun, join(ROOT, "bin", "loop", "main.ts"), ...loopArgs(STATE_ROOT)], {
          stdin: "ignore", stdout: log, stderr: log, env: env as Record<string, string>,
        });
        p.unref();
      } finally { closeSync(log); }
    }
    for (let i = 1; i <= 100; i++) {
      const pid = await loopPid();
      if (pid !== undefined && pid !== old) { writeOut(`loop: started (pid ${pid})\n`); return 0; }
      if (i !== 100) await Bun.sleep(100);
    }
    writeErr(`loop: did not start in 10 s — see ${(await useSystemd()) ? `journalctl --user -u ${UNIT}` : join(STATE_ROOT, "loop.log")}\n`);
    return 1;
  };

  const ensure = async (): Promise<number> => {
    const pid = await loopPid();
    if (pid === undefined) return start();
    const w = Bun.spawn([bun, join(ROOT, "bin", "loop", "core", "watchdog.ts")], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
    const [out, rc] = await Promise.all([new Response(w.stdout).text(), w.exited]);
    if (rc !== 0) return rc;
    let verdict: any;
    try { verdict = JSON.parse(out); } catch { writeErr(`loop: the watchdog said ${JSON.stringify(chomp(out))}, not JSON\n`); return 5; }
    if (verdict?.state !== "stale") { writeOut(`loop: running (pid ${pid})\n`); return 0; }
    writeOut(`loop: pid ${pid} has not ticked for ${interp(verdict.age)}s — restarting it\n`);
    await stopPid(pid);
    return start(pid);
  };

  const status = async (): Promise<number> => {
    const pid = await loopPid();
    if (pid === undefined) { writeOut("loop: not running\n"); return 3; }
    writeOut(`loop: running (pid ${pid}${(await useSystemd()) ? `, ${UNIT}` : ""})\n`);
    const rc = await inherit([ds, "--state", STATE_ROOT, "health"], { env: process.env });
    if (rc !== 0) return rc;
    try {
      const { skippedProjects } = await import("../loop/settings/projects.ts");
      line(() => skippedLine(skippedProjects(STATE_ROOT)));
    } catch { /* best effort, like the shell's || true */ }
    const ev = await sh([ds, "--state", STATE_ROOT, "events", "--kind", "tick_slow", "--last"]);
    line(() => tickSlowLine(JSON.parse(ev.out)));
    const spawns = readJson(join(STATE_ROOT, "loop", "orca-spawns.json"));
    if (spawns !== undefined) line(() => orcaSpawnsLine(spawns));
    const deferred = readJson(join(STATE_ROOT, "loop", "bg-deferred.json"));
    if (deferred !== undefined) line(() => bgDeferredLine(deferred));
    return 0;
  };

  const stop = async (): Promise<number> => {
    if (await useSystemd()) {
      const rc = await inherit(["systemctl", "--user", "stop", UNIT]);
      if (rc !== 0) return rc;
    }
    const pid = await loopPid();
    if (pid !== undefined) await stopPid(pid);
    writeOut("loop: stopped\n");
    return 0;
  };

  switch (argv[0] ?? "") {
    case "--ensure": return ensure();
    case "--status": return status();
    case "--stop": return stop();
    default: writeErr(USAGE); return 2;
  }
}

/** `kill -0`: the process exists and may be signalled by us. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function signal(pid: number, sig: NodeJS.Signals): boolean {
  try { process.kill(pid, sig); return true; } catch { return false; }
}
