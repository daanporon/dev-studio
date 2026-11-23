// server-unit.ts — start a backend's server outside the loop (orca-backend-alternatives U2;
// conventions/backend.md, "Backend servers live outside the loop"). A tmux or herdr server the loop
// needs must never be the loop's child: every loop restart (an update, the watchdog) would take every
// agent on it down. So, as fulfil/board.ts runs the board:
//
//   const h = await startServer({ name: "tmux-myproj", argv: ["tmux", "-L", "ds-myproj", "-D"], log });
//   h.via          "systemd": its own transient user unit (`systemd-run --user --collect --unit ds-<name>`),
//                  so `systemctl --user restart ds-loop` kills the loop's cgroup and not this one;
//                  "detached": its own session (setsid), when systemd is missing, refuses the unit (its
//                  name is taken, no user bus) or DS_SERVER_SYSTEMD=0.
//   serverAlive(h.pid), await stopServer(h)
//
// In a unit the server runs under a small shell that writes its pid to `<log>.pid` and, when it ends,
// its exit code to `<log>.exit` (`exitCodeOf`), since the caller is not its parent. Its stdout and
// stderr append to `log`. The unit does not inherit the caller's environment: `env` is the whole
// environment the server gets (default: the caller's, without ORCA_*).
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export type ServerSpec = {
  name: string;                 // the unit is ds-<name> (other characters become -)
  argv: string[];
  log: string;                  // stdout and stderr append here; <log>.pid and <log>.exit sit beside it
  cwd?: string;
  env?: Record<string, string>;
};
export type ServerHandle = { pid: number; via: "systemd" | "detached"; unit: string | null; log: string };

export const unitName = (name: string): string => `ds-${name.replace(/[^A-Za-z0-9_.-]/g, "-")}`;

function which(cmd: string): string | null { return Bun.which(cmd, { PATH: process.env.PATH ?? "" }); }

// True when this host can run a transient user unit (the test bin/loop/loop.sh and fulfil/board.ts use).
export function systemdUp(): boolean {
  if (process.env.DS_SERVER_SYSTEMD === "0") return false;
  const ctl = which("systemctl");
  if (!which("systemd-run") || !ctl) return false;
  try { return Bun.spawnSync([ctl, "--user", "show-environment"], { timeout: 5000, stdout: "ignore", stderr: "ignore" }).exitCode === 0; }
  catch { return false; }
}

export function defaultEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("ORCA_")) env[k] = v;
  return env;
}

// True for a live pid (a zombie, which a killed parent may leave for a moment, is not live).
export function serverAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
}

const readInt = (f: string): number | null => { try { const n = parseInt(readFileSync(f, "utf8").trim(), 10); return Number.isNaN(n) ? null : n; } catch { return null; } };
// A unit server's exit code once it ended (null while it runs, and for a detached one).
export const exitCodeOf = (h: ServerHandle): number | null => (h.via === "systemd" ? readInt(`${h.log}.exit`) : null);

async function viaUnit(spec: ServerSpec, env: Record<string, string>): Promise<ServerHandle | null> {
  const pidFile = `${spec.log}.pid`, exitFile = `${spec.log}.exit`, unit = unitName(spec.name);
  rmSync(pidFile, { force: true }); rmSync(exitFile, { force: true });
  const script = 'pf=$1; ef=$2; shift 2; "$@" & echo $! > "$pf"; wait $!; echo $? > "$ef"';
  const setenv = Object.entries(env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/[\n\0]/.test(v)).flatMap(([k, v]) => ["-E", `${k}=${v}`]);
  let r: Bun.SyncSubprocess;
  try {
    r = Bun.spawnSync([which("systemd-run") ?? "systemd-run", "--user", "--collect", "--quiet", "--unit", unit,
      ...(spec.cwd ? ["-p", `WorkingDirectory=${spec.cwd}`] : []), "-p", `StandardOutput=append:${spec.log}`, "-p", `StandardError=append:${spec.log}`,
      ...setenv, "--", "sh", "-c", script, "sh", pidFile, exitFile, ...spec.argv], { timeout: 15_000, stdout: "ignore", stderr: "ignore" });
  } catch { return null; }
  if (r.exitCode !== 0) return null;
  for (let t = 0; t < 5000; t += 50) {
    const pid = readInt(pidFile);
    if (pid && pid > 0) return { pid, via: "systemd", unit, log: spec.log };
    await Bun.sleep(50);
  }
  return null;
}

function detached(spec: ServerSpec, env: Record<string, string>): ServerHandle {
  const fd = openSync(spec.log, "a");
  try {
    const p = Bun.spawn(spec.argv, { cwd: spec.cwd, env, detached: true, stdio: ["ignore", fd, fd] } as Parameters<typeof Bun.spawn>[1]);
    p.unref();
    return { pid: p.pid, via: "detached", unit: null, log: spec.log };
  } finally { closeSync(fd); }
}

// Start the server; throws only when even the detached spawn fails (no such program).
export async function startServer(spec: ServerSpec): Promise<ServerHandle> {
  if (!spec.argv.length) throw new Error("startServer: empty argv");
  mkdirSync(dirname(spec.log), { recursive: true });
  const env = spec.env ?? defaultEnv();
  if (systemdUp()) {
    const h = await viaUnit(spec, env);
    if (h) return h;
  }
  return detached(spec, env);
}

// Stop it: the unit (and everything in it) through systemctl, a detached one by its process group
// (its own session), SIGTERM then SIGKILL after 2 s.
export async function stopServer(h: ServerHandle): Promise<void> {
  if (h.unit) {
    const ctl = which("systemctl");
    if (ctl) Bun.spawnSync([ctl, "--user", "stop", h.unit], { timeout: 15_000, stdout: "ignore", stderr: "ignore" });
  }
  const sig = (s: NodeJS.Signals) => { try { process.kill(h.via === "detached" ? -h.pid : h.pid, s); } catch { try { process.kill(h.pid, s); } catch { /* gone */ } } };
  if (!serverAlive(h.pid)) return;
  sig("SIGTERM");
  for (let t = 0; t < 2000 && serverAlive(h.pid); t += 50) await Bun.sleep(50);
  if (serverAlive(h.pid)) sig("SIGKILL");
  for (let t = 0; t < 2000 && serverAlive(h.pid); t += 50) await Bun.sleep(50);
}
