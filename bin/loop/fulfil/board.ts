// fulfil/board.ts — the web board as a service the loop runs (U16, R7, KTD16). The services
// reconciler (reconcilers/services.ts) compares a `services` row's wish with its pid and /healthz
// ping and emits these kinds; this file does them:
//   board_start    spawn `bun bin/board/board-server.ts` for the row's scope and port, DS_LOOP_CHILD=1 and
//                  DS_STATE_ROOT set, so it outlives a loop restart (which adopts it): in its own
//                  transient user unit (`systemd-run --user --collect --unit ds-board-<id>`) when
//                  `systemctl --user` works — a `systemctl --user restart ds-loop` kills the loop's
//                  cgroup, not that unit — else detached (its own session; the services reconciler
//                  brings a killed one back within a tick). The row records the want_at it served as
//                  started_at (never older than the wish). Wait in the background up to DS_LOOP_BOARD_WAIT_MS (default
//                  10 s) for /healthz. Running: status=running with pid and started_at. Exited (a
//                  port taken between the probe and the bind) or never answered: status=failed, the
//                  log's tail in `result`, the wish given up (`want_result` failed: …) until the next
//                  `ds want board`.
//                  The port (U2 of board-empty-state-and-port): the row's `port` when nobody holds it on
//                  any bind address, else the next free one up to DS_BOARD_PORT_TRIES (20) further
//                  (bin/board/free-port.ts), skipping ports another scope's row registers (running or
//                  not) and ports another start is probing (`claimed`). The port bound is written back
//                  to the row, so it is the scope's registered port from then on (`ds want board`
//                  without --port asks for it). A row whose own old server is alive keeps its port;
//                  after a restart stopped it, the port gets a 2 s release window before it counts
//                  as taken (the server's own bind retry covers the rest). No free port: failed.
//   board_restart  stop the old pid, count the restart (payload.counted), then the same start
//   board_stop     stop the pid; status=stopped
//   board_giveup   the restart cap: stop the pid, status=failed, one Studio alert
// The server listens where board.sh --serve-fg listens: DS_BIND, else 127.0.0.1 and the tailnet
// IP; DS_BOARD_HOSTS adds Host names — the asker's, carried in the wish, else the loop's own. Its log is state/<label>/board-serve[-<topic>].log (the one
// before it kept as .log.1); DS_BOARD_SERVER replaces the server file (tests run a copy).
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { alert, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { childEnv } from "../io/orca.ts";
import type { Action } from "../core/plugins.ts";
import { discoverProjects } from "../settings/projects.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { tailscale } from "../io/tailnet.ts";
import { freePort, held, lastPort } from "../../board/free-port.ts";

const waitMs = () => envInt("DS_LOOP_BOARD_WAIT_MS", 10_000);
const pingMs = () => envInt("DS_LOOP_BOARD_PING_MS", 3_000);

// The board processes this loop process started, by pid: their exit code tells a server that
// exited 75 (its code changed on disk, a pull) from one that died. Starts in flight, by row id.
const children = new Map<number, Bun.Subprocess>();
// A board in a systemd unit is no child of ours: its wrapper shell writes the exit code to a file.
const exitFiles = new Map<number, string>();
const starting = new Set<number>();
// The ports starts in flight have picked (or are probing), by port -> row id: a second start skips them.
const claimed = new Map<number, number>();
const unclaim = (port: number, id: number) => { if (claimed.get(port) === id) claimed.delete(port); };
export function exitCodeOf(pid: number): number | null {
  const c = children.get(pid)?.exitCode;
  if (c != null) return c;
  const f = exitFiles.get(pid);
  if (!f) return null;
  const n = parseInt(readFileSync(f, "utf8").trim(), 10);
  return Number.isNaN(n) ? null : n;
}
export const isStarting = (id: number) => starting.has(id);
// A start in flight for services row `id` (the link service, fulfil/link.ts, shares this set: row ids are unique).
export const markStarting = (id: number, on: boolean) => { if (on) starting.add(id); else starting.delete(id); };
// The epochs a row was restarted at (the cap's window).
export function restartsOf(r: Row): number[] {
  try { return JSON.parse(String(r.restarts ?? "[]")) as number[]; } catch { return []; }
}

// The loop is leaving for good (a rollback took its checkout): its boards go with it, so the ports
// are free for the sweep's. The wish stays: a re-switch starts them again.
export async function stopAll(store: Store, at: number): Promise<void> {
  for (const r of store.db.query("SELECT * FROM services WHERE name = 'board' AND pid IS NOT NULL").all() as Row[]) {
    await stop(r.pid);
    set(store, "service_stopped", r, { status: "stopped", pid: null }, at);
  }
}

// The address to ping: the first bind (0.0.0.0 -> loopback), as board.sh's board_up did.
function pingHost(binds: string): string {
  let h = binds.split(/\s+/).filter(Boolean)[0] ?? "127.0.0.1";
  if (h === "0.0.0.0") h = "127.0.0.1";
  if (h === "::") h = "::1";
  return h.includes(":") ? `[${h}]` : h;
}
// True when the board on this port answers GET /healthz — and, given a pid, when that pid is the one
// answering, so another board already holding the port is not taken for ours. Two tries, so one slow
// answer is no verdict.
export async function boardUp(port: number | string, b = binds(), pid?: unknown): Promise<boolean> {
  const want = pid == null ? null : Number(pid);
  for (let i = 0; i < 2; i++) {
    const ok = await fetch(`http://${pingHost(b)}:${port}/healthz`, { signal: AbortSignal.timeout(pingMs()) })
      .then(async (r) => r.ok && (want === null || Number(((await r.json()) as { pid?: unknown }).pid) === want), () => false);
    if (ok) return true;
  }
  return false;
}

// True only for a live pid that is a board server — never a reused pid of something else.
export function isBoard(pid: unknown): boolean { return isProc(pid, /board-server/); }

// True only for a live pid whose command line matches `re` — never a reused pid of something else.
export function isProc(pid: unknown, re: RegExp): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); } catch { return false; }
  let args = "";
  try { args = readFileSync(`/proc/${n}/cmdline`, "utf8").replace(/\0/g, " "); }
  catch { args = Bun.spawnSync(["ps", "-p", String(n), "-o", "args="]).stdout.toString(); }
  return re.test(args);
}

// SIGTERM (and SIGCONT, so a stopped one can act on it), then SIGKILL after 2 s; `alive` says it is still ours.
export async function stopProc(pid: unknown, alive: (pid: unknown) => boolean = isBoard): Promise<void> {
  if (!alive(pid)) return;
  const n = Number(pid);
  for (const sig of ["SIGTERM", "SIGCONT"] as const) { try { process.kill(n, sig); } catch { /* gone */ } }
  for (let t = 0; t < 2000 && alive(n); t += 100) await Bun.sleep(100);
  if (alive(n)) { try { process.kill(n, "SIGKILL"); } catch { /* gone */ } }
  for (let t = 0; t < 2000 && alive(n); t += 100) await Bun.sleep(100);
}
const stop = (pid: unknown) => stopProc(pid, isBoard);

export function binds(): string {
  return process.env.DS_BIND || ["127.0.0.1", tailscale().ip].filter(Boolean).join(" ");
}
// The asker's DS_BIND / DS_BOARD_HOSTS travel in the wish (`ds want board --bind/--hosts`, which
// board.sh --serve passes): the loop's own environment is only the fallback.
function payloadOf(r: Row): { bind?: string; hosts?: string } {
  try { return (JSON.parse(String(r.want_payload ?? "{}")) ?? {}) as { bind?: string; hosts?: string }; } catch { return {}; }
}
export const bindsOf = (r: Row): string => payloadOf(r).bind || binds();
function hosts(r: Row, b: string): string {
  const t = tailscale();
  return ["localhost", "127.0.0.1", "::1", hostname(), hostname().split(".")[0], t.ip, t.dns, t.dns.split(".")[0], b, process.env.DS_BOARD_HOSTS ?? "", payloadOf(r).hosts ?? ""]
    .join(" ").split(/\s+/).filter(Boolean).join(" ");
}

export function logPath(root: string, r: Row): string {
  const dir = r.project ? join(root, String(r.project)) : root;
  return join(dir, `board-serve${r.topic ? `-${r.topic}` : ""}.log`);
}
const tail = (path: string) => { try { return readFileSync(path, "utf8").trim().split("\n").slice(-3).join(" ").slice(-600); } catch { return ""; } };

const rowOf = (s: Store, a: Action) => s.wish("service", Number((a.payload as { id?: number })?.id));
const ctxOf = (r: Row) => ({ project: String(r.project) || null, squad: String(r.topic) || null, payload: { id: r.id, name: r.name, project: r.project, topic: r.topic, port: r.port } as Record<string, unknown> });
export function set(s: Store, kind: string, r: Row, cols: Row, at: number, extra: Record<string, unknown> = {}): void {
  const c = ctxOf(r);
  s.fact(kind, [{ table: "services", key: { id: r.id }, set: { ...cols, observed_at: at, updated_at: at } }], { ...c, payload: { ...c.payload, ...extra } });
}
// The wish given up: failed until the next `ds want board` (store.want asks a failed wish again).
function fail(s: Store, r: Row, why: string, at: number, cols: Row = {}): void {
  set(s, "service_failed", r, { status: "failed", pid: null, result: why, want_result: `failed: ${why}`, ...cols }, at, { error: why });
}
// A start in flight that fails after a newer wish (another port, or --stop) replaced it: the attempt
// is over, but the newer wish is not given up — the reconciler acts on it on the next tick.
function failStart(s: Store, r: Row, why: string, at: number, cols: Row = {}): void {
  const now = s.wish("service", Number(r.id));
  if (now && (now.want !== "running" || now.want_at !== r.want_at || now.want_payload !== r.want_payload)) {
    set(s, "service_failed", now, { status: "failed", pid: null, result: why, ...cols }, at, { error: why, superseded: true });
  } else fail(s, now ?? r, why, at, cols);
}

// A running server the start waits on: its pid, and whether (and how) it has exited.
export type Handle = { pid: number; exited(): { code: number | null } | null };

// True when this host can run a transient user unit (the same test bin/loop/loop.sh uses for the loop's own).
// DS_BOARD_SYSTEMD=0 turns it off.
export function systemdUp(): boolean {
  const PATH = process.env.PATH ?? "";
  if (process.env.DS_BOARD_SYSTEMD === "0" || !Bun.which("systemd-run", { PATH }) || !Bun.which("systemctl", { PATH })) return false;
  try { return Bun.spawnSync([Bun.which("systemctl", { PATH })!, "--user", "show-environment"], { timeout: 5000, stdout: "ignore", stderr: "ignore" }).exitCode === 0; } catch { return false; }
}

// Start the server in its own user unit (`ds-board-<id>`; the link's is `ds-link-<id>`). The unit runs a small shell that starts the
// server, writes its pid and, when it ends, its exit code (the loop is not its parent). Null when
// systemd refuses (the unit name is taken, no bus): the caller spawns it detached instead.
export async function startUnit(unit: string, argv: string[], env: Record<string, string>, log: string, alive: (pid: unknown) => boolean = isBoard): Promise<Handle | null> {
  const pidFile = `${log}.pid`, exitFile = `${log}.exit`;
  rmSync(pidFile, { force: true }); rmSync(exitFile, { force: true });
  const script = 'pf=$1; ef=$2; shift 2; "$@" & echo $! > "$pf"; wait $!; echo $? > "$ef"';
  const setenv = Object.entries(env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/[\n\0]/.test(v)).flatMap(([k, v]) => ["-E", `${k}=${v}`]);
  let r: Bun.SyncSubprocess;
  try {
    r = Bun.spawnSync([Bun.which("systemd-run", { PATH: process.env.PATH ?? "" }) ?? "systemd-run", "--user", "--collect", "--quiet", "--unit", unit,
      "-p", `WorkingDirectory=${ROOT}`, "-p", `StandardOutput=append:${log}`, "-p", `StandardError=append:${log}`,
      ...setenv, "--", "sh", "-c", script, "sh", pidFile, exitFile, ...argv], { timeout: 15_000, stdout: "ignore", stderr: "pipe" });
  } catch { return null; }
  if (r.exitCode !== 0) return null;
  for (let t = 0; t < 3000; t += 50) {
    const pid = parseInt(((): string => { try { return readFileSync(pidFile, "utf8"); } catch { return ""; } })().trim(), 10);
    if (pid > 0) {
      exitFiles.set(pid, exitFile);
      return { pid, exited: () => (alive(pid) ? null : { code: exitCodeOf(pid) }) };
    }
    await Bun.sleep(50);
  }
  return null;
}

// True when another scope's row registers this port, or another start has claimed it.
function taken(s: Store, id: number, port: number): boolean {
  const by = claimed.get(port);
  if (by !== undefined && by !== id) return true;
  return s.db.query("SELECT 1 FROM services WHERE name = 'board' AND id != ? AND port = ?").get(id, port) != null;
}

// The port this start binds: the row's own when its old server still holds it, else the first free
// one from the row's port (after a restart of our own server, a short wait for it to let go first).
async function pickPort(s: Store, r: Row, b: string, restarted: boolean): Promise<number | null> {
  const id = Number(r.id), asked = Number(r.port);
  if (isBoard(r.pid)) return asked;
  if (restarted && !taken(s, id, asked)) for (let i = 0; i < 10 && await held(asked, b); i++) await Bun.sleep(200);
  return freePort(asked, b, {
    skip: (p) => taken(s, id, p),
    claim: (p) => claimed.set(p, id),
    release: (p) => unclaim(p, id),
  });
}

// Spawn the server and wait for /healthz in the background.
async function start(x: Exec, r: Row, restarted = false): Promise<Result> {
  const { store, now: at } = x, id = Number(r.id), asked = Number(r.port);
  // The wish this start serves: started_at is never older than it (a wish written after the tick's
  // clock was read would otherwise look newer than the start it got).
  const served = Math.max(at, Number(r.want_at ?? 0));
  if (!Number.isInteger(asked) || asked <= 0 || asked > 65535) { fail(store, r, `no valid port (${r.port})`, at); return { failed: `no valid port (${r.port})` }; }
  const b = bindsOf(r);
  const port = await pickPort(store, r, b, restarted);
  if (port === null) {
    const why = `ports ${asked}-${lastPort(asked)} are all taken or registered to another board`;
    fail(store, r, why, at);
    return { failed: why };
  }
  const log = logPath(store.root, r);
  mkdirSync(join(log, ".."), { recursive: true });
  try { renameSync(log, `${log}.1`); } catch { /* none yet */ }
  closeSync(openSync(log, "w"));
  const data = [process.execPath, join(ROOT, "bin", "board", "board-data.ts"), ...(r.project ? [String(r.project)] : []), ...(r.topic ? ["--topic", String(r.topic)] : []), "--json"];
  const argv = [process.execPath, process.env.DS_BOARD_SERVER || join(ROOT, "bin", "board", "board-server.ts"), b, String(port), join(ROOT, "web", "board.html"), ...data];
  const env = childEnv({ DS_STATE_ROOT: store.root, DS_BOARD_HOSTS: hosts(r, b), DS_READY_FILE: null });
  let h: Handle | null = null;
  if (systemdUp()) { h = await startUnit(`ds-board-${id}`, argv, env, log); }
  if (!h) {
    const fd2 = openSync(log, "a");
    let p: Bun.Subprocess;
    try {
      p = Bun.spawn(argv, { cwd: ROOT, detached: true, stdio: ["ignore", fd2, fd2], env } as Parameters<typeof Bun.spawn>[1]);
    } catch (e) { closeSync(fd2); unclaim(port, id); const why = `spawn failed: ${(e as Error).message}`; fail(store, r, why, at); return { failed: why }; }
    closeSync(fd2);
    p.unref();
    // A start replaces whatever ran before: the exit codes of the dead ones are no longer asked for.
    for (const [pid, c] of children) if (c.exitCode !== null || c.signalCode) children.delete(pid);
    children.set(p.pid, p);
    h = { pid: p.pid, exited: () => (p.exitCode !== null || p.signalCode ? { code: p.exitCode } : null) };
  }
  const { pid } = h;
  starting.add(id);
  // The port bound becomes the row's: the scope's registered port, the one every reader pings. Not
  // over a newer wish written meanwhile (another port): the reconciler restarts the board on that one.
  const same = store.wish("service", id)?.want_at === r.want_at;
  set(store, "service_starting", r, { status: "starting", pid, started_at: served, result: null, ...(same ? { port } : {}) }, at, { pid, port, ...(port !== asked ? { asked } : {}) });
  r = store.wish("service", id) ?? { ...r, port };
  return {
    background: (async (): Promise<Result> => {
      try {
        for (let t = 0; t < waitMs(); t += 200) {
          const gone = h.exited();
          if (gone) {
            const why = tail(log) || `the board exited ${gone.code ?? "(signal)"}`;
            failStart(store, r, why, at, { started_at: served });
            return { failed: why };
          }
          if (await boardUp(port, b, pid)) {
            set(store, "service_started", r, { status: "running", pid, last_ping_at: at }, at, { pid });
            return { done: true, result: { pid, port } };
          }
          await Bun.sleep(200);
        }
        await stop(pid);
        const t = tail(log), why = `the board didn't answer /healthz on :${port} within ${waitMs() / 1000}s${t ? `: ${t}` : ""}`;
        failStart(store, r, why, at);
        return { failed: why };
      } finally { starting.delete(id); unclaim(port, id); }
    })(),
  };
}

// The project whose Studio hears about an all-projects board: the first one in the state root.
const alertProject = (s: Store, r: Row) => String(r.project) || discoverProjects(s.root)[0] || "";

const board: Fulfiller = {
  name: "board",
  scope: "host",
  kinds: ["board_start", "board_restart", "board_stop", "board_giveup"],
  run: () => [],
  async exec(a, x) {
    const r = rowOf(x.store, a);
    if (!r) return { dropped: "no such services row" };
    const p = (a.payload ?? {}) as { counted?: boolean; why?: string };
    if (a.kind === "board_stop") {
      await stop(r.pid);
      set(x.store, "service_stopped", r, { status: "stopped", pid: null }, x.now);
      return { done: true };
    }
    if (a.kind === "board_giveup") {
      await stop(r.pid);
      const why = p.why ?? "restarted too often";
      fail(x.store, r, why, x.now);
      const project = alertProject(x.store, r);
      if (project) await alert(x.store, project, `board${r.project ? `-${r.project}` : ""}${r.topic ? `-${r.topic}` : ""}`, a.episode,
        `the web board${r.project ? ` for ${r.project}` : ""}${r.topic ? ` (${r.topic})` : ""} ${why} — the loop stopped restarting it; see ${logPath(x.store.root, r)}, then ask again with \`board.sh ${r.project || ""} --serve\``);
      return { done: true };
    }
    const restarted = a.kind === "board_restart" && isBoard(r.pid);
    if (a.kind === "board_restart") {
      await stop(r.pid);
      const restarts = restartsOf(r);
      if (p.counted) restarts.push(x.now);
      set(x.store, "service_restarted", r, { restarts: JSON.stringify(restarts.slice(-20)), pid: null }, x.now, { why: p.why ?? null, counted: !!p.counted });
    } else if (isBoard(r.pid) && await boardUp(Number(r.port), bindsOf(r), r.pid)) {
      // A start the loop crashed in the middle of: the server is up, keep it.
      set(x.store, "service_started", r, { status: "running", last_ping_at: x.now }, x.now, { pid: r.pid, adopted: true });
      return { done: true };
    }
    return start(x, rowOf(x.store, a) ?? r, restarted);
  },
};
export default board;
