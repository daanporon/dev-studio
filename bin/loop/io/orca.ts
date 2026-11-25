// orca.ts — the loop's one way to Orca and to the shell (Bun). Every Orca call is an op of the
// backend adapter ($BACKEND), never `orca` itself (KTD9); tests swap in bin/loop/fakes/orca.ts, which
// answers the same ops. The default adapter, bin/backend/orca.sh, is only `exec ds backend <op>`, so
// the loop calls its TypeScript (bin/backend/orca.ts) in process instead (U227): no shell, no bun
// start per call, the same {code, out, err}. Any other $BACKEND (a sibling adapter, a test's fake
// script) is a program and is still spawned.
//
// Every process the loop spawns gets childEnv(): no ORCA_* (an inherited agent handle would
// clash with --from) and no inherited worker identity (DS_MEMBER, DS_WT, DS_GEN, U4: only set on
// purpose, as a replay sets its filer's), DS_LOOP_CHILD=1 (a child script does its own Orca mechanics instead of
// writing a wish back to the loop), and the sender terminal and retry id of this call.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ROOT } from "../core/store.ts";

export type Out = { code: number; out: string; err: string };
export type Via = { from?: string | null; retry?: string | null; env?: Record<string, string> };
export interface Orca { run(op: string, args: string[], via?: Via): Promise<Out> }

const IDENTITY = new Set(["DS_MEMBER", "DS_WT", "DS_GEN", "DS_START_MEMBER", "DS_START_GEN", "DS_START_OLD_GONE"]);

export function childEnv(extra: Record<string, string | null | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("ORCA_") && !IDENTITY.has(k)) env[k] = v;
  env.DS_LOOP_CHILD = "1";
  // Not a handle but where Orca keeps its data: the adapter needs it to find the managed accounts.
  if (process.env.ORCA_USER_DATA_PATH && !env.DS_ORCA_DATA) env.DS_ORCA_DATA = process.env.ORCA_USER_DATA_PATH;
  if (process.env.ORCA_CLI_BIN_DIR && !env.DS_ORCA_CLI_BIN_DIR) env.DS_ORCA_CLI_BIN_DIR = process.env.ORCA_CLI_BIN_DIR;
  for (const [k, v] of Object.entries(extra)) if (v) env[k] = v;
  return env;
}

async function exec(argv: string[], env: Record<string, string>, timeoutMs: number, cwd?: string): Promise<Out> {
  try {
    const p = Bun.spawn(argv, { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  } catch (e) { return { code: -1, out: "", err: (e as Error)?.message ?? String(e) }; }
}

export function spawn(argv: string[], extra: Record<string, string | null | undefined> = {}, timeoutMs = 600_000, cwd?: string): Promise<Out> {
  return exec(argv, childEnv(extra), timeoutMs, cwd);
}

export const ORCA_SH = join(ROOT, "bin", "backend", "orca.sh");
export const backendPath = (): string => process.env.BACKEND || ORCA_SH;

/** This checkout's orca.sh (by any path to it): its verbs run in process. */
export function inProcess(backend: string): boolean {
  if (backend === ORCA_SH) return true;
  try { return realpathSync(backend) === realpathSync(ORCA_SH); } catch { return false; }
}

/** One backend op with this environment, answering what `<backend> <op> <args…>` answered. In process
 *  the env gets what orca.sh exported (DS_ROOT beside the script, no transpiler cache), a throw is
 *  `ds backend: <message>` exit 1, an unknown op exit 2, and a call still running at timeoutMs answers
 *  143 as the killed process did. There is no process to kill, so the timeout aborts the verb's signal:
 *  its children are killed, none start, and it unwinds through its finally blocks, releasing the name
 *  locks it holds under the loop's pid, which never dies to let a later caller take them over. The timer
 *  fires only while the verb awaits: a verb's synchronous work holds the loop's thread, so it must stay cheap. */
export async function backendOp(backend: string, op: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<Out> {
  const dir = process.env.DS_ORCA_TICK_DIR;
  if (dir && MEMO.has(op) && args.length === 0 && inProcess(backend)) return memoRead(op, dir, () => rawOp(backend, op, args, env, timeoutMs));
  return rawOp(backend, op, args, env, timeoutMs);
}

// U248: inside a tick the host-wide unread listing is read once: the first caller's answer is kept in the tick's
// directory with the write counter it was read at, and a later caller gets it while no write has gone out.
const MEMO = new Set(["inbox-unread-all"]);
async function memoRead(op: string, dir: string, fetch: () => Promise<Out>): Promise<Out> {
  const { gen } = await import("../../backend/orca-cache.ts");   // lazy, like orca.ts: a copy of bin/loop has no bin/backend
  const f = join(dir, `memo-${op}`), g = gen(dir);
  try {
    const [head, ...rest] = readFileSync(f, "utf8").split("\n");
    if (head === g) return { code: 0, out: rest.join("\n"), err: "" };
  } catch { /* not read yet this tick */ }
  const r = await fetch();
  if (r.code === 0 && gen(dir) === g) { try { writeFileSync(f, `${g}\n${r.out}`); } catch { /* the tick ended */ } }
  return r;
}

async function rawOp(backend: string, op: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<Out> {
  if (!inProcess(backend)) return exec([backend, op, ...args], env, timeoutMs);
  // Loaded on the first in-process call, not at import: whatever imports bin/loop without calling the
  // backend (the board server, a copy of bin/loop with no bin/backend beside it) never needs it.
  const { call } = await import("../../backend/orca.ts");
  const stop = new AbortController();
  const verb = call(op, args, { ...env, DS_ROOT: resolve(dirname(backend), "..", ".."), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stop.signal)
    .then((r): Out => r ? { code: r.code, out: r.out, err: r.err } : { code: 2, out: "", err: `orca adapter: unknown op '${op}'\n` });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Out>((done) => {
    timer = setTimeout(() => {
      stop.abort();
      done({ code: 143, out: "", err: `orca adapter: ${op} timed out after ${Math.round(timeoutMs / 1000)}s\n` });
    }, timeoutMs);
  });
  try { return await Promise.race([verb, late]); } finally { clearTimeout(timer); }
}

// The real backend. A worker-start is tried once (DS_WORKER_START_RETRIES=1): on runtime_busy the
// actuator leaves the action pending for the next tick instead of sleeping inside the tick.
export function shell(backend = backendPath()): Orca {
  return {
    run: (op, args, via = {}) => backendOp(backend, op, args,
      childEnv({ ...via.env, DS_ORCA_FROM: via.from, DS_ORCA_RETRY_REQUEST: via.retry, DS_WORKER_START_RETRIES: "1" }), 600_000),
  };
}

// The error an op gave, or `<what> exit <code>` when it printed nothing.
export const errOf = (o: Out, what: string): string => (o.err || o.out).trim() || `${what} exit ${o.code}`;

// The adapter could not get as far as Orca and says so ("still pending"): another run of this start
// holds its lock, or a read it needs failed. Orca has no receipt yet, so request-show would answer
// absent, and a new id would run beside the old one. The call stays open under its id.
export const inDoubt = (o: Out): boolean => /still pending/i.test(o.err + o.out);

// Orca refused for capacity (the 16 long-poll slots), or still works on the same request: nothing
// to do but wait.
export function busy(o: Out): boolean { return /runtime_busy|long-poll capacity|capacity reached|still pending/i.test(o.err + o.out); }
