// orca-cache.ts — the loop's per-tick copy of the Orca reads every step of a tick shares (U244), and the
// count of Orca CLI spawns. The twin of orca_tick / orca_spawn in bin/backend/orca.sh: both read and write
// the same files, so a read made by a bash verb serves a TypeScript one and the other way round.
//
// The loop makes a fresh directory per tick and names it in DS_ORCA_TICK_DIR. In it, a cacheable read
// (`terminal list`, a Run's `worker-list`, a Run's `run-show`) is one file named by the sha1 of its
// canonical arguments (each followed by a NUL). The first caller makes the call; one that comes while
// it runs waits for its file; later callers read it. Any call that is not a read drops the copies it can
// change (U264: runsOfWrite; the `gen` file takes a new token first, so a read that began before the write
// cannot store its answer).
// No directory: nothing is cached and every call goes to Orca, as before.
//
// U248: a page of a Run's worker-list (the cursor is part of the key) is one entry too, so the whole walk of a
// Run is read once per tick whoever walks it. A Run's reads carry a `<key>.meta` sidecar (`<run>\t<read at, ms>`)
// that bin/loop/io/run-keep.ts uses to keep them across ticks: it copies the still-valid ones into the next tick's
// directory and takes the new ones out at the tick's end. DS_ORCA_KEEP_DIR names the kept copies; a write drops
// those too.
//
// DS_ORCA_SPAWN_LOG names a file each real Orca CLI call appends `<verb> <subverb>\t<caller>\t<kind>` to, so a
// tick can count its spawns by verb and by the backend verb that made them (U252).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY = /^[0-9a-f]{40}(\.meta)?$/;

/** The arguments a cacheable read is made and keyed by, or null when the call is not one that is shared.
 *  U252: each flag that changes the answer is part of the key (`--full`, `--terminal-state`, a terminal list's
 *  `--worktree`); `--limit` is not: the shared copy is the widest page. */
export function canonRead(args: string[]): string[] | null {
  const verb = `${args[0] ?? ""} ${args[1] ?? ""}`;
  const rest = args.slice(2);
  const wl = verb === "orchestration worker-list";
  let json = false, full = false, run = "", id = "", cursor = "", state = "", wt = "";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i], v = i + 1 < rest.length;
    if (a === "--json") json = true;
    else if (a === "--full") full = true;
    else if (a === "--limit" && v) i++;
    else if (a === "--cursor" && wl && v) cursor = rest[++i];
    else if (a === "--run" && wl && v) run = rest[++i];
    else if (a === "--terminal-state" && wl && v) state = rest[++i];
    else if (a === "--id" && verb === "orchestration run-show" && v) id = rest[++i];
    else if (a === "--worktree" && verb === "terminal list" && v) wt = rest[++i];
    else return null;
  }
  if (!json) return null;
  const F = full ? ["--full"] : [];
  if (verb === "terminal list") return ["terminal", "list", ...(wt ? ["--worktree", wt] : []), "--limit", "1000", "--json", ...F];
  if (wl && (run || state)) return ["orchestration", "worker-list", ...(run ? ["--run", run] : []), ...(state ? ["--terminal-state", state] : []), "--json", ...F, "--limit", "100", ...(cursor ? ["--cursor", cursor] : [])];
  if (verb === "orchestration run-show" && id) return ["orchestration", "run-show", "--id", id, "--json", ...F];
  // Host-wide reads every project's step makes the same way: one copy a tick, dropped by any write.
  if (verb === "orchestration inbox" && full) return ["orchestration", "inbox", "--limit", "1000", "--json", "--full"];
  if (verb === "worktree ps" && !full) return ["worktree", "ps", "--json", "--limit", "1000"];
  if (verb === "worktree current" && !full) return ["worktree", "current", "--json"];
  return null;
}

/** `worktree current` answers for the directory it runs in, so its key carries this process's. */
export const keyOf = (canon: string[]): string => createHash("sha1")
  .update([...canon, ...(canon[0] === "worktree" && canon[1] === "current" ? [`cwd=${process.cwd()}`] : [])].map((a) => `${a}\0`).join("")).digest("hex");

/** The Run a shared read belongs to (a worker-list or run-show), "" for any other. A `--terminal-state` listing
 *  belongs to none: it is shared within the tick only, never kept across ticks (run-keep.ts keeps by Run). */
export function runOfCanon(canon: string[]): string {
  if (canon.includes("--terminal-state")) return "";
  const verb = `${canon[0]} ${canon[1]}`;
  const flag = verb === "orchestration worker-list" ? "--run" : verb === "orchestration run-show" ? "--id" : "";
  const i = flag ? canon.indexOf(flag) : -1;
  return i >= 0 ? canon[i + 1] ?? "" : "";
}

export const gen = (dir: string): string => { try { return readFileSync(join(dir, "gen"), "utf8"); } catch { return ""; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The answer of a cacheable read: the tick's copy, or `fetch`'s (stored when it succeeded and no write came between). */
export async function cachedRead<T>(dir: string, canon: string[], fetch: () => Promise<{ code: number; out: Uint8Array; value: T }>):
  Promise<{ hit: true; out: Uint8Array } | { hit: false; value: T }> {
  if (!existsSync(dir)) return { hit: false, value: (await fetch()).value };
  const f = join(dir, keyOf(canon)), lock = `${f}.lk`;
  for (let n = 0; n < 400; n++) {
    try { return { hit: true, out: readFileSync(f) }; } catch { /* not there yet */ }
    let mine = false;
    try { mkdirSync(lock); mine = true; } catch { /* another call is making it */ }
    if (!mine) { await sleep(50); continue; }
    try {
      const g0 = gen(dir), r = await fetch();
      if (r.code === 0 && gen(dir) === g0) {
        const tmp = `${f}.${process.pid}.tmp`;
        try {
          writeFileSync(tmp, r.out); renameSync(tmp, f);
          const run = runOfCanon(canon);
          if (run) writeFileSync(`${f}.meta`, `${run}\t${Date.now()}\n`);
        } catch { /* the tick ended: nothing to keep */ }
      }
      return { hit: false, value: r.value };
    } finally { try { rmdirSync(lock); } catch { /* gone with the tick */ } }
  }
  return { hit: false, value: (await fetch()).value };
}

/** The Runs whose cached reads (the files with a `.meta`: a worker-list page, a run-show) name any of `subjects` as a
 *  JSON string: a worker-list names its workers' dispatch, task, terminal and worktree ids, a run-show its coordinator. */
export function runsNaming(subjects: string[], dirs: (string | undefined)[]): string[] {
  const needles = subjects.filter(Boolean).map((s) => JSON.stringify(s)), runs = new Set<string>();
  for (const d of dirs) {
    if (!d || !needles.length) continue;
    try {
      for (const n of readdirSync(d)) {
        if (!/^[0-9a-f]{40}$/.test(n)) continue;
        const m = metaRun(join(d, n));
        if (!m || runs.has(m)) continue;
        const text = readFileSync(join(d, n), "utf8");
        if (needles.some((x) => text.includes(x))) runs.add(m);
      }
    } catch { /* none cached */ }
  }
  return [...runs];
}
const metaRun = (f: string): string => { try { return readFileSync(`${f}.meta`, "utf8").split("\t")[0] ?? ""; } catch { return ""; } };

/** The flags that name what a write acts on, in the order they are looked at. */
const SUBJECTS = ["--terminal", "--to", "--from", "--dispatch", "--worker", "--worktree", "--task"];

/** U264: the Runs a write can change. `--run` (run-use's `--id`, `--to run:<id>`) names it; otherwise each subject the
 *  write names (a terminal handle, a dispatch, worker, worktree or task id; `dispatch:`, `@worktree:` and `id:` taken
 *  off) is looked up in the cached Run reads (runsNaming). [] = no cached Run read names the subject, so no Run copy is
 *  about it (a stray terminal close): only the Run-less copies go. null = the write names no subject at all: it cannot
 *  be placed and every copy goes. */
export function runsOfWrite(args: string[], dirs: (string | undefined)[]): string[] | null {
  const at = (f: string) => { const i = args.indexOf(f, 2); return i >= 0 ? args[i + 1] ?? "" : ""; };
  const run = at("--run") || (args[0] === "orchestration" && args[1] === "run-use" ? at("--id") : "");
  if (run) return [run];
  const subjects: string[] = [];
  for (const f of SUBJECTS) {
    const v = at(f);
    if (v.startsWith("run:")) return [v.slice(4)];
    if (v) subjects.push(v.replace(/^(dispatch:|@worktree:|id:)/, ""));
  }
  return subjects.length ? runsNaming(subjects, dirs) : null;
}

/** A write went to Orca: the copies it can change are stale. With `runs` (runsOfWrite) only those Runs' copies and
 *  the Run-less ones (`terminal list`, the inbox, `worktree ps`) go; without it every copy of the tick and every kept
 *  one goes. The `gen` file takes a new token either way, so a read that began before the write cannot store its answer. */
export function dropCached(dir: string, keepDir?: string, runs?: string[]): void {
  const take = (d: string) => {
    for (const n of readdirSync(d)) {
      if (!KEY.test(n)) continue;
      const base = n.replace(/\.meta$/, "");
      if (runs) { const m = metaRun(join(d, base)); if (m && !runs.includes(m)) continue; }
      rmSync(join(d, n), { force: true });
    }
  };
  if (keepDir) try { take(keepDir); } catch { /* none kept */ }
  if (!existsSync(dir)) return;
  try {
    writeFileSync(join(dir, `gen.${process.pid}`), `${process.pid}.${process.hrtime.bigint()}\n`);
    renameSync(join(dir, `gen.${process.pid}`), join(dir, "gen"));
    take(dir);
  } catch { /* the tick ended */ }
}

/** One line in the tick's spawn log (DS_ORCA_SPAWN_LOG), when there is one. */
export function countLine(env: Record<string, string | undefined>, line: string): void {
  const log = env.DS_ORCA_SPAWN_LOG;
  if (!log) return;
  try { appendFileSync(log, `${line}\n`); } catch { /* a count is never worth a failed call */ }
}

/** What made a drop, for the tick's `dropped_by` count: a `drop <verb> <subverb>` line in the spawn log, and a
 *  `drop unplaced` line too when the write could not be placed (U264), so every copy went. */
export function countDrop(env: Record<string, string | undefined>, args: string[], unplaced = false): void {
  countLine(env, `drop ${args[0] ?? ""} ${args[1] ?? ""}`);
  if (unplaced) countLine(env, "drop unplaced");
}

/** Why a real Orca CLI call was made, for the tick's per-caller count (U252): `keyed` a shared read no copy
 *  answered yet, `past` a read that is not shared (canonRead had no key for it), `write` any other call. */
export type SpawnKind = "keyed" | "past" | "write";

/** One real Orca CLI call, for the tick's count: `<verb> <subverb>\t<caller>\t<kind>`, the caller being the
 *  backend verb that made it ("" when the call came from outside one). */
export function countSpawn(env: Record<string, string | undefined>, args: string[], caller = "", kind: SpawnKind | "" = ""): void {
  countLine(env, `${args[0] ?? ""} ${args[1] ?? ""}\t${caller}\t${kind}`);
}
