// split.ts — side-loop-host U8 (issue #127, KTD6): the local half of a `split` command. A split command reads
// the worker's worktree, which only the side host has, and writes rows, which only main has. So `bin/ds` on the
// side host gathers the facts first (gather), the relay carries them up with the call, main checks their shape
// (checkFacts) and runs the real command with them in DS_LINK_FACTS (factsOf). The facts are what the command
// would have read itself; nothing else of the worktree reaches main.
//   finish-unit-ts  the branch, HEAD and the review receipt's state on this branch (finishFacts)
//   watch-ts        whether the instructions changed since this worktree last read them (watch-ts instructionsSeen)
//   picker-hook-ts  (u8b) post: the answer from the hook's stdin; pre-async: the hook input file, cut to what it
//                   uses; permission-async: the hook input and the transcript's tool call (picker-hook-ts *Facts).
//                   The side's hook input file is read and removed here; main never sees its path.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run as runCmd } from "../lib/shared";

export type Facts = Record<string, unknown>;
/** The most facts one call carries, as JSON. */
export const FACTS_MAX = 16 * 1024;

/** What finish-unit reads from the worktree's git (the same on main and on a side host). */
export type FinishFacts = {
  branch: string | null;        // rev-parse --abbrev-ref HEAD
  head: string | null;          // rev-parse HEAD
  receipt: string | null;       // line 1 of <git-dir>/ds-review, null when there is none
  origin_head: string | null;   // symbolic-ref refs/remotes/origin/HEAD
  ancestor: boolean | null;     // the receipt's sha is on HEAD's history (null: no receipt sha)
  since: string | null;         // commits from the receipt's sha to HEAD
  short: string | null;         // the receipt's sha, short
};

const chomp = (s: string) => s.replace(/\n+$/, "");

async function git(args: string[], cwd?: string): Promise<string | null> {
  const r = await runCmd(["git", ...args], cwd ? { cwd } : undefined);
  return r.rc === 0 && chomp(r.out) ? chomp(r.out) : null;
}

export async function finishFacts(cwd?: string): Promise<FinishFacts> {
  const [branch, head, gdir, origin_head] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], cwd), git(["rev-parse", "HEAD"], cwd),
    git(["rev-parse", "--git-dir"], cwd), git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd)]);
  let receipt: string | null = null;
  if (gdir) try { receipt = readFileSync(join(cwd && !gdir.startsWith("/") ? join(cwd, gdir) : gdir, "ds-review"), "utf8").split("\n")[0] ?? ""; } catch { /* no receipt */ }
  const rsha = receipt?.split("\t")[0] ?? "";
  let ancestor: boolean | null = null, since: string | null = null, short: string | null = null;
  if (rsha) {
    ancestor = (await runCmd(["git", "merge-base", "--is-ancestor", rsha, "HEAD"], cwd ? { cwd } : undefined)).rc === 0;
    if (ancestor) since = await git(["rev-list", "--count", `${rsha}..HEAD`], cwd);
    short = await git(["rev-parse", "--short", rsha], cwd);
  }
  return { branch, head, receipt, origin_head, ancestor, since, short };
}

const TOOL_ID = /^[A-Za-z0-9_-]{0,200}$/;
const strOrNull = (v: unknown, max = 4096) => v === null || (typeof v === "string" && v.length <= max);

const CHECKS: Record<string, (f: Facts) => string | null> = {
  "finish-unit-ts": (f) => {
    for (const k of ["branch", "head", "receipt", "origin_head", "since", "short"]) if (!strOrNull(f[k])) return `${k} is not a short string or null`;
    if (!(f.ancestor === null || typeof f.ancestor === "boolean")) return "ancestor is not a boolean or null";
    return null;
  },
  "watch-ts": (f) => (f.instr === null || f.instr === "changed" || f.instr === "unchanged" ? null : "instr is not changed, unchanged or null"),
  "picker-hook-ts": (f) => {
    const str = (k: string, max = 4096) => (typeof f[k] === "string" && (f[k] as string).length <= max ? null : `${k} is not a short string`);
    // A tool_use_id names a file in main's picker-done folder: letters, digits, _ and - only.
    const id = (v: unknown, k: string) => (typeof v === "string" && TOOL_ID.test(v) ? null : `${k} is not a tool_use_id`);
    if (f.mode === "post") return id(f.tid, "tid") ?? str("answer", 8192);
    if (f.mode === "pre-async") {
      if (typeof f.ok !== "boolean") return "ok is not a boolean";
      const h = f.hook;   // anything but an object is ignored there (no tool_use_id)
      if (!f.ok || !h || typeof h !== "object" || Array.isArray(h)) return null;
      const t = (h as Facts).tool_use_id;
      return t === undefined || t === null ? null : id(t, "hook.tool_use_id");
    }
    if (f.mode === "permission-async") {
      for (const k of ["tool", "agent_id", "agent_type", "cwd", "tpath", "shown"]) { const bad = str(k); if (bad) return bad; }
      const bad = id(f.found, "found"); if (bad) return bad;
      return typeof f.answerable === "boolean" ? null : "answerable is not a boolean";
    }
    return "mode is not post, pre-async or permission-async";
  },
};

/** The split commands: the ones with a local half. */
export const SPLIT_COMMANDS = Object.keys(CHECKS);

/** The side host's half: the facts `cmd` needs from this worktree. */
export async function gather(cmd: string, argv: string[]): Promise<Facts> {
  if (cmd === "finish-unit-ts") return finishFacts();
  if (cmd === "watch-ts") {
    const { instructionsSeen } = await import("../commands/watch-ts.ts");
    return { instr: argv.includes("--poll") ? null : instructionsSeen() };
  }
  if (cmd === "picker-hook-ts") {
    const h = await import("../commands/picker-hook-ts.ts");
    const [mode, , , , file = ""] = argv;
    if (mode === "post") { let input = ""; try { input = await Bun.stdin.text(); } catch { /* none */ } return h.postFacts(input); }
    try {
      if (mode === "pre-async") return h.preFacts(file);
      if (mode === "permission-async") return await h.permissionFacts(file);
    } finally { if (file && mode !== "post") rmSync(file, { force: true }); }
  }
  return {};
}

/** Main's check of the facts a split call carries: null when they are fine, else why not. */
export function checkFacts(cmd: string, facts: unknown): string | null {
  const c = CHECKS[cmd];
  if (!c) return `'${cmd}' is not a split command`;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return "a split call carries its facts as an object";
  if (JSON.stringify(facts).length > FACTS_MAX) return "the facts are too big";
  return c(facts as Facts);
}

/** On main, inside a forwarded split call: the facts the side host gathered; null anywhere else. */
export function factsOf<T = Facts>(): T | null {
  if (process.env.DS_LINK_FORWARDED !== "1" || !process.env.DS_LINK_FACTS) return null;
  try { return JSON.parse(process.env.DS_LINK_FACTS) as T; } catch { return null; }
}

/** On main, inside a forwarded call: the member row's worktree id (`<host>::<path>`); null anywhere else. */
export function linkWt(): string | null {
  return process.env.DS_LINK_FORWARDED === "1" && process.env.DS_LINK_WT ? process.env.DS_LINK_WT : null;
}
