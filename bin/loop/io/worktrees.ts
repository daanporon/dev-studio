// worktrees.ts — the loop makes and removes worktrees itself (orca-backend-alternatives U7), through one
// provider interface: `create`, `remove`, `list`, `prune`. A provider is one file, bin/loop/io/providers/
// <name>.ts, found by name (`provider()`), so a later provider (treehouse U8, orca U8b) adds only its own
// file. `git` (plain `git worktree add/remove`) is the first. Each call writes or updates the worktree's
// `worktrees` row (U5, keyed by host + path) with the provider's name; only the provider reads its own id
// (`orca_id`, `lease`). Only squads on a new backend will call it (wired up in U11); `ds worktree` wraps
// it for tests and operators.
//
// Crash safety: `create` writes the row (gone_at NULL) before the provider runs and fills it in after, so
// a crash between the two leaves a row that names the folder: the next create of the same path adopts
// what the provider already made, and the next `list` or `prune` of its repo marks it gone when the
// provider has no such worktree. A `remove` whose folder is already gone marks the row gone. No row is
// ever deleted. The host is always `local` for now (other hosts come later, through a sideloop).
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { now as nowS, type Row, type Store } from "../core/store.ts";
import { childEnv, type Out } from "./orca.ts";

export type Spec = {
  repo: string;            // the main checkout's absolute path
  name: string;            // the worktree's name (one path segment)
  branch: string;          // the branch it holds (made from `base` when new)
  base: string;            // the ref a new branch starts from
  parent?: string | null;  // the parent worktree's path
  project?: string | null;
  squad?: string | null;
  role?: string | null;
  path?: string | null;    // where it goes; else the provider's pathFor()
  host?: string;
};
/** What the provider made, or found already made at the path (`adopted`). */
export type Made = { path: string; branch: string; adopted: boolean; lease?: string | null; orca_id?: string | null };
export type RemoveOpts = { force?: boolean; deleteBranch?: boolean; base?: string };
/** removed: the folder went (or was already gone); branch: what became of its branch. */
export type Gone = { removed: boolean; already: boolean; branch: "kept" | "deleted" | "none"; why?: string };
export type Listed = { path: string; branch: string | null; head: string | null; prunable: boolean };

export interface Provider {
  name: string;
  pathFor(spec: Spec): string;
  create(spec: Spec, path: string): Promise<Made>;
  remove(row: Row, opts: RemoveOpts): Promise<Gone>;
  list(repo: string): Promise<Listed[]>;
  prune(repo: string): Promise<Out>;
}

/** A refusal the caller can show as is (a bad name, a path that holds another branch, git's error). */
export class WorktreeError extends Error {}

const HOST = "local";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A path as git lists it: the real path of its nearest existing folder, the rest joined on. A worktree
 *  root reached through a symlink would otherwise key the row by a path git never prints. */
export function canon(path: string): string {
  const abs = resolve(path);
  let head = abs;
  const rest: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) { rest.unshift(basename(head)); head = dirname(head); }
  try { return join(realpathSync(head), ...rest); } catch { return abs; }
}

/** The provider called `name` (bin/loop/io/providers/<name>.ts). */
export async function provider(name: string): Promise<Provider> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new WorktreeError(`worktrees: '${name}' is not a provider name`);
  const file = resolve(import.meta.dir, "providers", `${name}.ts`);
  if (!existsSync(file)) throw new WorktreeError(`worktrees: no provider '${name}' (no ${file})`);
  const mod = await import(file) as { default?: Provider };
  if (!mod.default || mod.default.name !== name) throw new WorktreeError(`worktrees: ${file} exports no provider '${name}'`);
  return mod.default;
}

// git without the caller's repo variables (a hook or a test can set them): every call names its repo.
const GIT_REPO_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"];
export async function git(args: string[], timeoutMs = 120_000): Promise<Out> {
  const env = childEnv();
  for (const k of GIT_REPO_VARS) delete env[k];
  env.GIT_TERMINAL_PROMPT = "0";
  try {
    const p = Bun.spawn(["git", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  } catch (e) { return { code: -1, out: "", err: (e as Error)?.message ?? String(e) }; }
}
/** The last non-empty line of a failed call, for a refusal. */
export const lastLine = (o: Out): string => (o.err + "\n" + o.out).split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? `exit ${o.code}`;

const rowAt = (s: Store, path: string, host = HOST): Row | null => s.get("worktrees", { host, path });
const ctx = (r: { project?: unknown; squad?: unknown }) => ({ project: r.project == null ? undefined : String(r.project), squad: r.squad == null ? undefined : String(r.squad) });

function check(spec: Spec): void {
  if ((spec.host ?? HOST) !== HOST) throw new WorktreeError(`worktrees: only host '${HOST}' is supported, not '${spec.host}'`);
  if (!isAbsolute(spec.repo)) throw new WorktreeError(`worktrees: the repo is an absolute path, not '${spec.repo}'`);
  if (!NAME.test(spec.name)) throw new WorktreeError(`worktrees: '${spec.name}' is not a worktree name (letters, digits, . _ -)`);
  if (!spec.branch || spec.branch.startsWith("-")) throw new WorktreeError("worktrees: a branch is required");
  if (!spec.base || spec.base.startsWith("-")) throw new WorktreeError("worktrees: a base ref is required");
  if (spec.path && !isAbsolute(spec.path)) throw new WorktreeError(`worktrees: the path is absolute, not '${spec.path}'`);
  if (spec.parent && !isAbsolute(spec.parent)) throw new WorktreeError(`worktrees: the parent is a path, not '${spec.parent}'`);
}

/** Make a worktree through `providerName` and record it; the same spec again returns the row (adopted). */
export async function createWorktree(s: Store, providerName: string, spec: Spec, at = nowS()): Promise<{ row: Row; adopted: boolean }> {
  check(spec);
  const p = await provider(providerName);
  const repo = canon(spec.repo);
  spec = { ...spec, repo };
  const path = canon(spec.path || p.pathFor(spec));
  const had = rowAt(s, path);
  if (had && had.gone_at == null) {
    if (had.provider !== p.name) throw new WorktreeError(`worktrees: ${path} is recorded for provider '${had.provider}', not '${p.name}'`);
    if (had.branch && had.branch !== spec.branch) throw new WorktreeError(`worktrees: ${path} is recorded on branch '${had.branch}', not '${spec.branch}'`);
  }
  // The intent: the row names the folder before the provider makes it (see the header).
  // A field the spec leaves out keeps what a live row already records.
  const keep = (v: string | null | undefined, k: string) => v ?? (had && had.gone_at == null ? (had[k] as string | null) ?? null : null);
  const fields = { project: keep(spec.project, "project"), name: spec.name, parent_path: keep(spec.parent, "parent_path"), branch: spec.branch,
    squad: keep(spec.squad, "squad"), role: keep(spec.role, "role"), provider: p.name, repo, gone_at: null };
  s.upsert("worktrees", { host: HOST, path }, { ...fields, created_at: had && had.gone_at == null ? had.created_at : at });
  let made: Made;
  try { made = await p.create(spec, path); } catch (e) {
    // Nothing was made: the row goes back to gone (a fresh one was never a worktree), with the why.
    if (!had || had.gone_at != null) {
      s.fact("worktree_gone", [{ table: "worktrees", key: { host: HOST, path }, set: { gone_at: at } }],
        { ...ctx(fields), payload: { path, provider: p.name, why: `create failed: ${(e as Error).message.slice(0, 200)}` } });
    }
    throw e;
  }
  const set = { ...fields, branch: made.branch, lease: made.lease ?? null, orca_id: made.orca_id ?? null };
  const changed = !had || had.gone_at != null || !made.adopted || Object.entries(set).some(([k, v]) => (had[k] ?? null) !== v);
  if (changed) {
    s.fact("worktree_created", [{ table: "worktrees", key: { host: HOST, path }, set }],
      { ...ctx(fields), payload: { path, provider: p.name, branch: made.branch, adopted: made.adopted, ...(fields.parent_path ? { parent: fields.parent_path } : {}) } });
  }
  return { row: rowAt(s, path) as Row, adopted: made.adopted };
}

/** Remove the worktree at `path` through the provider that made it; its branch is kept unless
 *  opts.deleteBranch and the provider finds it merged into opts.base. A refusal leaves the row live. */
export async function removeWorktree(s: Store, path: string, opts: RemoveOpts = {}, at = nowS()): Promise<{ row: Row; gone: Gone }> {
  const abs = canon(path);
  const r = rowAt(s, abs);
  if (!r) throw new WorktreeError(`worktrees: no worktree recorded at ${abs}`);
  if (r.gone_at != null) return { row: r, gone: { removed: true, already: true, branch: "none", why: "already recorded gone" } };
  const p = await provider(String(r.provider));
  const gone = await p.remove(r, opts);
  if (!gone.removed) throw new WorktreeError(`worktrees: ${abs} not removed: ${gone.why ?? "refused"}`);
  s.fact("worktree_removed", [{ table: "worktrees", key: { host: HOST, path: abs }, set: { gone_at: at } }],
    { ...ctx(r), payload: { path: abs, provider: p.name, branch: gone.branch, already: gone.already, ...(gone.why ? { why: gone.why } : {}) } });
  return { row: rowAt(s, abs) as Row, gone };
}

export type ListOpts = { project?: string; provider?: string; repo?: string; all?: boolean };

// Check the live rows of each (provider, repo) against the provider's own list: a row whose worktree the
// provider no longer has is marked gone (a crash after `git worktree remove`, a folder removed by hand, a
// create that died before git ran), and a branch the provider reports differently is updated. Returns the
// paths it marked gone.
async function reconcile(s: Store, o: ListOpts, at: number): Promise<string[]> {
  const where = ["host = ?", "gone_at IS NULL", "repo IS NOT NULL"], args: string[] = [HOST];
  if (o.provider) { where.push("provider = ?"); args.push(o.provider); }
  if (o.repo) { where.push("repo = ?"); args.push(canon(o.repo)); }
  if (o.project) { where.push("project = ?"); args.push(o.project); }
  const rows = s.db.query(`SELECT * FROM worktrees WHERE ${where.join(" AND ")}`).all(...args) as Row[];
  const groups = new Map<string, Row[]>();
  for (const r of rows) { const k = `${r.provider}\0${r.repo}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const marked: string[] = [];
  for (const [k, rs] of groups) {
    const [name, repo] = k.split("\0");
    const p = await provider(name);
    if (!existsSync(repo)) continue;   // the repo itself is gone or not mounted: change nothing
    let listed: Listed[];
    try { listed = await p.list(repo); } catch { continue; }
    const by = new Map(listed.map((l) => [l.path, l]));
    for (const r of rs) {
      const l = by.get(String(r.path));
      if (l && !l.prunable && existsSync(String(r.path))) {
        if (l.branch && l.branch !== r.branch) s.upsert("worktrees", { host: HOST, path: r.path }, { branch: l.branch });
        continue;
      }
      s.fact("worktree_gone", [{ table: "worktrees", key: { host: HOST, path: r.path }, set: { gone_at: at } }],
        { ...ctx(r), payload: { path: String(r.path), provider: name, why: l ? "folder gone" : `not a ${name} worktree of ${repo}` } });
      marked.push(String(r.path));
    }
  }
  return marked;
}

/** The recorded worktrees (live ones unless opts.all), after checking every live row the providers own. */
export async function listWorktrees(s: Store, o: ListOpts = {}, at = nowS()): Promise<{ rows: Row[]; marked: string[] }> {
  const marked = await reconcile(s, o, at);
  const where = ["host = ?"], args: string[] = [HOST];
  if (!o.all) where.push("gone_at IS NULL");
  if (o.provider) { where.push("provider = ?"); args.push(o.provider); }
  if (o.repo) { where.push("repo = ?"); args.push(canon(o.repo)); }
  if (o.project) { where.push("project = ?"); args.push(o.project); }
  const rows = s.db.query(`SELECT * FROM worktrees WHERE ${where.join(" AND ")} ORDER BY project, path`).all(...args) as Row[];
  return { rows, marked };
}

/** Let each provider forget worktrees whose folders are gone (`git worktree prune`), then check the rows. */
export async function pruneWorktrees(s: Store, o: ListOpts = {}, at = nowS()): Promise<{ marked: string[]; pruned: string[] }> {
  const where = ["host = ?", "repo IS NOT NULL"], args: string[] = [HOST];
  if (o.provider) { where.push("provider = ?"); args.push(o.provider); }
  if (o.repo) { where.push("repo = ?"); args.push(canon(o.repo)); }
  if (o.project) { where.push("project = ?"); args.push(o.project); }
  const pairs = s.db.query(`SELECT DISTINCT provider, repo FROM worktrees WHERE ${where.join(" AND ")}`).all(...args) as Row[];
  if (o.repo && o.provider && !pairs.length) pairs.push({ provider: o.provider, repo: canon(o.repo) });
  const pruned: string[] = [];
  for (const pr of pairs) {
    if (!existsSync(String(pr.repo))) continue;
    const out = await (await provider(String(pr.provider))).prune(String(pr.repo));
    if (out.code === 0) pruned.push(String(pr.repo));
  }
  return { marked: await reconcile(s, o, at), pruned };
}

/** One line per row for `ds worktree list`. */
export function worktreeLine(r: Row): string {
  const who = r.squad ? `${r.squad}/${r.role ?? "-"}` : "-";
  return `${r.gone_at == null ? "live" : "gone"}  ${r.provider}  ${r.project ?? "-"}  ${who}  ${r.branch ?? "-"}  ${r.path}${r.parent_path ? `  (parent ${r.parent_path})` : ""}`;
}
