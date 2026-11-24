// orca.ts — the Orca backend adapter in TypeScript (U223-U226): one function per verb, and the one
// wrapper every verb calls the `orca` CLI through. Every verb lives here: bin/backend/orca.sh is only
// `exec ds backend <verb>`, so callers keep calling orca.sh (KTD9: only the adapter calls `orca`).
// U227 calls it in process from the loop.
//
// The contract is the shell's: same arguments, stdout, stderr lines and exit codes. Where the shell
// read JSON with jq, the helpers below (idx, each, or, raw, interp, pretty, jq) do what jq did, errors
// included, so a malformed answer fails the same way. Only bun/node built-ins; no package.
import { accessSync, appendFileSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { cachedRead, canonRead, countDrop, countSpawn, dropCached, runsOfWrite, type SpawnKind } from "./orca-cache.ts";
import { clientRead, orcaClientOn, streams } from "./orca-client.ts";
import { bashQ, claudeLine, claudeSettings, markTrusted, orcaData, systemJsonDir, utf8Locale, type ClaudeConfig, type LaunchLine } from "../loop/drivers/claude-launch.ts";

type Env = Record<string, string | undefined>;
type Sink = (b: string | Uint8Array) => void;

/** One verb call: its environment, where its stdout/stderr go and whether children read our stdin. signal
 *  (a caller in process, U227): once it fires, the verb's children are killed and no more start, so the
 *  verb unwinds through its finally blocks (its name locks) as a killed `ds backend` process ended. */
export type Ctx = { env: Env; out: Sink; err: Sink; stdin: "inherit" | "ignore"; cli?: string | null; signal?: AbortSignal; op?: string };
export type Result = { code: number; out: string; err: string };

const HERE = import.meta.dir;

// --- jq, the parts the adapter used -------------------------------------------------------------
export class JqError extends Error {}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const jqType = (v: unknown): string => v === null || v === undefined ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v;
/** `.k`: null on null, the field (or null) on an object, an error on anything else. */
export function idx(v: unknown, k: string): any {
  if (v === null || v === undefined) return null;
  if (isObj(v)) return Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null;
  throw new JqError(`Cannot index ${jqType(v)} with "${k}"`);
}
/** `.[]?`: an array's items, an object's values, nothing for anything else. */
export function each(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (isObj(v)) return Object.values(v);
  return [];
}
export const truthy = (v: unknown): boolean => v !== null && v !== undefined && v !== false;
/** `a // b // …` over values already computed. */
export function alt(...vs: unknown[]): any {
  for (const v of vs) if (truthy(v)) return v;
  return vs.length ? vs[vs.length - 1] ?? null : null;
}
/** jq's JSON text: JSON.stringify, plus the one escape jq adds (DEL). */
export function pretty(v: unknown, indent = 2): string {
  return (JSON.stringify(v, null, indent) ?? "null").replace(/\x7f/g, "\\u007f");
}
/** `jq -r` of one value: a string as is, anything else as (indented) JSON. */
export const raw = (v: unknown): string => typeof v === "string" ? v : pretty(v);
/** `"\(v)"`: a string as is, anything else as compact JSON. */
export const interp = (v: unknown): string => typeof v === "string" ? v : pretty(v, 0);
/** Every JSON value in a text (jq reads a stream); throws JqError on a parse error. "" is none. */
export function docs(text: string): any[] {
  const s = scan(text);
  if (s.bad) throw new JqError("parse error: invalid JSON text");
  return s.vals;
}
/** The values jq reads from a text before its first parse error (`bad`): jq handles each one before it
 *  reaches the bad part, so a valid answer followed by stray text still gives its output. */
export function scan(text: string): { vals: any[]; bad: boolean } {
  const t = text.trim();
  if (t === "") return { vals: [], bad: false };
  try { return { vals: [JSON.parse(t)], bad: false }; } catch { /* a stream of several, or not JSON */ }
  const out: any[] = [];
  const n = t.length;
  const num = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(t[i])) i++;
    if (i >= n) break;
    const c = t[i];
    let end = -1;
    if (c === "{" || c === "[") {
      // one forward walk to where this top-level value closes: depth, strings and escapes
      let depth = 0, inStr = false;
      for (let j = i; j < n; j++) {
        const ch = t[j];
        if (inStr) { if (ch === "\\") j++; else if (ch === '"') inStr = false; }
        else if (ch === '"') inStr = true;
        else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") { if (--depth === 0) { end = j + 1; break; } }
      }
    } else if (c === '"') {
      for (let j = i + 1; j < n; j++) {
        if (t[j] === "\\") j++;
        else if (t[j] === '"') { end = j + 1; break; }
      }
    } else {
      for (const lit of ["true", "false", "null"]) if (t.startsWith(lit, i)) { end = i + lit.length; break; }
      if (end < 0) { num.lastIndex = i; const m = num.exec(t); if (m) end = i + m[0].length; }
    }
    if (end < 0) return { vals: out, bad: true };
    try { out.push(JSON.parse(t.slice(i, end))); } catch { return { vals: out, bad: true }; }
    i = end;
  }
  return { vals: out, bad: false };
}
/** `.[n]`: null on null, the item (or null) of an array, an error on anything else. */
export function at(v: unknown, n: number): any {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v[n] ?? null;
  throw new JqError(`Cannot index ${jqType(v)} with number`);
}
export type Jq = { vals: unknown[]; code: number; errs: string[] };
/** `jq <filter>` over a text, fn being the filter for one input (emit = one output). As jq 1.7 does: a
 *  runtime error ends that input, keeping what it emitted, and jq goes on with the next; a parse error ends
 *  the stream; the exit is 5 when the stream ended on a parse error or its last input failed, else 0. */
export function jq(text: string, fn: (d: any, emit: (v: unknown) => void) => void): Jq {
  const { vals: ins, bad } = scan(text);
  const vals: unknown[] = [], errs: string[] = [];
  let failed = false;
  for (const d of ins) {
    try { fn(d, (v) => vals.push(v)); failed = false; }
    catch (e) { if (!(e instanceof JqError)) throw e; errs.push(e.message); failed = true; }
  }
  if (bad) errs.push("parse error: invalid JSON text");
  return { vals, code: bad || failed ? 5 : 0, errs };
}
/** jq -e: 4 with no output, 1 when the last output is false or null, else jq's own code. */
export const jqE = (r: Jq): number => r.code !== 0 ? r.code : r.vals.length === 0 ? 4 : truthy(r.vals[r.vals.length - 1]) ? 0 : 1;
/** What `jq -r` prints for these outputs. */
export const rawLines = (vals: unknown[]): string => vals.map((v) => raw(v) + "\n").join("");
/** `$(jq -r … 2>/dev/null || true)`: the outputs, errors dropped, trailing newlines gone. */
export const jqr = (text: string, fn: (d: any, emit: (v: unknown) => void) => void): string => chomp(rawLines(jq(text, fn).vals));
const jqFail = (ctx: Ctx, e: unknown): number => {
  if (!(e instanceof JqError)) throw e;
  ctx.err(`jq: error: ${e.message}\n`);
  return e.message.startsWith("parse error") ? 2 : 5;
};

// --- shell bits ---------------------------------------------------------------------------------
/** The lines a `while read` loop sees: every newline-terminated line (an unterminated tail is skipped). */
export const lines = (s: string): string[] => s.split("\n").slice(0, -1);
/** `$(…)`: the text without its trailing newlines. */
export const chomp = (s: string): string => s.replace(/\n+$/, "");
/** `IFS=$'\t' read -r a b … z`: tab is IFS whitespace, so a run of tabs is one separator and the
 *  ends are trimmed; the last name gets the rest of the line. */
export function readTabs(line: string, n: number): string[] {
  let s = line.replace(/^\t+/, "");
  const out: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    const m = s.match(/^([^\t]*)\t*/)!;
    out.push(m[1]);
    s = s.slice(m[0].length);
  }
  out.push(s.replace(/\t+$/, ""));
  return out;
}
/** `awk -F'\t' '$1==k {print $2; exit}'`. */
const awkField2 = (rows: string, k: string): string => {
  for (const l of rows.split("\n")) { const f = l.split("\t"); if (f[0] === k) return f[1] ?? ""; }
  return "";
};
const isNum = (s: string | undefined): s is string => !!s && /^[0-9]+$/.test(s);
const nowS = (env: Env): number => env.DS_NOW ? Number(env.DS_NOW) : Math.floor(Date.now() / 1000);
/** Bytes as a one-char-per-byte string, as the C locale the loop's sweep runs in sees them. */
const bytes = (s: string): string => Buffer.from(s, "utf8").toString("latin1");
const latin1 = (b: Uint8Array): string => Buffer.from(b).toString("latin1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where Orca keeps its data (profiles, the bundled CLI). */
export { orcaData };
const claudeSys = (env: Env): string => env.DS_CLAUDE_HOME || `${env.HOME}/.claude`;

type Ran = { code: number; out: Uint8Array; err: Uint8Array };
/** Run a program to completion; a program that cannot start is 127 (the shell's "not found"), one the
 *  ctx's signal stops is 143 (SIGTERM). */
async function spawn(ctx: Ctx, argv: string[], opts: { stdin?: string; env?: Env } = {}): Promise<Ran> {
  if (ctx.signal?.aborted) return { code: 143, out: new Uint8Array(), err: new Uint8Array() };
  try {
    const p = Bun.spawn(argv, {
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : ctx.stdin,
      stdout: "pipe", stderr: "pipe",
      env: { ...(opts.env ?? ctx.env) } as Record<string, string>,
      signal: ctx.signal,
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).bytes(), p.exited]);
    return { code, out, err };
  } catch {
    return { code: 127, out: new Uint8Array(), err: new TextEncoder().encode(`${argv[0]}: command not found\n`) };
  }
}
function spawnSync(argv: string[], env: Env): { code: number; out: string } {
  try {
    const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: env as Record<string, string> });
    return { code: p.exitCode ?? 1, out: p.stdout.toString() };
  } catch { return { code: 127, out: "" }; }
}

// --- the orca CLI -------------------------------------------------------------------------------
/** The `orca` binary: DS_ORCA_CLI_BIN_DIR / ORCA_CLI_BIN_DIR when set, else Orca's bundled CLI,
 *  else PATH. null (and the shell's message on stderr) when there is none. */
export function resolveOrcaCli(ctx: Ctx): string | null {
  if (ctx.cli) return ctx.cli;
  const dir = ctx.env.DS_ORCA_CLI_BIN_DIR || ctx.env.ORCA_CLI_BIN_DIR || "";
  let cand: string | null = null;
  const exe = (p: string) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
  if (dir) {
    cand = `${dir.replace(/\/$/, "")}/orca`;
    if (!exe(cand)) { ctx.err(`orca_cli_unavailable: no executable orca in ${dir}\n`); return null; }
  } else if (exe(`${orcaData(ctx.env)}/cli/bin/orca`)) {
    cand = `${orcaData(ctx.env)}/cli/bin/orca`;
  } else {
    cand = Bun.which("orca", { PATH: ctx.env.PATH ?? "" });
    if (!cand) { ctx.err("orca_cli_unavailable: no executable orca on PATH\n"); return null; }
  }
  ctx.cli = cand;
  return cand;
}

// A loop replay can spend minutes reading/probing before a mutation, so every write rechecks its
// durable eligibility (bin/loop/pause/check-activity.ts) when the loop passed DS_LOOP_ACTIVITY. Reads skip it.
const READS = new Set(["worktree ps", "worktree show", "terminal list", "terminal show", "terminal output", "terminal outputs",
  "account list", "account usage", "account show", "orchestration run-show", "orchestration worker-show",
  "orchestration task-show", "orchestration request-show", "orchestration inbox", "orchestration worker-list",
  "worktree current", "terminal read", "orchestration gate-list", "orchestration task-list", "project list"]);
export function isRead(args: string[]): boolean {
  const sub = `${args[0] ?? ""} ${args[1] ?? ""}`;
  return READS.has(sub) || args[0] === "status" || sub.startsWith("terminal wait") || sub.startsWith("agent-context ");
}

/** A call that leaves Orca as it was: a read, or a `check` that does not mark read (`--peek`, `--all`: Orca's help says
 *  `--all` "does not mark read"). Anything else drops the tick's shared copies. */
const isReadOnly = (args: string[]): boolean => isRead(args) || args.includes("--peek")
  || (`${args[0]} ${args[1]}` === "orchestration check" && args.includes("--all"));

export type Call = { code: number; out: string; outBytes: Uint8Array; err: string };
/** One `orca` call. stderr "pass" goes to the verb's stderr (the shell's default), "drop" is `2>/dev/null`,
 *  "keep" returns it apart in `err`, "merge" interleaves it into `out` as written (the shell's `2>&1` into a
 *  variable: one pipe, so the order holds). */
type Stderr = "pass" | "drop" | "keep" | "merge";
export async function orca(ctx: Ctx, args: string[], stderr: Stderr = "pass"): Promise<Call> {
  // U244: inside a loop tick (DS_ORCA_TICK_DIR) a read every step shares is made once (orca-cache.ts).
  // U252: in every stderr mode. The shared call keeps its stderr apart (a copy is stdout only: what a successful
  // read printed to stderr is not part of its answer) and this caller's mode is applied to it after.
  const dir = ctx.env.DS_ORCA_TICK_DIR, canon = dir ? canonRead(args) : null;
  if (!dir || !canon) return orcaSpawn(ctx, args, stderr, isReadOnly(args) ? "past" : "write");
  const got = await cachedRead(dir, canon, async () => {
    const r = await orcaSpawn(ctx, canon, "keep", "keyed");
    return { code: r.code, out: r.outBytes, value: r };
  });
  if (got.hit) return { code: 0, out: new TextDecoder().decode(got.out), outBytes: got.out, err: "" };
  const r = got.value as Call;
  if (stderr === "keep") return r;
  if (stderr === "pass" && r.err) ctx.err(r.err);
  if (stderr !== "merge" || !r.err) return { ...r, err: "" };
  const out = r.err + r.out;
  return { code: r.code, out, outBytes: new TextEncoder().encode(out), err: "" };
}

async function orcaSpawn(ctx: Ctx, args: string[], stderr: Stderr, kind: SpawnKind = "write"): Promise<Call> {
  const call = await orcaSpawnRaw(ctx, args, stderr, kind);
  const tick = ctx.env.DS_ORCA_TICK_DIR;
  if (tick && !isReadOnly(args)) {
    const runs = runsOfWrite(args, [tick, ctx.env.DS_ORCA_KEEP_DIR]);
    countDrop(ctx.env, args, runs === null);
    dropCached(tick, ctx.env.DS_ORCA_KEEP_DIR, runs ?? undefined);
  }
  return call;
}

async function orcaSpawnRaw(ctx: Ctx, args: string[], stderr: Stderr, kind: SpawnKind): Promise<Call> {
  const fail = (code: number, err: Uint8Array): Call => {
    if (stderr === "pass") ctx.err(err);
    if (stderr === "merge") return { code, out: new TextDecoder().decode(err), outBytes: err, err: "" };
    return { code, out: "", outBytes: new Uint8Array(), err: stderr === "keep" ? new TextDecoder().decode(err) : "" };
  };
  if (ctx.env.DS_LOOP_ACTIVITY && !isRead(args)) {
    const bun = Bun.which("bun", { PATH: ctx.env.PATH ?? "" }) || process.execPath;
    const f = await spawn(ctx, [bun, join(HERE, "..", "loop", "pause", "check-activity.ts")]);
    if (f.code !== 0) return fail(f.code, f.err);
  }
  let cli = ctx.cli;
  if (!cli) {
    const msgs: Uint8Array[] = [];
    cli = resolveOrcaCli({ ...ctx, err: (b) => msgs.push(typeof b === "string" ? new TextEncoder().encode(b) : b) });
    if (!cli) return fail(1, Buffer.concat(msgs));
    ctx.cli = cli;
  }
  // U254 spike (off by default): a read served by the long-lived helper that keeps Orca's CLI loaded.
  if (orcaClientOn()) {
    const r = await clientRead(cli, args, ctx.env);
    if (r) {
      countSpawn(ctx.env, ["client", ...args], ctx.op ?? "", kind);
      const s = streams(r);
      if (stderr === "pass") ctx.err(s.err);
      const out = stderr === "merge" ? s.merged : s.out;
      return { code: r.code, out, outBytes: new TextEncoder().encode(out), err: stderr === "keep" ? s.err : "" };
    }
  }
  countSpawn(ctx.env, args, ctx.op ?? "", kind);
  const r = await spawn(ctx, stderr === "merge" ? ["/bin/sh", "-c", 'exec "$@" 2>&1', "sh", cli, ...args] : [cli, ...args]);
  if (stderr === "pass") ctx.err(r.err);
  return { code: r.code, out: new TextDecoder().decode(r.out), outBytes: r.out, err: stderr === "keep" ? new TextDecoder().decode(r.err) : "" };
}

// --- shared readers (the jq defs later groups reuse) ----------------------------------------------
/** entity_id: the entity id of an orca answer. Accepts both the --full shapes (.result.run.id,
 *  .task.id, .gate.id, …) and the COMPACT ones Orca 1.4.246 prints by default for --json (.result.runId,
 *  .taskId, .gateId). Compact order is most-specific first: a gate also carries its taskId, and a task
 *  may name its runId. Prints what `jq -r` printed (one line per document; nothing when absent). */
export function entityId(text: string): string[] {
  const out: string[] = [];
  for (const d of docs(text)) {
    const v = entityOf(d);
    if (truthy(v)) out.push(raw(v));
  }
  return out;
}
/** entity_id of one answer (null when it names none). */
export function entityOf(d: unknown): any {
  const r = idx(d, "result");
  return or(() => idx(idx(r, "run"), "id"), () => idx(idx(r, "task"), "id"), () => idx(idx(r, "worktree"), "id"),
    () => idx(idx(r, "resource"), "worktreeId"), () => idx(r, "worktreeId"), () => idx(idx(r, "gate"), "id"), () => idx(r, "gateId"),
    () => idx(r, "taskId"), () => idx(r, "runId"), () => idx(r, "id"));
}

/** (U216) A worker-list row's worktree. A supervised dispatch carries it in .resource.worktreeId; an
 *  injected (unsupervised) one, such as the dispatch Orca makes on a rebind, has resource: null and
 *  carries it only in .projection.workspace.id. Every reader of worker-list selects through this one
 *  function, so a rebound member is seen by run-workers, pause, stop, release and the terminal reap alike. */
export function wtOf(row: unknown): any {
  return or(() => idx(idx(row, "resource"), "worktreeId"), () => idx(idx(idx(row, "projection"), "workspace"), "id"), () => "");
}

/** merged_ps: worktree ps JSON merged across the default host and the omitted hosts (R8), the single
 *  source for every state read, so a squad spawned with --host <saved-env> isn't reported GONE on every
 *  tick (its remote workers live on an omitted host). strict: a failed ps of any host fails here (null),
 *  for a caller that acts on what is NOT listed. Throws JqError when a host's answer is not JSON. */
export async function mergedPs(ctx: Ctx, strict = false): Promise<{ result: { worktrees: any[] } } | null> {
  const okShape = (text: string): boolean => {
    try {
      const ds = docs(text);
      return ds.length > 0 && ds.every((d) => idx(d, "ok") !== false && Array.isArray(idx(idx(d, "result"), "worktrees")));
    } catch { return false; }
  };
  const p = await orca(ctx, ["worktree", "ps", "--json", "--limit", "1000"], "drop");
  let primary = p.out;
  if (p.code !== 0) { if (strict) return null; primary = "{}"; }
  if (strict && !okShape(primary)) return null;
  // One selector per line; a selector like "--host saved:env1" is split into words for the call.
  let selectors: string[] = [];
  try {
    for (const d of docs(primary)) for (const h of each(idx(idx(idx(d, "result"), "hostScope"), "omittedHostSelectors"))) {
      const s = idx(h, "selector");
      if (truthy(s)) selectors.push(...raw(s).split("\n"));
    }
  } catch { selectors = []; }
  const texts = [primary];
  for (const sel of selectors) {
    if (sel === "") continue;
    const r = await orca(ctx, ["worktree", "ps", "--json", "--limit", "1000", ...sel.split(/[ \t\n]+/).filter(Boolean)], "drop");
    let remote = r.out;
    if (r.code !== 0) { if (strict) return null; remote = "{}"; }
    if (strict && !okShape(remote)) return null;
    texts.push(remote);
  }
  const worktrees: any[] = [];
  for (const t of texts) for (const d of docs(t)) worktrees.push(...each(idx(idx(d, "result"), "worktrees")));
  return { result: { worktrees } };
}

/** agent_terminal: the handle of the worktree's live agent terminal (connected, writable, not orphaned,
 *  an agent running in it), newest output first; "" when there is none. */
export async function agentTerminal(ctx: Ctx, wt: string): Promise<string> {
  const r = await orca(ctx, ["terminal", "list", "--limit", "1000", "--json"], "drop");
  return jqr(r.out, (d, emit) => {
    const ts = each(idx(idx(d, "result"), "terminals")).filter((t) => idx(t, "worktreeId") === wt && isAgent(t));
    // sort_by is stable and `last` takes the last of equals: the newest output wins, ties to the later row.
    some(emit, idx(sortBy(ts, (t) => or(() => idx(t, "lastOutputAt"), () => 0)).at(-1) ?? null, "handle"));
  });
}
/** agent_terminal's selector, field by field in jq's order: an agent runs in it, connected, writable, not orphaned. */
function isAgent(t: unknown): boolean {
  return idx(t, "agentIdentity") !== null && idx(t, "connected") === true && idx(t, "writable") !== false && idx(t, "orphaned") !== true;
}

/** cmd_screen_tail: the rendered bottom of the worktree's agent terminal, as `jq -r` printed it. A
 *  terminal handle (`term_…`, U261: the adopted Studio's) is read as itself, whatever else runs in its
 *  worktree; a read changes nothing on that terminal. */
export async function screenTail(ctx: Ctx, wt: string): Promise<string> {
  const h = wt.startsWith("term_") ? wt : await agentTerminal(ctx, wt);
  return h ? (await readScreen(ctx, h)).text : "";
}
async function readScreen(ctx: Ctx, h: string): Promise<{ ok: boolean; text: string }> {
  const r = await orca(ctx, ["terminal", "read", "--terminal", h, "--screen", "--json"], "drop");
  const j = jq(r.out, (d, emit) => { for (const v of each(idx(idx(idx(d, "result"), "terminal"), "tail"))) emit(v); });
  return { ok: r.code === 0 && j.code === 0, text: rawLines(j.vals) };
}

/** U264: the screens `limited` read, kept between its runs inside the loop (DS_ORCA_TICK_DIR; the loop's accounts
 *  refresh runs it about once a minute) in `loop/limited-screens.json` beside the tick's directory. A worker's screen
 *  is read again only when its terminal, state, state time or last output changed, or DS_LIMITED_REREAD_S (300)
 *  passed since it was read; a silent worker's screen does not change. Outside the loop every run reads every screen. */
type Screens = { file: string; at: number; every: number; was: Record<string, { key: string; at: number; screen: string }>; now: Record<string, { key: string; at: number; screen: string }> };
function screensOpen(env: Env): Screens | null {
  const tick = env.DS_ORCA_TICK_DIR;
  if (!tick) return null;
  const file = join(dirname(tick), "limited-screens.json"), v = Number(env.DS_LIMITED_REREAD_S);
  let was: Screens["was"] = {};
  try { const d = JSON.parse(readFileSync(file, "utf8")); if (d && typeof d === "object" && !Array.isArray(d)) was = d; } catch { /* none kept */ }
  return { file, at: nowS(env), every: env.DS_LIMITED_REREAD_S !== undefined && env.DS_LIMITED_REREAD_S !== "" && Number.isFinite(v) && v >= 0 ? v : 300, was, now: {} };
}
async function keptScreen(ctx: Ctx, wt: string, sig: string, k: Screens | null): Promise<string> {
  if (!k) return screenTail(ctx, wt);
  const h = await agentTerminal(ctx, wt);
  if (!h) return "";
  const key = `${h}|${sig}`, e = k.was[wt];
  if (e && e.key === key && typeof e.screen === "string" && k.at - e.at < k.every) { k.now[wt] = e; return e.screen; }
  const r = await readScreen(ctx, h);
  if (r.ok) k.now[wt] = { key, at: k.at, screen: r.text };
  return r.text;
}
function screensSave(k: Screens | null): void {
  if (!k) return;
  try { const tmp = `${k.file}.${process.pid}`; writeFileSync(tmp, JSON.stringify(k.now)); renameSync(tmp, k.file); } catch { /* a cache is never worth a failed run */ }
}

// --- locks ----------------------------------------------------------------------------------------
// Under the state root, next to this checkout unless DS_STATE_ROOT is set: the same files the shell's
// name_lock used, so a start from an older checkout and this one still take turns.
const root = (env: Env): string => env.DS_ROOT || join(HERE, "..", "..");
const locksRoot = (env: Env): string => `${env.DS_STATE_ROOT || `${root(env)}/state`}/.wt-locks`;
export function lockPath(env: Env, key: string): string {
  let safe = "";
  for (const b of Buffer.from(key, "utf8")) { const c = String.fromCharCode(b); safe += /[A-Za-z0-9._-]/.test(c) ? c : "_"; }
  return `${locksRoot(env)}/${safe}.lock`;
}
const alive = (pid: string): boolean => { try { process.kill(Number(pid), 0); return /^[0-9]+$/.test(pid); } catch { return false; } };

/** name_lock: hold <key>'s lock, a directory holding a file pid.<holder>. Waits for a live holder,
 *  DS_WT_LOCK_WAIT seconds at most (default 120), then false. A dead holder's lock is taken over by
 *  renaming pid.<dead> to pid.<me>: that name is gone after the first rename, so of any number of waiters
 *  exactly one gets it, with no moment the lock is free. A lock with no pid file is a holder between mkdir
 *  and its file; one older than 10 s died there. */
export async function nameLock(ctx: Ctx, key: string): Promise<boolean> {
  const dir = lockPath(ctx.env, key), me = String(process.pid);
  const wait = ctx.env.DS_WT_LOCK_WAIT || "120";
  try { mkdirSync(dirname(dir), { recursive: true }); } catch { ctx.err(`orca adapter: cannot make the lock folder for ${dir}\n`); return false; }
  const pids = (): string[] => { try { return readdirSync(dir).filter((f) => f.startsWith("pid.")); } catch { return []; } };
  const end = Math.floor(Date.now() / 1000) + Number(wait);
  for (;;) {
    if (ctx.signal?.aborted) return false;
    let made = false;
    try { mkdirSync(dir); made = true; } catch { /* held */ }
    if (made) {
      // A waiter that cleared this as an abandoned empty lock may have made it again just now, so
      // another pid file here means two holders: this one steps back and tries again.
      try {
        writeFileSync(`${dir}/pid.${me}`, "");
        if (pids().length <= 1) return true;
        rmSync(`${dir}/pid.${me}`, { force: true });
        await sleep(100 * (Math.floor(Math.random() * 5) + 1));
      } catch { /* gone again: retry */ }
      continue;
    }
    const holder = (pids()[0] ?? "").slice(4);
    if (holder) {
      if (!alive(holder)) {
        try {
          renameSync(`${dir}/pid.${holder}`, `${dir}/pid.${me}`);
          ctx.err(`orca adapter: took over the lock of ${key} from dead pid ${holder}\n`);
          return true;
        } catch { /* another waiter took it */ }
      }
    } else {
      let age = Math.floor(Date.now() / 1000);
      try { age = Math.floor(statSync(dir).mtimeMs / 1000); } catch { /* just went */ }
      if (Math.floor(Date.now() / 1000) - age > 10) { try { rmdirSync(dir); } catch { /* not empty */ } continue; }
    }
    if (Math.floor(Date.now() / 1000) >= end) {
      // "still pending": the actuator keeps the retry id and waits (bin/loop/io/orca.ts inDoubt);
      // "pid N holds its lock": it tries less often and alerts (HOLDER in bin/loop/core/actuator.ts).
      ctx.err(`orca adapter: ${key} is still pending: pid ${holder || "unknown"} holds its lock after ${wait}s\n`);
      return false;
    }
    await sleep(200);
  }
}
export function nameUnlock(env: Env, key: string): void {
  const dir = lockPath(env, key);
  rmSync(`${dir}/pid.${process.pid}`, { force: true });
  try { rmdirSync(dir); } catch { /* another holder's file */ }
}

/** The fields of an Orca worktree the `orca` worktree provider reads (wt-make, wt-show, wt-list). */
// `childWorktreeIds` only when Orca gives it (worktree show does; docs/backends/orca-probe.md): the nesting the
// trial record shows (`ds trial snapshot`, orca-backend-alternatives U16a).
const wtSlim = (w: Record<string, unknown>) => ({ id: w.id ?? null, path: w.path ?? null, branch: w.branch ?? null,
  head: w.head ?? null, parentWorktreeId: w.parentWorktreeId ?? null,
  ...(Array.isArray(w.childWorktreeIds) ? { childWorktreeIds: w.childWorktreeIds as unknown[] } : {}) });
/** `result.worktree` of an Orca JSON answer, slimmed; null when the answer holds none. */
function wtJson(out: string): ReturnType<typeof wtSlim> | null {
  try {
    const w = JSON.parse(out)?.result?.worktree;
    return w && typeof w === "object" && w.id && w.path ? wtSlim(w) : null;
  } catch { return null; }
}

/** wt_create <repo> <name> [parent] [extra args] -> the worktree id. Idempotent: reuses a LIVE worktree
 *  with this displayName (it carries the ds-<label>-<role>-<topic> namespace), never an archived one (a
 *  torn-down ds-<label>-… must not be started back to life). Never matches the repo by the ps row's .path:
 *  that is the worktree's own path, never the repo selector, so it forked a "-2" on every re-up. Otherwise
 *  nested under the parent first (KTD2), top-level when the host rejects the parent. orca's stderr is
 *  not swallowed. The check and the create hold the name's lock, so two runs at once end with one
 *  worktree (a killed loop's adapter child and the restarted loop's replay of the same start). The tree is
 *  Studio > squad Lead > its roles and Builders (bin/loop/drivers/types.ts parentFor, kept by
 *  bin/loop/reconcilers/nesting.ts through wt-set-parent). Returns the id ("" when the create gave none)
 *  and the exit code. */
export type Created = { id: string; printed: string; code: number };
export async function wtCreate(ctx: Ctx, repo: string, name: string, parent: string, extra: string[] = []): Promise<Created> {
  if (!(await nameLock(ctx, name))) return { id: "", printed: "", code: 1 };
  try { return await wtCreateLocked(ctx, repo, name, parent, extra); } finally { nameUnlock(ctx.env, name); }
}
async function wtCreateLocked(ctx: Ctx, repo: string, name: string, parent: string, extra: string[]): Promise<Created> {
  // A failed list is not an empty one: creating then would fork the "-2" of a live worktree.
  let listed: Awaited<ReturnType<typeof mergedPs>> = null;
  try { listed = await mergedPs(ctx, true); } catch { listed = null; }
  if (!listed) { ctx.err(`orca adapter: cannot list worktrees to look for ${name}: the create is still pending\n`); return { id: "", printed: "", code: 1 }; }
  let hit = "";
  for (const w of listed.result.worktrees) {   // (confirm@host: displayName/isArchived)
    try {
      if (idx(w, "displayName") === name && !truthy(alt(idx(w, "isArchived"), false))) { hit = raw(idx(w, "worktreeId")).split("\n")[0]; break; }
    } catch { break; }   // jq stopped at a row it could not read
  }
  if (hit) return { id: hit, printed: hit, code: 0 };
  // The shell printed a reused or nested id bare, a top-level create's as `jq -r` did (newline-ended).
  const idOf = (out: string, bare: boolean): Created => {
    try {
      const ids = entityId(out);
      return { id: ids.join("\n"), printed: bare ? ids.join("\n") : ids.map((l) => l + "\n").join(""), code: 0 };
    } catch (e) { return { id: "", printed: "", code: jqFail(ctx, e) }; }
  };
  if (parent) {
    // Only fall back to top-level when the nested create COMMAND failed. If it succeeded but we
    // couldn't read an id, do NOT re-create (that orphans a second same-named worktree).
    const n = await orca(ctx, ["worktree", "create", "--repo", repo, "--parent-worktree", `worktree:${parent}`, "--name", name, ...extra, "--json"]);
    if (n.code === 0) {
      const made = idOf(n.out, true);
      if (made.id) return made;
      ctx.err(`orca adapter: nested create for '${name}' succeeded but returned no id; output: ${chomp(n.out)}\n`);
      return { id: "", printed: "", code: 1 };
    }
    ctx.err(`orca adapter: nested worktree create rejected, retrying top-level (name=${name})\n`);
  }
  const t = await orca(ctx, ["worktree", "create", "--repo", repo, "--name", name, ...extra, "--json"]);
  return idOf(t.code === 0 ? t.out : "", false);
}

// --- accounts -------------------------------------------------------------------------------------
/** claude_accounts: "<id>\t<label>" per Claude account, the default login first: every host profile
 *  Orca manages plus the system login (`system`). Just the system login when Orca lists none. */
export async function claudeAccounts(ctx: Ctx): Promise<string[]> {
  const r = await orca(ctx, ["account", "list", "--json"], "drop");
  const rows: string[] = [];
  if (r.code === 0) {
    try {
      for (const d of docs(r.out)) {
        const c = alt(idx(idx(d, "result"), "claude"), {});
        const def = alt(alt(idx(idx(c, "activeAccountIdsByRuntime"), "host"), idx(c, "activeAccountId")), "system");
        const email = idx(c, "systemDefaultEmail");
        const list: { id: any; label: any }[] = [{ id: "system", label: "system login" + (truthy(email) ? ` (${interp(email)})` : "") }];
        for (const a of each(alt(idx(c, "accounts"), []))) {
          if (alt(idx(a, "managedAuthRuntime"), "host") !== "host") continue;
          list.push({ id: idx(a, "id"), label: alt(idx(a, "email"), idx(a, "organizationName"), idx(a, "id")) });
        }
        const same = (x: unknown) => JSON.stringify(x) === JSON.stringify(def);
        for (const a of [...list.filter((a) => same(a.id)), ...list.filter((a) => !same(a.id))]) {
          if (typeof a.label !== "string") throw new JqError(`${jqType(a.label)} cannot be matched, as it is not a string`);
          rows.push(`${interp(a.id)}\t${a.label.replace(/[\t\n]/g, " ")}`);
        }
      }
    } catch (e) { if (!(e instanceof JqError)) throw e; }
  }
  const out = chomp(rows.map((l) => l + "\n").join(""));
  return out ? out.split("\n") : ["system\tsystem login"];
}

/** agent_accounts: the `agent-accounts` verb, from $DS_PROC (default /proc). A top-level agent (no agent
 *  above it in its parent chain) is its member's own agent and prints a main line,
 *  "<cwd>\tmain\t<agent>\t<model>\t<account>\t<effort>\t<pid>\t<start>\t<rss>" (U149: its --model and
 *  --effort flags, pid, start in epoch seconds and RSS in kB, each "-" when unread). Any other agent
 *  process prints a sub line, "<cwd>\tsub\t<agent>\t<model>\t<account>[\t<effort>]" (U105: the effort only
 *  when it has one). A headless `claude -p` (U98) and a headless codex (`codex exec`, `codex app-server`,
 *  U152) are always sub lines; a claude without -p under another claude is skipped (the top claude is the
 *  member's own agent), and so is a process whose environ (a claude's account) or cwd can't be read.
 *  Muse's versioned binary (comm "muse-bin-<version>") is muse. Lines come in pid order (the shell's came
 *  in bash's hash order); everything is read and printed as bytes. */
export function agentAccounts(env: Env): string {
  const proc = env.DS_PROC || "/proc";
  const sys = bytes(claudeSys(env)).replace(/\/$/, "");
  const data = bytes(orcaData(env));
  const read = (f: string): string | null => { try { return latin1(readFileSync(f)); } catch { return null; } };
  /** `read -r v < f`: the first line, ends trimmed; null when there is no full line. */
  const readLine = (f: string): string | null => {
    const t = read(f);
    if (t === null || !t.includes("\n")) return null;
    return t.slice(0, t.indexOf("\n")).replace(/^[ \t]+|[ \t]+$/g, "");
  };
  const readable = (f: string): boolean => { try { accessSync(f, constants.R_OK); return true; } catch { return false; } };
  const comm = new Map<string, string>(), parent = new Map<string, string>(), stat = new Map<string, string>();
  let entries: string[] = [];
  try { entries = readdirSync(proc).filter((n) => /^[0-9]/.test(n)); } catch { /* no table */ }
  for (const pid of entries) {
    let c = readLine(`${proc}/${pid}/comm`);
    const line = c === null ? null : readLine(`${proc}/${pid}/stat`);
    if (c === null || line === null) continue;
    let rest = line.includes(") ") ? line.slice(line.lastIndexOf(") ") + 2) : line;   // after the comm: state ppid pgrp …
    if (rest.includes(" ")) rest = rest.slice(rest.indexOf(" ") + 1);
    if (c.startsWith("muse-")) c = "muse";
    comm.set(pid, c);
    parent.set(pid, rest.includes(" ") ? rest.slice(0, rest.indexOf(" ")) : rest);
    if (c === "claude" || c === "muse" || c === "codex") stat.set(pid, rest);
  }
  // A main's start time is the boot time plus stat field 22 (clock ticks since boot); its RSS is field 24
  // (pages). No btime in the process table's stat (a fake /proc): start reads "-".
  const btime = (read(`${proc}/stat`) ?? "").split("\n").map((l) => l.trim().split(/[ \t]+/)).find((f) => f[0] === "btime")?.[1] ?? "";
  let tck = 0, page = 0;
  const conf = () => {
    if (tck) return;
    const t = spawnSync(["getconf", "CLK_TCK"], env), p = spawnSync(["getconf", "PAGESIZE"], env);
    tck = Number(t.code === 0 ? chomp(t.out) : "100") || 100; page = Number(p.code === 0 ? chomp(p.out) : "4096") || 4096;
  };
  const isAgent = (c: string | undefined) => c === "claude" || c === "muse" || c === "codex";
  const argLines = (pid: string): string[] | null => {
    const f = `${proc}/${pid}/cmdline`;
    if (!readable(f)) return null;
    const t = read(f);
    return t === null ? null : t.replace(/\0/g, "\n").split("\n");
  };
  const flag = (argv: string[], name: string): string => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${name}`) return argv[i + 1] ?? "";
      if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
    }
    return "";
  };
  const out: string[] = [];
  for (const pid of [...comm.keys()].sort((a, b) => Number(a) - Number(b))) {
    const c = comm.get(pid)!;
    if (!isAgent(c)) continue;
    // The agents above this one: the first decides main vs sub, while a claude with any claude above it
    // stays skipped.
    let p = parent.get(pid) || "0", first = "", anyclaude = false;
    while (/^-?[0-9]+$/.test(p) && Number(p) > 1 && comm.get(p)) {
      const pc = comm.get(p)!;
      if (isAgent(pc)) { if (!first) first = pc; if (pc === "claude") anyclaude = true; }
      p = parent.get(p) || "0";
    }
    const al = argLines(pid);
    let isp = false;
    if (c === "claude" && al && al.includes("-p")) isp = true;
    if (c === "codex" && al && al.length > 1 && (al[1] === "exec" || al[1] === "app-server")) isp = true;
    if (!isp && c === "claude" && anyclaude) continue;
    let acct: string;
    if (c === "claude") {
      const envf = `${proc}/${pid}/environ`;
      if (!readable(envf)) continue;
      const e = read(envf);
      if (e === null) continue;
      let cfg = "";
      for (const kv of e.split("\0").slice(0, -1)) if (kv.startsWith("CLAUDE_CONFIG_DIR=")) cfg = kv.slice(18);
      cfg = cfg.replace(/\/$/, "");
      const pre = `${data}/claude-profiles/`;
      if (cfg === "" || cfg === sys) acct = "system";
      else if (cfg.startsWith(pre) && cfg.length >= pre.length + 5 && cfg.endsWith("/home")) acct = cfg.slice(pre.length, -5);
      else continue;
      if (acct === "" || acct.includes("/")) continue;
    } else acct = "default";   // muse and codex have one login each (see account-list)
    let cwd: string;
    try { cwd = latin1(readlinkSync(`${proc}/${pid}/cwd`, { encoding: "buffer" })).replace(/\n+$/, ""); } catch { continue; }
    const argv = (al ?? []).join("\n").replace(/\n+$/, "").split("\n");
    const model = flag(argv, "model"), effort = flag(argv, "effort");
    if (!first && !isp) {
      const st = (stat.get(pid) ?? "").trim().split(/[ \t\n]+/);
      let start = "-", rss = "-";
      if (/^[0-9]+$/.test(btime) && /^[0-9]+$/.test(st[18] ?? "")) { conf(); start = String(Number(btime) + Math.floor(Number(st[18]) / tck)); }
      if (/^[0-9]+$/.test(st[20] ?? "")) { conf(); rss = String(Math.floor(Number(st[20]) * page / 1024)); }
      out.push(`${cwd}\tmain\t${c}\t${model || "-"}\t${acct}\t${effort || "-"}\t${pid}\t${start}\t${rss}\n`);
    } else {
      out.push(`${cwd}\tsub\t${c}\t${model || "-"}\t${acct}${effort ? `\t${effort}` : ""}\n`);
    }
  }
  return out.join("");
}

// account-usage: per Claude account, the (undocumented, rate-limited) endpoint Orca's own credits poll
// uses, with the account's OAuth token from <home>/.credentials.json (claudeAiOauth.accessToken). Never
// refreshes a token (that rotates the login). One call per account per DS_USAGE_TTL_S (a host-wide cache
// shared by every project's sweep); a failure (no token, expired, 429, network) is cached too and prints
// `-`, never "exhausted".
/** account_home: an account's Claude config dir; `system` is the default login. */
const accountHome = (env: Env, id: string): string => id === "system" ? claudeSys(env) : `${orcaData(env)}/claude-profiles/${id}/home`;
/** iso_epoch: an ISO string or epoch s/ms as epoch s, "-" when unknown. */
function isoEpoch(env: Env, v: string): string {
  if (v === "" || v === "-" || v === "null") return "-";
  if (/[^0-9.]/.test(v)) { const d = spawnSync(["date", "-d", v, "+%s"], env); return d.code === 0 ? chomp(d.out) : "-"; }
  let n = v.split(".")[0];
  if (n.length > 11) n = String(Math.trunc(Number(n) / 1000));
  return n;
}
const pct = (v: unknown): string => typeof v === "number" ? String(Math.round(Math.min(Math.max(v, 0), 100))) : "-";
const tsv = (fs: string[]): string => fs.map((f) => f.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r")).join("\t");
/** The User-Agent the usage call presents. The free-reset grants come back only to Claude Code's own CLI
 *  User-Agent; an older or foreign one answers `ineligible_reason: "surface"`, which reads as unknown (a
 *  stale pin shows `?`, never 0). Pinned here; DS_CLAUDE_CLI_UA replaces the whole string. */
const CLAUDE_CLI_UA = "claude-cli/2.1.326 (external, cli)";
/** A provider's window names -> the generic words a grant refills (anything else is kept as its own word). */
const CLAUDE_REFILLS: Record<string, string> = {
  five_hour: "session", seven_day: "weekly",
  seven_day_overage_included: "weekly_model", seven_day_opus: "weekly_model", seven_day_sonnet: "weekly_model",
};
/** An ISO time or epoch s/ms as epoch s; null when absent or unreadable. */
function epochOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v > 1e11 ? v / 1000 : v);
  if (typeof v !== "string" || v === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
/** The generic free-resets shape (conventions/backend.md `account-resets`) from a Claude usage answer's
 *  `cedar_ember`. No `cedar_ember`, `eligible:false` or a malformed one is `unknown` (with a reason when
 *  there is one), never `reported` with 0. Throws nothing. */
export function claudeResets(d: unknown, now: number): Record<string, unknown> {
  const unknown = (reason?: string) => reason ? { state: "unknown", reason, at: now } : { state: "unknown", at: now };
  const c = isObj(d) ? d.cedar_ember : undefined;
  if (!isObj(c)) return unknown();
  if (c.eligible !== true) return unknown(typeof c.ineligible_reason === "string" && c.ineligible_reason ? c.ineligible_reason : "ineligible");
  if (!Array.isArray(c.grants)) return unknown("malformed");
  const grants: Record<string, unknown>[] = [];
  for (const g of c.grants) {
    if (!isObj(g) || typeof g.id !== "string" || g.id === "") return unknown("malformed");
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
    const refills = [...new Set((Array.isArray(g.clears) ? g.clears : []).filter((x: unknown) => typeof x === "string").map((x: string) => CLAUDE_REFILLS[x] ?? x))];
    grants.push({
      id: g.id, label: typeof g.label === "string" && g.label ? g.label : g.id,
      left: num(g.resets_left), total: num(g.resets_total), use_by: epochOf(g.ends_at),
      refills, usable_now: g.usable_now === true && g.paused !== true,
    });
  }
  const count = grants.reduce((n, g) => n + (typeof g.left === "number" ? g.left : 0), 0);
  return { state: "reported", count, grants, at: now };
}
/** usage_fetch: `row` is "<session_pct>\t<session_reset>\t<weekly_pct>\t<weekly_reset>[\t<note>]". `expired`
 *  = the token's own expiresAt has passed (or a 401 on a file with no expiresAt): WHY usage is unknown;
 *  nothing is done about it — the token refreshes the next time Claude runs on that account. A 401 on a
 *  token that has not expired by its own expiresAt is `refused` (the endpoint said no; the login is fine).
 *  `resets` is the account's free-resets JSON from the same answer, or null when there was no readable
 *  answer (the last one read stays). */
/** An account's OAuth access token and its expiresAt (ms, "" when absent) from `<home>/.credentials.json`;
 *  `tok` is "" when there is none. */
function claudeToken(home: string): { tok: string; exp: string } {
  let cred: any;
  try { cred = docs(readFileSync(`${home}/.credentials.json`, "utf8"))[0]; } catch { cred = undefined; }
  let tok = "", exp = "";
  try { const t = idx(idx(cred, "claudeAiOauth"), "accessToken"); tok = truthy(t) ? raw(t) : ""; } catch { tok = ""; }
  try { const x = idx(idx(cred, "claudeAiOauth"), "expiresAt"); exp = truthy(x) ? raw(x) : ""; } catch { exp = ""; }
  return { tok, exp };
}
const tokenExpired = (exp: string, now: number): boolean => isNum(exp) && !(Math.floor(Number(exp) / 1000) > now);
/** One Claude API call with an account's token: curl with the token on stdin (`-K -`, never in argv where
 *  `ps` shows it), the oauth beta header and the CLI User-Agent. `code` is the HTTP status, "000" when
 *  no answer came (curl could not connect, timed out, or did not run). */
async function claudeCurl(ctx: Ctx, tok: string, url: string, extra: string[], secs: number): Promise<{ code: string; body: string }> {
  const r = await spawn(ctx, ["curl", "-sS", "--max-time", String(secs), "-K", "-", "-H", "anthropic-beta: oauth-2025-04-20",
    "-H", `User-Agent: ${ctx.env.DS_CLAUDE_CLI_UA || CLAUDE_CLI_UA}`, ...extra, "-w", "\n%{http_code}", url], { stdin: `header = "Authorization: Bearer ${tok}"\n` });
  const out = chomp(new TextDecoder().decode(r.out));
  const nl = out.lastIndexOf("\n");
  const code = nl < 0 ? out : out.slice(nl + 1), body = nl < 0 ? out : out.slice(0, nl);
  return { code: /^[1-5][0-9][0-9]$/.test(code) ? code : "000", body };
}
async function usageFetch(ctx: Ctx, home: string): Promise<{ row: string; resets: string | null }> {
  const unknown = "-\t-\t-\t-", expired = "-\t-\t-\t-\texpired", refused = "-\t-\t-\t-\trefused", now = nowS(ctx.env);
  const only = (row: string) => ({ row, resets: null });
  const { tok, exp } = claudeToken(home);
  if (!tok) return only(unknown);
  if (tokenExpired(exp, now)) return only(expired);
  // `cedar_ember=1` adds the free-reset grants to the same answer (`skip_spend=1`: no spend figures); the
  // five_hour/seven_day figures are the same either way.
  const base = ctx.env.DS_USAGE_URL || "https://api.anthropic.com/api/oauth/usage";
  const url = `${base}${base.includes("?") ? "&" : "?"}cedar_ember=1&skip_spend=1`;
  const { code, body } = await claudeCurl(ctx, tok, url, [], 10);
  if (code === "401") return only(isNum(exp) ? refused : expired);
  if (code !== "200") return only(unknown);
  let fields: string[], first: unknown;
  try {
    const ds = docs(body);
    first = ds[0];
    const rows = ds.map((d) => {
      const p = (w: unknown) => isObj(w) ? pct(alt(idx(w, "utilization"), idx(w, "used_percentage"))) : "-";
      const rs = (w: unknown) => isObj(w) && idx(w, "resets_at") !== null ? interp(idx(w, "resets_at")) : "-";
      const fh = idx(d, "five_hour"), sd = idx(d, "seven_day");
      return tsv([p(fh), rs(fh), p(sd), rs(sd)]);
    });
    if (!rows.length) return only(unknown);
    fields = readTabs(rows[0], 4);
  } catch { return only(unknown); }
  const [s, sr, w, wr] = fields.map((f) => f || "-");
  return { row: `${s}\t${isoEpoch(ctx.env, sr)}\t${w}\t${isoEpoch(ctx.env, wr)}`, resets: JSON.stringify(claudeResets(first, now)) };
}
/** A cached row is fresh when younger than the TTL and no window in its first line has reset since (a
 *  pre-reset 97% must not keep an account blocked for the rest of the TTL). */
function cached(f: string, ttl: number, now: number, failTtl?: number): string | null {
  try {
    const age = now - Math.floor(statSync(f).mtimeMs / 1000);
    if (age >= ttl) return null;
    const text = readFileSync(f, "latin1");
    const first = text === "" ? null : text.split("\n")[0].split("\t");
    // A failed check (a note, or no figures at all) is retried sooner than a good answer is refreshed.
    if (failTtl !== undefined && age >= failTtl && first && (/^(refused|stale)/.test(first[4] ?? "") || first.slice(0, 4).every((x) => x === "-"))) return null;
    const past = (x: string | undefined) => isNum(x) && Number(x) <= now;
    if (first && (past(first[1]) || past(first[3]))) return null;
    return chomp(text);
  } catch { return null; }
}
/** A refused or failed check keeps the last good figures from the cache file (whatever its age), marked
 *  `<note>@<epoch of those figures>`; a window that has reset since is blanked. No good figures: the row as is. */
function keepStale(f: string, row: string, now: number): string {
  const fields = row.split("\t");
  const note = fields[4] ?? "stale";
  if (fields[4] !== "refused" && !(fields.length === 4 && fields.every((x) => x === "-"))) return row;
  let prev: string[];
  let at: number;
  try { prev = readFileSync(f, "latin1").split("\n")[0].split("\t"); at = Math.floor(statSync(f).mtimeMs / 1000); } catch { return row; }
  if (prev.length < 4) return row;
  const m = /^(?:refused|stale)@(\d+)$/.exec(prev[4] ?? "");
  if (m) at = Number(m[1]);
  else if (prev[4]) return row;
  const win = (p: string, r: string): [string, string] => isNum(r) && Number(r) <= now ? ["-", "-"] : [p, r];
  const [s, sr] = win(prev[0], prev[1]), [w, wr] = win(prev[2], prev[3]);
  if (![s, w].some((x) => isNum(x))) return row;
  return `${s}\t${sr}\t${w}\t${wr}\t${note}@${at}`;
}
function cache(f: string, row: string, enc: BufferEncoding = "latin1"): void {
  const tmp = `${f}.${process.pid}`;
  try { writeFileSync(tmp, row, enc); renameSync(tmp, f); } catch { rmSync(tmp, { force: true }); }
}
/** muse_usage: the Muse row, from `muse usage --json` (no model turn, no quota), same cache and TTL.
 *  `reason == "server_sent_no_usage"` is a normal state (a new window, before first use): `-` numbers plus
 *  the note "no usage yet in this window", never 0% used. `reason == "no_allowance"` (billing not set up
 *  or failed) is `-` numbers plus the generic note "out of credits", which the loop holds the account on
 *  (bin/loop/capacity/credits.ts; provider words stay here). Any other failure prints NO row (usage stays
 *  unknown, never exhausted) plus one stderr line, and the miss is cached (an empty file). */
async function museUsage(ctx: Ctx, dir: string, ttl: number, now: number): Promise<string> {
  if (!Bun.which("muse", { PATH: ctx.env.PATH ?? "" })) return "";
  const f = `${dir}/muse-default.tsv`;
  let row = cached(f, ttl, now);
  if (row === null) {
    row = "";
    const r = await spawn(ctx, ["muse", "usage", "--json"]);
    if (r.code === 0) {
      try {
        const rows: string[] = [];
        for (const d of docs(new TextDecoder().decode(r.out))) {
          const rst = (v: unknown) => typeof v === "number" ? String(Math.floor(v / 1000)) : "-";
          if (idx(d, "schemaVersion") === 1 && idx(d, "reason") === "server_sent_no_usage") rows.push(tsv(["-", "-", "-", "-", "no usage yet in this window"]));
          if (idx(d, "schemaVersion") === 1 && idx(d, "reason") === "no_allowance") rows.push(tsv(["-", "-", "-", "-", "out of credits"]));
          if (idx(d, "schemaVersion") === 1 && idx(d, "reason") === null && isObj(idx(d, "allowance"))) {
            const a = idx(d, "allowance");
            rows.push(tsv([pct(idx(idx(a, "window"), "usedPercent")), rst(idx(idx(a, "window"), "resetsAtMs")),
              pct(idx(idx(a, "weekly"), "usedPercent")), rst(idx(idx(a, "weekly"), "resetsAtMs"))]));
          }
        }
        row = rows.join("\n");
      } catch { row = ""; }
    }
    if (!row) ctx.err("orca adapter: muse usage unavailable (no login, error, or unexpected output); no muse row\n");
    cache(f, row);
  }
  return row ? `muse\tdefault\t${row}\n` : "";
}
/** The free-resets shape (conventions/backend.md `account-resets`) from codex app-server's
 *  `rateLimitResetCredits`. `credits: null` is a count with no detail rows (an empty list); the count is
 *  `availableCount` (the backend may cap the list). Absent or malformed is `unknown`. Throws nothing. */
export function codexResets(s: unknown, now: number): Record<string, unknown> {
  const unknown = (reason?: string) => reason ? { state: "unknown", reason, at: now } : { state: "unknown", at: now };
  if (!isObj(s)) return unknown();
  if (typeof s.availableCount !== "number" || !Number.isFinite(s.availableCount)) return unknown("malformed");
  if (s.credits !== null && s.credits !== undefined && !Array.isArray(s.credits)) return unknown("malformed");
  const grants: Record<string, unknown>[] = [];
  for (const c of Array.isArray(s.credits) ? s.credits : []) {
    if (!isObj(c) || typeof c.id !== "string" || c.id === "") return unknown("malformed");
    const label = [c.title, c.description].find((x) => typeof x === "string" && x !== "");
    const kind = typeof c.resetType === "string" ? c.resetType : "unknown";
    const avail = c.status === "available";
    grants.push({
      id: c.id, label: label ?? c.id, left: avail ? 1 : 0, total: 1, use_by: epochOf(c.expiresAt),
      refills: kind === "codexRateLimits" ? ["session", "weekly"] : [kind], usable_now: avail,
    });
  }
  return { state: "reported", count: Math.max(0, Math.floor(s.availableCount)), grants, at: now };
}
/** The rate-limits read (codexCall's `account/rateLimits/read`): its result, or null on any failure. */
async function codexRead(ctx: Ctx, cwd: string): Promise<unknown> {
  const r = await codexCall(ctx, cwd, "account/rateLimits/read");
  return r && "result" in r ? r.result ?? null : null;
}
/** One JSON-RPC exchange with `codex app-server` (stdio, one JSON object per line): initialize, the
 *  initialized notification, then `method` (with `params` when given). `{result}` or, for a JSON-RPC error,
 *  `{error: <its message>}`; null when no answer came (cannot start, exits, no answer within
 *  DS_CODEX_USAGE_TIMEOUT_S, default 15). stdin stays open until the answer (app-server exits on EOF
 *  without answering); the process is killed after. Its cwd is the usage cache dir, so the process walk
 *  never pins it on a role worktree (U152). */
type CodexAnswer = { result: unknown } | { error: string } | null;
async function codexCall(ctx: Ctx, cwd: string, method: string, params?: Record<string, unknown>): Promise<CodexAnswer> {
  if (ctx.signal?.aborted) return null;
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["codex", "app-server"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...ctx.env } as Record<string, string> });
  } catch { return null; }
  const secs = Number(ctx.env.DS_CODEX_USAGE_TIMEOUT_S || "15");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sink = p.stdin as import("bun").FileSink;
  // EOF first (app-server's own way out), then SIGTERM; SIGKILL only if it is still there 2 s later.
  const stop = () => {
    try { sink.end(); } catch { /* closed */ }
    try { p.kill("SIGTERM"); } catch { return; }
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
    t.unref?.();
    void p.exited.then(() => clearTimeout(t));
  };
  ctx.signal?.addEventListener("abort", stop, { once: true });
  const read = (async (): Promise<CodexAnswer> => {
    sink.write([
      { id: 1, method: "initialize", params: { clientInfo: { name: "dev-studio", version: "1" } } },
      { method: "initialized" },
      params ? { id: 2, method, params } : { id: 2, method },
    ].map((m) => `${JSON.stringify(m)}\n`).join(""));
    await sink.flush();
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let m: unknown;
        try { m = JSON.parse(line); } catch { continue; }
        if (!isObj(m) || (m.id !== 1 && m.id !== 2)) continue;   // notifications (configWarning, account/updated, …)
        if (m.error !== undefined) {
          const e = m.error, msg = isObj(e) && typeof e.message === "string" ? e.message : JSON.stringify(e);
          return { error: m.id === 1 ? `initialize: ${msg}` : msg };
        }
        if (m.id === 2) return { result: m.result };
      }
    }
    return null;   // exited without the answer
  })().catch(() => null);
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), secs * 1000); });
  const got = await Promise.race([read, late]);
  clearTimeout(timer);
  ctx.signal?.removeEventListener("abort", stop);
  stop();
  return got;
}
/** codex_usage: the Codex row from one `codex app-server` rate-limits read, with the muse row's cache file
 *  naming and the Claude rows' TTL, fail TTL and keepStale. Each window maps by its length: up to 300
 *  minutes is the session column, longer the weekly one (the free plan's 30-day window reads as weekly).
 *  The same answer writes `codex-default.resets.json` (read by `account-resets`); a failure leaves it. No
 *  figures at all prints no row (unknown, never exhausted) plus one stderr line. */
async function codexUsage(ctx: Ctx, dir: string, ttl: number, failTtl: number, now: number): Promise<string> {
  if (!Bun.which("codex", { PATH: ctx.env.PATH ?? "" })) return "";
  const f = `${dir}/codex-default.tsv`;
  let row = cached(f, ttl, now, failTtl);
  if (row === null) {
    const res = await codexRead(ctx, dir);
    let fresh = "-\t-\t-\t-";
    const rl = isObj(res) ? res.rateLimits : undefined;
    if (isObj(rl)) {
      const cols: Record<"session" | "weekly", [string, string] | undefined> = { session: undefined, weekly: undefined };
      for (const [k, dflt] of [["primary", "session"], ["secondary", "weekly"]] as const) {
        const w = rl[k];
        if (!isObj(w)) continue;
        const mins = w.windowDurationMins;
        const slot = typeof mins === "number" ? (mins <= 300 ? "session" : "weekly") : dflt;
        const at = epochOf(w.resetsAt);
        cols[slot] ??= [pct(w.usedPercent), at === null ? "-" : String(at)];
      }
      const [s, sr] = cols.session ?? ["-", "-"], [w, wr] = cols.weekly ?? ["-", "-"];
      fresh = `${s}\t${sr}\t${w}\t${wr}`;
      cache(`${dir}/codex-default.resets.json`, JSON.stringify(codexResets((res as Record<string, unknown>).rateLimitResetCredits, now)), "utf8");
    }
    row = keepStale(f, fresh, now); cache(f, row);
    if (!isObj(rl)) ctx.err("orca adapter: codex usage unavailable (no login, error, timeout, or unexpected output)\n");
  }
  return row && !/^-\t-\t-\t-$/.test(row) ? `codex\tdefault\t${row}\n` : "";
}
/** The host-wide usage cache dir (shared by every project's loop). */
const usageDir = (env: Env): string => env.DS_USAGE_CACHE || `${env.XDG_CACHE_HOME || `${env.HOME}/.cache`}/dev-studio/account-usage`;
/** Writes each row as it is known, so a stderr line (muse's, codex's) lands after the rows before it. A fetched
 *  Claude answer also writes that account's free resets to `claude-<id>.resets.json` beside the row (read by
 *  `account-resets`); a cached row or a failed fetch leaves that file as it is. The Codex row (and its
 *  `codex-default.resets.json`) comes from one cached `codex app-server` read (codexUsage). */
export async function accountUsage(ctx: Ctx): Promise<void> {
  const env = ctx.env, dir = usageDir(env);
  const ttl = Number(env.DS_USAGE_TTL_S || "300"), failTtl = Number(env.DS_USAGE_FAIL_TTL_S || "60"), now = nowS(env);
  try { mkdirSync(dir, { recursive: true }); } catch { /* cache is best effort */ }
  for (const l of await accountList(ctx)) {
    const [agent, id] = readTabs(l, 3);
    if (agent !== "claude" || !id) continue;
    const f = `${dir}/claude-${id}.tsv`;
    let row = cached(f, ttl, now, failTtl);
    if (row === null) {
      const got = await usageFetch(ctx, accountHome(env, id));
      row = keepStale(f, got.row, now); cache(f, row);
      if (got.resets !== null) cache(`${dir}/claude-${id}.resets.json`, got.resets, "utf8");
    }
    ctx.out(`claude\t${id}\t${row}\n`);
  }
  ctx.out(await museUsage(ctx, dir, ttl, now));
  ctx.out(await codexUsage(ctx, dir, ttl, failTtl, now));
}
/** RESET_STATES: the generic free-resets states; anything else read from a sidecar is `unknown`. */
const RESET_STATES = new Set(["reported", "not_reported", "unknown"]);
/** account-resets: "<agent>\t<account>\t<json>" per `account-list` account, from the sidecars the usage
 *  fetch writes; it calls no provider. Muse has no free resets to report (`not_reported`); a missing or
 *  unreadable sidecar (an account not fetched yet, a Codex whose read never worked) is `unknown`. */
export async function accountResets(ctx: Ctx): Promise<void> {
  const dir = usageDir(ctx.env);
  for (const l of await accountList(ctx)) {
    const [agent, id] = readTabs(l, 3);
    if (!agent || !id) continue;
    let doc: unknown = { state: "unknown" };
    if (agent === "muse") doc = { state: "not_reported" };
    else {
      try {
        const d: unknown = JSON.parse(readFileSync(`${dir}/${agent}-${id}.resets.json`, "utf8"));
        if (isObj(d) && typeof d.state === "string" && RESET_STATES.has(d.state)) doc = d;
      } catch { /* no sidecar: unknown */ }
    }
    ctx.out(`${agent}\t${id}\t${JSON.stringify(doc)}\n`);
  }
}
/** account-list lines: claude's accounts (default first), then muse's and codex's one login each. */
export async function accountList(ctx: Ctx): Promise<string[]> {
  const cl = (await claudeAccounts(ctx)).join("\n").split("\n").map((l) => `claude\t${l}`);
  return [...cl, "muse\tdefault\tdefault", "codex\tdefault\tdefault"];
}

// --- account-reset-use (account-free-resets U4) -----------------------------------------------------
// Uses one free reset grant. Only the loop's account-reset fulfiller calls it, for an operator's press on
// the board; nothing else may (tests/loop/fulfil-account-reset.test.ts greps for callers).
type ResetOutcome = "used" | "nothing_to_reset" | "no_grant" | "already_used" | "failed";
/** Claude's redeem `result` -> the generic outcome (the CLI's own words, read from claude 2.1.326). */
const CLAUDE_RESET: Record<string, ResetOutcome> = { reset: "used", already_used: "already_used", not_limited: "nothing_to_reset", unavailable: "no_grant" };
/** codex app-server's ConsumeAccountRateLimitResetCreditOutcome -> the generic outcome. */
const CODEX_RESET: Record<string, ResetOutcome> = { reset: "used", nothingToReset: "nothing_to_reset", noCredit: "no_grant", alreadyRedeemed: "already_used" };
/** Outcomes after which the cached figures and grants are known to be stale: they are dropped, so the
 *  refresh that follows reads the provider again. */
const RESET_STALE = new Set<ResetOutcome>(["used", "already_used", "no_grant"]);
const oneLine = (s: string): string => s.replace(/[\t\r\n]+/g, " ").trim().slice(0, 200);
/** The account's organization uuid from its `.claude.json` (the system login's may sit in `$HOME`). */
function claudeOrg(env: Env, id: string, home: string): string {
  for (const f of [`${home}/.claude.json`, ...(id === "system" ? [`${env.HOME}/.claude.json`] : [])]) {
    try {
      const o: unknown = JSON.parse(readFileSync(f, "utf8"));
      const org = isObj(o) && isObj(o.oauthAccount) ? o.oauthAccount.organizationUuid : undefined;
      if (typeof org === "string" && /^[A-Za-z0-9-]{1,64}$/.test(org)) return org;
    } catch { /* next */ }
  }
  return "";
}
/** Claude: `POST /api/organizations/<org>/reset_rate_limits {program:"cedar_ember", grant_id, request_id}`
 *  with the usage call's token and User-Agent. request_id is the press's key, so a retry is the same claim.
 *  null = no answer (in doubt). */
async function claudeResetUse(ctx: Ctx, id: string, grant: string, key: string): Promise<[ResetOutcome, string] | null> {
  const home = accountHome(ctx.env, id);
  const { tok, exp } = claudeToken(home);
  if (!tok) return ["failed", "no login token"];
  if (tokenExpired(exp, nowS(ctx.env))) return ["failed", "login expired"];
  const org = claudeOrg(ctx.env, id, home);
  if (!org) return ["failed", "no organization in .claude.json"];
  let api = "https://api.anthropic.com";
  try { if (ctx.env.DS_USAGE_URL) api = new URL(ctx.env.DS_USAGE_URL).origin; } catch { /* the default */ }
  const body = JSON.stringify({ program: "cedar_ember", grant_id: grant, request_id: key });
  const { code, body: out } = await claudeCurl(ctx, tok, `${api}/api/organizations/${org}/reset_rate_limits`,
    ["-X", "POST", "-H", "Content-Type: application/json", "--data-raw", body], 30);
  if (code === "000") return null;
  if (!code.startsWith("2")) return ["failed", oneLine(`HTTP ${code}${out ? `: ${out}` : ""}`)];
  let parsed: unknown;
  try { parsed = JSON.parse(out); } catch { return ["failed", oneLine(`unreadable answer: ${out}`)]; }
  const d: Record<string, unknown> = isObj(parsed) ? parsed : {};
  const res = d.result, reason = typeof d.reason === "string" ? d.reason : "";
  const left = typeof d.resets_left === "number" ? `resets left ${d.resets_left}` : "";
  const o = typeof res === "string" ? CLAUDE_RESET[res] : undefined;
  if (o) return [o, oneLine([reason, left].filter(Boolean).join(" · "))];
  return ["failed", oneLine([typeof res === "string" ? res : `unexpected answer ${out}`, reason].filter(Boolean).join(": "))];
}
/** Codex: `account/rateLimitResetCredit/consume {creditId, idempotencyKey}` over one app-server exchange. */
async function codexResetUse(ctx: Ctx, dir: string, grant: string, key: string): Promise<[ResetOutcome, string] | null> {
  if (!Bun.which("codex", { PATH: ctx.env.PATH ?? "" })) return ["failed", "codex is not installed"];
  const r = await codexCall(ctx, dir, "account/rateLimitResetCredit/consume", { creditId: grant, idempotencyKey: key });
  if (r === null) return null;
  if ("error" in r) return ["failed", oneLine(r.error)];
  const o = isObj(r.result) ? r.result.outcome : undefined;
  return typeof o === "string" && CODEX_RESET[o] ? [CODEX_RESET[o], ""] : ["failed", oneLine(`unexpected outcome ${JSON.stringify(o ?? null)}`)];
}
/** account-reset-use <agent> <account> <grant> <key>: "<outcome>\t<detail>" and exit 0 once the provider
 *  answered (or the call is refused before it: a bad id, no login). No answer at all is exit 1 with a
 *  stderr line and no outcome: the claim is in doubt, so the caller retries with the same key. After an
 *  outcome that makes the cached figures stale, that account's usage and resets caches are dropped. */
export async function accountResetUse(ctx: Ctx, a: string[]): Promise<number> {
  if (a.length !== 4) { ctx.err("usage: account-reset-use <agent> <account> <grant> <key>\n"); return 2; }
  const [agent, id, grant, key] = a;
  const say = (o: ResetOutcome, detail: string) => { ctx.out(`${o}\t${detail}\n`); return 0; };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) return say("failed", "bad account id");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(grant)) return say("failed", "bad grant id");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return say("failed", "bad key");
  const dir = usageDir(ctx.env);
  try { mkdirSync(dir, { recursive: true }); } catch { /* codex's cwd; the call says if it cannot start */ }
  let got: [ResetOutcome, string] | null;
  if (agent === "claude") got = await claudeResetUse(ctx, id, grant, key);
  else if (agent === "codex") got = await codexResetUse(ctx, dir, grant, key);
  else return say("failed", `${agent} has no free resets`);
  if (got === null) { ctx.err(`account-reset-use: no answer from ${agent}; the claim is in doubt, retry with the same key\n`); return 1; }
  if (RESET_STALE.has(got[0])) for (const ext of ["tsv", "resets.json"]) rmSync(`${dir}/${agent}-${id}.${ext}`, { force: true });
  return say(got[0], got[1]);
}

// --- limited ----------------------------------------------------------------------------------------
// Claude Code's limit notices as known so far ("5-hour limit reached ∙ resets 3pm", "You've hit your weekly
// limit · resets Oct 31, 8pm (Europe/Berlin)", "Claude usage limit reached …", "API Error: 429") — a limit
// word AND a "resets", so test output like "rate limit exceeded" doesn't count, nor does Claude Code's
// recovery line "Usage limit reset · Continuing automatically" (a bare "reset"). The qualifier in "hit your
// <qualifier> limit" is the window/model the real notices name. Aggregator-pool 429s ("Request rejected
// (429)" / "All credentials … cooling down") are independently distinctive pool shapes. Anchored: the notice
// must START the line, after only leading whitespace and the UI's result marker `⎿` (then spaces or the NBSP
// the real notices carry), so prose, quotes, timestamps or a `Finding:` prefix quoting a notice never count.
// Codex renders terminal errors with ■ and Muse a diamond; those shapes count only on a worker of that agent.
// Matched as bytes, the way the shell's grep saw them in the C locale the loop runs in.
const SP = "[ \\t\\n\\v\\f\\r]";
const NBSP = "\\xc2\\xa0";
const B = (s: string) => bytes(s);
const LIMIT_RE = `^${SP}*${B("⎿")}(${SP}|${NBSP})*(((([0-9]+-hour|[A-Za-z]+) ){0,2}limit reached|(You[^ \\t\\n\\v\\f\\r]{1,4}ve )?hit your (weekly |session |opus |sonnet )?limit|([A-Za-z]+ ){0,2}usage limit).*resets|Claude usage limit reached|API Error: (429|Request rejected \\(429\\))|(API Error: .*)?All credentials .*cooling down)`;
const CODEX_LIMIT_RE = `^${SP}*${B("■")}${SP}*(You.ve hit your usage limit([^A-Za-z0-9_]|$)|unexpected status 429([^A-Za-z0-9_]|$))`;
const MUSE_LIMIT_RE = `^${SP}*${B("◆")} Usage limit reached ${B("·")} /upgrade \\(`;
// A billing error (kind credits): the provider's exact phrase, each on its own agent's worker (Claude's on one
// with no known agent too); keep in step with fingerprints.ts.
const CLAUDE_CREDITS_RE = `^${SP}*${B("⎿")}(${SP}|${NBSP})*(API Error: 402([^A-Za-z0-9_]|$)|Credit balance is too low)`;
const MUSE_CREDITS_RE = `^${SP}*${B("◆")} model failed: API error 402([^A-Za-z0-9_]|$)`;
const CODEX_CREDITS_RE = `^${SP}*${B("■")}${SP}*.*insufficient_quota`;
const MUSE_ENTRY_RE = new RegExp(`^${SP}*${B("◆")}`, "s");
// A new transcript entry (assistant or tool output), or the recovery line. A notice counts only while none
// follows it: an agent that recovered has written on since.
const ENTRY_RE = new RegExp(`^${SP}*(${B("⏺")}|${B("●")}|${B("•")}|${B("■")})|^${SP}*${B("⎿")}(${SP}|${NBSP})*[Uu]sage limit reset([^s]|$)`, "s");
// The loop's and the sweep's own pokes on the screen are not notices.
const OWN_POKE = new RegExp(`dev-studio (sweep|board)|^${SP}*(${B("❯")}|${B("•")})?${SP}*dev-studio loop:`, "s");

const tzEpoch = (env: Env, tz: string, spec: string): string | null => {
  const r = spawnSync(["date", "-d", spec, "+%s"], tz ? { ...env, TZ: tz } : env);
  return r.code === 0 ? chomp(r.out) : null;
};
const tzFdate = (env: Env, tz: string, epoch: number, fmt: string): string | null => {
  const r = spawnSync(["date", "-d", `@${epoch}`, `+${fmt}`], tz ? { ...env, TZ: tz } : env);
  return r.code === 0 ? chomp(r.out) : null;
};
const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
/** limit_reset: the epoch of the reset a notice names — "resets 3pm", "resets 3:30pm", "resets at 15:00", a
 *  dated "resets Oct 31, 8pm", Muse's "reset at Nov 9 at 1:00 AM", or an ISO instant "resets at
 *  2026-10-29T16:11:19Z" (the instant itself, no roll-forward; a past one still counts). Else the next such
 *  time after the anchor (the moment the agent went quiet); a dated form resolves in the anchor's year and
 *  rolls forward a year at a time while it is at or before the anchor. A zone in parentheses ("(Europe/Berlin)")
 *  reads the wall time there, else in the host zone. noroll (a dialog row) keeps the past candidate, so the
 *  sweep's past-reset expiry can fire. "-" when no clock time is in the text. */
export function limitReset(env: Env, text: string, anchor: number, noroll: boolean): string {
  const iso = text.match(/[Rr]esets? at ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?(Z|[+-][0-9]{2}:?[0-9]{2})?)/);
  if (iso) return tzEpoch(env, "", iso[1]) ?? "-";
  text = text.replace(/([Rr]esets? at [A-Za-z]+ [0-9]{1,2}) at /, "$1 ");
  const z = text.match(/\(([A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)+|UTC|GMT)\)/);
  const tz = z ? z[1] : "";
  const m = text.match(/[Rr]esets? (at )?(([Jj]an|[Ff]eb|[Mm]ar|[Aa]pr|[Mm]ay|[Jj]un|[Jj]ul|[Aa]ug|[Ss]ep|[Oo]ct|[Nn]ov|[Dd]ec)[A-Za-z]* ([0-9]{1,2}),? )?([0-9]{1,2})(:([0-9]{2}))? ?([AaPp][Mm])?/);
  if (!m) return "-";
  const mon = m[3] ?? "", day = m[4] ?? "", hh = m[5], ap = m[8] ?? "";
  let mm = m[7] ?? "";
  // A bare hour is no clock time ("resets 5 hours from now" is not 05:00): it needs minutes or an am/pm.
  if (!mm && !ap) return "-";
  if (!mm) mm = "00";
  const y = tzFdate(env, tz, anchor, "%Y");
  if (y === null) return "-";
  let year = Number(y), cand: string | null;
  if (mon) {
    const mon_num = MONTHS[mon.toLowerCase()];
    if (!mon_num) return "-";
    const dd = String(Number(day)).padStart(2, "0");
    for (;;) {
      cand = tzEpoch(env, tz, `${year}-${mon_num}-${dd} ${hh}:${mm} ${ap}`);
      if (cand === null) return "-";
      if (Number(cand) > anchor || noroll) break;
      year++;
    }
  } else {
    cand = tzEpoch(env, tz, `${tzFdate(env, tz, anchor, "%F") ?? ""} ${hh}:${mm} ${ap}`);
    if (cand === null) return "-";
    if (Number(cand) <= anchor && !noroll) {
      cand = tzEpoch(env, tz, `${tzFdate(env, tz, anchor + 86400, "%F") ?? ""} ${hh}:${mm} ${ap}`);
      if (cand === null) return "-";
    }
  }
  return cand;
}

/** The limit dialog: its header on its own line, then at least two numbered options in order (option 3
 *  under any name after 1 and 2 — it has been "Add funds" and "Switch to usage credits"; the loop never
 *  answers it, it spends money; a narrow pane wraps an option, the rest indented deeper), and after the last
 *  option only lines that were blank before stripping or the prompt footer ("Enter to confirm · Esc to
 *  cancel"); any other line kills it (a stuck dialog ends the screen; quoted/diff text is followed by prompts
 *  or output). Options match by prefix ("2. Wait here, then continue automatically at Oct 31, 9pm" embeds
 *  the reset). Leading decoration (the ❯ cursor) is stripped per line. */
function isDialog(tail: string[]): boolean {
  let hdr = 0, n = 0, prev = 0, last = 0, bad = false, at = 0;
  tail.forEach((line, i) => {
    const NR = i + 1;
    const rawl = line.replace(/[ \t]+$/, "");
    const ind = rawl.match(/^[ \t]*/)![0].length;
    const l = rawl.replace(/^[ \t]*[^A-Za-z0-9]*[ \t]*/, "");
    if (l === "What do you want to do?") { hdr = NR; n = 0; prev = 0; last = 0; bad = false; return; }
    let num = 0;
    if (hdr && /^1\. Stop and wait/.test(l)) num = 1;
    else if (hdr && /^2\. Wait here/.test(l)) num = 2;
    else if (hdr && n === 2 && prev === 2 && /^3\. /.test(l)) num = 3;
    if (num > prev) { n++; prev = num; last = NR; at = ind; return; }
    if (last && /[^ \t]/.test(rawl) && !/^(Enter to confirm|Esc to cancel)/.test(l) && ind <= at) bad = true;
  });
  return !!hdr && n >= 2 && !bad;
}

/** limited: "<worktree_id>\t<reset epoch or ->\t<notice>[\tdialog]" per worker whose screen shows a usage-limit
 *  notice. An idle or done worker counts once silent for DS_SWEEP_SILENT_MIN (default 10) minutes; with no
 *  state time it uses its last output, and with neither only a recognised dialog counts, anchored at now. A
 *  `working` worker counts only when its terminal has been silent that long (the limit dialog: Claude Code
 *  sits on "What do you want to do?" while worker-states still reads working) or the dialog shows (the
 *  silence wait waived, the row's 4th field `dialog`). The notice is printed cut to 160 bytes; the reset is
 *  read from the whole line plus the lines a narrow pane wrapped under it. */
export async function limited(ctx: Ctx): Promise<Uint8Array> {
  const env = ctx.env;
  const silent = Number(env.DS_SWEEP_SILENT_MIN || "10"), now = nowS(env);
  // terminal-activity and worker-states, in process (U225); their stderr was never read.
  const sh = async (verb: string) => {
    const out: Uint8Array[] = [];
    await VERBS[verb]({ ...ctx, out: (b) => out.push(typeof b === "string" ? Buffer.from(b) : b), err: () => {} }, []);
    return latin1(Buffer.concat(out));
  };
  const actRows = chomp(await sh("terminal-activity"));
  // Each worker's own agent: the main lines of agent-accounts, matched to the worker's worktree path (an
  // agent may run in a directory under it). No line = unknown agent.
  const agentRows = agentAccounts(env).split("\n").filter(Boolean).map((l) => l.split("\t")).filter((f) => f[1] === "main").map((f) => [f[0], f[2] ?? ""]);
  const states = await sh("worker-states");
  const out: Buffer[] = [];
  const kept = screensOpen(env);
  for (const row of lines(states)) {
    const [wt, st, , sinceRaw] = readTabs(row, 5);
    let since = sinceRaw, anchor: number, timeless = false;
    let recent = false;
    if (st === "idle" || st === "done") {
      if (!isNum(since)) since = awkField2(actRows, wt);
      if (!isNum(since)) { timeless = true; anchor = now; }
      else {
        recent = !(now - Math.floor(Number(since) / 1000) >= silent * 60);
        anchor = Math.floor(Number(since) / 1000);
      }
    } else if (st === "working") {
      const act = awkField2(actRows, wt);
      if (!isNum(act)) continue;
      anchor = Math.floor(Number(act) / 1000);
    } else continue;
    const screen = bytes(await keptScreen(ctx, wt, `${st}|${sinceRaw}|${awkField2(actRows, wt)}`, kept));
    const tailw = chomp(lines(screen).slice(-12).filter((l) => !OWN_POKE.test(l)).map((l) => l + "\n").join("")).split("\n");
    const p = wt.includes("::") ? wt.slice(wt.indexOf("::") + 2) : wt;
    const wagent = agentRows.find(([cwd]) => p !== "" && (cwd === p || cwd.startsWith(p + "/")))?.[1] ?? "";
    const lre = new RegExp(wagent === "muse" ? `${LIMIT_RE}|${MUSE_LIMIT_RE}` : wagent === "codex" ? `${LIMIT_RE}|${CODEX_LIMIT_RE}` : LIMIT_RE, "is");
    const cre = new RegExp(wagent === "muse" ? MUSE_CREDITS_RE : wagent === "codex" ? CODEX_CREDITS_RE : wagent === "" || wagent === "claude" ? CLAUDE_CREDITS_RE : "(?!)", "is");
    let at = -1;
    tailw.forEach((l, i) => { if (lre.test(l) || cre.test(l)) at = i; });
    if (at < 0) continue;
    if (tailw.slice(at + 1).some((l) => ENTRY_RE.test(l) || (wagent === "muse" && MUSE_ENTRY_RE.test(l)))) continue;
    const credits = cre.test(tailw[at]);
    if (recent && !credits) continue;
    // A narrow pane wraps the notice ("resets Nov 2,\n     6pm (Europe/Berlin)"): the reset is read across
    // the lines indented under it; the notice stays its first line.
    const d = tailw[at].match(/^[ \t]*/)![0].length;
    let wrap = "";
    for (const l of tailw.slice(at + 1)) {
      if (l.match(/^[ \t]*/)![0].length > d && /[^ \t]/.test(l)) wrap += " " + l.replace(/^[ \t]+|[ \t]+$/g, "");
      else break;
    }
    const notice = tailw[at].replace(/^[^A-Za-z0-9]+/, "");
    const dlg = !credits && isDialog(tailw);
    if (timeless && !dlg && !credits) continue;
    // Reset is parsed from the full line (an aggregator 429's ISO reset sits past the 160-byte display cut).
    const reset = credits ? "-" : limitReset(env, notice + wrap, anchor, dlg);
    if (st === "working" && !dlg && now - anchor < silent * 60) continue;
    // 4th field `dialog` or `-`, 5th `credits`: `-` keeps bash `read` from merging two tabs in a row.
    out.push(Buffer.from(`${wt}\t${reset}\t${notice.slice(0, 160)}${credits ? "\t-\tcredits" : dlg ? "\tdialog" : ""}\n`, "latin1"));
  }
  screensSave(kept);
  return Buffer.concat(out);
}

// --- messaging and inbox (U224) ---------------------------------------------------------------------
/** `a // b // …` as jq evaluates it: left to right, stopping at the first truthy value (else the last value),
 *  so an alternative after a truthy one is never evaluated and its error never raised. */
export function or(...fs: (() => unknown)[]): any {
  let v: unknown = null;
  for (const f of fs) { v = f(); if (truthy(v)) return v; }
  return v ?? null;
}
/** `jq -r 'x // empty'` of one value: emit it only when truthy. */
const some = (emit: (v: unknown) => void, v: unknown): void => { if (truthy(v)) emit(v); };
/** `$(jq -r … 2>/dev/null || echo <fallback>)`: the outputs, plus the fallback line when jq failed. */
const jqrOr = (text: string, fn: (d: any, emit: (v: unknown) => void) => void, fallback: string): string => {
  const j = jq(text, fn);
  return chomp(rawLines(j.vals) + (j.code !== 0 ? `${fallback}\n` : ""));
};
/** jq's runtime errors on stderr (a filter whose stderr the shell did not drop). */
const jqErrs = (ctx: Ctx, j: Jq): void => { for (const e of j.errs) ctx.err(e.startsWith("parse error") ? `jq: ${e}\n` : `jq: error: ${e}\n`); };
/** jq's `length`. */
function jqLength(v: unknown): unknown {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") throw new JqError(`boolean (${v}) has no length`);
  if (typeof v === "number") return Math.abs(v);
  if (typeof v === "string") return [...v].length;
  return Array.isArray(v) ? v.length : Object.keys(v as object).length;
}
/** One `@tsv` cell: strings escaped, numbers and booleans as text, null empty, anything else an error. */
function tsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  throw new JqError(`${jqType(v)} (${pretty(v, 0)}) is not valid in a csv row`);
}
/** `sub("\\.[0-9]+"; "") | fromdateiso8601`: an ISO-8601 UTC time, its fraction dropped, as epoch seconds.
 *  jq parses it with strptime("%Y-%m-%dT%H:%M:%SZ"): spaces before a number and after the Z pass, a
 *  zone offset does not. */
export function isoSec(v: unknown): number {
  if (typeof v !== "string") throw new JqError(`${jqType(v)} (${pretty(v, 0)}) cannot be matched, as it is not a string`);
  const s = v.replace(/\.[0-9]+/, "");
  const m = s.match(/^ *([0-9]{1,4})- *([0-9]{1,2})- *([0-9]{1,2})T *([0-9]{1,2}): *([0-9]{1,2}): *([0-9]{1,2})Z\s*$/);
  const [Y, Mo, D, h, mi, sec] = (m ?? []).slice(1).map(Number);
  if (!m || Mo < 1 || Mo > 12 || D < 1 || D > 31 || h > 23 || mi > 59 || sec > 61) {
    throw new JqError(`date "${s}" does not match format "%Y-%m-%dT%H:%M:%SZ"`);
  }
  const t = new Date(0);
  t.setUTCFullYear(Y, Mo - 1, D);
  t.setUTCHours(h, mi, sec, 0);
  return Math.floor(t.getTime() / 1000);
}

/** The caller's terminal, passed as --from. Inside an Orca terminal ORCA_TERMINAL_HANDLE names it; the loop
 *  (bin/loop/io/orca.ts) runs with no ORCA_* at all and names its own sender terminal in DS_ORCA_FROM. Outside
 *  one, orchestration commands fail clearly, which is correct. */
const fromHandle = (env: Env): string => env.DS_ORCA_FROM || env.ORCA_TERMINAL_HANDLE || "";
const fromArgs = (env: Env): string[] => fromHandle(env) ? ["--from", fromHandle(env)] : [];
/** DS_ORCA_RETRY_REQUEST: the loop mints a request id before a call and stores it, so a call lost in a crash
 *  is settled with request-show and replayed under the same id. */
const retryArgs = (env: Env): string[] => env.DS_ORCA_RETRY_REQUEST ? ["--retry-request", env.DS_ORCA_RETRY_REQUEST] : [];

/** A real message: not one of Orca's worker keepalives (type heartbeat/keepalive). (confirm@host: the keepalive
 *  type strings; adjust here if the live build names them differently.) */
const isReal = (m: unknown): boolean => { const t = or(() => idx(m, "type"), () => ""); return t !== "heartbeat" && t !== "keepalive"; };
/** `(.result.messages) |= [ .[]? | select(real) ]` on a check answer inboxCheck accepted. */
function realOnly(d: any): any {
  const r = idx(d, "result");
  r.messages = each(idx(r, "messages")).filter(isReal);
  return d;
}
/** Print a check answer with its keepalives stripped (jq's indented JSON); 5 and jq's error when a message
 *  can't be read. */
function printReal(ctx: Ctx, batch: string): number {
  try { ctx.out(pretty(realOnly(JSON.parse(batch))) + "\n"); return 0; }
  catch (e) { if (!(e instanceof JqError)) throw e; ctx.err(`jq: error: ${e.message}\n`); return 5; }
}
/** stderr lines without Orca's keepalive noise (`grep -vi keepalive`). */
const noKeepalive = (err: string): string[] => (err === "" ? [] : err.replace(/\n$/, "").split("\n")).filter((l) => !/keepalive/i.test(l));

/** inbox_check: `orca orchestration check <args> --json --full`, the answer text when it is one object with a
 *  result object and not ok:false. A failed check is never an empty inbox: null, after Orca's error code and
 *  message (or why there is none) on stderr. */
async function inboxCheck(ctx: Ctx, args: string[]): Promise<string | null> {
  const r = await orca(ctx, ["orchestration", "check", ...args, "--json", "--full"], "keep");
  const out = chomp(r.out);
  const errs = noKeepalive(r.err);
  if (r.code === 0) {
    const s = scan(out);
    const d = s.vals[0];
    if (!s.bad && s.vals.length === 1 && isObj(d) && d.ok !== false && isObj(d.result)) {
      ctx.err(errs.map((l) => l + "\n").join(""));
      return out;
    }
  }
  let detail = jqr(out, (d, emit) => {
    const e = idx(d, "error"), code = idx(e, "code"), msg = idx(e, "message");
    if (code === null || msg === null) return;
    if (typeof code !== "string" || typeof msg !== "string") throw new JqError("cannot be added");
    emit(`${code}: ${msg}`);
  });
  if (!detail) {
    const said = errs.map((l) => l + " ").join("");
    detail = said ? `orca_check_failed: ${said}` : r.code !== 0 ? `orca_check_failed: check exited ${r.code}` : "invalid_response: check returned invalid JSON or no result";
  }
  ctx.err(`${detail}\n`);
  return null;
}

/** inbox_wait_drain: block for a REAL message, transparently draining Orca worker keepalive messages (type
 *  heartbeat/keepalive). Those land in the coordinator's inbox and, left unacked, (a) block real messages
 *  behind their delivery and (b) would wake the agent on every ping. So: ack the prior batch (`ack`), ack a
 *  keepalive-only batch and keep waiting within the caller's timeout; print the first batch with a real
 *  message (keepalives stripped from it), or the empty batch on timeout. */
async function inboxWaitDrain(ctx: Ctx, tmo: string, ack: string, extra: string[]): Promise<number> {
  const now = () => Math.floor(Date.now() / 1000);
  const end = now() + Math.trunc(((Number.parseInt(tmo, 10) || 0) + 999) / 1000);
  for (;;) {
    const remain = Math.max(end - now(), 1);
    const batch = await inboxCheck(ctx, ["--wait", "--timeout-ms", String(remain * 1000), ...extra, ...(ack ? ["--ack", ack] : [])]);
    if (batch === null) return 1;
    let real = 0;
    try { real = each(idx(idx(JSON.parse(batch), "result"), "messages")).filter(isReal).length; } catch { real = 0; }
    const did = jqr(batch, (d, emit) => {
      const r = idx(d, "result");
      some(emit, or(() => idx(r, "deliveryId"), () => idx(idx(r, "delivery"), "id"), () => idx(at(idx(r, "messages"), 0), "deliveryId")));
    });
    if (real > 0 || did === "" || now() >= end) {
      try { ctx.out(pretty(realOnly(JSON.parse(batch))) + "\n"); } catch (e) { if (!(e instanceof JqError)) throw e; ctx.out(batch); }
      return 0;
    }
    ack = did; // keepalive-only batch -> ack it and wait again for a real message
  }
}

/** One run's or every run's unread mail from the host-wide inbox listing (`check --run` is fenced to the
 *  Run's coordinator; the listing is not). One line per unread real message, as `line` makes it. Exit 1 when
 *  Orca can't be read, so a caller never takes "no answer" for "no mail".
 *  shortcut: reads the newest 1000 messages host-wide; raise --limit if a host outgrows it. */
async function unread(ctx: Ctx, pick: (m: any) => boolean, line: (m: any) => string): Promise<number> {
  const r = await orca(ctx, ["orchestration", "inbox", "--limit", "1000", "--json", "--full"], "merge");
  const text = chomp(r.out);
  if (r.code !== 0) { ctx.err(`${text}\n`); return 1; }
  ctx.out(rawLines(jq(text, (d, emit) => {
    for (const m of each(idx(idx(d, "result"), "messages"))) if (pick(m) && isReal(m)) emit(line(m));
  }).vals));
  return 0;
}

/** The Run's unread mail read as its coordinator, the loop's pane (DS_ORCA_FROM, `check --terminal`): peek
 *  leaves it unread, take is Orca's consuming check. */
async function runInbox(ctx: Ctx, op: string, a: string[]): Promise<number> {
  const from = fromHandle(ctx.env);
  if (!from) { ctx.err(`orca adapter: ${op} needs the coordinator's terminal (DS_ORCA_FROM)\n`); return 1; }
  if (!need(ctx, a, 1)) return 1;
  const r = await orca(ctx, ["orchestration", "check", "--run", a[0], ...(op === "run-inbox-peek" ? ["--peek"] : []), "--terminal", from, "--json", "--full"], "merge");
  const text = chomp(r.out);
  if (r.code !== 0) { ctx.err(`${text}\norca adapter: ${op} failed for run ${a[0]}\n`); return 1; }
  const j = jq(text, (d, emit) => {
    if (idx(d, "ok") === false) throw new JqError("refused");
    emit(each(idx(idx(d, "result"), "messages")).filter(isReal).map((m) => ({
      id: idx(m, "id"), from_handle: idx(m, "from_handle"), type: idx(m, "type"), subject: idx(m, "subject"), body: idx(m, "body"), payload: idx(m, "payload"),
    })));
  });
  ctx.out(j.vals.map((v) => pretty(v, 0) + "\n").join(""));
  if (jqE(j) === 0) return 0;
  ctx.err(`${text}\norca adapter: ${op} for run ${a[0]} printed no message list\n`);
  return 1;
}

// --- the verbs --------------------------------------------------------------------------------------
type Verb = (ctx: Ctx, a: string[]) => Promise<number>;
/** A positional the shell read as "$N" under `set -u`: missing is bash's unbound-variable exit. */
function need(ctx: Ctx, a: string[], n: number): boolean {
  if (a.length >= n) return true;
  ctx.err(`orca.sh: $${a.length + 1}: unbound variable\n`);
  return false;
}
const blank = (v: string | undefined): string => v === "-" ? "" : v ?? "";
/** need() for an arm that reads its positionals out of order: the first of `order` that is missing is the
 *  one bash names. */
function needIn(ctx: Ctx, a: string[], ...order: number[]): boolean {
  const n = order.find((i) => a.length < i);
  if (n === undefined) return true;
  ctx.err(`orca.sh: $${n}: unbound variable\n`);
  return false;
}
/** `$(head -c 300 <<<"$s" | tr '\n' ' ')`: the first 300 bytes of the text and a newline, newlines as spaces. */
const head300 = (s: string): Uint8Array => Buffer.from(`${s}\n`).subarray(0, 300).map((b) => b === 10 ? 32 : b);
/** The message a `send --json --full` receipt carries (`.result.message // .result.messages[0] // {}`). */
const receipt = (d: unknown): any => { const r = idx(d, "result"); return or(() => idx(r, "message"), () => at(idx(r, "messages"), 0), () => ({})); };

/** The inbox verbs: a check answer with its keepalives stripped, or exit 1 when the check failed. */
const peekVerb = (mode: string, run: boolean): Verb => async (ctx, a) => {
  if (run && !need(ctx, a, 1)) return 1;
  const batch = await inboxCheck(ctx, [...(run ? ["--run", a[0]] : []), mode]);
  if (batch === null) return 1;
  return printReal(ctx, batch);
};

/** The messaging and inbox verbs (U224). */
const INBOX: Record<string, Verb> = {
  /** <request_id> -> completed|pending|absent, then a tab and the dispatch id when one is known.
   *  Read-only: it never retries or settles anything (orca orchestration request-show). */
  async "request-show"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["orchestration", "request-show", "--request", a[0], "--json", "--full"]);
    const j = jq(r.out, (d, emit) => {
      const x = idx(d, "result");
      emit(tsv([or(() => idx(x, "state"), () => idx(x, "status"), () => "absent"),
        or(() => idx(x, "dispatchId"), () => idx(idx(x, "outcome"), "dispatchId"), () => idx(idx(x, "result"), "dispatchId"), () => "")]
        .map(tsvCell)));
    });
    ctx.out(rawLines(j.vals)); jqErrs(ctx, j);
    if (r.code === 0 && jqE(j) === 0) return 0;
    ctx.err(`orca adapter: request-show failed for ${a[0]}\n`);
    return 1;
  },
  /** <run_id> <subject> <body> -> message a Run's inbox (the coordinator reads it). Orca writes its error as
   *  JSON on stdout: on a failure that goes to stderr, so the caller says why. */
  async send(ctx, a) {
    if (!need(ctx, a, 3)) return 1;
    const r = await orca(ctx, ["orchestration", "send", "--to", `run:${a[0]}`, "--subject", a[1], "--body", a[2], ...fromArgs(ctx.env), "--json", "--full"], "merge");
    if (r.code === 0) return 0;
    const out = chomp(r.out);
    const why = jqr(out, (d, emit) => {
      const e = idx(d, "error");
      if (e !== null) emit(`${interp(or(() => idx(e, "code"), () => "error"))}: ${interp(or(() => idx(e, "message"), () => ""))}`);
    });
    ctx.err(`orca adapter: send failed for run ${a[0]}: ${why || out || "no output"}\n`);
    return 1;
  },
  /** <worktree_id> <subject> <body> -> message ONE worker's own inbox. A Run group EXCLUDES its own
   *  coordinator, so a Lead that needs to reach a child (forward a question to a Thinker, tell children to
   *  reload) must address the worktree directly — `send run:<own>` would just loop back to the Lead's own
   *  inbox. Orca resolves @worktree: only inside the sender's OWN Run: aimed at the Studio or another squad
   *  it reports success but files the message under run:<own run>, where the sender's own Lead reads it
   *  (host-confirmed 2026-10-16, docs/orca-notes.md). Fail loudly then — unless the target IS that Run's
   *  coordinator (a Thinker answering its Lead), where run:<own run> is the right mailbox. */
  async "send-worker"(ctx, a) {
    if (!need(ctx, a, 3)) return 1;
    const r = await orca(ctx, ["orchestration", "send", "--to", `@worktree:${a[0]}`, "--subject", a[1], "--body", a[2], ...fromArgs(ctx.env), "--json", "--full"]);
    if (r.code !== 0) { ctx.err(`orca adapter: send-worker failed for worktree ${a[0]} (see error above)\n`); return 1; }
    const to = jqr(r.out, (d, emit) => some(emit, idx(at(idx(idx(d, "result"), "messages"), 0), "to_handle")));
    if (to.startsWith("run:")) {
      const show = await orca(ctx, ["orchestration", "run-show", "--id", to.slice(4), "--json", "--full"], "drop");
      const coord = jqr(show.out, (d, emit) => some(emit, idx(idx(idx(d, "result"), "run"), "coordinator_handle")));
      const terms = await orca(ctx, ["terminal", "list", "--json"], "drop");
      const cwt = rawLines(jq(terms.out, (d, emit) => {
        for (const t of each(idx(idx(d, "result"), "terminals"))) if (idx(t, "handle") === coord) some(emit, idx(t, "worktreeId"));
      }).vals).split("\n")[0];
      // Can't tell who the coordinator is -> don't guess; a false error would derail a real answer.
      // Compare FULL ids: they are <repo-id>::<path> and all worktrees of a repo share the repo-id.
      if (cwt && cwt !== a[0]) {
        ctx.err(`orca adapter: send-worker NOT delivered to ${a[0]} — it has no live worker in your Run (a done/stopped worker, or outside your squad), so Orca filed it under ${to} and your own Lead got it. A done/stopped worker in your squad: restart-role.sh it, then send. Outside your squad: ask-operator.sh (conventions/escalation.md).\n`);
        return 3;
      }
    }
    // A receipt, so the sender knows it landed (silence used to make Leads re-check PRs).
    const id = jqrOr(r.out, (d, emit) => emit(or(() => idx(at(idx(idx(d, "result"), "messages"), 0), "id"), () => "?")), "?");
    ctx.out(`send-worker: delivered to ${to || a[0]} (${id})\n`);
    return 0;
  },
  /** [--to <handle>] <run_id> <worktree_id> <subject> <body> -> message ONE worker of ANOTHER Run at its
   *  WORKTREE, scoped to that Run (`--run <peer> --to @worktree:`); without --run, @worktree: misfiles to
   *  run:<own run>. Exit 3 = NOT delivered: the worktree has no live terminal in the run
   *  (terminal_not_found), the SENDER has an active dispatch (dispatch_run_mismatch pins --run to its own
   *  run, so the loop replays send-peer from its squad's dispatch-less sender pane via DS_ORCA_FROM), or the
   *  receipt shows a misfile (to_handle is run:* or empty, or run_id isn't the run). --to <handle> (U79):
   *  send to that terminal, not the worktree (`@worktree:` can resolve to a plain shell in it); the receipt
   *  must then name that handle, or `dispatch:<id>` of a dispatch assigned to it, else exit 3
   *  "misdelivered" naming both handles. (docs/orca-notes.md, host 2026-10-28 and 2026-11-03.) */
  async "send-run-worker"(ctx, a) {
    let handle = "";
    if (a[0] === "--to") {
      if (a.length < 2) return 1; // bash's `shift 2` out of range under set -e
      handle = a[1]; a = a.slice(2);
    }
    if (!needIn(ctx, a, 2, 1, 3, 4)) return 1;
    const target = handle || `@worktree:${a[1]}`;
    // stdout only into the JSON parse (a stderr warning on a good send must not break it); stderr kept
    // apart so the error codes below can be found wherever the CLI prints them.
    const r = await orca(ctx, ["orchestration", "send", "--run", a[0], "--to", target, "--subject", a[2], "--body", a[3],
      ...fromArgs(ctx.env), ...retryArgs(ctx.env), "--json", "--full"], "keep");
    const out = chomp(r.out);
    const refused = jqr(out, (d, emit) => { if (idx(d, "ok") === false) emit("false"); }) === "false";
    if (r.code !== 0 || refused) {
      const said = `${out} ${chomp(r.err)}`;
      if (/terminal_not_found|No recipients resolved/.test(said)) {
        ctx.err(`orca adapter: send-run-worker NOT delivered — worktree ${a[1]} has no live terminal in run ${a[0]} (not running, restarted, or closed). Ask your Lead; it raises it to the Studio.\n`);
        return 3;
      }
      if (said.includes("dispatch_run_mismatch")) {
        ctx.err("orca adapter: send-run-worker NOT delivered — this terminal has an ACTIVE dispatch, which pins --run to its own run; cross-run delivery needs a sender with no dispatch (the loop sends send-peer from its squad's sender pane). Ask your Lead; it raises it to the Studio.\n");
        return 3;
      }
      ctx.err(Buffer.concat([Buffer.from(`orca adapter: send-run-worker failed for worktree ${a[1]} in run ${a[0]}: `), head300(said), Buffer.from("\n")]));
      return 1;
    }
    const to = jqr(out, (d, emit) => some(emit, idx(receipt(d), "to_handle")));
    const run = jqr(out, (d, emit) => some(emit, or(() => idx(receipt(d), "run_id"), () => idx(idx(d, "result"), "run_id"))));
    if (to === "" || to.startsWith("run:")) {
      ctx.err(`orca adapter: send-run-worker NOT delivered to ${a[1]} — Orca filed it under '${to || "?"}' instead of its terminal. Ask your Lead; it raises it to the Studio.\n`);
      return 3;
    }
    if (run !== a[0]) {
      ctx.err(`orca adapter: send-run-worker NOT delivered to ${a[1]} — the receipt is for run '${run || "?"}', not ${a[0]}. Ask your Lead; it raises it to the Studio.\n`);
      return 3;
    }
    let got = "";
    if (handle) {
      got = to;
      if (to.startsWith("dispatch:")) {
        const w = await orca(ctx, ["orchestration", "worker-show", "--dispatch", to.slice(9), "--json", "--full"], "drop");
        got = jqr(w.out, (d, emit) => some(emit, idx(idx(idx(d, "result"), "dispatch"), "assigneeHandle")));
        if (!got) { ctx.err(`orca adapter: send-run-worker to ${handle}: could not tell which terminal ${to} is\n`); return 1; }
      }
      if (got !== handle) {
        ctx.err(`orca adapter: send-run-worker NOT delivered to ${handle} — misdelivered: the receipt names ${got}, not ${handle}\n`);
        return 3;
      }
    }
    const id = jqrOr(out, (d, emit) => emit(or(() => idx(receipt(d), "id"), () => "?")), "?");
    ctx.out(`send-run-worker: delivered to ${got || to} (${id})\n`);
    return 0;
  },
  /** [--outcome succeeded|failed] <subject> <body> -> complete THIS terminal's active dispatch with that outcome
   *  (default succeeded; bin/role/finish-unit.sh ends a Builder's unit with this, --failed with failed). Discovers the ids itself — the dispatch via
   *  `check --peek` on $ORCA_TERMINAL_HANDLE (marks nothing read), task + sender handle via `worker-show` — so
   *  the caller passes no ids and can't complete the wrong dispatch. HOST-CONFIRMED 2026-10-28: `check
   *  --peek` carries .result.dispatchId even with zero unread (envelope metadata, not a message), and
   *  `worker-show` carries .result.dispatch.taskId + .assigneeHandle (docs/orca-notes.md). */
  async "worker-done"(ctx, a) {
    const usage = () => { ctx.err("usage: worker-done [--outcome succeeded|failed] <subject> <body>\n"); return 2; };
    let outcome = "succeeded";
    if (a[0] === "--outcome") {
      outcome = a[1] ?? "";
      if (outcome !== "succeeded" && outcome !== "failed") return usage();
      a = a.slice(2);
    }
    if (a.length < 2) return usage();
    const me = ctx.env.ORCA_TERMINAL_HANDLE;
    if (!me) { ctx.err("orca adapter: worker-done needs ORCA_TERMINAL_HANDLE — run it in the dispatched worker's own terminal\n"); return 1; }
    const check = await inboxCheck(ctx, ["--terminal", me, "--peek"]);
    if (check === null) return 1;
    const disp = jqr(check, (d, emit) => some(emit, idx(idx(d, "result"), "dispatchId")));
    if (!disp) { ctx.err("orca adapter: worker-done found no active dispatch for this terminal — run it in the dispatched worker's own terminal (if worker_done was already sent, there is nothing to do)\n"); return 1; }
    const w = await orca(ctx, ["orchestration", "worker-show", "--dispatch", disp, "--json", "--full"], "drop");
    const ids = jqr(w.out, (d, emit) => {
      const x = idx(idx(d, "result"), "dispatch");
      const task = or(() => idx(x, "taskId"), () => idx(x, "task_id")), who = idx(x, "assigneeHandle");
      if (truthy(task) && truthy(who)) emit(`${interp(task)} ${interp(who)}`);
    });
    const sp = ids.indexOf(" ");
    const task = sp < 0 ? ids : ids.slice(0, sp), from = sp < 0 ? ids : ids.slice(sp + 1);
    if (!task || !from) { ctx.err(`orca adapter: worker-done could not resolve task/sender for dispatch ${disp}\n`); return 1; }
    const s = await orca(ctx, ["orchestration", "send", "--from", from, "--type", "worker_done", "--subject", a[0], "--body", a[1],
      "--task-id", task, "--dispatch-id", disp, "--outcome", outcome, "--json", "--full"]);
    if (s.code !== 0) { ctx.err(`orca adapter: worker-done failed for task ${task} (dispatch ${disp}; see error above)\n`); return 1; }
    ctx.out(`worker-done: completed task ${task} (dispatch ${disp})\n`);
    return 0;
  },
  /** <msg_id> <run_id> <body> -> reply to a message (relay an answer down). */
  async reply(ctx, a) {
    if (!need(ctx, a, 3)) return 1;
    const r = await orca(ctx, ["orchestration", "reply", "--id", a[0], "--run", a[1], "--body", a[2], ...fromArgs(ctx.env), ...retryArgs(ctx.env), "--json", "--full"]);
    if (r.code === 0) return 0;
    ctx.err(`orca adapter: reply failed for msg ${a[0]} (see error above)\n`);
    return 1;
  },
  /** <run_id> <question> -> ask the Run coordinator and BLOCK until answered; prints the answer. */
  async ask(ctx, a) {
    if (!needIn(ctx, a, 2, 1)) return 1;
    const r = await orca(ctx, ["orchestration", "ask", "--question", a[1], "--to", `run:${a[0]}`, ...fromArgs(ctx.env), "--json", "--full"]);
    ctx.out(r.outBytes);
    if (r.code === 0) return 0;
    ctx.err(`orca adapter: ask failed for run ${a[0]} (see error above)\n`);
    return 1;
  },
  /** <task_id> <question> -> create a checkpoint gate on the task; prints the gate id. */
  async "gate-create"(ctx, a) {
    if (!need(ctx, a, 2)) return 1;
    const r = await orca(ctx, ["orchestration", "gate-create", "--task", a[0], "--question", a[1], ...fromArgs(ctx.env), "--json", "--full"]);
    if (r.code !== 0) { ctx.err(`orca adapter: gate-create failed for task ${a[0]} (see error above)\n`); return 1; }
    const j = jq(chomp(r.out), (d, emit) => some(emit, entityOf(d)));
    ctx.out(rawLines(j.vals)); jqErrs(ctx, j);
    return j.code;
  },
  /** <gate_id> <resolution> -> resolve a pending checkpoint gate. */
  async "gate-resolve"(ctx, a) {
    if (!need(ctx, a, 2)) return 1;
    const r = await orca(ctx, ["orchestration", "gate-resolve", "--id", a[0], "--resolution", a[1], ...fromArgs(ctx.env), "--json", "--full"]);
    if (r.code === 0) return 0;
    ctx.err(`orca adapter: gate-resolve failed for gate ${a[0]} (see error above)\n`);
    return 1;
  },
  /** <run_id> -> count of pending checkpoint gates, exactly one integer (best-effort); a result with no
   *  .gates counts 0 (not the object's key count). */
  async "gate-list"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["orchestration", "gate-list", "--run", a[0], ...fromArgs(ctx.env), "--json", "--full"], "drop");
    const n = jqr(chomp(r.out), (d, emit) => emit(jqLength(or(() => idx(idx(d, "result"), "gates"), () => []))));
    ctx.out(`${/^[0-9]+$/.test(n) ? n : "0"}\n`);
    return 0;
  },
  /** <run_id> <timeout_ms> [ack_delivery_id] -> ack the PRIOR batch (so it isn't replayed), then block until
   *  a REAL message lands or the timeout, draining keepalives transparently. Prints the batch JSON (empty on
   *  timeout). A rejected --ack surfaces on stderr (only 'keepalive' noise is dropped), so a bad ack-id
   *  doesn't silently replay forever. Used by bin/lib/watch.sh. */
  async "inbox-wait"(ctx, a) {
    if (!needIn(ctx, a, 2, 1)) return 1;
    return inboxWaitDrain(ctx, a[1], a[2] ?? "", ["--run", a[0]]);
  },
  /** <timeout_ms> [ack_delivery_id] -> inbox-wait on the CALLER's own worktree inbox (no --run), so a
   *  non-coordinator worker (a Thinker) can receive what the Lead sent it with send-worker. */
  async "inbox-wait-self"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    return inboxWaitDrain(ctx, a[0], a[1] ?? "", []);
  },
  /** <run_id> -> NON-BLOCKING peek: is a real message waiting, right now? No --wait, so it's a SHORT RPC that
   *  holds ZERO long-poll slots (unlike inbox-wait), and --peek leaves the message unread so the agent's
   *  woken turn still consumes+acks it. The rewake hook polls with this + a sleep gap. Prints the batch JSON
   *  (keepalives stripped). `--peek` ALONE = unread only, don't mark read (`--peek --unread` is rejected
   *  as "choose at most one read mode"). */
  "inbox-peek": peekVerb("--peek", true),
  /** -> inbox-peek on the CALLER's own worktree inbox (no --run). */
  "inbox-peek-self": peekVerb("--peek", false),
  /** <run_id> -> the Run's FULL message list (read ones too; marks nothing read), keepalives stripped like
   *  inbox-peek. Lets a consumed message be re-read without raw orca. */
  "inbox-all": peekVerb("--all", true),
  /** -> inbox-all on the CALLER's own worktree inbox (no --run). */
  "inbox-all-self": peekVerb("--all", false),
  /** <run_id> -> "<created epoch s>\t<message id>" per UNREAD real message to the Run. `check --run` is
   *  fenced to the Run's coordinator; the host-wide listing is not, so a reader outside the Run sees it. */
  async "inbox-unread"(ctx, a) {
    const r = a[0];
    const code = await unread(ctx,
      (m) => idx(m, "read") === 0 && r !== undefined && idx(m, "run_id") === r && idx(m, "to_handle") === `run:${r}`,
      (m) => `${interp(isoSec(idx(m, "created_at")))}\t${interp(idx(m, "id"))}`);
    if (code === 0 && r === undefined) ctx.err("orca.sh: $1: unbound variable\n"); // bash: in the jq pipe's subshell, after the read
    return code;
  },
  /** -> "<to_handle>\t<run_id>\t<created epoch s>\t<message id>" per UNREAD real message host-wide: every
   *  Run's and every worker's mail from ONE inbox read (the loop's per-tick read,
   *  bin/loop/observers/orca.ts). Same listing and filter as inbox-unread. */
  async "inbox-unread-all"(ctx) {
    return unread(ctx, (m) => idx(m, "read") === 0,
      (m) => `${interp(or(() => idx(m, "to_handle"), () => ""))}\t${interp(or(() => idx(m, "run_id"), () => ""))}\t${interp(isoSec(idx(m, "created_at")))}\t${interp(idx(m, "id"))}`);
  },
  /** <run_id> -> the Run's unread mail as a JSON array of messages (id, from_handle, type, subject, body,
   *  payload), read as the Run's coordinator: the loop's pane (DS_ORCA_FROM, `check --terminal`). peek
   *  leaves it unread; take is Orca's consuming check, which marks the oldest unread batch read and prints
   *  what it took (the loop relays a Run's mail to its Lead, bin/loop/messages/relay.ts). Exit 1 when Orca refuses
   *  (consumer_fenced: this pane doesn't hold the Run) or prints no list. */
  "run-inbox-peek": (ctx, a) => runInbox(ctx, "run-inbox-peek", a),
  "run-inbox-take": (ctx, a) => runInbox(ctx, "run-inbox-take", a),
};

// --- terminals (U225) -------------------------------------------------------------------------------
/** `.[]` without `?`: an array's items, an object's values, an error for anything else. */
function iter(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (isObj(v)) return Object.values(v);
  throw new JqError(`Cannot iterate over ${jqType(v)}${v === null || v === undefined ? "" : ` (${pretty(v, 0)})`}`);
}
const rank = (v: unknown): number => v === null || v === undefined ? 0 : v === false ? 1 : v === true ? 2
  : typeof v === "number" ? 3 : typeof v === "string" ? 4 : Array.isArray(v) ? 5 : 6;
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
/** jq's order: null < false < true < numbers < strings (by bytes) < arrays (item by item) < objects (their
 *  sorted keys first, then the values key by key). 0 is jq's `==`. */
export function jqCmp(a: any, b: any): number {
  const r = rank(a) - rank(b);
  if (r !== 0) return r;
  if (typeof a === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string") return byBytes(a, b);
  if (Array.isArray(a)) {
    for (let i = 0; ; i++) {
      if (i >= a.length || i >= b.length) return (i < a.length ? 1 : 0) - (i < b.length ? 1 : 0);
      const c = jqCmp(a[i], b[i]);
      if (c !== 0) return c;
    }
  }
  if (isObj(a)) {
    const ka = Object.keys(a).sort(byBytes), kb = Object.keys(b).sort(byBytes);
    const c = jqCmp(ka, kb);
    if (c !== 0) return c;
    for (const k of ka) { const d = jqCmp(a[k], b[k]); if (d !== 0) return d; }
  }
  return 0;
}
const jqEq = (a: unknown, b: unknown): boolean => jqCmp(a, b) === 0;
/** `sort_by(f)`: every item's key first, then a stable sort by jq's order. */
function sortBy<T>(xs: T[], f: (x: T) => unknown): T[] {
  return xs.map((x) => ({ x, k: f(x) })).sort((p, q) => jqCmp(p.k, q.k)).map((p) => p.x);
}
/** `group_by(f)`: sort_by(f), then runs of equal keys. */
function groupBy<T>(xs: T[], f: (x: T) => unknown): T[][] {
  const out: T[][] = [];
  let last: unknown;
  for (const p of xs.map((x) => ({ x, k: f(x) })).sort((p, q) => jqCmp(p.k, q.k))) {
    if (out.length && jqEq(p.k, last)) out[out.length - 1].push(p.x); else out.push([p.x]);
    last = p.k;
  }
  return out;
}
/** `max_by(f)` (and `max` with f the identity): the last of the greatest; null for []. An object is jq's error. */
function maxBy(v: unknown, f: (x: any) => unknown): any {
  if (!Array.isArray(v)) throw new JqError(`Cannot find the max of ${jqType(v)}`);
  let best: any = null, bk: unknown;
  v.map((x) => [x, f(x)] as const).forEach(([x, k], i) => { if (i === 0 || jqCmp(k, bk) >= 0) { best = x; bk = k; } });
  return best;
}
/** `.[$k]` for the cases `indices` falls through to: a field, an item, null on null, else jq's error. */
function jqGet(v: unknown, k: unknown): any {
  if (typeof k === "string") return idx(v, k);
  if (typeof k === "number") return at(v, k);
  if (v === null || v === undefined) return null;
  throw new JqError(`Cannot index ${jqType(v)} with ${jqType(k)}`);
}
/** jq's `index($x)` (`indices($x) | .[0]`): in an array, where $x (or the items of an array $x, in a row) first
 *  stands; in a string, the byte offset of a substring; else `.[$x] | .[0]`. null when it is not there. */
function jqIndex(v: unknown, x: unknown): any {
  if (Array.isArray(v)) {
    const b = Array.isArray(x) ? x : [x];
    if (!b.length) return null;
    for (let i = 0; i < v.length; i++) if (b.every((y, j) => i + j < v.length && jqEq(v[i + j], y))) return i;
    return null;
  }
  if (typeof v === "string" && typeof x === "string") {
    const i = x === "" ? -1 : Buffer.from(v).indexOf(Buffer.from(x));
    return i < 0 ? null : i;
  }
  return at(jqGet(v, x), 0);
}
/** jq's `a + b`. */
function jqAdd(a: any, b: any): any {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  if ((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string")) return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (isObj(a) && isObj(b)) return { ...a, ...b };
  throw new JqError(`${jqType(a)} (${pretty(a, 0)}) and ${jqType(b)} (${pretty(b, 0)}) cannot be added`);
}
/** jq's `a / b` for numbers (a string over a string is jq's split, which no caller has). */
function jqDiv(a: unknown, b: number): number {
  if (typeof a !== "number") throw new JqError(`${jqType(a)} (${pretty(a, 0)}) and number (${b}) cannot be divided`);
  return a / b;
}
/** jq's unary minus. */
function neg(v: unknown): number {
  if (typeof v !== "number") throw new JqError(`${jqType(v)} (${pretty(v, 0)}) cannot be negated`);
  return -v;
}
/** `gsub(re; " ")`: only a string can be matched. */
function gsub(v: unknown, re: RegExp, to: string): string {
  if (typeof v !== "string") throw new JqError(`${jqType(v)} (${pretty(v, 0)}) cannot be matched, as it is not a string`);
  return v.replace(re, to);
}
/** jq `@tsv` of one row. */
const tsvRow = (vs: unknown[]): string => tsv(vs.map(tsvCell));
/** A pipeline's exit under pipefail: the last command that failed, else 0. */
const pipe = (...codes: number[]): number => codes.filter((c) => c !== 0).at(-1) ?? 0;
/** `cmd | jq … 2>/dev/null || true`: the filter's outputs over these inputs, errors dropped. */
function jqVals(ins: unknown[], fn: (d: any, emit: (v: unknown) => void) => void): unknown[] {
  const vals: unknown[] = [];
  for (const d of ins) {
    try { fn(d, (v) => vals.push(v)); } catch (e) { if (!(e instanceof JqError)) throw e; }
  }
  return vals;
}
/** `merged_ps 2>/dev/null | jq …`: the merged ps, or no input at all when a host's answer was not JSON. */
async function psIns(ctx: Ctx): Promise<unknown[]> {
  try { return [await mergedPs(ctx)]; } catch (e) { if (e instanceof JqError) return []; throw e; }
}
const LIST = ["terminal", "list", "--limit", "1000", "--json"];
const terminalsOf = (d: unknown): any[] => each(idx(idx(d, "result"), "terminals"));
/** The whole list must be an array (agent-handles, terminal-shells: else the list is unparsable). */
function terminalArray(d: unknown): any[] {
  const ts = idx(idx(d, "result"), "terminals");
  if (!Array.isArray(ts)) throw new JqError("no terminal array");
  return ts;
}
/** A worker-list row's terminal: `.agentTerminalHandle // .resource.terminalHandle // ""`. */
const workerHandle = (w: unknown): any => or(() => idx(w, "agentTerminalHandle"), () => idx(idx(w, "resource"), "terminalHandle"), () => "");
/** The agent states of one ps worktree (`[($w.agents // [])[].state]`). */
const agentStates = (w: unknown): unknown[] => iter(or(() => idx(w, "agents"), () => [])).map((x) => idx(x, "state"));
/** `while read -r h` over sort's output: IFS whitespace trimmed from each line. */
const readTrim = (l: string): string => l.replace(/^[ \t\n]+|[ \t\n]+$/g, "");

/** `orca <args>` with its stdout and stderr passed on as they come (loop-terminals: the list is streamed). */
async function orcaStream(ctx: Ctx, args: string[]): Promise<number> {
  const cli = ctx.cli ?? resolveOrcaCli(ctx);
  if (!cli) return 1;
  if (ctx.signal?.aborted) return 143;
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn([cli, ...args], { stdin: ctx.stdin, stdout: "pipe", stderr: "pipe", env: { ...ctx.env } as Record<string, string>, signal: ctx.signal });
  } catch { ctx.err(`${cli}: command not found\n`); return 127; }
  const pump = async (s: ReadableStream<Uint8Array>, sink: Sink) => { for await (const c of s) sink(c); };
  await Promise.all([pump(p.stdout as ReadableStream<Uint8Array>, ctx.out), pump(p.stderr as ReadableStream<Uint8Array>, ctx.err)]);
  return p.exited;
}

/** terminal-shells' process scan: handle -> idle|busy, from each session leader with a tty (pid == session
 *  id, tty_nr != 0) whose environ names ORCA_TERMINAL_HANDLE. idle = the shell is its tty's foreground
 *  process group and its session holds no other process; busy = anything else. As the shell's builtins read
 *  them: stat's first newline-terminated line, the fields after the last ") ", environ's NUL-terminated entries. */
function shellStates(env: Env): Map<string, string> {
  const dir = env.DS_PROC || "/proc";
  const state = new Map<string, string>(), lead = new Map<string, string>(), more = new Set<string>();
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => /^[0-9]/.test(n)); } catch { names = []; }
  for (const n of names) {
    const d = `${dir}/${n}`;
    let line: string;
    try {
      const s = latin1(readFileSync(`${d}/stat`));
      if (!s.includes("\n")) continue;
      line = readTrim(s.slice(0, s.indexOf("\n")));
    } catch { continue; }
    const cut = line.lastIndexOf(") ");
    const f = readTrim(cut < 0 ? line : line.slice(cut + 2)).split(/[ \t\n]+/);
    const [pgrp = "", sid = "", tty = "", tpgid = ""] = f.slice(2, 6);
    if (n !== sid) { more.add(sid); continue; }
    if ((tty || "0") === "0") continue;
    try { accessSync(`${d}/environ`, constants.R_OK); } catch { continue; }
    let h = "";
    try {
      const kvs = latin1(readFileSync(`${d}/environ`)).split("\0").slice(0, -1);
      const kv = kvs.find((x) => x.startsWith("ORCA_TERMINAL_HANDLE="));
      if (kv) h = Buffer.from(kv.slice("ORCA_TERMINAL_HANDLE=".length), "latin1").toString("utf8");
    } catch { h = ""; }
    if (!h) continue;
    lead.set(sid, h);
    if (tpgid === pgrp) state.set(h, state.get(h) || "idle"); else state.set(h, "busy");
  }
  for (const [sid, h] of lead) if (more.has(sid)) state.set(h, "busy");
  return state;
}

/** <worktree_id> -> exit 1 with "orca adapter: <verb>: no live agent terminal for <wt>", else its handle. */
async function liveAgent(ctx: Ctx, verb: string, wt: string): Promise<string> {
  const h = await agentTerminal(ctx, wt);
  if (!h) ctx.err(`orca adapter: ${verb}: no live agent terminal for ${wt}\n`);
  return h;
}

/** The terminal verbs (U225). */
const TERMINALS: Record<string, Verb> = {
  /** <worktree_id> <title> [command] -> "<handle>\t<pane key>" of a new plain shell terminal: the loop's sender
   *  terminal for one Run (docs/spikes/loop-coordinator.md), or an orca-lite member's tab (bin/backend/orca-lite.ts,
   *  whose env rides on [command], typed into the new shell). The pane key (tabId:leafId) is what Orca matches the
   *  Run's coordinator by; it is read back from `terminal list` (empty when not listed yet). */
  async "terminal-create"(ctx, a) {
    // A missing argument fails the create's subshell, then the failure line (whose own $1 may be unbound).
    if (!need(ctx, a, 2)) {
      if (!need(ctx, a, 1)) return 1;
      ctx.err(`orca adapter: terminal-create failed in ${a[0]}\n`);
      return 1;
    }
    const cmd = blank(a[2]);
    const c = await orca(ctx, ["terminal", "create", "--worktree", `id:${a[0]}`, "--title", a[1], ...(cmd ? ["--command", cmd] : []), "--json"]);
    const j = jq(c.out, (d, emit) => some(emit, idx(idx(idx(d, "result"), "terminal"), "handle")));
    jqErrs(ctx, j);
    if (pipe(c.code, jqE(j)) !== 0) { ctx.err(`orca adapter: terminal-create failed in ${a[0]}\n`); return 1; }
    const h = chomp(rawLines(j.vals));
    const l = await orca(ctx, ["terminal", "list", "--json"], "drop");
    const p = jq(l.out, (d, emit) => {
      const keys = terminalsOf(d).filter((t) => jqEq(idx(t, "handle"), h) && truthy(idx(t, "tabId")) && truthy(idx(t, "leafId")))
        .map((t) => `${interp(idx(t, "tabId"))}:${interp(idx(t, "leafId"))}`);
      some(emit, keys[0] ?? null);
    });
    jqErrs(ctx, p);
    const rc = pipe(l.code, p.code);
    if (rc !== 0) return rc;
    ctx.out(`${h}\t${chomp(rawLines(p.vals))}\n`);
    return 0;
  },
  /** <pane key> -> the live handle of that pane (a restarted Orca hands out new handles for the same pane);
   *  empty when the pane is gone. */
  async "terminal-find"(ctx, a) {
    const l = await orca(ctx, ["terminal", "list", "--json"], "drop");
    if (!need(ctx, a, 1)) return 1;
    const j = jq(l.out, (d, emit) => {
      const hs = terminalsOf(d).filter((t) => jqEq(jqAdd(jqAdd(or(() => idx(t, "tabId"), () => ""), ":"), or(() => idx(t, "leafId"), () => "")), a[0]))
        .map((t) => idx(t, "handle"));
      some(emit, hs[0] ?? null);
    });
    ctx.out(rawLines(j.vals)); jqErrs(ctx, j);
    return pipe(l.code, j.code);
  },
  /** -> "<worktree_id>\t<handle>\t<title>" per live AGENT terminal (agent_terminal's selector: agentIdentity
   *  set, connected, writable, not orphaned), host-wide, newest output first within a worktree. A plain shell
   *  (the loop's own `ds-loop` pane) never shows. Exit 1 when the list can't be read or parsed. */
  async "agent-handles"(ctx) {
    const l = await orca(ctx, LIST, "drop");
    if (l.code !== 0) { ctx.err("orca adapter: agent-handles could not read the terminal list\n"); return 1; }
    const j = jq(l.out, (d, emit) => {
      const live = terminalArray(d).filter((t) => idx(t, "worktreeId") !== null && isAgent(t));
      for (const t of sortBy(live, (t) => [idx(t, "worktreeId"), neg(or(() => idx(t, "lastOutputAt"), () => 0))])) {
        emit(`${interp(idx(t, "worktreeId"))}\t${interp(idx(t, "handle"))}\t${gsub(or(() => idx(t, "title"), () => ""), /[\t\n]/g, " ")}`);
      }
    });
    ctx.out(rawLines(j.vals));
    if (j.code !== 0) { ctx.err("orca adapter: agent-handles could not parse the terminal list\n"); return 1; }
    return 0;
  },
  /** Host-wide terminal facts for the observer. U248: inside a loop tick the list is the tick's shared copy (the signals read, the observer and the reconcilers
   *  all ask for it); outside one it is streamed as it comes. */
  async "loop-terminals"(ctx) {
    if (!ctx.env.DS_ORCA_TICK_DIR) return orcaStream(ctx, LIST);
    const r = await orca(ctx, LIST, "pass");
    ctx.out(r.outBytes);
    return r.code;
  },
  /** -> "<worktree_id>" per worktree with a live terminal (unique). Host-wide: worktree ids are globally
   *  unique, so no run scoping is needed. This is the phone book's liveness source: an idle standing role
   *  (Lead/Thinker between wakes) shows as `completed` + `terminalState: retained` in worker-list, so neither
   *  dispatch status nor terminalState can tell whether it is alive — but `terminal list` still shows its
   *  terminal (host-confirmed 2026-10-28). Orphaned tabs (backing gone) don't count; anything else does —
   *  delivery is judged by the send receipt, so this stays permissive. Exit 1 when the list can't be read
   *  (the phone book then reports liveness unknown instead of guessing). */
  async "wt-terminals"(ctx) {
    const l = await orca(ctx, LIST, "drop");
    if (l.code !== 0) { ctx.err("orca adapter: wt-terminals could not read the terminal list\n"); return 1; }
    const j = jq(l.out, (d, emit) => {
      const wts = terminalsOf(d).filter((t) => idx(t, "worktreeId") !== null && idx(t, "orphaned") !== true).map((t) => idx(t, "worktreeId"));
      for (const g of groupBy(wts, (w) => w)) emit(g[0]);
    });
    ctx.out(rawLines(j.vals));
    if (j.code !== 0) { ctx.err("orca adapter: wt-terminals could not parse the terminal list\n"); return 1; }
    return 0;
  },
  /** -> "<worktree_id>\t<handle>\t<idle|busy|unknown>\t<last output, epoch s|->\t<title>" per live terminal
   *  in a worktree with NO agent (a plain shell: agentIdentity unset, connected, not orphaned). Host-wide;
   *  members.ts closes the idle ones in member worktrees (U79: `@worktree:` mail landed in one). idle = its
   *  shell is the foreground process group of its tty and its session holds no other process (nothing runs
   *  in it, not even a stopped or background job); busy = anything else; unknown = no session leader of it
   *  was readable in $DS_PROC (default /proc), found by ORCA_TERMINAL_HANDLE in its environ. Exit 1 when the
   *  terminal list can't be read or parsed. */
  async "terminal-shells"(ctx) {
    const l = await orca(ctx, LIST, "drop");
    if (l.code !== 0) { ctx.err("orca adapter: terminal-shells could not read the terminal list\n"); return 1; }
    const j = jq(l.out, (d, emit) => {
      for (const t of terminalArray(d)) {
        if (!(idx(t, "worktreeId") !== null && idx(t, "agentIdentity") === null && idx(t, "connected") === true && idx(t, "orphaned") !== true)) continue;
        const out = idx(t, "lastOutputAt");
        emit(tsvRow([idx(t, "worktreeId"), idx(t, "handle"),
          truthy(out) ? interp(Math.floor(jqDiv(out, 1000))) : "-", gsub(or(() => idx(t, "title"), () => ""), /[\t\n]/g, " ")]));
      }
    });
    if (j.code !== 0) { ctx.err("orca adapter: terminal-shells could not parse the terminal list\n"); return 1; }
    const rows = chomp(rawLines(j.vals));
    if (!rows) return 0;
    const state = shellStates(ctx.env);
    for (const row of rows.split("\n")) {
      const [wt, h, out, title] = readTabs(row, 4);
      ctx.out(`${wt}\t${h}\t${state.get(h) || "unknown"}\t${out}\t${title}\n`);
    }
    return 0;
  },
  /** <handle> -> close one terminal (members.ts closes an idle stray shell, U79). */
  async "terminal-close"(ctx, a) {
    if (!a[0]) { ctx.err("usage: terminal-close <handle>\n"); return 2; }
    const r = await orca(ctx, ["terminal", "close", "--terminal", a[0], "--json"], "merge");
    const out = chomp(r.out);
    const say = (what: string) => ctx.err(Buffer.concat([Buffer.from(`orca adapter: terminal-close ${a[0]} ${what}: `), head300(out), Buffer.from("\n")]));
    if (r.code !== 0) { say("failed"); return 1; }
    if (jqr(out, (d, emit) => { if (idx(d, "ok") === false) emit("false"); }) === "false") { say("refused"); return 1; }
    ctx.out(`terminal-close: closed ${a[0]}\n`);
    return 0;
  },
  /** -> "<handle>\t<worktreeId>\t<tabId:leafId>\t<last output, epoch s|->" per terminal Orca lists that is not
   *  orphaned, agent or plain shell alike (the orca-lite backend's list, bin/backend/orca-lite.ts); an empty pane key
   *  or worktree when Orca gives none. Exit 1 when the list can't be read or parsed. */
  async "terminal-panes"(ctx) {
    const l = await orca(ctx, LIST, "drop");
    let ts: unknown;
    try { ts = l.code === 0 ? (JSON.parse(l.out) as { result?: { terminals?: unknown } }).result?.terminals : null; } catch { ts = null; }
    if (!Array.isArray(ts)) { ctx.err("orca adapter: terminal-panes could not read the terminal list\n"); return 1; }
    const flat = (v: unknown) => (typeof v === "string" ? v.replace(/[\t\n]/g, " ") : "");
    for (const t of ts as Record<string, unknown>[]) {
      if (!t || typeof t.handle !== "string" || t.orphaned === true) continue;
      const pane = t.tabId && t.leafId ? `${flat(t.tabId)}:${flat(t.leafId)}` : "";
      const out = typeof t.lastOutputAt === "number" ? String(Math.floor(t.lastOutputAt / 1000)) : "-";
      ctx.out(`${flat(t.handle)}\t${flat(t.worktreeId)}\t${pane}\t${out}\n`);
    }
    return 0;
  },
  /** <handle> <text> [enter] -> write <text> to that terminal as is (control bytes pass through), plain shell or
   *  agent, with Enter after it when `enter` is given; prints `turn_started` when Orca's receipt saw the agent start
   *  a turn (it waits up to 10 s for one), else `accepted` (orca-lite's terminal.send). Exit 1 = the send failed. */
  async "terminal-type"(ctx, a) {
    if (!need(ctx, a, 2)) return 1;
    const enter = a[2] === "enter";
    const r = await orca(ctx, ["terminal", "send", "--terminal", a[0], "--text", a[1], ...(enter ? ["--enter", "--wait-submit", "10"] : []), "--json"], "keep");
    let d: { ok?: unknown; result?: { send?: { prompt?: { stages?: unknown } } } } | null = null;
    try { d = JSON.parse(chomp(r.out)); } catch { d = null; }
    if (r.code !== 0 || d?.ok === false) { ctx.err(`orca adapter: terminal-type: terminal send failed for ${a[0]}: ${chomp(r.out + r.err).slice(0, 300)}\n`); return 1; }
    const stages = d?.result?.send?.prompt?.stages;
    ctx.out(`${enter && Array.isArray(stages) && stages.includes("turn_started") ? "turn_started" : "accepted"}\n`);
    return 0;
  },
  /** <handle> [screen|stream] [limit] -> that terminal's output, one line each: the rendered screen with `screen`,
   *  else the accumulated output (escape sequences stripped), at most [limit] lines (orca-lite's terminal.read).
   *  Exit 3 when Orca has no such terminal, 1 when the read failed. */
  async "terminal-read"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const limit = /^[1-9][0-9]*$/.test(a[2] ?? "") ? a[2] : "";
    const r = await orca(ctx, ["terminal", "read", "--terminal", a[0], ...(a[1] === "screen" ? ["--screen"] : []), ...(limit ? ["--limit", limit] : []), "--json"], "keep");
    let d: { ok?: unknown; result?: { terminal?: { tail?: unknown } } } | null = null;
    try { d = JSON.parse(chomp(r.out)); } catch { d = null; }
    const tail = d?.result?.terminal?.tail;
    if (r.code === 0 && Array.isArray(tail)) {
      const lines = tail.map((x) => (typeof x === "string" ? x : ""));
      ctx.out(lines.length ? `${lines.join("\n")}\n` : "");
      return 0;
    }
    if (/not_found/.test(r.out + r.err)) return 3;
    ctx.err(`orca adapter: terminal-read failed for ${a[0]}: ${chomp(r.out + r.err).slice(0, 300)}\n`);
    return 1;
  },
  /** <worktree_id> <tabId:leafId> -> the state `worktree ps` gives the agent in that pane (`working`, `waiting`,
   *  `done`, …), or nothing when ps lists no agent there: Orca reports a plain tab's agent only in a worktree
   *  `orca worktree create` made (docs/backends/orca-probe.md Q5). orca-lite's agent.state. */
  async "pane-state"(ctx, a) {
    if (!need(ctx, a, 2)) return 1;
    for (const d of await psIns(ctx)) {
      const wts = (d as { result?: { worktrees?: unknown } })?.result?.worktrees;
      if (!Array.isArray(wts)) continue;
      for (const w of wts as { worktreeId?: unknown; agents?: unknown }[]) {
        if (w?.worktreeId !== a[0] || !Array.isArray(w.agents)) continue;
        const ag = (w.agents as { paneKey?: unknown; state?: unknown }[]).find((x) => x?.paneKey === a[1]);
        if (ag && typeof ag.state === "string") { ctx.out(`${ag.state}\n`); return 0; }
      }
    }
    return 0;
  },
  /** <worktree-selector> [keep-handle|--strict] -> close EVERY terminal TAB on this worktree in ONE native call
   *  (orca terminal close --worktree <sel> --all). worktree-rm stops the worker but LEAVES the tab open, and
   *  tabs hold Orca's long-poll capacity — the real saturation (tabs jammed it with 0 active workers).
   *  restart-role (before a fresh start) and close-squad (before rm) call this so neither strands tabs.
   *  Selector is id:/name:/path: etc. --strict: a failed close fails (cancellation retries and alerts on it);
   *  ordinary callers keep best-effort behavior. [keep-handle]: every tab but that one (the loop's pane in a
   *  Lead's worktree, U59), one close each; an unreadable list closes none. */
  async "terminal-close-worktree"(ctx, a) {
    if (!a[0]) { ctx.err("orca adapter: terminal-close-worktree needs a worktree selector\n"); return 2; }
    const all = ["terminal", "close", "--worktree", a[0], "--all", "--json"];
    if (a[1] === "--strict") return (await orca(ctx, all)).code;
    if (!a[1]) { await orca(ctx, all, "drop"); return 0; }
    if (!a[0].startsWith("id:")) { ctx.err("orca adapter: terminal-close-worktree keeps a tab only with an id: selector\n"); return 2; }
    const l = await orca(ctx, LIST, "drop");
    const j = l.code === 0 ? jq(l.out, (d, emit) => {
      for (const t of terminalsOf(d)) if (jqEq(idx(t, "worktreeId"), a[0].slice(3))) emit(idx(t, "handle"));
    }) : null;
    if (!j || j.code !== 0) { ctx.err(`orca adapter: terminal-close-worktree could not list ${a[0]}'s tabs: closing none\n`); return 0; }
    for (const h of chomp(rawLines(j.vals)).split("\n")) {
      if (h && h !== a[1]) await orca(ctx, ["terminal", "close", "--terminal", h], "drop");
    }
    return 0;
  },
  /** -> close every ORPHANED terminal tab host-wide (backing worktree/pty gone), to free long-poll capacity
   *  stranded by already-closed squads. ONLY orphaned==true — never a connected/live tab — so it CANNOT close
   *  the operator's own working terminals or another project's. Prints count. */
  async "terminal-reap-orphaned"(ctx) {
    const l = await orca(ctx, ["terminal", "list", "--limit", "100", "--json"], "drop");
    const hs = jq(l.out, (d, emit) => { for (const t of terminalsOf(d)) if (idx(t, "orphaned") === true) some(emit, idx(t, "handle")); }).vals;
    let n = 0;
    for (const h of lines(rawLines(hs))) {
      if (h && (await orca(ctx, ["terminal", "close", "--terminal", h], "drop")).code === 0) n++;
    }
    ctx.out(`${n}\n`);
    return 0;
  },
  /** [<worktree-name-prefix>] -> "<count>\tterminals" : a live-resource count for the board. Orca's real
   *  constraint is concurrent long-polls (cap 16), but since the push-on-idle wake landed, agents hold ~0
   *  long-polls at rest — so the live TERMINAL count is no longer a long-poll gauge, just "how many live
   *  terminals". Useful next to "live worktrees": terminals >> worktrees means a tab leak. With a name-prefix
   *  (e.g. "ds-myproj-"), counts ONLY this studio's terminals — join worktree ps (displayName startswith
   *  prefix -> path) against terminals' worktreePath; without, machine-wide totalCount. A backend with
   *  nothing to report prints nothing. */
  async capacity(ctx, a) {
    const pref = a[0] ?? "";
    let tc = "";
    if (!pref) {
      const l = await orca(ctx, ["terminal", "list", "--limit", "100", "--json"], "drop");
      tc = jqr(l.out, (d, emit) => some(emit, idx(idx(d, "result"), "totalCount")));
    } else {
      // `{ merged_ps; orca terminal list … || echo '{}'; } | jq -s`: merged_ps's own jq error reaches stderr.
      const ins: unknown[] = [];
      try { ins.push(await mergedPs(ctx)); } catch (e) {
        if (!(e instanceof JqError)) throw e;
        ctx.err(e.message.startsWith("parse error") ? `jq: ${e.message}\n` : `jq: error: ${e.message}\n`);
      }
      const l = await orca(ctx, ["terminal", "list", "--limit", "100", "--json"], "drop");
      const s = scan(l.out + (l.code !== 0 ? "{}\n" : ""));
      if (!s.bad) {
        ins.push(...s.vals);
        try {
          const paths = each(idx(idx(ins[0] ?? null, "result"), "worktrees")).filter((w) => {
            const n = or(() => idx(w, "displayName"), () => "");
            if (typeof n !== "string") throw new JqError("startswith() requires string inputs");
            return n.startsWith(pref);
          }).map((w) => idx(w, "path"));
          const n = terminalsOf(ins[1] ?? null).filter((t) => {
            const w = or(() => idx(t, "worktreePath"), () => "");
            return jqCmp(jqLength(w), 0) > 0 && jqIndex(paths, w) !== null;
          }).length;
          tc = String(n);
        } catch (e) { if (!(e instanceof JqError)) throw e; tc = ""; }
      }
    }
    if (isNum(tc)) ctx.out(`${tc}\tterminals`);
    return 0;
  },
  /** -> "<worktreeId>\t<newest lastOutputAt, epoch ms>" per worktree with a terminal. worker-states can't tell
   *  a hung `working` agent from a busy one; output age can (the removed sweep). A short RPC — no sender
   *  terminal needed. */
  async "terminal-activity"(ctx) {
    const l = await orca(ctx, LIST, "drop");
    ctx.out(rawLines(jq(l.out, (d, emit) => {
      const ts = terminalsOf(d).filter((t) => idx(t, "worktreeId") !== null && idx(t, "lastOutputAt") !== null);
      for (const g of groupBy(ts, (t) => idx(t, "worktreeId"))) {
        emit(`${interp(idx(g[0], "worktreeId"))}\t${interp(maxBy(g.map((t) => idx(t, "lastOutputAt")), (v) => v))}`);
      }
    }).vals));
    return 0;
  },
  /** <worktreeId> <text> -> type <text> + Enter into the worktree's live AGENT terminal. The way to wake an
   *  agent that stopped listening (usage limit, idle with unread mail): an inbox message waits unread, typed
   *  text starts a turn. No sender terminal needed (the removed sweep runs it from cron). Exit 0 = the agent
   *  started a turn; 3 = text accepted but no turn seen in 10s; 1 = no agent terminal / failed. The CALLER
   *  may poke a working Claude agent only for the PR pokes (U148: Claude queues the typed text for its next
   *  step); any other agent must be idle (text would land mid-turn). */
  async poke(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const h = await liveAgent(ctx, "poke", a[0]);
    if (!h) return 1;
    // A missing text fails the send's subshell: the send-failed line follows.
    if (!need(ctx, a, 2)) { ctx.err(`orca adapter: poke: terminal send failed for ${a[0]}\n`); return 1; }
    // stderr kept out of the answer: a warning there would break the JSON parse below.
    const r = await orca(ctx, ["terminal", "send", "--terminal", h, "--text", a[1], "--enter", "--wait-submit", "10", "--json"], "drop");
    if (r.code !== 0) { ctx.err(`orca adapter: poke: terminal send failed for ${a[0]}\n`); return 1; }
    const j = jq(chomp(r.out), (d, emit) => emit(jqIndex(or(() => idx(idx(idx(idx(d, "result"), "send"), "prompt"), "stages"), () => []), "turn_started")));
    return jqE(j) === 0 ? 0 : 3;
  },
  /** <terminal handle> <text> -> type <text> + Enter into that terminal. For a sender the loop holds only by
   *  handle (a request's `from`): no worktree to look an agent up by. Exit 0 = sent; 1 = not a live agent
   *  terminal / the send failed. */
  async "poke-terminal"(ctx, a) {
    if (!a[0]) { ctx.err("orca adapter: poke-terminal: needs a terminal handle\n"); return 1; }
    // Only a live AGENT terminal (agent_terminal's selector): a plain shell would run the line as a command.
    const l = await orca(ctx, LIST, "drop");
    const j = jq(l.out, (d, emit) => emit(terminalsOf(d).filter((t) => idx(t, "handle") === a[0] && isAgent(t)).length > 0));
    if (pipe(l.code, jqE(j)) !== 0) { ctx.err(`orca adapter: poke-terminal: ${a[0]} is not a live agent terminal\n`); return 1; }
    if (!need(ctx, a, 2)) return 1;
    const r = await orca(ctx, ["terminal", "send", "--terminal", a[0], "--text", a[1], "--enter", "--json"], "drop");
    if (r.code !== 0) { ctx.err(`orca adapter: poke-terminal: terminal send failed for ${a[0]}\n`); return 1; }
    return 0;
  },
  /** <worktreeId> <text> [enter] -> type <text> into the worktree's live AGENT terminal, with NO Enter unless
   *  `enter` is given: a digit picks that option of a live AskUserQuestion picker at once (an Enter would
   *  select whichever option is highlighted). `enter` is a separate send: Orca refuses text + Enter in one
   *  send while a picker shows (agent_prompt_blocked). The board answers picker entries with it
   *  (bin/loop/fulfil/answer.ts). Exit 1 = no agent terminal / failed. */
  async keys(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const h = await liveAgent(ctx, "keys", a[0]);
    if (!h) return 1;
    if (!need(ctx, a, 2)) return 1;
    if ((await orca(ctx, ["terminal", "send", "--terminal", h, "--text", a[1], "--json"], "drop")).code !== 0) {
      ctx.err(`orca adapter: keys: terminal send failed for ${a[0]}\n`); return 1;
    }
    if (a[2] === "enter" && (await orca(ctx, ["terminal", "send", "--terminal", h, "--enter", "--json"], "drop")).code !== 0) {
      ctx.err(`orca adapter: keys: Enter failed for ${a[0]}\n`); return 1;
    }
    return 0;
  },
  /** <worktreeId> -> switch the UI to the worktree's live AGENT terminal (the one poke types into). Found by
   *  worktree, not by run, so a restarted/reloaded agent whose terminal the run doesn't list is still found.
   *  Exit 1 = no live agent terminal. */
  async focus(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const h = await liveAgent(ctx, "focus", a[0]);
    if (!h) return 1;
    if ((await orca(ctx, ["terminal", "switch", "--terminal", h], "drop")).code !== 0) {
      ctx.err(`orca adapter: focus: terminal switch failed for ${h}\n`); return 1;
    }
    return 0;
  },
  /** <worktreeId | term_ handle> -> the rendered bottom of the agent terminal's screen, one line each (where
   *  Claude Code prints a usage-limit notice). Empty if no agent terminal. */
  async "screen-tail"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    ctx.out(await screenTail(ctx, a[0]));
    return 0;
  },
  /** -> "<worktree-id>\t<working|waiting|done|idle>\t<displayName>\t<state-since ms>\t<last said>" for every
   *  worktree. The backend owns the state mapping, so the watch/board stay backend-agnostic. Built on
   *  merged_ps so remote-host workers aren't reported GONE. Cols 4-5 (newest agent's stateStartedAt + the END
   *  of its last message — where a closing question sits — one line) let the Lead see a Builder that is just
   *  sitting; older readers only use cols 1-3. */
  async "worker-states"(ctx) {
    ctx.out(rawLines(jqVals(await psIns(ctx), (d, emit) => {
      for (const w of each(idx(idx(d, "result"), "worktrees"))) {
        const s = agentStates(w);
        const ag = maxBy(or(() => idx(w, "agents"), () => []), (x) => or(() => idx(x, "stateStartedAt"), () => 0));
        const state = truthy(jqIndex(s, "working")) ? "working" : truthy(jqIndex(s, "waiting")) ? "waiting" : truthy(jqIndex(s, "done")) ? "done" : "idle";
        const said = [...gsub(or(() => idx(ag, "lastAssistantMessage"), () => ""), /[\t\n\r]+/g, " ")];
        emit(`${interp(idx(w, "worktreeId"))}\t${state}\t${interp(idx(w, "displayName"))}\t${interp(or(() => idx(ag, "stateStartedAt"), () => ""))}\t`
          + (said.length > 200 ? `…${said.slice(-200).join("")}` : said.join("")));
      }
    })));
    return 0;
  },
  /** <run_id> -> "<worktree_id>\t<backend-specific live-terminal handle>" per worktree. Lets a generic view
   *  (team.sh) enrich the roster AND act on it (switch/close) with whatever THIS backend knows — the token is
   *  opaque to the view. Orca: the LIVE terminal handle. Keyed on terminalState=="active", NOT dispatch
   *  status: the two are separate accounting, so a completed dispatch can still own the live terminal (and
   *  the dead retained/reclaimable ones are the sidebar's "+N" history, not the live session). A backend with
   *  no such concept returns nothing. */
  async "worker-detail"(ctx, a) {
    if (!need(ctx, a, 1)) return 0;
    const r = await orca(ctx, ["orchestration", "worker-list", "--run", a[0], "--json", "--full"], "drop");
    const text = rawLines(jq(r.out, (d, emit) => {
      for (const w of each(idx(idx(d, "result"), "workers"))) {
        if (idx(w, "terminalState") !== "active" || jqEq(wtOf(w), "")) continue;
        emit(`${interp(wtOf(w))}\t${interp(workerHandle(w))}`);
      }
    }).vals);
    // awk -F'\t' '$2!="" && !seen[$1 FS $2]++'
    const seen = new Set<string>();
    for (const l of lines(text)) {
      const [f1 = "", f2 = ""] = l.split("\t");
      if (f2 === "" || seen.has(`${f1}\t${f2}`)) continue;
      seen.add(`${f1}\t${f2}`);
      ctx.out(`${l}\n`);
    }
    return 0;
  },
  /** <handle> -> focus (switch to) that terminal tab in the UI. Non-destructive. */
  async "terminal-switch"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    if ((await orca(ctx, ["terminal", "switch", "--terminal", a[0]], "drop")).code !== 0) {
      ctx.err(`orca adapter: terminal switch failed for ${a[0]}\n`); return 1;
    }
    return 0;
  },
  /** <run_id> [worktree_id] -> keep only what's meaningful: KEEP each worktree's owner (the newest
   *  worker-list entry whose terminal is CONNECTED in `orca terminal list`) and close everything else — all
   *  its dead "+N" history AND any older duplicate live terminal. With a worktree_id, just that worktree
   *  (used after a restart, where the fresh dispatch is newest = owner); without it, every worktree in the
   *  run (the cleanup sweep). A worktree with no connected terminal gets all its dead ones closed. Prints how
   *  many it closed; a backend without terminals is a no-op. Liveness is the TERMINAL's, not the dispatch's:
   *  a worker launched with `--terminal` (auto-compact window) stays terminalState=retained, never active.
   *  ponytail: "owner = newest connected" is a heuristic — a hand-split extra pane would be closed too. Fine
   *  for the one-session-per-worktree squad model. */
  async "terminal-reap"(ctx, a) {
    // An unusable terminal list means "unknown", not "nothing is connected": close nothing.
    const l = await orca(ctx, LIST, "drop");
    const conn = chomp(jq(l.out, (d, emit) => {
      const ts = idx(idx(d, "result"), "terminals");
      if (Array.isArray(ts)) emit(ts.filter((t) => idx(t, "connected") === true).map((t) => idx(t, "handle")));
    }).vals.map((v) => `${pretty(v, 0)}\n`).join(""));
    if (!conn) { ctx.out("0\n"); return 0; }
    if (!need(ctx, a, 1)) { ctx.out("0\n"); return 0; }
    const w = a[1] ?? "";
    const wl = await orca(ctx, ["orchestration", "worker-list", "--run", a[0], "--json", "--full"], "drop");
    // --argjson takes exactly one JSON value: several lines of it fail jq, which then reaps nothing.
    const cs = scan(conn);
    const hs = cs.bad || cs.vals.length !== 1 ? [] : jq(wl.out, (d, emit) => {
      const rows = each(idx(idx(d, "result"), "workers")).map((x) => ({ wt: wtOf(x), h: workerHandle(x) }))
        .filter((r) => !jqEq(r.wt, "") && !jqEq(r.h, "") && (w === "" || jqEq(r.wt, w)));
      for (const g of groupBy(rows, (r) => r.wt)) {
        const keep = or(() => idx(at(g.filter((r) => truthy(jqIndex(cs.vals[0], r.h))), 0), "h"), () => "");
        for (const r of g) if (!jqEq(r.h, keep)) emit(r.h);
      }
    }).vals;
    // | sort -u (byte order), then `while IFS= read -r h`.
    const sorted = [...new Set(lines(rawLines(hs)))].sort(byBytes);
    let n = 0;
    for (const h of sorted) {
      const t = readTrim(h);
      if (t && (await orca(ctx, ["terminal", "close", "--terminal", t], "drop")).code === 0) n++;
    }
    ctx.out(`${n}\n`);
    return 0;
  },
  /** -> "<worktreeId>\t<active|waiting>" per worktree whose agent is doing something (Orca: state
   *  working->active, waiting->waiting; idle/done omitted). The backend owns the mapping, so the board stays
   *  backend-agnostic. */
  async activity(ctx) {
    ctx.out(rawLines(jqVals(await psIns(ctx), (d, emit) => {
      for (const w of each(idx(idx(d, "result"), "worktrees"))) {
        const s = agentStates(w);
        if (truthy(jqIndex(s, "working"))) emit(`${interp(idx(w, "worktreeId"))}\tactive`);
        else if (truthy(jqIndex(s, "waiting"))) emit(`${interp(idx(w, "worktreeId"))}\twaiting`);
      }
    })));
    return 0;
  },
  /** -> displayNames (one per line) of worktrees whose agent is WAITING for input. The backend owns what
   *  "waiting" means (Orca: agents[].state=="waiting"), so the board stays backend-agnostic. Merged across
   *  hosts. */
  async attention(ctx) {
    ctx.out(rawLines(jqVals(await psIns(ctx), (d, emit) => {
      for (const w of each(idx(idx(d, "result"), "worktrees"))) {
        if (truthy(jqIndex(each(idx(w, "agents")).map((x) => idx(x, "state")), "waiting"))) emit(idx(w, "displayName"));
      }
    })));
    return 0;
  },
};

// --- runs and workers (U226) -------------------------------------------------------------------------
/** jq over values already read (not a text): a runtime error ends that input, as in jq(). */
function jqOn(ins: unknown[], fn: (d: any, emit: (v: unknown) => void) => void): Jq {
  const vals: unknown[] = [], errs: string[] = [];
  let failed = false;
  for (const d of ins) {
    try { fn(d, (v) => vals.push(v)); failed = false; }
    catch (e) { if (!(e instanceof JqError)) throw e; errs.push(e.message); failed = true; }
  }
  return { vals, code: failed ? 5 : 0, errs };
}
/** `jq -r` of these outputs as `$(…)` held them. */
const jqOut = (j: Jq): string => chomp(rawLines(j.vals));
/** The first line `jq -r … | head -n1` printed. */
const firstLine = (j: Jq): string => rawLines(j.vals).split("\n")[0];
/** jq's `test(re)`: only a string can be matched. */
function matches(v: unknown, re: RegExp): boolean {
  if (typeof v !== "string") throw new JqError(`${jqType(v)} (${pretty(v, 0)}) cannot be matched, as it is not a string`);
  return re.test(v);
}
/** jq's `fromjson`. */
function fromJson(s: string): unknown {
  try { return JSON.parse(s); } catch { throw new JqError(`${s} (while parsing '${s}')`); }
}
// Oniguruma's `\b` after "ds-loop": the next character is not a word character.
const DS_LOOP = /^ds-loop(?![\p{L}\p{M}\p{Nd}\p{Pc}])/u;
const PAUSE_SKIP = /^ds-loop(?![\p{L}\p{M}\p{Nd}\p{Pc}])|claude -p/u;
const title = (t: unknown): unknown => or(() => idx(t, "title"), () => "");
/** `.ok != false and .result.ok != false and (.ok == true or .result.ok == true)`: Orca confirmed it. */
const okConfirmed = (d: unknown): boolean =>
  idx(d, "ok") !== false && idx(idx(d, "result"), "ok") !== false && (idx(d, "ok") === true || idx(idx(d, "result"), "ok") === true);
/** A child shell's copy of the environment (`$(…)`): what it unsets stays there. */
const sub = (ctx: Ctx): Ctx => ({ ...ctx, env: { ...ctx.env } });
const say = (ctx: Ctx, s: string): void => ctx.err(`${s}\n`);
/** need() for a positional the shell read twice, once in a `$(…)` and again in the main shell: both name it. */
function needTwice(ctx: Ctx, a: string[], n: number): boolean {
  if (need(ctx, a, n)) return true;
  need(ctx, a, n);
  return false;
}

// --- files, as the shell's tests saw them
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const writable = (p: string): boolean => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };
/** `[ a -ef b ]`. */
function sameFile(a: string, b: string): boolean {
  try { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}
/** `cmp -s a b`. */
const sameBytes = (a: string, b: string): boolean => { try { return Buffer.compare(readFileSync(a), readFileSync(b)) === 0; } catch { return false; } };
/** `readlink -f`: the canonical path; its last part need not exist. "" when a folder above it is missing. */
function readlinkF(p: string): string {
  try { return realpathSync(p); } catch { /* the last part is missing */ }
  try { return join(realpathSync(dirname(p)), basename(p)); } catch { return ""; }
}
/** `$(cat f 2>/dev/null || true)`. */
const readText = (f: string): string => { try { return chomp(readFileSync(f, "utf8")); } catch { return ""; } };
/** `${wt##*::}`: the worktree's path part. */
const wtPath = (wt: string): string => wt.replace(/^.*::/s, "");

// --- printf %q -------------------------------------------------------------------------------------
/** The shell's locale (LC_ALL, LC_CTYPE, LANG): a UTF-8 one prints a printable non-ASCII character as is. */
export { bashQ };
/** shim_path: `PATH=<bin/hooks/path-gates>:$PATH` for the front of a role's claude command (U235). The hook
 *  shims gate the lavish-axi / gh-axi / chrome-devtools-axi SessionStart hooks by role on every account
 *  without touching any settings.json (Orca rewrites a profile's). `$PATH` stays literal: the terminal's
 *  shell expands it. */
function gates(env: Env): string {
  const d = resolve(root(env), "bin", "hooks", "path-gates");
  return isDir(d) ? d : "";
}

// --- the pause verbs' reads
/** pause_terminals: the worktree's exact agent identities. Shells and the loop's control pane never qualify.
 *  The text jq printed and the pipeline's exit; jq's errors on stderr. */
async function pauseTerminals(ctx: Ctx, wt: string): Promise<{ text: string; code: number }> {
  const r = await orca(ctx, ["terminal", "list", "--worktree", `id:${wt}`, "--limit", "1000", "--json"]);
  const j = jq(r.out, (d, emit) => {
    if (idx(d, "ok") === false || jqType(idx(idx(d, "result"), "terminals")) !== "array") throw new JqError("invalid terminal listing");
    emit((idx(idx(d, "result"), "terminals") as unknown[]).filter((t) => idx(t, "worktreeId") === wt && isAgent(t) && !matches(title(t), PAUSE_SKIP)));
  });
  jqErrs(ctx, j);
  return { text: j.vals.map((v) => `${pretty(v)}\n`).join(""), code: pipe(r.code, jqE(j)) };
}
/** `jq -e --arg h <h> 'any(.[]; .handle == $h)'` over a pause_terminals answer, errors on stderr. */
function listsHandle(ctx: Ctx, tabs: string, h: string): boolean {
  const j = jq(tabs, (d, emit) => emit(iter(d).some((t) => idx(t, "handle") === h)));
  jqErrs(ctx, j);
  return jqE(j) === 0;
}
/** merged_ps --strict as the pause verbs ran it: a host whose ps fails or is not a worktree list fails it
 *  (null). Unlike mergedPs, jq's errors reach stderr. The text jq printed. */
async function mergedPsLoud(ctx: Ctx): Promise<string | null> {
  const valid = (text: string): boolean => {
    const j = jq(text, (d, emit) => emit(idx(d, "ok") !== false && jqType(idx(idx(d, "result"), "worktrees")) === "array"));
    jqErrs(ctx, j);
    return jqE(j) === 0;
  };
  const p = await orca(ctx, ["worktree", "ps", "--json", "--limit", "1000"], "drop");
  if (p.code !== 0 || !valid(p.out)) return null;
  const sels = jq(p.out, (d, emit) => {
    for (const h of each(idx(idx(idx(d, "result"), "hostScope"), "omittedHostSelectors"))) some(emit, idx(h, "selector"));
  });
  const texts = [p.out];
  for (const sel of lines(rawLines(sels.vals))) {
    if (sel === "") continue;
    const r = await orca(ctx, ["worktree", "ps", "--json", "--limit", "1000", ...sel.split(/[ \t\n]+/).filter(Boolean)], "drop");
    if (r.code !== 0 || !valid(r.out)) return null;
    texts.push(r.out);
  }
  try {
    const worktrees: unknown[] = [];
    for (const t of texts) for (const d of docs(t)) worktrees.push(...each(idx(idx(d, "result"), "worktrees")));
    return `${pretty({ result: { worktrees } })}\n`;
  } catch (e) {
    if (!(e instanceof JqError)) throw e;
    ctx.err(`jq: error: ${e.message}\n`);
    return null;
  }
}
/** pause-close's check: one worktree, all its agents idle or done, and every agent tab one the checkpoint knew. */
function closeSafe(v: unknown, wt: string): boolean {
  const tabs = at(v, 0), expected = at(v, 2);
  const trees = iter(idx(idx(at(v, 1), "result"), "worktrees")).filter((w) => idx(w, "worktreeId") === wt);
  const agents = idx(at(trees, 0), "agents");
  return trees.length === 1 && jqType(agents) === "array" && (agents as unknown[]).length > 0
    && iter(agents).every((x) => idx(x, "state") === "idle" || idx(x, "state") === "done")
    && jqType(expected) === "array" && iter(tabs).every((t) => truthy(jqIndex(expected, idx(t, "handle"))));
}
/** One more page of a worker-list walk: the next cursor, "" when the walk is done, null after printing why it
 *  cannot go on (or the exit of a jq that failed). */
function nextPage(ctx: Ctx, page: string, cursor: string): string | number {
  const more = jq(page, (d, emit) => emit(or(() => idx(idx(idx(d, "result"), "page"), "hasMore"), () => false)));
  jqErrs(ctx, more);
  if (jqOut(more) !== "true") return "";
  const nx = jq(page, (d, emit) => some(emit, idx(idx(idx(d, "result"), "page"), "nextCursor")));
  jqErrs(ctx, nx);
  if (nx.code !== 0) return nx.code;
  const next = jqOut(nx);
  if (!next || next === cursor) { say(ctx, "pause: incomplete dispatch listing"); return 1; }
  return next;
}
/** pause-release: worker-release's answer means the dispatch is released (or kept with nothing to close). */
const released = (d: unknown): boolean => {
  const r = idx(d, "result");
  return idx(d, "ok") !== false && idx(r, "ok") !== false
    && (idx(r, "state") === "released" || idx(r, "state") === "already_released" || (idx(r, "state") === "retained" && idx(r, "processAction") === "none"));
};

// --- worker starts ------------------------------------------------------------------------------------
/** run_worker_start: worker-start with --from (and the retry id), the one orchestration call WITHOUT --full
 *  (with --full a start whose turn was not yet observed exits 1, and callers then close the tab or start a
 *  second worker). consumer_fenced fails at once: only the Run's coordinator can start workers.
 *  runtime_busy is transient (Orca caps concurrent long-polls and a worker-start is one): back off and retry
 *  here, DS_WORKER_START_RETRIES tries (8), DS_WORKER_START_BACKOFF seconds first (2), doubling to 20. */
async function runWorkerStart(ctx: Ctx, what: string, args: string[]): Promise<boolean> {
  const max = Number(ctx.env.DS_WORKER_START_RETRIES || 8);
  let delay = Number(ctx.env.DS_WORKER_START_BACKOFF || 2), tries = 0;
  for (;;) {
    const r = await orca(ctx, ["orchestration", "worker-start", ...args, ...fromArgs(ctx.env), ...retryArgs(ctx.env), "--json"], "merge");
    if (r.code === 0) return true;
    const out = chomp(r.out);
    if (out.includes("consumer_fenced")) {
      say(ctx, `orca adapter: worker-start for ${what} was FENCED (consumer_fenced) — only the Run's COORDINATOR can start workers. Run this from the Lead (it adopts the run), not another session.`);
      return false;
    }
    tries++;
    if (tries < max && /runtime_busy|long-poll capacity|capacity reached/i.test(out)) {
      say(ctx, `orca adapter: worker-start for ${what} hit runtime_busy (try ${tries}/${max}) — backing off ${delay}s`);
      if (delay > 0) await sleep(delay * 1000);
      delay = Math.min(delay * 2, 20);
      continue;
    }
    say(ctx, `orca adapter: worker-start failed for ${what}: ${out}`);
    return false;
  }
}
/** on_other_account: this start must launch on a non-default Claude account. No account, or the default
 *  login, is the plain worker-start. Each call reads the account list once. */
async function onOtherAccount(ctx: Ctx, agent: string, acct: string): Promise<boolean> {
  return agent === "claude" && acct !== "" && acct !== (await claudeAccounts(ctx))[0].split("\t")[0];
}
/** claude_home: that account's Claude config dir, or null (said on stderr) when it does not exist. */
function claudeHome(ctx: Ctx, acct: string): string | null {
  const h = accountHome(ctx.env, acct);
  if (isDir(h)) return h;
  say(ctx, `orca adapter: no Claude home for account ${acct} (${h})`);
  return null;
}

/** link_projects: every managed account's projects/ is a link to the system login's, so spend, context
 *  readings, compaction and `--continue` see a worker whichever account it runs on. Called at every worker
 *  start and resume, for all accounts: a plain start on the selected managed account never goes through
 *  claudeTab. It never blocks a start: whatever goes wrong is a warning on stderr, and the next start tries
 *  again. All linked is the usual case and takes no lock. Already the same folder counts, however it got
 *  there: comparing a folder's files with themselves would read as "same bytes" and delete them. */
const projectsLinked = (home: string, target: string): boolean =>
  existsSync(`${home}/projects`) && readlinkF(`${home}/projects`) === readlinkF(target);
async function linkProjects(ctx: Ctx): Promise<void> {
  const target = `${claudeSys(ctx.env)}/projects`, base = `${orcaData(ctx.env)}/claude-profiles`, key = "account-projects";
  let names: string[] = [];
  try { names = readdirSync(base).filter((n) => !n.startsWith(".")).sort(byBytes); } catch { /* no profiles */ }
  const todo = names.map((n) => `${base}/${n}/home`).filter((h) => isDir(h) && !projectsLinked(h, target));
  if (!todo.length) return;
  try { mkdirSync(target, { recursive: true }); } catch {
    say(ctx, `orca adapter: warning: cannot make ${target}: not linking any account's projects`);
    return;
  }
  const quiet: Ctx = { ...ctx, env: { ...ctx.env, DS_WT_LOCK_WAIT: ctx.env.DS_LINK_LOCK_WAIT || "5" }, err: () => {} };
  if (!(await nameLock(quiet, key))) {
    say(ctx, "orca adapter: warning: another start is linking the accounts' projects: going ahead without waiting");
    return;
  }
  // finally: in the loop's process (U227) the lock's holder is the loop itself, never dead, so a throw
  // here must still free it.
  try { for (const h of todo) linkAccountProjects(ctx, h, target); } finally { nameUnlock(ctx.env, key); }
}
/** `find p -mindepth 1 \( -type f -o -type l \)`: files and links, a folder's before the next sibling's. */
function sessionFiles(dir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = `${dir}/${n}`;
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isFile() || st.isSymbolicLink()) out.push(p);
    else if (st.isDirectory()) out.push(...sessionFiles(p));
  }
  return out;
}
/** `find p -mindepth 1 -depth -type d -empty -delete`. */
function dropEmptyDirs(dir: string): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = `${dir}/${n}`;
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    dropEmptyDirs(p);
    try { if (readdirSync(p).length === 0) rmdirSync(p); } catch { /* left */ }
  }
}
/** link_account_projects: a link elsewhere is reported and left alone. A real folder has its files moved
 *  across first (all checked before any moves: half moved, the account's --continue no longer finds what
 *  went across), and only an emptied folder is replaced: rmdir refuses one a live session has just written
 *  to, and the next start picks that up. */
function linkAccountProjects(ctx: Ctx, home: string, target: string): void {
  const p = `${home}/projects`;
  if (projectsLinked(home, target)) return;
  if (isLink(p) || (existsSync(p) && !isDir(p))) {
    say(ctx, `orca adapter: warning: ${p} is not a folder or a link to ${target}: leaving it, its workers' spend is not counted`);
    return;
  }
  if (isDir(p)) {
    const files = sessionFiles(p);
    for (const src of files) {
      if (sessionFileMovable(p, target, src)) continue;
      say(ctx, `orca adapter: warning: could not move ${src} to ${target}: nothing moved, ${p} stays a folder, its workers' spend is not counted`);
      return;
    }
    for (const src of files) {
      if (moveSessionFile(ctx, p, target, src)) continue;
      say(ctx, `orca adapter: warning: could not move ${src} to ${target}: earlier sessions have moved, so --continue on this account may miss them; ${p} stays a folder, its workers' spend is not counted`);
      return;
    }
    dropEmptyDirs(p);
    try { rmdirSync(p); } catch {
      say(ctx, `orca adapter: warning: ${p} still holds files after the move: it stays a folder until the next start`);
      return;
    }
  }
  try { symlinkSync(target, p); } catch { say(ctx, `orca adapter: warning: could not link ${p} to ${target}`); }
}
const relOf = (root: string, src: string): string => src.startsWith(`${root}/`) ? src.slice(root.length + 1) : src;
/** session_file_movable: makes nothing. Its folder can be emptied, its destination folder can be made, and the
 *  destination is not the file itself by a link the other way (a link of ours has nothing to lose). */
function sessionFileMovable(from: string, to: string, src: string): boolean {
  const dest = `${to}/${relOf(from, src)}`;
  if (!writable(dirname(src))) return false;
  let d = dirname(dest);
  while (!existsSync(d) && !isLink(d)) d = dirname(d);
  if (!isDir(d) || !writable(d)) return false;
  return sameFile(src, dest) ? isLink(src) && !isLink(dest) : true;
}
/** `mv -n src dest` for a dest that is not there: a rename, or a copy and delete across file systems. */
function moveNew(src: string, dest: string): void {
  try { renameSync(src, dest); return; } catch (e) { if ((e as { code?: string }).code !== "EXDEV") return; }
  try {
    const st = lstatSync(src);
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dest);
    else { copyFileSync(src, dest, constants.COPYFILE_EXCL); chmodSync(dest, st.mode & 0o7777); utimesSync(dest, st.atime, st.mtime); }
    rmSync(src, { force: true });
  } catch { /* src stays: the move failed */ }
}
/** move_session_file: never overwrites. The same name with the same bytes needs no copy; with other bytes (a
 *  shared memory file, a live session's late append) the file goes beside it as
 *  <stem>.from-<account>-<n><ext>, so a .jsonl is still scanned, and the scan counts a message once. Fails
 *  when the file could not be moved, or dest already is this file. */
function moveSessionFile(ctx: Ctx, srcRoot: string, dstRoot: string, src: string): boolean {
  const rel = relOf(srcRoot, src);
  let dest = `${dstRoot}/${rel}`;
  const dir = dirname(dest);
  try { mkdirSync(dir, { recursive: true }); } catch { return false; }
  const rm = (): boolean => { try { rmSync(src, { force: true }); return true; } catch { return false; } };
  if (existsSync(dest) || isLink(dest)) {
    // A link the other way makes dest this very file: "same bytes" would delete the only copy.
    if (sameFile(src, dest)) return isLink(src) && !isLink(dest) && rm();
    if (sameBytes(src, dest)) return rm();
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const dot = base.slice(1).includes(".") ? base.lastIndexOf(".") : -1;
    const stem = dot < 0 ? base : base.slice(0, dot), ext = dot < 0 ? "" : base.slice(dot);
    const acct = basename(dirname(dirname(srcRoot)));   // <account>/home/projects
    for (let i = 1; ; i++) {
      dest = `${dir}/${stem}.from-${acct}-${i}${ext}`;
      if (!existsSync(dest) && !isLink(dest)) break;
    }
    say(ctx, `orca adapter: warning: ${rel} differs between ${srcRoot} and ${dstRoot}: kept both, as ${dest}`);
  }
  moveNew(src, dest);
  return !existsSync(src) && !isLink(src);
}
/** claude_trust: pre-accept Claude's "trust this folder" prompt for the worktree in that account's
 *  <dir>/.claude.json (projects[path].hasTrustDialogAccepted), so the TUI comes up without it. Best effort: a
 *  missing or non-JSON file is left alone, an already-trusted path is not rewritten, no other key is touched. */
function claudeTrust(ctx: Ctx, dir: string, wt: string): void {
  if (markTrusted(dir, wtPath(wt)) === "unusable") say(ctx, `orca adapter: not pre-trusting ${wtPath(wt)}: no usable ${dir}/.claude.json`);
}

/** tab_record: the file holding the handle of the tab this run's retry id owns. */
const tabRecord = (env: Env): string => `${lockPath(env, `tab-${env.DS_ORCA_RETRY_REQUEST}`).replace(/\.lock$/, "")}.handle`;
/** tab_connected: that tab is live in a terminal list. */
const tabConnected = (h: string, list: string): boolean =>
  jqE(jq(list, (d, emit) => emit(each(idx(idx(d, "result"), "terminals")).some((t) => idx(t, "handle") === h && idx(t, "connected") === true)))) === 0;
const tuiIdle = (h: string): string[] => ["terminal", "wait", "--terminal", h, "--for", "tui-idle", "--timeout-ms", "90000", "--json"];
/** request_state: what Orca knows of this run's retry id (completed|pending|absent); null on no answer. */
async function requestState(ctx: Ctx): Promise<string | null> {
  const r = await orca(ctx, ["orchestration", "request-show", "--request", ctx.env.DS_ORCA_RETRY_REQUEST ?? "", "--json", "--full"], "drop");
  const j = jq(r.out, (d, emit) => { const res = idx(d, "result"); emit(or(() => idx(res, "state"), () => idx(res, "status"), () => "absent")); });
  const s = jqOut(j);
  return r.code === 0 && j.code === 0 && s !== "" ? s : null;
}
/** U270: one failed Claude launch's evidence, on one stderr line after the failure's own: the tab's last 40 screen
 *  lines (null when there was no tab, or it could not be read) and what Orca said. The loop (bin/loop/squad/start-failed.ts)
 *  turns the line into a `start_failed` event and drops it from the refusal text, which keeps a pointer to the event. */
type Where = { wt?: string; account?: string };
const START_FAILED = "orca adapter: start_failed ";
const lastLines = (s: string, n = 40): string => s.replace(/\s+$/, "").split("\n").slice(-n).join("\n");
const said = (c: Call): string => [c.out.trim(), c.err.trim(), `exit ${c.code}`].filter(Boolean).join("\n");
function startFailed(ctx: Ctx, failure: string, where: Where, screen: string | null, orcaSaid: string): void {
  ctx.err(`${START_FAILED}${JSON.stringify({ failure, worktree: where.wt ?? null, account: where.account ?? null,
    screen: screen === null ? null : lastLines(screen), orca: lastLines(orcaSaid) })}\n`);
}
/** launched: a tab has just opened: wait for its TUI and give the handle. The pause decision belongs before
 *  the launch, so from here the fence is off: a tab that fails closes, and a pause cannot strand the agent in
 *  it. The handle is recorded before the wait, so a run killed during the wait leaves its replay the same tab
 *  instead of a second one. */
async function launched(ctx: Ctx, h: string, failure: string, where: Where = {}): Promise<string | null> {
  delete ctx.env.DS_LOOP_ACTIVITY;
  const rec = ctx.env.DS_ORCA_RETRY_REQUEST ? tabRecord(ctx.env) : "";
  if (rec) { try { writeFileSync(rec, h); } catch { /* the lock folder is gone */ } }
  const w = await orca(ctx, tuiIdle(h), "keep");
  if (w.code === 0) return h;
  // U270: what Claude printed before it quit is on the tab's screen until the close.
  const screen = await readScreen(ctx, h);
  say(ctx, `orca adapter: ${failure}`);
  startFailed(ctx, failure, where, screen.ok ? screen.text : null, said(w));
  await orca(ctx, ["terminal", "close", "--terminal", h], "drop");
  if (rec) rmSync(rec, { force: true });
  return null;
}
/** The handle of a tab `terminal create` just opened in the worktree ("" when there is none), and what Orca printed. */
async function openTab(ctx: Ctx, wt: string, name: string, cmd: string): Promise<{ h: string; created: Call }> {
  const r = await orca(ctx, ["terminal", "create", "--worktree", `id:${wt}`, "--title", name, "--command", cmd, "--json"], "keep");
  return { h: jqOut(jq(r.out, (d, emit) => some(emit, idx(idx(idx(d, "result"), "terminal"), "handle")))), created: r };
}
/** A tab that did not open: say why, and keep Orca's answer (U270). Exit 75 is the activity fence refusing the
 *  create (the start was paused, bin/loop/pause/check-activity.ts): no launch failed, so there is nothing to keep. */
function noTab(ctx: Ctx, failure: string, where: Where, created: Call): null {
  say(ctx, `orca adapter: ${failure}`);
  if (created.code !== 75) startFailed(ctx, failure, where, null, said(created));
  return null;
}
/** claude_tab: a new tab running claude on <account>, once its TUI is up. worker-start --terminal takes no
 *  --model/--effort, so they go on the claude line. An empty <account> is the default login as a plain
 *  `claude`. `system` keeps its onboarded config at ~/.claude.json, so it must run with NO CLAUDE_CONFIG_DIR
 *  (setting ~/.claude would read the un-onboarded ~/.claude/.claude.json and stall on first-run onboarding).
 *  It is launched through `env -u`, because with a managed account selected Orca's `claude` function
 *  re-selects that profile whenever the variable is unset; `env` is a binary, so it skips the function. */
async function claudeTab(ctx: Ctx, wt: string, acct: string, args: string[]): Promise<string | null> {
  const sys = systemJsonDir(ctx.env);
  let config: ClaudeConfig = null;
  if (acct && acct !== "system") {
    const home = claudeHome(ctx, acct);
    if (home === null) return null;
    claudeTrust(ctx, home, wt);
    config = { home };
  } else {
    claudeTrust(ctx, sys, wt);
    if (acct) config = { system: true };
  }
  const cmd = claudeLine({ config, gates: gates(ctx.env), identity: identity(ctx, wt), args, utf8: utf8Locale(ctx.env) });
  const { h, created } = await openTab(ctx, wt, `claude${acct ? `@${[...acct].slice(0, 8).join("")}` : ""}`, cmd);
  const where = { wt, account: acct };
  if (!h) return noTab(ctx, `could not open a terminal in ${wt} for account ${acct}`, where, created);
  return launched(ctx, h, `claude on account ${acct} never came up in ${wt}`, where);
}
/** The worker identity a loop start gives its terminal (U4 of orca-backend-alternatives, bin/loop/core/whoami.ts):
 *  `DS_MEMBER=… DS_WT=… DS_GEN=… ` from the DS_START_MEMBER/DS_START_GEN the loop sent, empty for a start the loop
 *  did not identify (an operator's script, a test, a role's shell, which may hold its own DS_MEMBER). */
function identity(ctx: Ctx, wt: string): LaunchLine["identity"] {
  const member = ctx.env.DS_START_MEMBER;
  return member ? { member, wt: wtPath(wt), gen: ctx.env.DS_START_GEN || null } : null;
}
/** resume_tab: a tab running `claude --continue` on the default login. */
async function resumeTab(ctx: Ctx, wt: string, model: string, args: string[]): Promise<string | null> {
  const cmd = claudeLine({ config: null, gates: gates(ctx.env), identity: identity(ctx, wt), resume: model, args, utf8: utf8Locale(ctx.env) });
  const { h, created } = await openTab(ctx, wt, "resume", cmd);
  if (!h) return noTab(ctx, `worker-resume could not open a terminal in ${wt}`, { wt }, created);
  return launched(ctx, h, `worker-resume — claude --continue never came up in ${wt}`, { wt });
}
/** finish_launched: a replay whose first run got past the launch finishes as that run would have: Orca has
 *  its start, or its tab is live. Lifts the fence for the whole replay. Anything else keeps it, so a paused
 *  replay with nothing launched starts nothing. */
async function finishLaunched(ctx: Ctx): Promise<void> {
  if (!ctx.env.DS_LOOP_ACTIVITY || !ctx.env.DS_ORCA_RETRY_REQUEST) return;
  const s = await requestState(ctx);
  if (s === "completed" || s === "pending") { delete ctx.env.DS_LOOP_ACTIVITY; return; }
  const h = readText(tabRecord(ctx.env));
  if (!h) return;
  const t = await orca(ctx, LIST, "drop");
  if (t.code === 0 && tabConnected(h, t.out)) delete ctx.env.DS_LOOP_ACTIVITY;
}
/** retry_tab: the tab of this start, from claudeTab or resumeTab, run as the shell's `$(…)` did (ctx is the
 *  caller's copy). --terminal is part of what Orca keeps under a retry id, so a replay has to name the same
 *  tab: the first run opens it and records its handle, a later run under that id finds it while it is
 *  connected (the lock makes it wait for a tab still coming up; a run that died before binding it left the
 *  TUI unchecked, so the replay waits for it first, and closes a tab Orca holds nothing for that never comes
 *  up, as the first run would have). An unreadable terminal list fails the run: a new tab there would change
 *  the input under the id, and the replay asks again. A recorded tab that closed is replaced only if Orca
 *  holds no receipt: under a landed id the same handle is the same input, and Orca answers with the recorded
 *  outcome. No retry id: a new tab, as ever. forgetTab closes it again when the start did not take. */
async function retryTab(ctx: Ctx, open: (c: Ctx) => Promise<string | null>, where: Where = {}): Promise<string | null> {
  const id = ctx.env.DS_ORCA_RETRY_REQUEST;
  if (!id) return open(ctx);
  const key = `tab-${id}`, rec = tabRecord(ctx.env);
  if (!(await nameLock(ctx, key))) return null;
  try {
    const h = readText(rec);
    const tabs = h ? await orca(ctx, LIST, "drop") : null;
    if (h && tabs!.code !== 0) {
      say(ctx, `orca adapter: cannot tell whether tab ${h} of this start is live: the start is still pending`);
      return null;
    }
    if (h && tabConnected(h, tabs!.out)) {
      const state = (await requestState(ctx)) ?? "";
      if (state === "completed" || state === "pending") return h;
      if (state === "absent") return launched(ctx, h, `tab ${h} of this start never came up`, where);
      if ((await orca(ctx, tuiIdle(h), "drop")).code === 0) return h;
      say(ctx, `orca adapter: tab ${h} of this start is not up yet: the start is still pending`);
      return null;
    }
    let state = "";
    if (h) {
      const s = await requestState(ctx);
      if (s === null) { say(ctx, `orca adapter: cannot tell whether a start used closed tab ${h}: the start is still pending`); return null; }
      state = s;
    }
    if (state === "completed") return h;
    if (state === "pending") { say(ctx, `orca adapter: tab ${h} closed while Orca works on this start: the start is still pending`); return null; }
    const made = await open(sub(ctx));
    if (made !== null) dropOldRecords(dirname(rec));
    return made;
  } finally {
    nameUnlock(ctx.env, key);
  }
}
/** `find <dir> -maxdepth 1 -name '*.handle' -mmin +1440 -delete`: tab records a day old. */
function dropOldRecords(dir: string): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.endsWith(".handle")) continue;
    try {
      const st = lstatSync(`${dir}/${n}`);
      if (Date.now() - st.mtimeMs <= 1440 * 60_000) continue;
      if (st.isDirectory()) rmdirSync(`${dir}/${n}`); else rmSync(`${dir}/${n}`, { force: true });
    } catch { /* gone or kept */ }
  }
}
/** skill_overrides: the skillOverrides JSON ({} for none) for the role the worktree name carries:
 *  `ds skills resolve --wt <path>` (DS_SKILLS_RESOLVE replaces that command, for tests). A failing resolve
 *  logs one line and gives {} so the session starts with every skill, as before U229; it never blocks a start. */
async function skillOverrides(ctx: Ctx, wt: string): Promise<{ so: string; denied: string; plugins: Record<string, unknown> }> {
  const cmd = ctx.env.DS_SKILLS_RESOLVE || `${root(ctx.env)}/bin/ds skills resolve`;
  const r = await spawn(ctx, [...cmd.split(/[ \t\n]+/).filter(Boolean), "--wt", wtPath(wt), "--all"]);
  let so = chomp(new TextDecoder().decode(r.out)), denied = "[]", plugins: Record<string, unknown> = {};
  if (r.code !== 0 || jqE(jq(so, (d, emit) => emit(jqType(d) === "object"))) !== 0) {
    say(ctx, `orca adapter: skill list unavailable for ${wt} (ds skills resolve failed) — starting with no skill overrides`);
    so = "{}";
  } else {
    // U283: `--all` prints {skillOverrides, mcp, deniedMcpServers, plugins, enabledPlugins}; a resolver that prints the bare
    // skillOverrides object, or one without enabledPlugins, still works.
    const all = scan(so);
    const o = !all.bad && all.vals.length === 1 ? all.vals[0] : null;
    if (o && typeof o === "object" && !Array.isArray(o) && typeof (o as any).skillOverrides === "object" && Array.isArray((o as any).deniedMcpServers)) {
      so = pretty((o as any).skillOverrides, 0);
      denied = pretty((o as any).deniedMcpServers, 0);
      const ep = (o as any).enabledPlugins;
      if (ep && typeof ep === "object" && !Array.isArray(ep)) plugins = ep;
    }
  }
  return { so: chomp(jq(so, (d, emit) => emit(d)).vals.map((v) => `${pretty(v, 0)}\n`).join("")), denied, plugins };
}
/** compact_settings: the claude args for one --settings JSON that holds the auto-compact window (env), the
 *  role's skillOverrides, its denied MCP servers (U283, `deniedMcpServers`, probed in conventions/skills.conf) and the plugins it has
 *  off (`enabledPlugins`, review-unit-no-receipt U1), or none when all are empty. A non-numeric window is ignored. --settings outranks
 *  ~/.claude/settings.json; an env var on the command does not (probed 2026-10-27 on the system login and a
 *  managed account: /context showed "/ 150k" vs "/ 400k"). skillOverrides probed 2026-11-12 on 2.1.322
 *  (conventions/skills.conf). */
async function compactSettings(ctx: Ctx, window: string, wt: string): Promise<string[]> {
  let win = window;
  if (/[^0-9]/.test(win)) { say(ctx, `orca adapter: ignoring auto-compact window '${win}' (not a number)`); win = ""; }
  const { so, denied, plugins } = wt ? await skillOverrides(ctx, wt) : { so: "{}", denied: "[]", plugins: {} };
  const hasPlugins = Object.keys(plugins).length > 0;
  if (!win && so === "{}" && denied === "[]" && !hasPlugins) return [];
  const s = scan(so), d = scan(denied);
  if (s.bad || s.vals.length !== 1) {
    ctx.err("jq: invalid JSON text passed to --argjson\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n");
    return ["--settings", ""];
  }
  return claudeSettings({ window: win, skillOverrides: s.vals[0], denied: d.bad || d.vals.length !== 1 ? [] : d.vals[0], plugins });
}
/** forget_tab: a worker start failed: close its tab unless a replay needs it. Under a retry id that is what
 *  request-show says: absent means the actuator gives the next try a new id, which would never find this
 *  tab; pending, completed or no answer means the id lives on, and so does it. */
async function forgetTab(ctx: Ctx, h: string): Promise<void> {
  const close = ["terminal", "close", "--terminal", h];
  if (!ctx.env.DS_ORCA_RETRY_REQUEST) { await orca(ctx, close, "drop"); return; }
  if ((await requestState(ctx)) !== "absent") return;
  const key = `tab-${ctx.env.DS_ORCA_RETRY_REQUEST}`;
  if (!(await nameLock(ctx, key))) return;
  try {
    rmSync(tabRecord(ctx.env), { force: true });
    await orca(ctx, close, "drop");
  } finally { nameUnlock(ctx.env, key); }
}
/** all_tabs (no worktree) / wt_tabs: the handles of every terminal on the host, or of that worktree's, one
 *  per line; null when the list can't be read. */
async function tabsOf(ctx: Ctx, wt?: string): Promise<string | null> {
  const r = await orca(ctx, LIST, "drop");
  if (r.code !== 0) return null;
  const j = jq(r.out, (d, emit) => {
    for (const t of each(idx(idx(d, "result"), "terminals"))) if (wt === undefined || idx(t, "worktreeId") === wt) emit(idx(t, "handle"));
  });
  return j.code === 0 ? jqOut(j) : null;
}
/** drop_new_tabs: a start failed: close every terminal it left in the worktree that was not there before (the
 *  shell a new worktree opens with, an agent tab Orca opened), so failed tries leave no stray tabs (U59). Not
 *  while the retry id lives on, as forgetTab: the replay may use them. A before of `?` (the list was
 *  unreadable then) closes nothing. */
async function dropNewTabs(ctx: Ctx, wt: string, before: string): Promise<void> {
  if (before === "?") return;
  if (ctx.env.DS_ORCA_RETRY_REQUEST && (await requestState(ctx)) !== "absent") return;
  const now = await tabsOf(ctx, wt);
  if (now === null) return;
  const had = new Set(before.split("\n"));
  for (const h of now.split("\n")) {
    if (h && !had.has(h)) await orca(ctx, ["terminal", "close", "--terminal", h], "drop");
  }
}
/** guard_fresh_start — U97: a fresh start never leaves the old agent running. Before a worker starts in an
 *  existing worktree, close that worktree's other live agent terminals (agentIdentity set, connected,
 *  writable, not orphaned; the loop's `ds-loop` panes, headless `claude -p` and plain shells are kept), and
 *  start only once they are gone. An agent mid-turn (its worktree's ps state is `working`) is never closed:
 *  refuse with exit 3 and `agent_busy` on stderr, so the caller can wait and retry. A close that fails, a
 *  terminal list that can't be read, or an agent still live afterwards also refuses (exit 1). No agent: no-op.
 *  A replay under a live retry id owns whatever its first attempt started: unless request-show says
 *  `absent`, defer to the start's own machinery (retryTab/runWorkerStart), which reuses that worker or
 *  refuses as `still pending`. */
async function guardFreshStart(ctx: Ctx, wt: string): Promise<number> {
  const retry = !!ctx.env.DS_ORCA_RETRY_REQUEST;
  let keep = "";
  if (retry) {
    if ((await requestState(ctx)) !== "absent") return 0;
    keep = readText(tabRecord(ctx.env));
  }
  const refuse = (why: string): number => { say(ctx, `orca adapter: start in ${wt} refused: ${why}`); return 1; };
  const live = (list: string): Jq => jq(list, (d, emit) => {
    for (const t of each(idx(idx(d, "result"), "terminals"))) {
      if (idx(t, "worktreeId") === wt && idx(t, "handle") !== keep && isAgent(t) && !matches(title(t), DS_LOOP) && !matches(title(t), /claude -p/)) emit(idx(t, "handle"));
    }
  });
  const first = await orca(ctx, LIST, "drop");
  if (first.code !== 0) return retry ? 0 : refuse("could not read the terminal list to check for a live agent");
  const found = live(first.out);
  if (found.code !== 0) return refuse("could not parse the terminal list to check for a live agent");
  const handles = jqOut(found);
  if (!handles) return 0;
  // Fail closed on busyness: an unparseable ps refuses rather than closing an agent that may be mid-turn.
  const busy = jqOn(await psIns(ctx), (d, emit) => {
    const states: unknown[] = [];
    for (const w of each(idx(idx(d, "result"), "worktrees"))) {
      if (idx(w, "worktreeId") === wt) for (const x of each(idx(w, "agents"))) states.push(idx(x, "state"));
    }
    emit(jqIndex(states, "working") !== null);
  });
  if (busy.code !== 0) return refuse("could not read worktree ps to check for a mid-turn agent");
  if (jqOut(busy) === "true") {
    say(ctx, `orca adapter: agent_busy: worktree ${wt} has an agent mid-turn; refusing to start a second session`);
    return 3;
  }
  for (const h of handles.split("\n")) {
    if (h && (await orca(ctx, ["terminal", "close", "--terminal", h], "drop")).code !== 0) return refuse(`could not close the old agent terminal ${h}`);
  }
  const again = await orca(ctx, LIST, "drop");
  if (again.code !== 0) return retry ? 0 : refuse("could not re-read the terminal list after closing the old agent");
  const still = live(again.out);
  const left = still.code !== 0 ? "?" : jqOut(still);
  return left ? refuse(`the old agent terminal is still live (${left})`) : 0;
}
/** start_worker: the one place a supervised worker starts in an existing worktree. Every Claude start on this
 *  host is a claude tab under that account's home (plain `claude` for the default login), then worker-start
 *  --terminal (keeps Run/Task/Dispatch): worker-start --agent can't pass claude flags (the auto-compact
 *  <window>, skill overrides) or the PATH that puts bin/hooks/path-gates first (the hook shims, U235; U9 made
 *  the default login take it too). A failed start closes that tab unless a retry id owns it, then the replay uses it. Other agents, and a
 *  default-login Claude with --on, take the plain worker-start --agent: Orca types their launch line, so they
 *  run without the path gates. Managed accounts live on this host, so not with --on; a window with --on is
 *  dropped. Other agents ignore the window. */
async function startWorker(ctx: Ctx, what: string, wt: string, agent: string, model: string, host: string, effort: string,
  acct: string, window: string, rest: string[]): Promise<boolean> {
  await linkProjects(ctx);
  let cs = agent === "claude" ? await compactSettings(ctx, window, wt) : [];
  if (cs.length && host && !(await onOtherAccount(ctx, agent, acct))) {
    say(ctx, `orca adapter: ${what} — no auto-compact window with --on ${host} (launching with the default)`);
    cs = [];
  }
  if ((await onOtherAccount(ctx, agent, acct)) || cs.length || (agent === "claude" && !host)) {
    if (host) { say(ctx, `orca adapter: ${what} — launching on account ${acct} works on this host only, not --on ${host}`); return false; }
    let tabAcct = (await onOtherAccount(ctx, agent, acct)) ? acct : "";
    if (!tabAcct) {   // the default login: plain claude, unless that default is a managed account
      tabAcct = (await claudeAccounts(ctx))[0].split("\t")[0];
      if (tabAcct === "system") tabAcct = "";
    }
    const ca = ["--model", model, ...(effort ? ["--effort", effort] : [])];
    const h = await retryTab(sub(ctx), (c) => claudeTab(c, wt, tabAcct, [...ca, ...cs]), { wt, account: tabAcct });
    if (h === null) return false;
    delete ctx.env.DS_LOOP_ACTIVITY;   // launched: the bind and its cleanup run whatever a pause says
    if (await runWorkerStart(ctx, `${what}${tabAcct ? ` (account ${tabAcct})` : ""}`, ["--worktree", `id:${wt}`, ...rest, "--terminal", h])) return true;
    await forgetTab(ctx, h);
    return false;
  }
  return runWorkerStart(ctx, what, ["--worktree", `id:${wt}`, ...rest, "--agent", agent, "--model", model,
    ...(host ? ["--on", host] : []), ...(effort ? ["--effort", effort] : [])]);
}
/** keep_open: --keep-open for a standing role (lead|thinker|studio), nothing otherwise (U64). A standing role
 *  lives across turns; without --keep-open Orca closes a finished worker's terminal, so a standing role
 *  whose dispatch settles (a stray worker_done) would lose its session. */
const keepOpen = (role: string): string[] => ["lead", "thinker", "studio"].includes(role) ? ["--keep-open"] : [];
/** The entity id a create answered with, printed bare; jq's errors fail the verb with jq's exit. */
function printId(ctx: Ctx, out: string, none: string): number {
  const j = jq(out, (d, emit) => some(emit, entityOf(d)));
  jqErrs(ctx, j);
  if (j.code !== 0) return j.code;
  const id = jqOut(j);
  if (!id) { say(ctx, `orca adapter: ${none}; output: ${chomp(out)}`); return 1; }
  ctx.out(id);
  return 0;
}
/** The dispatch ids of a worktree's rows in a Run's worker list (worker-release, worker-abandon). */
async function wtDispatchIds(ctx: Ctx, a: string[]): Promise<string[]> {
  if (a.length < 1) { ctx.err("orca.sh: $1: unbound variable\norca.sh: $2: unbound variable\n"); return []; }
  const r = await orca(ctx, ["orchestration", "worker-list", "--run", a[0], "--json", "--full"], "drop");
  if (!need(ctx, a, 2)) return [];
  return lines(rawLines(jq(r.out, (d, emit) => {
    for (const w of each(idx(idx(d, "result"), "workers"))) if (wtOf(w) === a[1]) some(emit, idx(w, "dispatchId"));
  }).vals)).filter(Boolean);
}
const dispatchIds = (text: string): string[] =>
  lines(rawLines(jq(text, (d, emit) => { for (const w of each(idx(idx(d, "result"), "workers"))) some(emit, idx(w, "dispatchId")); }).vals));

const WORKERS: Record<string, Verb> = {
  /** <objective> -> run_… */
  async "run-create"(ctx, a) {
    const failed = () => { say(ctx, "orca adapter: run-create failed (see error above)"); return 1; };
    if (!need(ctx, a, 1)) return failed();
    const r = await orca(ctx, ["orchestration", "run-create", "--objective", a[0], ...fromArgs(ctx.env), "--json", "--full"]);
    return r.code !== 0 ? failed() : printId(ctx, chomp(r.out), "run-create returned no run id");
  },
  /** <run_id> <spec> <title> [parent_task_id] -> task_… (a write-ahead call's retry id rides along: a replay
   *  returns the same task, U71) */
  async "task-create"(ctx, a) {
    if (!need(ctx, a, 3)) return 1;
    const r = await orca(ctx, ["orchestration", "task-create", "--run", a[0], "--spec", a[1], "--task-title", a[2],
      ...(a[3] ? ["--parent", a[3]] : []), ...fromArgs(ctx.env), ...retryArgs(ctx.env), "--json", "--full"]);
    if (r.code !== 0) { say(ctx, "orca adapter: task-create failed (see error above)"); return 1; }
    return printId(ctx, chomp(r.out), "task-create returned no task id");
  },
  /** <run> <task> <repo> <agent> <model> <name> [parent_wt] [host] [effort] [account] [window] -> lead
   *  worktree id (`-` = a skipped optional positional; account = where it runs, window = its auto-compact
   *  window in tokens; see startWorker). No --name on the start: Orca rejects it on an existing worktree. */
  async "lead-start"(ctx, a) {
    if (!needIn(ctx, a, 3, 6)) return 1;
    const { printed, code } = await wtCreate(ctx, a[2], a[5], blank(a[6]));
    if (code !== 0) return code;
    const wt = chomp(printed);
    if (!wt) { say(ctx, `orca adapter: lead worktree create failed (repo=${a[2]} name=${a[5]}; see error above)`); return 1; }
    if (!(await startWorker(ctx, `lead ${a[5]}`, wt, a[3], a[4], blank(a[7]), blank(a[8]), blank(a[9]), blank(a[10]),
      ["--task", a[1], "--run", a[0], "--keep-open"]))) return 1;
    ctx.out(wt);
    return 0;
  },
  /** <run> <worktree_id> <spec> <model> [account] [agent] [window] [role] -> restart a CLAUDE worker in place
   *  KEEPING its conversation: open a tab running `claude --continue` (the newest session in that worktree),
   *  wait for its TUI to settle, then supervise THAT terminal (worker-start has no resume flag, hence
   *  --terminal, which takes no --model/--effort). Exit 1 on any failure so the caller falls back to a fresh
   *  worker-start; any agent but Claude exits 1, so the caller starts it fresh from state. On a non-default
   *  account the tab runs under that account's home: linkProjects links its projects/ to the system login's,
   *  so the session started on another account is still found. */
  async "worker-resume"(ctx, a) {
    await finishLaunched(ctx);
    if (!need(ctx, a, 2)) return 1;
    const g = await guardFreshStart(ctx, a[1]);
    if (g !== 0) return g;
    await linkProjects(ctx);
    const agent = blank(a[5]);
    if (agent === "muse") { say(ctx, "orca adapter: worker-resume — muse has no resume; start it fresh from the squad state"); return 1; }
    if (agent !== "claude" && agent !== "") { say(ctx, `orca adapter: worker-resume — no resume for agent ${a[5]}`); return 1; }
    const acct = blank(a[4]);
    const cs = await compactSettings(ctx, blank(a[6]), a[1]);
    const other = await onOtherAccount(ctx, "claude", acct);
    if (!need(ctx, a, 4)) return 1;
    const h = await retryTab(sub(ctx), other
      ? (c) => claudeTab(c, a[1], acct, ["--continue", "--model", a[3], ...cs])
      : (c) => resumeTab(c, a[1], a[3], cs), { wt: a[1], ...(other ? { account: acct } : {}) });
    if (h === null) return 1;
    delete ctx.env.DS_LOOP_ACTIVITY;   // launched: see launched
    if (await runWorkerStart(ctx, `worktree ${a[1]} (resume)`, ["--terminal", h, "--worktree", `id:${a[1]}`, "--spec", a[2], "--run", a[0],
      ...keepOpen(blank(a[7]))])) return 0;
    await forgetTab(ctx, h);
    return 1;
  },
  /** <run> <task> <worktree_id> <agent> <model> [host] [effort] [account] [window] -> start the Lead's
   *  supervised worker in an ALREADY-CREATED worktree (the worker-start half of lead-start). Called LAST in
   *  spawn, after the children are up. */
  async "lead-worker-start"(ctx, a) {
    if (!needIn(ctx, a, 3, 4, 5, 2, 1)) return 1;
    return (await startWorker(ctx, `lead (worker in ${a[2]})`, a[2], a[3], a[4], blank(a[5]), blank(a[6]), blank(a[7]), blank(a[8]),
      ["--task", a[1], "--run", a[0], "--keep-open"])) ? 0 : 1;
  },
  /** <run> <repo> <lead_wt> <spec> <agent> <model> <name> [host] [effort] [account] [window] [role] -> role
   *  worktree id (role: a standing one is started --keep-open, see keepOpen). The tabs listed before the
   *  worktree is made: a new one's first shell counts as this start's, closed when it fails. */
  async "role-start"(ctx, a) {
    await finishLaunched(ctx);
    const before = (await tabsOf(ctx)) ?? "?";
    if (!needIn(ctx, a, 2, 7)) return 1;
    const { printed, code } = await wtCreate(ctx, a[1], a[6], blank(a[2]));
    if (code !== 0) return code;
    const wt = chomp(printed);
    if (!wt) { say(ctx, `orca adapter: role worktree create failed (repo=${a[1]} name=${a[6]}; see error above)`); return 1; }
    if (!(await startWorker(ctx, `role ${a[6]}`, wt, a[4], a[5], blank(a[7]), blank(a[8]), blank(a[9]), blank(a[10]),
      ["--spec", a[3], "--run", a[0], ...keepOpen(blank(a[11]))]))) {
      await dropNewTabs(ctx, wt, before);
      return 1;
    }
    ctx.out(wt);
    return 0;
  },
  /** <run_id> -> become the Run's coordinator so this terminal can start workers; until it binds, every
   *  worker-start is fenced (consumer_fenced). A plain `run-use --id <run>` binds the caller (host-confirmed).
   *  Orca writes its error as JSON on stdout, so on a failure that is what goes to stderr. */
  async adopt(ctx, a) {
    if (!needTwice(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["orchestration", "run-use", "--id", a[0], ...fromArgs(ctx.env), "--json", "--full"], "merge");
    if (r.code === 0) return 0;
    const out = chomp(r.out);
    const why = jqr(out, (d, emit) => {
      const e = idx(d, "error");
      if (e !== null) emit(`${interp(or(() => idx(e, "code"), () => "error"))}: ${interp(or(() => idx(e, "message"), () => ""))}`);
    });
    say(ctx, `orca adapter: adopt (run-use) failed for run ${a[0]}: ${why || out || "no output"}`);
    return 1;
  },
  /** <run_id> -> the handle of the terminal that coordinates the Run now (empty: none). Read-only; exit 1
   *  when Orca can't say. The loop checks its own pane holds each Run's seat before it starts anything (U59). */
  async "run-coordinator"(ctx, a) {
    if (!needTwice(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["orchestration", "run-show", "--id", a[0], "--json", "--full"], "drop");
    if (r.code !== 0) { say(ctx, `orca adapter: run-show failed for ${a[0]}`); return 1; }
    const j = jq(r.out, (d, emit) => emit(or(() => idx(idx(idx(d, "result"), "run"), "coordinator_handle"), () => "")));
    ctx.out(rawLines(j.vals));
    if (jqE(j) !== 0) { say(ctx, `orca adapter: run-show for ${a[0]} has no run`); return 1; }
    return 0;
  },
  /** <run_id> -> "<worktree_id>\t<live yes|no>\t<dispatch id or ->\t<terminal handle or ->\t<task id or ->\t<status>\t<reported yes|no>"
   *  per worker of the Run, grouped by wtOf (injected rows count too). live = a dispatch with
   *  dispatchStatus "dispatched"; the handle, task and status are that dispatch's, or for a worktree with none
   *  open its newest's (worker-list lists newest first, and carries no dispatch timestamp, U216). reported
   *  (U215) = no open dispatch and the newest ended through the worker's own worker_done: completed, or failed
   *  with lastFailure.provenance "worker_report" (worker-show, once per dispatch, then remembered in
   *  $STATE/loop/dispatch-reported.tsv, U234: a failed dispatch never changes; only a clear answer is kept,
   *  and over DS_DISPATCH_CACHE_MAX lines (5000) only the ids this Run still lists stay). Exit 1 when the list
   *  can't be read: an empty answer would read as "no live workers" and rebind every member. */
  async "run-workers"(ctx, a) {
    if (!needTwice(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["orchestration", "worker-list", "--run", a[0], "--json", "--full"], "drop");
    if (r.code !== 0) { say(ctx, `orca adapter: run-workers could not read the worker list of ${a[0]}`); return 1; }
    const rows = jq(chomp(r.out), (d, emit) => {
      const ws = idx(idx(d, "result"), "workers");
      if (jqType(ws) !== "array") throw new JqError("no worker array");
      for (const g of groupBy((ws as unknown[]).filter((w) => wtOf(w) !== ""), wtOf)) {
        const live = at(g.filter((w) => idx(w, "dispatchStatus") === "dispatched"), 0);
        const n = truthy(live) ? live : g[0];
        const status = idx(n, "dispatchStatus");
        emit(`${interp(wtOf(g[0]))}\t` + (truthy(live) ? `yes\t${interp(idx(live, "dispatchId"))}` : "no\t-")
          + `\t${interp(or(() => idx(n, "agentTerminalHandle"), () => idx(idx(n, "resource"), "terminalHandle"), () => "-"))}`
          + `\t${interp(or(() => idx(n, "taskId"), () => "-"))}\t${interp(or(() => status, () => "-"))}`
          + "\t" + (truthy(live) ? "no" : status === "completed" ? "yes" : status === "failed" ? `check:${interp(idx(n, "dispatchId"))}` : "no"));
      }
    });
    if (rows.code !== 0) { say(ctx, `orca adapter: run-workers could not parse the worker list of ${a[0]}`); return 1; }
    const cache = `${ctx.env.DS_STATE_ROOT || `${root(ctx.env)}/state`}/loop/dispatch-reported.tsv`;
    const records = (): string[] => {
      try { const t = readFileSync(cache, "utf8"); return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n"); } catch { return []; }
    };
    const known = new Map<string, string>();
    for (const l of records()) { const f = l.split("\t"); if (f.length === 2 && (f[1] === "yes" || f[1] === "no")) known.set(f[0], f[1]); }
    for (const line of jqOut(rows).split("\n")) {
      if (!line) continue;
      if (!line.includes("\tcheck:")) { ctx.out(`${line}\n`); continue; }
      const k = line.lastIndexOf("check:"), d = line.slice(k + 6);
      let rep = known.get(d) ?? "";
      if (!rep) {
        rep = "no";
        const s = await orca(ctx, ["orchestration", "worker-show", "--dispatch", d, "--json", "--full"], "drop");
        const show = chomp(s.out);
        if (s.code === 0 && jqE(jq(show, (x, emit) => emit(jqType(idx(idx(x, "result"), "dispatch")) === "object"))) === 0) {
          const byWorker = jq(show, (x, emit) => {
            let f = idx(idx(idx(x, "result"), "dispatch"), "lastFailure");
            if (typeof f === "string") f = fromJson(f);
            emit(idx(f, "provenance") === "worker_report");
          });
          if (jqE(byWorker) === 0) rep = "yes";
          try { mkdirSync(dirname(cache), { recursive: true }); appendFileSync(cache, `${d}\t${rep}\n`); } catch { /* asked again next call */ }
        }
      }
      ctx.out(`${line.slice(0, k)}${rep}\n`);
    }
    let size = 0;
    try { if (statSync(cache).isFile()) size = readFileSync(cache).filter((b) => b === 10).length; else size = -1; } catch { size = -1; }
    const max = Number(ctx.env.DS_DISPATCH_CACHE_MAX || 5000);
    if (size > max) {
      const keep = new Set(jqr(r.out, (d, emit) => { for (const w of each(idx(idx(d, "result"), "workers"))) some(emit, idx(w, "dispatchId")); })
        .split("\n").map((l) => l.split("\t")[0]));
      const tmp = `${cache}.${process.pid}`;
      try {
        writeFileSync(tmp, records().filter((l) => { const f = l.split("\t"); return f.length === 2 && keep.has(f[0]); }).map((l) => `${l}\n`).join(""));
        renameSync(tmp, cache);
      } catch { rmSync(tmp, { force: true }); }
    }
    return 0;
  },
  /** <worktree id> <exact agent handle> <instruction> <run>: an idempotent accepted prompt. */
  async "pause-deliver"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const tabs = await pauseTerminals(ctx, a[0]);
    if (tabs.code !== 0 || !need(ctx, a, 2) || !listsHandle(ctx, chomp(tabs.text), a[1]) || !need(ctx, a, 3)) return 1;
    const r = await orca(ctx, ["terminal", "send", "--terminal", a[1], "--text", a[2], "--enter", ...retryArgs(ctx.env), "--json"]);
    if (r.code !== 0) return 1;
    const result = chomp(r.out);
    const ok = jq(result, (d, emit) => emit(idx(d, "ok") !== false && idx(idx(idx(d, "result"), "send"), "accepted") === true));
    jqErrs(ctx, ok);
    if (jqE(ok) !== 0) { say(ctx, "pause: instruction delivery unconfirmed"); return 1; }
    ctx.out(`${result}\n`);
    return 0;
  },
  /** <worktree id> <exact handle> <run> <checkpoint terminal handles>: safety reads only at close. A handle
   *  no longer listed is done. The listings go in on stdin (Linux caps each argv element at 128 KB). */
  async "pause-close"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const tabs = await pauseTerminals(ctx, a[0]);
    if (tabs.code !== 0 || !need(ctx, a, 2)) return 1;
    const t = chomp(tabs.text);
    if (!listsHandle(ctx, t, a[1])) return 0;
    const ps = await mergedPsLoud(ctx);
    if (ps === null) return 1;
    const s = scan(`${t}\n${chomp(ps)}\n${a[3] || "[]"}\n`);
    let safe = false;
    if (s.bad) ctx.err("jq: parse error: invalid JSON text\n");
    else {
      try { safe = closeSafe(s.vals, a[0]); } catch (e) { if (!(e instanceof JqError)) throw e; ctx.err(`jq: error: ${e.message}\n`); }
    }
    if (!safe) { say(ctx, "pause: agent busy, changed or unverifiable; terminal retained"); return 1; }
    const c = await orca(ctx, ["terminal", "close", "--terminal", a[1], "--json"]);
    if (c.code !== 0) return 1;
    const ok = jq(chomp(c.out), (d, emit) => emit(okConfirmed(d)));
    jqErrs(ctx, ok);
    if (jqE(ok) !== 0) { say(ctx, "pause: terminal closure unconfirmed"); return 1; }
    return 0;
  },
  /** <run> <worktree id>: absent agents only, strict fencing/release of every dispatch. A release Orca answers
   *  with release_unknown (its recorded terminal no longer resolves) never changes: noted and the walk goes
   *  on, so every other dispatch is still fenced and released; only that exit, after the whole walk, says
   *  so on its last line (the loop records it once, fulfil/pause.ts, and never retries). */
  async "pause-release"(ctx, a) {
    if (!needIn(ctx, a, 2)) return 1;
    const tabs = await pauseTerminals(ctx, a[1]);
    if (tabs.code !== 0) return 1;
    const none = jq(chomp(tabs.text), (d, emit) => emit(jqLength(d) === 0));
    jqErrs(ctx, none);
    if (jqE(none) !== 0) { say(ctx, "pause: agent terminal still present; dispatch retained"); return 1; }
    let ids = "", cursor = "", n = 0, unknown = "";
    for (;;) {
      const p = await orca(ctx, ["orchestration", "worker-list", "--run", a[0], "--limit", "100", "--json", "--full", ...(cursor ? ["--cursor", cursor] : [])], "merge");
      const page = chomp(p.out);
      if (p.code !== 0) { say(ctx, `pause: dispatch listing failed: ${page}`); return 1; }
      const rows = jq(page, (d, emit) => {
        if (idx(d, "ok") === false || jqType(idx(idx(d, "result"), "workers")) !== "array") throw new JqError("invalid dispatch listing");
        const mine = (idx(idx(d, "result"), "workers") as unknown[]).filter((w) => wtOf(w) === a[1]);
        if (mine.some((w) => jqType(idx(w, "dispatchId")) !== "string" || idx(w, "dispatchId") === "")) throw new JqError("missing dispatch identity");
        for (const w of mine) emit(tsvRow([idx(w, "dispatchId"), or(() => idx(w, "dispatchStatus"), () => "unknown")]));
      });
      jqErrs(ctx, rows);
      if (rows.code !== 0) return 1;
      if (jqOut(rows)) ids += `${jqOut(rows)}\n`;
      const next = nextPage(ctx, page, cursor);
      if (typeof next === "number") return next;
      if (!next) break;
      cursor = next;
    }
    for (const line of lines(`${ids}\n`)) {
      const [id, status] = readTabs(line, 2);
      if (!id) continue;
      if (!["completed", "failed", "cancelled"].includes(status)) {
        const f = await orca(ctx, ["orchestration", "worker-abandon", "--dispatch", id, "--json", "--full"], "merge");
        const fenced = chomp(f.out);
        if (f.code !== 0) { say(ctx, `pause: dispatch fence failed: ${fenced}`); return 1; }
        const ok = jq(fenced, (d, emit) => emit(okConfirmed(d)));
        jqErrs(ctx, ok);
        if (jqE(ok) !== 0) { say(ctx, `pause: dispatch fence unconfirmed: ${fenced}`); return 1; }
      }
      const rel = await orca(ctx, ["orchestration", "worker-release", "--dispatch", id, "--json", "--full"], "merge");
      const out = chomp(rel.out), why = rel.code === 0 ? "unconfirmed" : "failed";
      if (rel.code !== 0 || jqE(jq(out, (d, emit) => emit(released(d)))) !== 0) {
        if (out.includes("release_unknown") || out.includes("no longer resolves")) { unknown += `pause: dispatch release unknown: ${out}\n`; continue; }
        say(ctx, `pause: dispatch release ${why}: ${out}`);
        return 1;
      }
      n++;
    }
    if (unknown) { ctx.err(`${unknown}pause: release_unknown only; every other dispatch released\n`); return 1; }
    ctx.out(`${n}\n`);
    return 0;
  },
  /** <run_id> <task_id> -> that task's spec (exit 1 when the task isn't in the Run's list) */
  async "task-spec"(ctx, a) {
    if (!needTwice(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["orchestration", "task-list", "--run", a[0], "--json", "--full"], "drop");
    if (r.code !== 0) { say(ctx, `orca adapter: task-spec could not list the tasks of ${a[0]}`); return 1; }
    if (!needTwice(ctx, a, 2)) return 1;
    const j = jq(chomp(r.out), (d, emit) => {
      some(emit, idx(at(each(idx(idx(d, "result"), "tasks")).filter((t) => idx(t, "id") === a[1]), 0), "spec"));
    });
    ctx.out(rawLines(j.vals));
    if (jqE(j) !== 0) { say(ctx, `orca adapter: task-spec found no task ${a[1]} in ${a[0]}`); return 1; }
    return 0;
  },
  /** <task_id> <handle> <run_id> -> dispatch id: hand an existing task to a live terminal (`orchestration
   *  dispatch --inject`), sent from the Run's coordinator ($DS_ORCA_FROM). --inject types the task into the
   *  terminal: without it the member's screen shows nothing (injected:false, host 2026-11-03) and mail waits
   *  unread. The loop (U71) uses it to put a restarted member back in its Run; never the squad's umbrella
   *  task, which Orca refuses (task_not_startable). */
  async dispatch(ctx, a) {
    const say300 = (what: string, out: string) =>
      ctx.err(Buffer.concat([Buffer.from(`orca adapter: dispatch of ${a[0]} to ${a[1]} ${what}: `), head300(out), Buffer.from("\n")]));
    if (!need(ctx, a, 3)) {
      if (!need(ctx, a, 2)) return 1;
      say300("failed", "");
      return 1;
    }
    const r = await orca(ctx, ["orchestration", "dispatch", "--task", a[0], "--to", a[1], "--run", a[2], "--inject",
      ...fromArgs(ctx.env), ...retryArgs(ctx.env), "--json", "--full"], "merge");
    const out = chomp(r.out);
    if (r.code !== 0) { say300("failed", out); return 1; }
    const id = firstLine(jq(out, (d, emit) => {
      if (idx(d, "ok") === false) return;
      const res = idx(d, "result");
      some(emit, or(() => idx(idx(res, "dispatch"), "id"), () => idx(idx(res, "dispatch"), "dispatchId"), () => idx(res, "dispatchId"), () => idx(res, "id")));
    }));
    if (!id) { say300("returned no dispatch id", out); return 1; }
    ctx.out(`${id}\n`);
    return 0;
  },
  /** <dispatch_id> -> fence ONE dispatch (`orchestration worker-abandon --dispatch`), e.g. the old dispatch
   *  of a member the loop rebound, or a Run worker that is no longer a squad member (U71). worker-abandon
   *  takes no --from. Exit 1 when Orca refuses it. */
  async "dispatch-abandon"(ctx, a) {
    if (!needTwice(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["orchestration", "worker-abandon", "--dispatch", a[0], ...retryArgs(ctx.env), "--json", "--full"], "merge");
    const out = chomp(r.out);
    const say300 = (what: string) => ctx.err(Buffer.concat([Buffer.from(`orca adapter: dispatch-abandon of ${a[0]} ${what}: `), head300(out), Buffer.from("\n")]));
    if (r.code !== 0) { say300("failed"); return 1; }
    if (jqE(jq(out, (d, emit) => emit(idx(d, "ok") === false || idx(idx(d, "result"), "ok") === false))) === 0) { say300("refused"); return 1; }
    ctx.out(`dispatch-abandon: fenced ${a[0]}\n`);
    return 0;
  },
  /** <run_id> -> the newest dispatch per worktree, "<worktree>\t<dispatch id>\t<status>", from a complete,
   *  validated listing (every page, every row with a dispatch id). */
  async "run-dispatches"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    let cursor = "";
    const pageVals: unknown[] = [];
    for (;;) {
      const p = await orca(ctx, ["orchestration", "worker-list", "--run", a[0], "--json", "--full", "--limit", "100", ...(cursor ? ["--cursor", cursor] : [])]);
      if (p.code !== 0) return 1;
      const page = chomp(p.out);
      const v = jq(page, (d, emit) => {
        const ws = idx(idx(d, "result"), "workers");
        emit(idx(d, "ok") !== false && jqType(ws) === "array" && iter(ws).every((w) => jqType(idx(w, "dispatchId")) === "string"));
      });
      jqErrs(ctx, v);
      if (jqE(v) !== 0) return 1;
      pageVals.push(...scan(page).vals);
      const next = nextPage(ctx, page, cursor);
      if (typeof next === "number") return next;
      if (!next) break;
      cursor = next;
    }
    try {
      const ws: unknown[] = [];
      for (const d of pageVals) ws.push(...iter(idx(idx(d, "result"), "workers")).filter((w) => wtOf(w) !== ""));
      ctx.out(groupBy(ws, wtOf).map(([w]) => `${interp(wtOf(w))}\t${interp(idx(w, "dispatchId"))}\t${interp(or(() => idx(w, "dispatchStatus"), () => ""))}\n`).join(""));
      return 0;
    } catch (e) {
      if (!(e instanceof JqError)) throw e;
      ctx.err(`jq: error: ${e.message}\n`);
      return 5;
    }
  },
  /** <run_id> <worktree_id> -> stop the supervised worker in a worktree (keeps the worktree + its branch).
   *  worker-stop only takes --dispatch (no --from: it rejects it), so the worktree's LIVE dispatch comes from
   *  the Run's worker list first (dispatchStatus "dispatched", the FULL compound worktree id: its first half
   *  is the repo uuid, the same for every worktree of one repo). worker-stop can only fence an ACTIVE
   *  dispatch: a definite negative verdict (dispatch_inactive / stop_unknown, or an orphaned dispatch) is
   *  abandoned, so a later worker-release frees its long-poll slot; no JSON at all (a CLI hiccup, not a
   *  verdict) abandons nothing, as fencing a possibly healthy worker would let restart start a duplicate. */
  async "worker-stop"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["orchestration", "worker-list", "--run", a[0], "--json", "--full"], "drop");
    if (!needTwice(ctx, a, 2)) return 1;
    const disp = firstLine(jq(r.out, (d, emit) => {
      for (const w of each(idx(idx(d, "result"), "workers"))) if (idx(w, "dispatchStatus") === "dispatched" && wtOf(w) === a[1]) some(emit, idx(w, "dispatchId"));
    }));
    if (!disp) { say(ctx, `orca adapter: no live dispatch for worktree ${a[1]} in run ${a[0]} — nothing to stop`); return 0; }
    const s = chomp((await orca(ctx, ["orchestration", "worker-stop", "--dispatch", disp, "--json", "--full"], "drop")).out);
    // Not `//`: it treats false as empty, and a genuine ok:false must stay "false".
    const ok = jqr(s, (d, emit) => {
      const r2 = idx(idx(d, "result"), "ok"), t = idx(d, "ok");
      emit(r2 !== null ? interp(r2) : t !== null ? interp(t) : "");
    });
    const code = jqr(s, (d, emit) => some(emit, or(() => idx(idx(d, "result"), "code"), () => idx(d, "code"))));
    if (ok === "true") return 0;
    if (ok === "false") {
      say(ctx, /dispatch_inactive|stop_unknown/.test(code)
        ? `orca adapter: dispatch ${disp} inactive/unknown (worktree ${a[1]}; code=${code}) — abandoning so its slot can be released; restart will start fresh`
        : `orca adapter: dispatch ${disp} could not be stopped (worktree ${a[1]}; orphaned/dead) — abandoning so its slot can be released; restart will start fresh`);
      await orca(ctx, ["orchestration", "worker-abandon", "--dispatch", disp, "--json", "--full"], "drop");
      return 0;
    }
    say(ctx, `orca adapter: worker-stop got no verdict for dispatch ${disp} (worktree ${a[1]}) — treating as already-stopped, NOT abandoning (no negative verdict); restart will start fresh`);
    return 0;
  },
  /** <run> <worktree_id> <spec> <agent> <model> [host] [effort] [account] [window] [role] -> (re)start a
   *  supervised worker in an EXISTING worktree (no --name: a creation option Orca rejects on an existing
   *  worktree), to restart a role in place. The fresh-start guard's `agent_busy` refusal keeps its exit 3
   *  (U97); other failures exit 1. */
  async "worker-start"(ctx, a) {
    await finishLaunched(ctx);
    if (!need(ctx, a, 2)) return 1;
    const g = await guardFreshStart(ctx, a[1]);
    if (g !== 0) return g;
    const before = (await tabsOf(ctx, a[1])) ?? "?";
    if (!needIn(ctx, a, 4, 5, 3, 1)) return 1;
    if (await startWorker(ctx, `worktree ${a[1]} (restart)`, a[1], a[3], a[4], blank(a[5]), blank(a[6]), blank(a[7]), blank(a[8]),
      ["--spec", a[2], "--run", a[0], ...keepOpen(blank(a[9]))])) return 0;
    await dropNewTabs(ctx, a[1], before);
    return 1;
  },
  /** <run> <worktree_id> -> free the long-poll slot(s) this worktree's SETTLED dispatches hold. Orca keeps a
   *  stopped/succeeded worker as reclaimable/retained until released; left alone they pile up across
   *  restarts and saturate the runtime (runtime_busy). worker-release is settled-only and idempotent, and a
   *  still-live dispatch is a safe no-op, so every dispatch id of the worktree is released. Prints how many. */
  async "worker-release"(ctx, a) {
    let n = 0;
    for (const d of await wtDispatchIds(ctx, a)) {
      const r = await orca(ctx, ["orchestration", "worker-release", "--dispatch", d, "--json", "--full"], "merge");
      if (r.code === 0) n++;
      else say(ctx, `orca adapter: worker-release failed for dispatch ${d}: ${chomp(r.out)}`);
    }
    ctx.out(`${n}\n`);
    return 0;
  },
  /** <run> <worktree_id> -> fence this worktree's live/uncertain dispatch WITHOUT claiming its process
   *  stopped (the stop_unknown case worker-stop can't fence). The worker then settles so worker-release can
   *  free its slot instead of it leaking as retained forever. */
  async "worker-abandon"(ctx, a) {
    for (const d of await wtDispatchIds(ctx, a)) await orca(ctx, ["orchestration", "worker-abandon", "--dispatch", d, "--json", "--full"], "drop");
    return 0;
  },
  /** [<run>] -> close the leaked terminals of RECLAIMABLE settled workers: with a run, scoped to it (the
   *  self-clean a restart runs first); with none, the whole host (runs with no live state file). Only
   *  `reclaimable` is our leak; `retained` is a dispatch with no owned terminal or a PROTECTED one, which
   *  worker-release refuses to close. worker-list caps at 100 rows a page and its cursor is an offset, so
   *  every id is collected first, then released. Counts only a real close (processAction != "none"). */
  async "worker-reclaim"(ctx, a) {
    const run = a[0] ?? "";
    let ids = "", cursor = "", n = 0;
    for (;;) {
      const page = chomp((await orca(ctx, ["orchestration", "worker-list", ...(run ? ["--run", run] : []), "--terminal-state", "reclaimable",
        "--limit", "100", "--json", "--full", ...(cursor ? ["--cursor", cursor] : [])], "drop")).out);
      if (!page) break;
      const pids = chomp(dispatchIds(page).map((l) => `${l}\n`).join(""));
      if (pids) ids += `${pids}\n`;
      if (jqrOr(page, (d, emit) => emit(or(() => idx(idx(idx(d, "result"), "page"), "hasMore"), () => false)), "false") !== "true") break;
      cursor = jqr(page, (d, emit) => some(emit, idx(idx(idx(d, "result"), "page"), "nextCursor")));
      if (!cursor) break;
    }
    for (const d of lines(ids)) {
      if (!d) continue;
      const out = chomp((await orca(ctx, ["orchestration", "worker-release", "--dispatch", d, "--json", "--full"], "drop")).out);
      const freed = jq(out, (x, emit) => emit(idx(x, "ok") === true && or(() => idx(idx(x, "result"), "processAction"), () => "none") !== "none"));
      if (jqE(freed) === 0) n++;
    }
    ctx.out(`${n}\n`);
    return 0;
  },
  /** [<run>] -> unstick dispatches in `release_unknown` (a release that couldn't confirm): abandon each (fence
   *  it so it settles), then release it. With no run, host-wide. Idempotent. Prints how many it cleared. */
  async "worker-resolve-unknown"(ctx, a) {
    const run = a[0] ?? "";
    const r = await orca(ctx, ["orchestration", "worker-list", ...(run ? ["--run", run] : []), "--terminal-state", "release_unknown",
      "--limit", "100", "--json", "--full"], "drop");
    let n = 0;
    for (const d of dispatchIds(r.out)) {
      if (!d) continue;
      await orca(ctx, ["orchestration", "worker-abandon", "--dispatch", d, "--json", "--full"], "drop");
      if ((await orca(ctx, ["orchestration", "worker-release", "--dispatch", d, "--json", "--full"], "drop")).code === 0) n++;
    }
    ctx.out(`${n}\n`);
    return 0;
  },
};

/** True when `orca status` reports the runtime reachable. */
async function runtimeReachable(ctx: Ctx): Promise<boolean> {
  const r = await orca(ctx, ["status", "--json"], "drop");
  try { const ds = docs(r.out); return ds.length > 0 && ds.every((d) => alt(idx(idx(idx(d, "result"), "runtime"), "reachable"), idx(idx(d, "result"), "runtimeReachable")) === true); } catch { return false; }
}
/** The CLAUDE_CONFIG_DIR of a managed account (its profile home), "" for `system`, null when the home is missing. */
function claudeConfigDir(ctx: Ctx, acct: string): string | null {
  if (acct === "system") return "";
  const h = `${orcaData(ctx.env)}/claude-profiles/${acct}/home`;
  try { return statSync(h).isDirectory() ? h : null; } catch { return null; }
}

/** U264: `current`'s answer per cwd and CLI, inside the loop only. */
const currentKept = new Map<string, string>();

export const VERBS: Record<string, Verb> = {
  /** `reachable` when the runtime answers and reports reachable; exit 1 otherwise (install.sh's preflight). */
  async status(ctx) {
    if (await runtimeReachable(ctx)) { ctx.out("reachable\n"); return 0; }
    ctx.err("orca adapter: runtime not reachable (see 'orca status')\n");
    return 1;
  },
  /** One start for install.sh's preflight and wrap-hooks: exit 1 (nothing printed) when the runtime is not
   *  reachable, else the `account-list` rows, with a Claude row's config dir (empty for `system`, and for a
   *  profile whose home is missing) as a fourth column. */
  async preflight(ctx) {
    if (!(await runtimeReachable(ctx))) { ctx.err("orca adapter: runtime not reachable (see 'orca status')\n"); return 1; }
    for (const l of await accountList(ctx)) {
      const [agent, id] = l.split("\t");
      ctx.out(agent === "claude" && id ? `${l}\t${claudeConfigDir(ctx, id) ?? ""}\n` : `${l}\n`);
    }
    return 0;
  },
  /** The registered projects, the backend's raw JSON (the Dispatcher reads it). */
  async "project-list"(ctx) {
    const r = await orca(ctx, ["project", "list", "--json"], "drop");
    ctx.out(r.outBytes);
    return 0;
  },
  /** <path> -> register the home repo with the backend (idempotent; already registered is fine). */
  async "repo-ensure"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    await orca(ctx, ["repo", "add", "--path", a[0]], "drop");
    return 0;
  },
  /** "<agent>\t<account_id>\t<label>" per account; the FIRST line per agent is its default login. Claude:
   *  every host profile Orca manages plus the system login (`system`), default first. Muse/Codex: their one login. */
  async "account-list"(ctx) {
    ctx.out((await accountList(ctx)).map((l) => l + "\n").join(""));
    return 0;
  },
  async "agent-accounts"(ctx) {
    ctx.out(Buffer.from(agentAccounts(ctx.env), "latin1"));
    return 0;
  },
  /** <account> -> the CLAUDE_CONFIG_DIR a claude on that account runs with (its plugin registry lives under
   *  it); empty for `system` (run with CLAUDE_CONFIG_DIR unset). Exit 1 when the profile home is missing. */
  async "claude-config-dir"(ctx, a) {
    if (!a[0]) { ctx.err("orca adapter: claude-config-dir needs an account id\n"); return 2; }
    if (a[0] === "system") return 0;
    const h = claudeConfigDir(ctx, a[0]);
    if (h === null) { ctx.err(`orca adapter: no Claude home for account ${a[0]} (${orcaData(ctx.env)}/claude-profiles/${a[0]}/home)\n`); return 1; }
    ctx.out(`${h}\n`);
    return 0;
  },
  /** "<agent>\t<account>\t<session_pct>\t<session_reset>\t<weekly_pct>\t<weekly_reset>[\texpired]" per Claude
   *  account (resets epoch s, `-` = unknown), plus a `muse default` row when `muse usage` works. */
  async "account-usage"(ctx) {
    await accountUsage(ctx);
    return 0;
  },
  /** "<agent>\t<account>\t<json>" per account: its free resets (conventions/backend.md), read from what the
   *  last `account-usage` fetched; no provider call. */
  async "account-resets"(ctx) {
    await accountResets(ctx);
    return 0;
  },
  /** "<outcome>\t<detail>": uses one free reset grant (account-free-resets U4; the loop's account-reset
   *  fulfiller is its only caller). Exit 1 with no outcome when the provider gave no answer. */
  async "account-reset-use"(ctx, a) {
    return accountResetUse(ctx, a);
  },
  async limited(ctx) {
    ctx.out(await limited(ctx));
    return 0;
  },
  /** The worktree ps JSON merged across the default host and the omitted hosts (R8). */
  async ps(ctx) {
    try { ctx.out(pretty(await mergedPs(ctx)) + "\n"); return 0; } catch (e) { return jqFail(ctx, e); }
  },
  /** <n> -> raise Orca's "Nested worker depth" to >= <n> SAFELY. Orca MUST be stopped (the rollback refuses
   *  otherwise). Idempotent. The ONLY place that touches the profile store, and only via Orca's own tooling:
   *  orca-data.json is SQLite-mirrored, so a raw edit while SQLite exists diverges them and Orca refuses to
   *  start; `rollback --latest-json` exports to JSON and DELETES SQLite, so the JSON is authoritative and
   *  startup re-imports it. Studio->Lead->Builder nesting needs >= 2; Orca's default is 1. */
  async "set-nested-depth"(ctx, a) {
    const want = a[0] || "5";
    if (!/^[0-9]+$/.test(want)) { ctx.err("set-nested-depth: need a positive integer\n"); return 2; }
    const depth = (text: string): string => {
      const hits = text.match(/"nestedWorkerMaxDepth"[: ]*[0-9]*/g) ?? [];
      for (const h of hits) { const d = h.match(/[0-9]+/); if (d) return d[0]; }
      return "";
    };
    const cfg = `${ctx.env.XDG_CONFIG_HOME || `${ctx.env.HOME}/.config`}/orca`;
    let files: string[] = [];
    try { files = readdirSync(`${cfg}/profiles`).sort().map((p) => `${cfg}/profiles/${p}/orca-data.json`); } catch { files = []; }
    let cur = "";
    for (const f of [...files, `${cfg}/orca-data.json`]) {
      try { if (statSync(f).isFile()) { cur = depth(readFileSync(f, "latin1")); if (cur) break; } } catch { /* not there */ }
    }
    if (!/^[0-9]+$/.test(cur)) cur = "1";
    if (Number(cur) >= Number(want)) { ctx.out(`nested-worker-depth already ${cur} (>= ${want}) — nothing to do.\n`); return 0; }
    ctx.err(`nested-worker-depth ${cur} < ${want}; exporting profile state to JSON (Orca must be stopped)…\n`);
    const r = await orca(ctx, ["profile", "state", "rollback", "--latest-json"], "keep");
    const said = chomp(r.out + r.err);
    if (r.code !== 0) { ctx.err(`${said}\nset-nested-depth: rollback failed — STOP Orca first and retry.\n`); return 1; }
    ctx.err(`${said}\n`);
    const path = said.split("\n").find((l) => l.startsWith("restored:"))?.replace(/^restored:[ \t\n\v\f\r]*/, "") ?? "";
    let isFile = false;
    try { isFile = !!path && statSync(path).isFile(); } catch { isFile = false; }
    if (!isFile) { ctx.err("set-nested-depth: no 'restored:' path in rollback output.\n"); return 1; }
    const bak = `${path}.bak-${Math.floor(Date.now() / 1000)}`;
    copyFileSync(path, bak);
    const st = statSync(path);
    utimesSync(bak, st.atime, st.mtime);
    const d = JSON.parse(readFileSync(path, "utf8"));
    if (!isObj(d.settings)) d.settings = {};
    d.settings.nestedWorkerMaxDepth = Number.parseInt(want, 10);
    writeFileSync(path, JSON.stringify(d));
    const got = depth(readFileSync(path, "latin1"));
    if (got !== want) { ctx.err(`set-nested-depth: verify failed (reads '${got || "?"}').\n`); return 1; }
    ctx.out(`set nestedWorkerMaxDepth=${want} in ${path} (backup beside it). START Orca — it imports the JSON on startup.\n`);
    return 0;
  },
  /** This terminal's worktree id (the self-guards in close-squad/close-role/restart-role, ask-operator's
   *  card). By THIS terminal first: `orca worktree current` resolves the current DIRECTORY, so an agent that
   *  cd'd to ~/.dev-studio got "" and slipped past every self-guard. cwd is the fallback. */
  async current(ctx) {
    let cur = "";
    const h = ctx.env.ORCA_TERMINAL_HANDLE;
    if (h) {
      const r = await orca(ctx, ["terminal", "list", "--json"], "drop");
      try {
        for (const d of docs(r.out)) for (const t of each(idx(idx(d, "result"), "terminals"))) {
          if (cur || idx(t, "handle") !== h) continue;
          const w = idx(t, "worktreeId");
          if (truthy(w)) cur = raw(w).split("\n")[0];
        }
      } catch { cur = ""; }
    }
    if (cur) { ctx.out(`${cur}\n`); return 0; }
    // U264: inside the loop (DS_ORCA_TICK_DIR) the answer is kept for the process's life, by cwd and CLI: the
    // loop's directory never changes worktree, and from its checkout Orca answers selector_not_found on every call.
    const key = ctx.env.DS_ORCA_TICK_DIR ? `${process.cwd()}\0${ctx.env.DS_ORCA_CLI_BIN_DIR ?? ""}\0${ctx.env.ORCA_CLI_BIN_DIR ?? ""}` : "";
    const kept = key ? currentKept.get(key) : undefined;
    if (kept !== undefined) { ctx.out(kept); return 0; }
    const r = await orca(ctx, ["worktree", "current", "--json"], "keep");
    try {
      const o = entityId(r.out).map((l) => l + "\n").join("");
      ctx.out(o);
      if (key && (r.code === 0 || /"selector_not_found"/.test(r.out + r.err))) currentKept.set(key, o);
    } catch (e) { jqFail(ctx, e); }
    return 0;
  },
  /** <worktree_id> <text> -> set a card note on a worktree (the Lead->operator ping: "NEEDS YOU: <q>", empty
   *  clears it). The whole Lead->operator path rests on this, so a failure is surfaced, never swallowed. */
  async ping(ctx, a) {
    if (!need(ctx, a, 2)) return 1;
    const r = await orca(ctx, ["worktree", "set", "--worktree", `id:${a[0]}`, "--comment", a[1], "--json"]);
    if (r.code === 0) return 0;
    ctx.err(`orca adapter: ping failed for worktree ${a[0]} — card note NOT set (confirm@host: 'worktree set --comment', and clearing with "")\n`);
    return 1;
  },
  /** <repo> <name> [parent_wt] -> worktree id, with NO worker started: spawn creates the Lead's worktree
   *  first (so children nest under it) and starts its worker last, so the Lead isn't live to adopt the run
   *  and fence the Studio's child starts during the fan-out. */
  async "wt-create"(ctx, a) {
    if (!need(ctx, a, 2)) return 1;
    const { id, code } = await wtCreate(ctx, a[0], a[1], blank(a[2]));
    if (code !== 0) return code;
    if (!id) { ctx.err(`orca adapter: wt-create failed (repo=${a[0]} name=${a[1]}; see error above)\n`); return 1; }
    ctx.out(id);
    return 0;
  },
  /** <wt> <parent_wt> -> make <parent_wt> the parent of <wt> (the loop keeps the squad tree, U206). Setting
   *  the parent it already has is a no-op in Orca. */
  async "wt-set-parent"(ctx, a) {
    if (!a[0] || !a[1]) { ctx.err("orca adapter: wt-set-parent needs <wt> <parent_wt>\n"); return 2; }
    const r = await orca(ctx, ["worktree", "set", "--worktree", `id:${a[0]}`, "--parent-worktree", `id:${a[1]}`, "--json"]);
    if (r.code === 0) return 0;
    ctx.err(`orca adapter: wt-set-parent failed for ${a[0]} under ${a[1]}\n`);
    return 1;
  },
  /** <selector> [force] -> remove a worktree (stops its worker). Keeps unmerged branches unless force. */
  async "worktree-rm"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["worktree", "rm", "--worktree", a[0], ...(a[1] === "force" ? ["--force"] : []), "--json"], "keep");
    if (r.code === 0) return 0;
    // orca prints its error JSON on STDOUT, so keep it and surface it.
    ctx.err(`${chomp(r.out + r.err)}\norca adapter: worktree rm failed for ${a[0]} (see error above)\n`);
    return 1;
  },
  /** <repo> <name> <branch> <base> [parent_path] -> the new worktree as one JSON line ({id, path, branch, head,
   *  parentWorktreeId}): `orca worktree create` with no agent and no Run, setup hooks skipped, nested under
   *  <parent_path> or explicitly top-level (the `orca` worktree provider, U8b). Orca picks the folder, and an
   *  existing branch or taken name gets a `-2` suffix: the caller checks the answer. */
  async "wt-make"(ctx, a) {
    if (!need(ctx, a, 4)) return 1;
    const parent = blank(a[4]);
    const r = await orca(ctx, ["worktree", "create", "--repo", `path:${a[0]}`, "--name", a[1], "--branch", a[2], "--base-branch", a[3],
      ...(parent ? ["--parent-worktree", `path:${parent}`] : ["--no-parent"]), "--setup", "skip", "--json"], "keep");
    const w = r.code === 0 ? wtJson(r.out) : null;
    if (w) { ctx.out(`${JSON.stringify(w)}\n`); return 0; }
    ctx.err(`${chomp(r.out + r.err)}\norca adapter: wt-make failed (repo=${a[0]} name=${a[1]})\n`);
    return 1;
  },
  /** <selector> -> the worktree as one JSON line (as wt-make prints it); exit 3 when Orca has no such worktree.
   *  `path:<path>` finds a worktree Orca no longer lists too (docs/backends/orca-probe.md Q1). */
  async "wt-show"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["worktree", "show", "--worktree", a[0], "--json"], "keep");
    const w = r.code === 0 ? wtJson(r.out) : null;
    if (w) { ctx.out(`${JSON.stringify(w)}\n`); return 0; }
    if (/selector_not_found/.test(r.out + r.err)) return 3;
    ctx.err(`${chomp(r.out + r.err)}\norca adapter: wt-show failed for ${a[0]}\n`);
    return 1;
  },
  /** <repo> -> one JSON line per worktree Orca lists for the repo (as wt-make prints them), the main checkout
   *  left out; exit 1 when the list cannot be read whole (a truncated list would read as worktrees gone). */
  async "wt-list"(ctx, a) {
    if (!need(ctx, a, 1)) return 1;
    const r = await orca(ctx, ["worktree", "list", "--repo", `path:${a[0]}`, "--limit", "10000", "--json"], "keep");
    let res: { worktrees?: unknown[]; truncated?: boolean } | null = null;
    try { res = r.code === 0 ? JSON.parse(r.out).result : null; } catch { res = null; }
    if (!res || !Array.isArray(res.worktrees) || res.truncated) {
      ctx.err(`${chomp(r.out + r.err)}\norca adapter: wt-list failed for ${a[0]}${res?.truncated ? " (truncated)" : ""}\n`);
      return 1;
    }
    for (const w of res.worktrees as Record<string, unknown>[]) if (!w.isMainWorktree) ctx.out(`${JSON.stringify(wtSlim(w))}\n`);
    return 0;
  },
  /** <repo> <name> <agent> <prompt> [parent_wt] -> worktree id; create + launch the agent if absent. An empty
   *  <agent> creates the worktree only (/ds-up then opens the Studio with studio-start, U262). */
  async "worktree-ensure"(ctx, a) {
    if (!need(ctx, a, 4)) return 1;
    const { printed, code } = await wtCreate(ctx, a[0], a[1], a[4] ?? "", blank(a[2]) ? ["--agent", a[2], "--prompt", a[3]] : []);
    ctx.out(printed);
    return code;
  },
  /** <wt> <account> <model> <effort> <window> <prompt> -> the handle of a new Studio tab (KTD4, U262): claude
   *  in <wt> on <account> (empty or `-`: the default login, as startWorker picks it; `system`: the system
   *  login), with --model/--effort when given, the auto-compact <window> and the Studio's skillOverrides in one
   *  --settings, and <prompt> as its first message. The Studio is no Run worker, so nothing binds the tab
   *  (no worker-start), and nothing is closed first (no guardFreshStart): the caller has made sure no Studio
   *  runs in <wt>. A tab whose TUI never comes up is closed again, exit 1. */
  async "studio-start"(ctx, a) {
    if (!need(ctx, a, 6)) return 1;
    const wt = a[0], model = blank(a[2]), effort = blank(a[3]);
    let acct = blank(a[1]);
    if (!acct) { acct = (await claudeAccounts(ctx))[0].split("\t")[0]; if (acct === "system") acct = ""; }
    const cs = await compactSettings(ctx, blank(a[4]), wt);
    const h = await claudeTab(ctx, wt, acct,
      [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...cs, ...(a[5] ? [a[5]] : [])]);
    if (h === null) return 1;
    ctx.out(`${h}\n`);
    return 0;
  },
  /** <owner/repo> <number> -> close unmerged, keeping the remote branch. */
  async "pr-close"(ctx, a) {
    if (!need(ctx, a, 2)) return 1;
    const r = await spawn(ctx, [ctx.env.DS_GH || "gh", "pr", "close", a[1], "--repo", a[0]]);
    ctx.out(r.out); ctx.err(r.err);
    return r.code;
  },
  ...INBOX,
  ...TERMINALS,
  ...WORKERS,
};

/** Local process/config reads and the PR close need no orca, so they work during CLI repair. */
const NO_CLI = new Set(["claude-config-dir", "agent-accounts", "pr-close"]);
export const PORTED = Object.keys(VERBS);

/** Run one verb as orca.sh did: resolve the CLI first (except NO_CLI), then the verb on its own copy of the
 *  environment (a verb that lifts DS_LOOP_ACTIVITY lifts it for itself). null for an unknown verb. */
export async function runVerb(ctx: Ctx, verb: string, args: string[]): Promise<number | null> {
  const fn = VERBS[verb];
  if (!fn) return null;
  if (!NO_CLI.has(verb) && !resolveOrcaCli(ctx)) return 1;
  return fn({ ...ctx, env: { ...ctx.env }, op: ctx.op ?? verb }, args);
}

/** The verb's exit code with stdout and stderr collected (for a caller in process, U227). A verb that throws
 *  answers as `ds backend` did: what it printed so far, then `ds backend: <message>` and exit 1. */
export async function call(verb: string, args: string[], env: Env = process.env, signal?: AbortSignal): Promise<Result | null> {
  const out: Uint8Array[] = [], err: Uint8Array[] = [];
  const enc = (b: string | Uint8Array) => typeof b === "string" ? new TextEncoder().encode(b) : b;
  let code: number | null;
  try { code = await runVerb({ env, stdin: "ignore", out: (b) => out.push(enc(b)), err: (b) => err.push(enc(b)), signal }, verb, args); }
  catch (e) { err.push(enc(`ds backend: ${(e as Error)?.message ?? String(e)}\n`)); code = 1; }
  if (code === null) return null;
  return { code, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() };
}
