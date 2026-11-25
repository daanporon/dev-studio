// lib.ts — the helpers the hook ports (U190) call, kept here so the role-script ports after them (U260:
// ask-operator, watch) reuse them. Each keeps the inputs, output and calls of the shell function it is named
// after; the shell lib that held them is gone (U193).
// Only bun/node built-ins; no package.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { ROOT, stateRoot, backend, chomp, run, settingsAt, writeErr, writeOut } from "./shared.ts";
import { readRoster } from "../loop/settings/settings.ts";
import { filerIdentity, whoAmI } from "../loop/core/whoami.ts";
import { ownText } from "./settings-rows.ts";

// the old shell lib ds_limit_env (the historical names); bin/loop/settings/limits.ts ENV_NAMES is the same list.
const LIMIT_ENV: Record<string, string> = { context_warn: "DS_RESUME_MAX_CTX", limit_pct: "DS_SWEEP_LIMIT_PCT",
  pick_session_max: "DS_PICK_SESSION_MAX", pick_weekly_max: "DS_PICK_WEEKLY_MAX", unit_token_x: "DS_UNIT_TOKEN_X",
  unit_token_max: "DS_UNIT_TOKEN_MAX", auto_merge: "DS_LOOP_AUTO_MERGE" };

/** The first word after `key` on the first line whose first word is `key` (awk `$1==k{print $2; exit}`); null when no line is. */
export function confWord(file: string, key: string): string | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  return textWord(text, key);
}

/** confWord over a conf text. */
export function textWord(text: string, key: string): string | null {
  for (const line of text.split("\n")) {
    const f = line.split(/[ \t]+/).filter((w) => w !== "");
    if (f[0] === key) return f[1] ?? "";
  }
  return null;
}

/** ds_limit <label> <key>: the env var, else the project's override (its limits.conf rows, settings-rows.ts), else
 *  conventions/limits.conf; "" when unset. */
export function dsLimit(label: string, key: string): string {
  const env = process.env[LIMIT_ENV[key] ?? `DS_LIMIT_${key.toUpperCase()}`];
  if (env) return env;
  return textWord(ownText(label, "limits.conf"), key) || confWord(join(ROOT, "conventions", "limits.conf"), key) || "";
}

/** ds_compact_window <label> <role>: the role's auto-compact window from the limits files (auto_compact_<role> for
 *  lead, thinker, builder and studio, else auto_compact_other); "-" when unset or not a number. The loop reads
 *  the same from its config rows (bin/loop/settings/limits.ts compactWindow). */
export function compactWindowOf(label: string, role: string): string {
  const key = ["lead", "thinker", "builder", "studio"].includes(role) ? `auto_compact_${role}` : "auto_compact_other";
  const v = dsLimit(label, key);
  return /^[0-9]+$/.test(v) ? v : "-";
}

/** ds_role_row <label> <role>: the role's row of the project's effective roster (U267, settings.ts readRoster:
 *  the project's `config` rows over the shipped roles.conf), as `<role> <agent> <model> …`; "" when neither has
 *  one. A Builder's tier and phase rows are the picker's ladder (bin/loop/capacity/pick.ts). */
export function roleRow(label: string, role: string): string {
  const v = readRoster(label, settingsAt()).get(role);
  return v === undefined ? "" : `${role} ${v}`.trim();
}

/** The worktree's local path from a `$BACKEND ps` reply (`.result.worktrees[]? | select(.worktreeId==$w) | .path // empty`, first); "" when none. */
export function psPath(ps: string, wt: string): string {
  let j: any;
  try { j = JSON.parse(ps); } catch { return ""; }
  const ws = j?.result?.worktrees;
  const list: any[] = Array.isArray(ws) ? ws : ws && typeof ws === "object" ? Object.values(ws) : [];
  for (const w of list) {
    if (w === null) continue;
    if (typeof w !== "object") return ""; // jq stops on `.worktreeId` of a non-object
    if (w.worktreeId === wt && w.path !== null && w.path !== undefined && w.path !== false) {
      return typeof w.path === "string" ? w.path : JSON.stringify(w.path);
    }
  }
  return "";
}

/** `$BACKEND ps` then psPath; a `local::<path>` id (a member or Studio off Orca, U50) is its own path. */
export async function worktreePath(wt: string): Promise<string> {
  if (wt.startsWith("local::")) return wt.slice("local::".length);
  return psPath((await backend(["ps"])).out, wt);
}

/** `[ -d p ]`. */
export function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** `mktemp <prefix>XXXXXX`: a new empty file (mode 0600), its path; null when it cannot be made. */
export function mktemp(prefix: string): string | null {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 100; i++) {
    const p = prefix + Array.from({ length: 6 }, () => abc[Math.floor(Math.random() * abc.length)]).join("");
    try { closeSync(openSync(p, "wx", 0o600)); return p; } catch (e: any) { if (e?.code !== "EEXIST") return null; }
  }
  return null;
}

/** The arm scripts' settings merge: `<path>/.claude/settings.local.json` (a non-empty file that parses
 *  to a truthy value, else `{}`) through `edit`, written to a mktemp next to it (jq's 2-space pretty
 *  print) and moved over it. The exit code the shell would stop on, 0 when written: 1 for the
 *  mkdir/mktemp/mv, 5 when `edit` throws (jq's error; the temp file stays, as the shell leaves it). */
export function mergeSettings(path: string, edit: (s: any) => any): number {
  const dir = join(path, ".claude"), settings = join(dir, "settings.local.json");
  try { mkdirSync(dir, { recursive: true }); } catch { return 1; }
  let base: any = {};
  try {
    if (statSync(settings).size > 0) { const v = JSON.parse(readFileSync(settings, "utf8")); if (v !== null && v !== false) base = v; }
  } catch { /* missing or not JSON: {} */ }
  const tmp = mktemp(join(dir, ".settings."));
  if (!tmp) return 1;
  let out: any;
  try { out = edit(base); } catch { return 5; }
  try { writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n"); renameSync(tmp, settings); } catch { return 1; }
  return 0;
}

/** jq `.k = v` on a value: null becomes an object, anything but an object is jq's error. */
export function setKey(o: any, k: string, v: any): any {
  if (o === null || o === undefined) o = {};
  if (typeof o !== "object" || Array.isArray(o)) throw new Error(`cannot set ${k}`);
  o[k] = v;
  return o;
}

// --- the loop front door (the old shell lib "The loop as the one coordinator") ---------------------

/** ds_loop_root: the state root the loop owns. */
export const loopRoot = (): string => stateRoot();
/** ds_loop_migrated: the loop owns the state root (U13a's mark). */
export const loopMigrated = (): boolean => existsSync(join(loopRoot(), ".loop-migrated"));
/** ds_loop_on: this run writes a request (a migrated root, not the loop's child). */
export const loopOn = (): boolean => !process.env.DS_LOOP_CHILD && loopMigrated();

export type LoopArgs = { wait: string; argv: string[] };
/** ds_loop_args: `--wait <s>` (before any `--`) out, every other argument kept in order. Null (after
 *  the shell's message) when --wait has no value: the caller exits 2. */
export function loopArgs(args: string[], script: string): LoopArgs | null {
  let wait = "";
  const argv: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wait") {
      if (i + 1 >= args.length) { writeErr(`${script}: --wait needs seconds\n`); return null; }
      wait = args[++i];
    } else if (args[i] === "--") { argv.push(...args.slice(i)); break; }
    else argv.push(args[i]);
  }
  return { wait, argv };
}

/** ds_loop_key: a short hash of the arguments and the 5-minute window (DS_NOW pins it). */
export function loopKey(args: string[]): string {
  const now = process.env.DS_NOW ? Number(process.env.DS_NOW) : Math.floor(Date.now() / 1000);
  const h = createHash("sha1");
  for (const a of args) h.update(a + "\0");
  h.update(String(Math.floor(now / 300)));
  return h.digest("hex").slice(0, 12);
}

/** ds_loop_front: when loopOn, write this script's request through `bin/ds nudge` and return what it
 *  exits; null otherwise. `self` is the script's place under bin/ (`hooks/reassert-roles.sh`): the
 *  loop replays the script, never its port. */
export async function loopFront(label: string, kind: string, subject: string, id: string, key: string,
  a: LoopArgs, self: string): Promise<number | null> {
  if (!loopOn()) return null;
  const from = whoAmI().handle ?? "";
  const replay = JSON.stringify({ kind, key, argv: [join(ROOT, "bin", self), ...a.argv], cwd: process.env.PWD ?? process.cwd(),
    ...(from === "" ? {} : { from }), ...filerIdentity() });
  const about = [...(label ? ["--project", label] : []), ...(subject ? ["--squad", subject] : []), ...(id ? ["--member", id] : [])];
  const p = Bun.spawn([join(ROOT, "bin", "ds"), "--state", stateRoot(), "nudge", kind, "--json", replay, "--key", key,
    "--by", process.env.DS_WHO || kind, ...about, ...(a.wait ? ["--wait", a.wait] : [])], { stdio: ["inherit", "inherit", "inherit"] });
  return await p.exited;
}

/** ds_recipient_paused: in a loop child, that member is paused or resuming. */
export async function recipientPaused(label: string, wt: string): Promise<boolean> {
  if (!process.env.DS_LOOP_ACTIVITY || !wt) return false;
  return (await run([process.execPath, join(ROOT, "bin", "loop", "pause", "is-paused.ts"), label, wt])).rc === 0;
}

// --- role briefs ---------------------------------------------------------------------------------

/** ds_role_file: the role's instruction file, relative to the checkout. */
export const roleFile = (role: string): string => (role === "studio" ? "studio/studio.md" : `roles/${role}.md`);

/** ds_role_brief: the worktree-local CLAUDE.local.md that pins a dev-studio role. */
export function roleBrief(role: string, label = "", topic = "", run = ""): string {
  let s = `# dev-studio role — you are the ${role}\n\n`;
  s += `You are the **${role}** of the dev-studio orchestration system`;
  if (topic) s += ` for the "${topic}" squad`;
  if (label) s += ` (project ${label})`;
  s += ".\n\n";
  s += "This worktree sits inside a project repo, but your job is NOT to code this repo directly — it is to play your dev-studio role. The files below govern how you OPERATE and take priority over this repo for your role:\n\n";
  s += `1. Read \`${ROOT}/AGENTS.md\`\n`;
  s += `2. Read \`${ROOT}/${roleFile(role)}\`\n`;
  if (role === "lead" && run && loopMigrated()) {
    s += `\nYour Run is \`${run}\`. The loop coordinates it from its own pane and starts the workers you ask for: do not adopt it (a restarted Lead is refused with worker_cannot_coordinate_own_run, which is expected).\n`;
  } else if (role === "lead" && run) {
    s += `\nYour Run is \`${run}\`. Adopt it first, so you are its coordinator: \`${ROOT}/bin/backend/orca.sh adopt ${run}\`\n`;
  }
  s += "\nIf you are ever unsure who you are, re-read the two files above. They are your source of truth, not this repo.\n";
  return s;
}

/** ds_write_role_file: write the worktree's CLAUDE.local.md role brief (path from `$BACKEND ps`) and keep
 *  it out of the repo's git status. Prints a line; a remote/no-path worktree is skipped (stderr). */
export async function writeRoleFile(wt: string, role: string, label = "", topic = "", runId = ""): Promise<void> {
  const path = await worktreePath(wt);
  if (!path || !isDir(path)) {
    writeErr(`role-file: no local path for ${role} (wt=${wt}) — remote host? skipped\n`);
    return;
  }
  try { writeFileSync(join(path, "CLAUDE.local.md"), roleBrief(role, label, topic, runId)); }
  catch (e: any) { writeErr(`${join(path, "CLAUDE.local.md")}: ${e?.code === "EACCES" ? "Permission denied" : String(e?.message ?? e)}\n`); }
  let excl = chomp((await run(["git", "-C", path, "rev-parse", "--git-path", "info/exclude"])).out);
  if (excl) {
    if (!excl.startsWith("/")) excl = join(path, excl);
    try { mkdirSync(dirname(excl), { recursive: true }); } catch { /* the append below reports nothing either */ }
    let has = false;
    try { has = readFileSync(excl, "utf8").split("\n").includes("CLAUDE.local.md"); } catch { /* missing: append */ }
    if (!has) { try { appendFileSync(excl, "CLAUDE.local.md\n"); } catch { /* as the shell: best effort */ } }
  }
  writeOut(`role-file: ${role} -> ${path}/CLAUDE.local.md\n`);
}

// --- GitHub ---------------------------------------------------------------------------------------

/** repo_slug: "owner/repo" from any GitHub remote of the repo (an Orca selector's path); "" when none. */
export async function repoSlug(repo: string): Promise<string> {
  if (!repo) return "";
  let r = repo.startsWith("path:") ? repo.slice(5) : repo;
  if (r.includes("::")) r = r.slice(r.lastIndexOf("::") + 2);
  const m = (await run(["git", "-C", r, "remote", "-v"])).out.match(/github\.com[:/][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
  if (!m) return "";
  return m[0].replace(/^github\.com[:/]/, "").replace(/\.git$/, "");
}

const PR_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state isDraft mergeable mergeStateStatus reviewDecision reviewThreads(first:100){nodes{isResolved}}baseRef{rules(first:50){nodes{type parameters{... on RequiredStatusChecksParameters{requiredStatusChecks{context}}}}}refUpdateRule{requiredStatusCheckContexts}}commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name databaseId status conclusion isRequired(pullRequestNumber:$number)} ... on StatusContext{context state isRequired(pullRequestNumber:$number)}}}}}}}}}}";

/** pr_health <slug> <pr> [label]: one `$GH api graphql` call judged by bin/loop/observers/github.ts
 *  prHealth (the shell's jq twin). `line` is "<verdict>\t<reasons>"; `ok` false means "unknown\t" (the
 *  shell's return 1). */
export async function prHealthLine(slug: string, pr: string, label = ""): Promise<{ line: string; ok: boolean }> {
  const unknown = { line: "unknown\t", ok: false };
  const expected = label ? dsLimit(label, "expected_checks") : "";
  const gh = (process.env.GH || process.env.DS_GH || "gh").split(/\s+/).filter((w) => w !== "");
  const i = slug.indexOf("/");
  const owner = i < 0 ? slug : slug.slice(0, i), name = i < 0 ? slug : slug.slice(i + 1);
  const r = await run([...gh, "api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`, "-f", `query=${PR_QUERY}`]);
  if (r.rc !== 0) return unknown;
  let node: any;
  try { node = JSON.parse(r.out)?.data?.repository?.pullRequest; } catch { return unknown; }
  if (node === null || node === undefined || node === false) return unknown;
  const { prHealth } = await import("../loop/observers/github.ts");
  const h = prHealth(node, expected.split(",").filter((c) => c !== "" && c !== "-"));
  if (!h) return unknown;
  return { line: `${h.verdict}\t${h.reasons.join(",")}`, ok: true };
}
