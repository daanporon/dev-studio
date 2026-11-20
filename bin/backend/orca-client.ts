// orca-client.ts — U254 spike, off by default. With the loop started under DS_ORCA_CLIENT=1, a read the loop
// makes of Orca (SERVED below) goes to a long-lived helper (orca-client.cjs) that keeps Orca's own CLI bundle
// loaded, instead of a node start per call. Orca is not changed: the helper runs the code the `orca` launcher
// runs, under the node the launcher names, both read from the launcher script on every call (one stat), so an
// Orca update (a new artifact dir in the launcher) starts fresh helpers without a loop restart. Any failure
// (no launcher, a helper that will not start, dies or overruns, an environment the helper was not started
// with) answers null and the caller spawns the CLI as before. Only the process that called
// enableOrcaClient(true) (bin/loop/main.ts) uses it: the flag is inherited by every child, the switch is not.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

export type Reply = { code: number; chunks: [number, string][] };
export type Launcher = { node: string; script: string; userData: string; id: string };

// Verbs that only read Orca and end on their own (no `terminal wait`, no streams): the loop's hot reads.
const SERVED = new Set(["terminal list", "terminal show", "worktree ps", "worktree show", "worktree current",
  "account list", "account show", "orchestration run-show", "orchestration worker-show", "orchestration task-show",
  "orchestration request-show", "orchestration inbox", "orchestration worker-list"]);
export function servable(args: string[]): boolean {
  const verb = `${args[0] ?? ""} ${args[1] ?? ""}`;
  if (args.includes("--wait")) return false;   // a long poll would hold a helper that runs one call at a time
  return SERVED.has(verb) || (verb === "orchestration check" && args.includes("--peek"));
}

let launcherSeen: { stat: string; l: Launcher | null } | null = null;
/** The node and CLI bundle Orca's `orca` launcher execs (null when it has another shape). Re-read when the file changes. */
export function readLauncher(cli: string): Launcher | null {
  let stat: string;
  try { const s = statSync(cli); stat = `${cli}:${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return null; }
  if (launcherSeen?.stat === stat) return launcherSeen.l;
  let l: Launcher | null = null;
  try {
    const src = readFileSync(cli, "utf8");
    const m = src.match(/^exec '([^']+)' '([^']+)' "\$@"\s*$/m);
    if (m) l = { node: m[1], script: m[2], userData: src.match(/^export ORCA_USER_DATA_PATH='([^']*)'/m)?.[1] ?? "", id: `${stat}:${m[1]}:${m[2]}` };
  } catch { /* unreadable: the CLI */ }
  launcherSeen = { stat, l };
  return l;
}

type Helper = { proc: Subprocess<"pipe", "pipe", "ignore">; pending: Map<number, (r: Reply | null) => void>; ready: Promise<boolean>; dead: boolean; load: number };
let enabled = false, pool: Helper[] = [], poolFor = "", brokenFor = "", brokenUntil = 0, seq = 0;
const stats = { served: 0, fallback: 0, starts: 0 };

export function enableOrcaClient(on: boolean): void { enabled = on; if (!on) stopOrcaClient(); }
export const orcaClientOn = (): boolean => enabled;
export const orcaClientStats = () => ({ ...stats, helpers: pool.length });
export function stopOrcaClient(): void { for (const h of pool) kill(h); pool = []; poolFor = ""; }

function kill(h: Helper): void {
  if (h.dead) return;
  h.dead = true;
  try { h.proc.kill(); } catch { /* gone */ }
  for (const done of h.pending.values()) done(null);
  h.pending.clear();
  pool = pool.filter((x) => x !== h);
}

// What a helper's answers depend on besides the arguments: the Orca handles and where config lives.
function envKey(env: Record<string, string | undefined>): string {
  return JSON.stringify(Object.keys(env).filter((k) => k.startsWith("ORCA_") || k === "HOME" || k === "XDG_CONFIG_HOME").sort().map((k) => [k, env[k]]));
}

function start(l: Launcher, env: Record<string, string | undefined>): Helper {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
  delete e.NODE_OPTIONS; delete e.NODE_REPL_EXTERNAL_MODULE; delete e.ELECTRON_RUN_AS_NODE;
  if (l.userData) e.ORCA_USER_DATA_PATH = l.userData;
  stats.starts++;
  const proc = Bun.spawn([l.node, join(import.meta.dir, "orca-client.cjs"), l.script], { env: e, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  let ok: (v: boolean) => void = () => {};
  const h: Helper = { proc, pending: new Map(), ready: new Promise((r) => { ok = r; }), dead: false, load: 0 };
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let msg: { ready?: boolean; id?: number; code?: number; chunks?: [number, string][] };
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.ready) { ok(true); continue; }
          const done = msg.id !== undefined ? h.pending.get(msg.id) : undefined;
          if (!done) continue;
          h.pending.delete(msg.id!);
          done({ code: Number(msg.code) || 0, chunks: Array.isArray(msg.chunks) ? msg.chunks : [] });
        }
      }
    } catch { /* closed */ }
    ok(false);
    kill(h);
  })();
  return h;
}

/** One read through a helper; null = not served (the caller spawns the CLI). */
export async function clientRead(cli: string, args: string[], env: Record<string, string | undefined>): Promise<Reply | null> {
  if (!enabled || !servable(args)) return null;
  const l = readLauncher(cli);
  if (!l) return miss();
  const key = `${l.id}\n${envKey(env)}`;
  if (brokenFor === l.id && Date.now() < brokenUntil) return miss();
  if (poolFor !== key) {
    // A new launcher (an Orca update) replaces the pool; another environment is the CLI's to serve.
    if (poolFor && poolFor.split("\n")[0] === l.id) return miss();
    stopOrcaClient();
    poolFor = key;
  }
  const size = Math.max(1, Number(env.DS_ORCA_CLIENT_POOL ?? 2) || 2);
  // Picked and counted before any await, so calls made side by side spread over the pool.
  let h = pool.find((x) => x.load === 0);
  if (!h && pool.length < size) { h = start(l, env); pool.push(h); }
  if (!h) h = pool.reduce((a, b) => (b.load < a.load ? b : a));
  const helper = h;
  helper.load++;
  try {
    if (!(await helper.ready)) { brokenFor = l.id; brokenUntil = Date.now() + 60_000; return miss(); }
    const id = ++seq, timeoutMs = Number(env.DS_ORCA_CLIENT_TIMEOUT_MS ?? 30_000) || 30_000;
    const reply = await new Promise<Reply | null>((done) => {
      const timer = setTimeout(() => { done(null); kill(helper); }, timeoutMs);
      helper.pending.set(id, (r) => { clearTimeout(timer); done(r); });
      try { helper.proc.stdin.write(JSON.stringify({ id, args, cwd: process.cwd() }) + "\n"); helper.proc.stdin.flush(); } catch { clearTimeout(timer); kill(helper); done(null); }
    });
    if (!reply) return miss();
    stats.served++;
    return reply;
  } finally { helper.load--; }
}
function miss(): null { stats.fallback++; return null; }

/** A reply as the CLI's streams: stdout, stderr, and both in the order written (the shell's `2>&1`). */
export function streams(r: Reply): { out: string; err: string; merged: string } {
  let out = "", err = "", merged = "";
  for (const [fd, s] of r.chunks) { merged += s; if (fd === 2) err += s; else out += s; }
  return { out, err, merged };
}
