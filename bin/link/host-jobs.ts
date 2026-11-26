// host-jobs.ts — side-loop-host U5 (issue #127): the git and folder jobs main asks a named host to run. Each job is
// one checked request and one checked answer on the `host-jobs` channel (channels/host-jobs.ts, answered on the side):
//   clone            {project, url, dest?}          → {path, cloned}     clone a project (an existing clone of the same
//                                                                          origin is adopted; dest defaults to
//                                                                          <DS_SIDE_CLONE_ROOT, else ~/dev-studio-repos>/<project>)
//   worktree.add     {provider, spec}               → Made + {repo}      the provider's `create` (io/worktrees.ts)
//   worktree.remove  {provider, path, repo, branch, opts} → Gone         the provider's `remove`
//   probe            {path, timeout_ms, secured?}   → Out                the remove-safety probe (io/wt-probe.ts)
//   rescue           {path, project, squad, label}  → {listed, capped, files, kept_dest, kept}
//                                                                         the rescue plan (io/rescue.ts); files up to the
//                                                                          upload cap travel as base64, the rest are copied
//                                                                          into the side host's own rescue folder
//   ref.read         {path, ref}                    → Out + {missing}    `git rev-parse <ref>`
//   ref.set          {path, ref, sha, no_deref?}    → Out                `git update-ref [--no-deref] <ref> <sha>`
//   push             {path, branch, remote?}        → Out                `git push <remote> refs/heads/<b>:refs/heads/<b>`, never forced
// The `*On(host, …)` functions are what main calls. For host `local` each runs the same code as before this unit
// (createWorktree, removeWorktree, wtProbe, rescuePages, the same git calls); for any other host it sends the job down
// that host's link (server.ts linkRequest, or `o.send` in tests) and checks the answer's shape before using it. Both
// ends check a job's arguments (`checkJob`): absolute paths, names, refs, shas and remotes of a fixed form, nothing
// that git could read as an option. A side worktree is recorded on main as `worktrees (host, path)` with the side's
// path; the side records nothing (its rows come down from main, replica.ts). Before main writes a rescued file each
// path must be relative with no `..` or `.` segment and no NUL, resolve under that member's
// `<state root>/<project>/pages/<squad>/rescued/<label>/`, reach it through real folders only and land on a regular
// file or nothing: one bad path refuses the whole answer and nothing is written.
import { existsSync, lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { now as nowS, open, stateRoot, type Row, type Store } from "../loop/core/store.ts";
import { spawn, type Out } from "../loop/io/orca.ts";
import { wtProbe } from "../loop/io/wt-probe.ts";
import { canon, createWorktree, git, lastLine, provider, removeWorktree, WorktreeError, type Gone, type Made, type RemoveOpts, type Spec } from "../loop/io/worktrees.ts";
import { placeBody, planRescue, rescueDest, rescuePages, securable, sessionFiles, type Rescued } from "../loop/io/rescue.ts";
import { LOCAL_HOST } from "./host-keys.ts";
import { linkRequest } from "./server.ts";

export const CHANNEL = "host-jobs";

export type HostJob =
  | { job: "clone"; project: string; url: string; dest?: string }
  | { job: "worktree.add"; provider: string; spec: Spec }
  | { job: "worktree.remove"; provider: string; path: string; repo: string; branch: string | null; opts: RemoveOpts }
  | { job: "probe"; path: string; timeout_ms: number; secured?: string[] }
  | { job: "rescue"; path: string; project: string; squad: string; label: string }
  | { job: "ref.read"; path: string; ref: string }
  | { job: "ref.set"; path: string; ref: string; sha: string; no_deref?: boolean }
  | { job: "push"; path: string; branch: string; remote?: string };
export type JobName = HostJob["job"];

export type Cloned = { path: string; cloned: boolean };
export type Uploaded = { rel: string; size: number; data: string };
export type Collected = { listed: boolean; capped: number; files: Uploaded[]; kept_dest: string | null; kept: string[] };
export type RefRead = Out & { missing: boolean };

/** How main sends one job to a host; the default goes through the link server's unix socket. */
export type Send = (host: string, body: HostJob, timeoutMs: number) => Promise<unknown>;
export type JobOpts = { root?: string; send?: Send };

/** A job or an answer that failed its check, or a job the host refused. */
export class HostJobError extends Error {}

// ---------------------------------------------------------------- the checks (both ends)

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROVIDER = /^[a-z][a-z0-9-]*$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bad = (what: string): never => { throw new HostJobError(`host-jobs: ${what}`); };

function absPath(v: unknown, what: string): string {
  if (typeof v !== "string" || !isAbsolute(v) || /[\0\n\r]/.test(v)) bad(`${what} is an absolute path, not ${JSON.stringify(v)}`);
  return v as string;
}
function name(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > 200 || !NAME.test(v)) bad(`${what} is a name (letters, digits, . _ -), not ${JSON.stringify(v)}`);
  return v as string;
}
function branchName(v: unknown, what: string): string {
  if (typeof v !== "string" || !v || v.length > 250 || v.startsWith("-") || v.startsWith("/") || v.endsWith("/") || v.endsWith(".lock") || v.includes("..") || v.includes("//") || !BRANCH.test(v)) {
    bad(`${what} is a branch name, not ${JSON.stringify(v)}`);
  }
  return v as string;
}
function refName(v: unknown): string {
  if (v === "HEAD") return v;
  if (typeof v !== "string" || !v.startsWith("refs/")) bad(`a ref is HEAD or refs/…, not ${JSON.stringify(v)}`);
  branchName((v as string).slice(5), "a ref");
  return v as string;
}
function optStr(v: unknown, what: string): string | null | undefined {
  if (v === undefined || v === null) return v as null | undefined;
  if (typeof v !== "string" || /[\0\n\r]/.test(v)) bad(`${what} is text, not ${JSON.stringify(v)}`);
  return v as string;
}

/** Why `rel` is not a safe path inside a rescue folder, or null. */
export function relProblem(rel: unknown): string | null {
  if (typeof rel !== "string" || !rel || rel.length > 4096) return "not a path";
  if (rel.includes("\0")) return "it holds a NUL";
  if (isAbsolute(rel)) return "it is absolute";
  const parts = rel.split("/");
  if (parts.some((p) => p === ".." || p === ".")) return "it has a . or .. segment";
  if (parts.some((p) => p === "")) return "it has an empty segment";
  return null;
}

function checkSpec(v: unknown): Spec {
  if (!isObj(v)) return bad("a worktree spec is an object");
  const s = v as Record<string, unknown>;
  if (s.host !== undefined && s.host !== LOCAL_HOST) bad(`a spec sent to a host names no other host ('${String(s.host)}')`);
  const base = s.base;
  if (typeof base !== "string" || !base || base.startsWith("-") || /[\0\n\r\s]/.test(base)) bad(`a base ref is required, not ${JSON.stringify(base)}`);
  return {
    repo: absPath(s.repo, "the repo"), name: name(s.name, "the worktree name"), branch: branchName(s.branch, "the branch"), base: base as string,
    parent: s.parent == null ? null : absPath(s.parent, "the parent"), path: s.path == null ? null : absPath(s.path, "the path"),
    project: optStr(s.project, "the project") ?? null, squad: optStr(s.squad, "the squad") ?? null, role: optStr(s.role, "the role") ?? null,
  };
}
function checkOpts(v: unknown): RemoveOpts {
  if (v == null) return {};
  if (!isObj(v)) return bad("remove options are an object");
  const o: RemoveOpts = {};
  if (v.force !== undefined) { if (typeof v.force !== "boolean") bad("force is true or false"); o.force = v.force as boolean; }
  if (v.deleteBranch !== undefined) { if (typeof v.deleteBranch !== "boolean") bad("deleteBranch is true or false"); o.deleteBranch = v.deleteBranch as boolean; }
  if (v.base !== undefined) {
    if (typeof v.base !== "string" || v.base.startsWith("-") || /[\0\n\r\s]/.test(v.base)) bad(`a base ref is not ${JSON.stringify(v.base)}`);
    o.base = v.base as string;
  }
  return o;
}

/** The job in `v`, rebuilt from its checked fields only; throws HostJobError on anything else. */
export function checkJob(v: unknown): HostJob {
  if (!isObj(v)) return bad("a job is an object");
  switch (v.job) {
    case "clone": {
      const url = v.url;
      if (typeof url !== "string" || !url || url.length > 2048 || url.startsWith("-") || /[\0\s]/.test(url)) bad(`a clone url is not ${JSON.stringify(url)}`);
      return { job: "clone", project: name(v.project, "the project"), url: url as string, ...(v.dest == null ? {} : { dest: absPath(v.dest, "the clone folder") }) };
    }
    case "worktree.add": {
      if (typeof v.provider !== "string" || !PROVIDER.test(v.provider)) bad(`'${String(v.provider)}' is not a provider name`);
      return { job: "worktree.add", provider: v.provider as string, spec: checkSpec(v.spec) };
    }
    case "worktree.remove": {
      if (typeof v.provider !== "string" || !PROVIDER.test(v.provider)) bad(`'${String(v.provider)}' is not a provider name`);
      return { job: "worktree.remove", provider: v.provider as string, path: absPath(v.path, "the worktree"), repo: absPath(v.repo, "the repo"),
        branch: v.branch == null || v.branch === "" ? null : branchName(v.branch, "the branch"), opts: checkOpts(v.opts) };
    }
    case "probe": {
      const t = v.timeout_ms;
      if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 600_000) bad(`a probe timeout is 1..600000 ms, not ${JSON.stringify(t)}`);
      let secured: string[] | undefined;
      if (v.secured !== undefined) {
        if (!Array.isArray(v.secured) || v.secured.some((s) => relProblem(s) !== null)) bad("secured is a list of relative paths");
        secured = (v.secured as string[]).slice();
      }
      return { job: "probe", path: absPath(v.path, "the worktree"), timeout_ms: t as number, ...(secured ? { secured } : {}) };
    }
    case "rescue":
      return { job: "rescue", path: absPath(v.path, "the worktree"), project: name(v.project, "the project"), squad: name(v.squad, "the squad"), label: name(v.label, "the label") };
    case "ref.read":
      return { job: "ref.read", path: absPath(v.path, "the worktree"), ref: refName(v.ref) };
    case "ref.set": {
      if (typeof v.sha !== "string" || !SHA.test(v.sha)) bad(`a sha is 40 or 64 hex digits, not ${JSON.stringify(v.sha)}`);
      if (v.no_deref !== undefined && typeof v.no_deref !== "boolean") bad("no_deref is true or false");
      return { job: "ref.set", path: absPath(v.path, "the worktree"), ref: refName(v.ref), sha: v.sha as string, ...(v.no_deref ? { no_deref: true } : {}) };
    }
    case "push":
      return { job: "push", path: absPath(v.path, "the worktree"), branch: branchName(v.branch, "the branch"), ...(v.remote == null ? {} : { remote: name(v.remote, "the remote") }) };
    default:
      return bad(`unknown job '${String(v.job)}'`);
  }
}

// The answer checks: each returns the answer rebuilt from its checked fields, or throws.
const wrong = (host: string, job: string, why: string): never => { throw new HostJobError(`host-jobs: ${job} answer from ${host} is malformed: ${why}`); };
function outOf(v: unknown, host: string, job: string): Out {
  if (!isObj(v) || typeof v.code !== "number" || typeof v.out !== "string" || typeof v.err !== "string") return wrong(host, job, "not {code, out, err}");
  return { code: v.code as number, out: v.out as string, err: v.err as string };
}
function clonedOf(v: unknown, host: string): Cloned {
  if (!isObj(v) || typeof v.path !== "string" || !isAbsolute(v.path) || typeof v.cloned !== "boolean") return wrong(host, "clone", "not {path, cloned}");
  return { path: v.path as string, cloned: v.cloned as boolean };
}
function madeOf(v: unknown, host: string): Made & { repo: string } {
  if (!isObj(v) || typeof v.path !== "string" || !isAbsolute(v.path) || typeof v.repo !== "string" || !isAbsolute(v.repo)
    || typeof v.branch !== "string" || typeof v.adopted !== "boolean") return wrong(host, "worktree.add", "not {path, repo, branch, adopted}");
  const s = (k: string) => (typeof v[k] === "string" ? v[k] as string : null);
  return { path: v.path as string, repo: v.repo as string, branch: v.branch as string, adopted: v.adopted as boolean, lease: s("lease"), orca_id: s("orca_id") };
}
function goneOf(v: unknown, host: string): Gone {
  if (!isObj(v) || typeof v.removed !== "boolean" || typeof v.already !== "boolean" || !["kept", "deleted", "none"].includes(String(v.branch))) {
    return wrong(host, "worktree.remove", "not {removed, already, branch}");
  }
  return { removed: v.removed as boolean, already: v.already as boolean, branch: v.branch as Gone["branch"], ...(typeof v.why === "string" ? { why: v.why } : {}) };
}
function collectedOf(v: unknown, host: string): Collected {
  if (!isObj(v) || typeof v.listed !== "boolean" || typeof v.capped !== "number" || !Array.isArray(v.files) || !Array.isArray(v.kept)
    || !(v.kept_dest === null || typeof v.kept_dest === "string")) return wrong(host, "rescue", "not {listed, capped, files, kept_dest, kept}");
  const files = (v.files as unknown[]).map((f) => {
    if (!isObj(f) || typeof f.rel !== "string" || typeof f.size !== "number" || typeof f.data !== "string") return wrong(host, "rescue", "a file is not {rel, size, data}");
    return { rel: f.rel as string, size: f.size as number, data: f.data as string };
  });
  if ((v.kept as unknown[]).some((k) => typeof k !== "string")) wrong(host, "rescue", "kept is a list of paths");
  return { listed: v.listed as boolean, capped: v.capped as number, files, kept_dest: v.kept_dest as string | null, kept: v.kept as string[] };
}

// ---------------------------------------------------------------- the jobs on this host (the side runs these)

/** Where a side host clones a project when main names no folder. */
export const cloneRoot = (): string => resolve(process.env.DS_SIDE_CLONE_ROOT || join(homedir(), "dev-studio-repos"));
/** How many bytes of rescued files one answer carries (2 MB, at most 2.5 MB: base64 must fit a 4 MB frame). */
export function uploadCap(): number {
  const v = Number(process.env.DS_LINK_RESCUE_UPLOAD_MB);
  return Math.floor((Number.isFinite(v) && v > 0 ? Math.min(v, 2.5) : 2) * 1024 * 1024);
}

async function cloneHere(j: Extract<HostJob, { job: "clone" }>): Promise<Cloned> {
  const dest = canon(j.dest ?? join(cloneRoot(), j.project));
  if (existsSync(dest)) {
    const o = await git(["-C", dest, "remote", "get-url", "origin"]);
    if (o.code === 0 && o.out.trim() === j.url) return { path: dest, cloned: false };
    throw new HostJobError(`host-jobs: ${dest} exists and is not a clone of ${j.url}`);
  }
  const o = await git(["clone", "--quiet", "--", j.url, dest], 900_000);
  if (o.code !== 0) throw new HostJobError(`host-jobs: git clone ${j.url} failed: ${lastLine(o)}`);
  return { path: canon(dest), cloned: true };
}

async function addHere(j: Extract<HostJob, { job: "worktree.add" }>): Promise<Made & { repo: string }> {
  const p = await provider(j.provider);
  const spec = { ...j.spec, repo: canon(j.spec.repo) };
  const fixed = p.pathFor(spec);
  const made = await p.create(spec, fixed == null ? null : canon(spec.path || fixed));
  return { ...made, path: canon(made.path), repo: spec.repo };
}

const stores = new Map<string, Store>();
function storeAt(root: string): Store | null {
  let s = stores.get(root);
  if (!s) { try { s = open(root); stores.set(root, s); } catch { return null; } }
  return s;
}

// The side's half of a rescue: the same plan as rescuePages; files up to the upload cap go up, the rest are copied
// into this host's own rescue folder, so nothing in the plan is lost.
async function collectHere(j: Extract<HostJob, { job: "rescue" }>, root: string, store?: Store): Promise<Collected> {
  const s = store ?? storeAt(root);
  let pages: string[] = [];
  try { pages = s ? sessionFiles(s, j.path) : []; } catch { pages = []; }
  const { plan, capped, listed } = await planRescue(j.path, pages);
  const out: Collected = { listed, capped, files: [], kept_dest: null, kept: [] };
  const keptDest = rescueDest(root, j.project, j.squad, j.label);
  let left = uploadCap();
  for (const { rel } of plan) {
    let body: Buffer;
    try { body = await readFile(join(j.path, rel)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;   // gone since the listing
      throw e;
    }
    if (body.length <= left) { out.files.push({ rel, size: body.length, data: body.toString("base64") }); left -= body.length; continue; }
    await placeBody(body, join(keptDest, rel));
    out.kept_dest = keptDest;
    out.kept.push(rel);
  }
  return out;
}

const refRead = async (path: string, ref: string): Promise<RefRead> =>
  ({ ...(await spawn(["git", "-C", path, "rev-parse", ref], {}, 30_000)), missing: !existsSync(path) });
const refSet = (path: string, ref: string, sha: string, noDeref: boolean): Promise<Out> =>
  spawn(["git", "-C", path, "update-ref", ...(noDeref ? ["--no-deref"] : []), ref, sha], {}, 30_000);
const pushHere = (path: string, branch: string, remote = "origin"): Promise<Out> =>
  git(["-C", path, "push", "--porcelain", remote, `refs/heads/${branch}:refs/heads/${branch}`], 300_000);

/** Run a checked job on this host: what the side's `host-jobs` channel answers. `root` is this host's state root. */
export async function runHere(job: unknown, ctx: { root: string; store?: Store }): Promise<unknown> {
  const j = checkJob(job);
  switch (j.job) {
    case "clone": return cloneHere(j);
    case "worktree.add": return addHere(j);
    case "worktree.remove": return (await provider(j.provider)).remove({ path: j.path, repo: j.repo, branch: j.branch } as Row, j.opts);
    case "probe": return wtProbe(j.path, j.timeout_ms, j.secured ? { secured: j.secured } : undefined);
    case "rescue": return collectHere(j, ctx.root, ctx.store);
    case "ref.read": return refRead(j.path, j.ref);
    case "ref.set": return refSet(j.path, j.ref, j.sha, !!j.no_deref);
    case "push": return pushHere(j.path, j.branch, j.remote);
  }
}

// ---------------------------------------------------------------- main's side

const TIMEOUT: Record<JobName, number> = {
  "clone": 910_000, "worktree.add": 630_000, "worktree.remove": 180_000, "probe": 0, "rescue": 180_000,
  "ref.read": 45_000, "ref.set": 45_000, "push": 330_000,
};
const timeoutOf = (j: HostJob) => (j.job === "probe" ? j.timeout_ms + 15_000 : TIMEOUT[j.job]);

/** Send one job to a side host and return its raw answer (checked by the caller). */
async function sendJob(host: string, job: HostJob, o: JobOpts): Promise<unknown> {
  if (host === LOCAL_HOST) throw new HostJobError("host-jobs: host 'local' runs its jobs in place");
  const j = checkJob(job);
  const send: Send = o.send ?? ((h, body, ms) => linkRequest(o.root ?? stateRoot(), h, CHANNEL, body, ms));
  try { return await send(host, j, timeoutOf(j)); } catch (e) {
    throw new HostJobError(`host ${host}: ${j.job}: ${(e as Error).message}`);
  }
}

/** The host a member's worktree is on: its newest `members` row's host, else `local`. */
export function hostOfWt(store: Store, project: string | null | undefined, wt: string): string {
  const r = store.db.query("SELECT host FROM members WHERE project = ? AND wt = ? ORDER BY id DESC LIMIT 1").get(project ?? "", wt) as { host: string | null } | null;
  return r?.host || LOCAL_HOST;
}

/** Clone a project on `host`. Local: `git clone` here, the same as a side host runs it. */
export async function cloneOn(host: string, job: { project: string; url: string; dest?: string }, o: JobOpts = {}): Promise<Cloned> {
  const j = checkJob({ job: "clone", ...job }) as Extract<HostJob, { job: "clone" }>;
  if (host === LOCAL_HOST) return cloneHere(j);
  return clonedOf(await sendJob(host, j, o), host);
}

/** Make a worktree on `host` through `providerName` and record it. Local: io/worktrees.ts createWorktree, as
 *  before. A side host: its provider makes it there, and main records `worktrees (host, <side path>)`. */
export async function addWorktreeOn(store: Store, host: string, providerName: string, spec: Spec, o: JobOpts = {}, at = nowS()): Promise<{ row: Row; adopted: boolean }> {
  if (host === LOCAL_HOST) return createWorktree(store, providerName, spec, at);
  const { host: _h, ...rest } = spec;
  let made: Made & { repo: string };
  try { made = madeOf(await sendJob(host, { job: "worktree.add", provider: providerName, spec: rest }, { root: store.root, ...o }), host); }
  catch (e) { throw new WorktreeError((e as Error).message); }
  const key = { host, path: made.path };
  const had = store.get("worktrees", key), live = had && had.gone_at == null ? had : null;
  const set = { project: spec.project ?? null, name: spec.name, parent_path: spec.parent ?? null, branch: made.branch, squad: spec.squad ?? null,
    role: spec.role ?? null, provider: providerName, repo: made.repo, gone_at: null, lease: made.lease ?? null, orca_id: made.orca_id ?? null };
  store.fact("worktree_created", [{ table: "worktrees", key, set: live ? set : { ...set, created_at: at } }],
    { project: spec.project ?? undefined, squad: spec.squad ?? undefined, payload: { path: made.path, provider: providerName, branch: made.branch, adopted: made.adopted, host } });
  return { row: store.get("worktrees", key) as Row, adopted: made.adopted };
}

/** Remove the worktree at `path` on `host` through the provider that made it. Local: io/worktrees.ts removeWorktree,
 *  as before. A side host: its provider removes it there; a refusal throws and leaves the row live. */
export async function removeWorktreeOn(store: Store, host: string, path: string, opts: RemoveOpts = {}, o: JobOpts = {}, at = nowS()): Promise<{ row: Row; gone: Gone }> {
  if (host === LOCAL_HOST) return removeWorktree(store, path, opts, at);
  const key = { host, path };
  const r = store.get("worktrees", key);
  if (!r) throw new WorktreeError(`worktrees: no worktree recorded at ${host}::${path}`);
  if (r.gone_at != null) return { row: r, gone: { removed: true, already: true, branch: "none", why: "already recorded gone" } };
  let gone: Gone;
  try {
    gone = goneOf(await sendJob(host, { job: "worktree.remove", provider: String(r.provider), path, repo: String(r.repo ?? ""), branch: r.branch ? String(r.branch) : null, opts },
      { root: store.root, ...o }), host);
  } catch (e) { throw new WorktreeError((e as Error).message); }
  if (!gone.removed) throw new WorktreeError(`worktrees: ${host}::${path} not removed: ${gone.why ?? "refused"}`);
  store.fact("worktree_removed", [{ table: "worktrees", key, set: { gone_at: at } }],
    { project: r.project == null ? undefined : String(r.project), squad: r.squad == null ? undefined : String(r.squad),
      payload: { path, provider: String(r.provider), branch: gone.branch, already: gone.already, host, ...(gone.why ? { why: gone.why } : {}) } });
  return { row: store.get("worktrees", key) as Row, gone };
}

/** The remove-safety probe of the tree at `path` on `host` (io/wt-probe.ts's output). */
export async function probeOn(host: string, path: string, timeoutMs: number, opts?: { secured?: Iterable<string> }, o: JobOpts = {}): Promise<Out> {
  if (host === LOCAL_HOST) return wtProbe(path, timeoutMs, opts);
  const secured = opts ? [...(opts.secured ?? [])] : undefined;
  return outOf(await sendJob(host, { job: "probe", path, timeout_ms: Math.min(Math.max(1, Math.round(timeoutMs)), 600_000), ...(secured ? { secured } : {}) }, o), host, "probe");
}

/** Where a rescued file from a side host would be written under `dest`, or why it is refused (relProblem, then
 *  a folder on the way that is a symlink or not a folder, or a target that is not a regular file). */
export function rescueTarget(dest: string, rel: unknown): { at: string } | { why: string } {
  const p = relProblem(rel);
  if (p) return { why: p };
  const at = resolve(dest, rel as string);
  if (!at.startsWith(dest + sep) || relative(dest, at).split(sep).includes("..")) return { why: "it resolves outside the rescue folder" };
  // Every existing step from the state root's rescue folder down must be a real folder, and the target a regular file or nothing.
  const steps: string[] = [];
  for (let d = dirname(at); d.startsWith(dest + sep) || d === dest; d = dirname(d)) { steps.unshift(d); if (d === dest) break; }
  for (const d of steps) {
    let st;
    try { st = lstatSync(d); } catch { break; }   // not made yet: nothing below it exists either
    if (st.isSymbolicLink() || !st.isDirectory()) return { why: `${relative(dest, d) || "the rescue folder"} is not a folder` };
  }
  try { if (!lstatSync(at).isFile()) return { why: "it is not a regular file here" }; } catch { /* nothing there yet */ }
  return { at };
}

/** Copy the pages and notes of the tree at `path` on `host` into `<state root>/<project>/pages/<squad>/rescued/<label>/`.
 *  Local: io/rescue.ts rescuePages, as before. A side host: the files it uploads are written here after each path is
 *  checked (rescueTarget; one bad path refuses the whole answer, nothing written); those over its upload cap stay in
 *  its own rescue folder (`host_dest`, `host_files`) and count as secured, since their bytes are kept there. */
export async function rescueOn(store: Store, host: string, project: string, squad: string, label: string, path: string, o: JobOpts = {}): Promise<Rescued> {
  if (host === LOCAL_HOST) return rescuePages(store, project, squad, label, path);
  const dest = rescueDest(store.root, project, squad, label);
  const out: Rescued = { ok: true, dest, count: 0, bytes: 0, same: 0, capped: 0, listed: true, files: [], secured: [] };
  let got: Collected;
  try { got = collectedOf(await sendJob(host, { job: "rescue", path, project, squad, label }, { root: store.root, ...o }), host); }
  catch (e) { return { ...out, ok: false, why: (e as Error).message.slice(0, 200) }; }
  out.capped = got.capped;
  out.listed = got.listed;
  const todo: { rel: string; at: string; body: Buffer }[] = [];
  for (const f of got.files) {
    const t = rescueTarget(dest, f.rel);
    if ("why" in t) return { ...out, ok: false, why: `refused rescued path ${JSON.stringify(f.rel).slice(0, 120)} from ${host}: ${t.why}` };
    const body = Buffer.from(f.data, "base64");
    if (body.length !== f.size) return { ...out, ok: false, why: `refused rescued file ${f.rel} from ${host}: ${body.length} bytes, not the ${f.size} it named` };
    todo.push({ rel: f.rel, at: t.at, body });
  }
  for (const k of got.kept) { const p = relProblem(k); if (p) return { ...out, ok: false, why: `refused kept path from ${host}: ${p}` }; }
  for (const { rel, at, body } of todo) {
    try {
      if (await placeBody(body, at) === "same") { out.same++; if (securable(rel)) out.secured.push(rel); continue; }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      return { ...out, ok: false, why: `${err.code ?? "error"} on ${rel}: ${String(err.message ?? e).split("\n")[0]}`.slice(0, 200) };
    }
    out.count++; out.bytes += body.length; out.files.push(rel);
    if (securable(rel)) out.secured.push(rel);
  }
  if (got.kept.length) {
    out.host_dest = got.kept_dest ?? undefined;
    out.host_files = got.kept;
    for (const k of got.kept) if (securable(k)) out.secured.push(k);
  }
  return out;
}

/** `git rev-parse <ref>` in the tree at `path` on `host`; `missing` when the folder is not there. */
export async function readRefOn(host: string, path: string, ref: string, o: JobOpts = {}): Promise<RefRead> {
  if (host === LOCAL_HOST) return refRead(path, refName(ref));
  const v = await sendJob(host, { job: "ref.read", path, ref }, o);
  const out = outOf(v, host, "ref.read");
  if (typeof (v as Record<string, unknown>).missing !== "boolean") wrong(host, "ref.read", "no missing flag");
  return { ...out, missing: (v as Record<string, unknown>).missing as boolean };
}

/** Set a ref back: `git update-ref [--no-deref] <ref> <sha>` in the tree at `path` on `host`. */
export async function setRefOn(host: string, path: string, ref: string, sha: string, noDeref = false, o: JobOpts = {}): Promise<Out> {
  const j = checkJob({ job: "ref.set", path, ref, sha, no_deref: noDeref }) as Extract<HostJob, { job: "ref.set" }>;
  if (host === LOCAL_HOST) return refSet(j.path, j.ref, j.sha, !!j.no_deref);
  return outOf(await sendJob(host, j, o), host, "ref.set");
}

/** Push `branch` of the tree at `path` on `host` to its remote (default origin), never forced. */
export async function pushOn(host: string, path: string, branch: string, remote?: string, o: JobOpts = {}): Promise<Out> {
  const j = checkJob({ job: "push", path, branch, ...(remote ? { remote } : {}) }) as Extract<HostJob, { job: "push" }>;
  if (host === LOCAL_HOST) return pushHere(j.path, j.branch, j.remote);
  return outOf(await sendJob(host, j, o), host, "push");
}
