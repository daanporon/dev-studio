// providers/treehouse.ts — the `treehouse` worktree provider (orca-backend-alternatives U8): a leased slot
// of treehouse's per-repo pool of warm worktrees (github.com/kunchenguid/treehouse, pinned TREEHOUSE_VERSION).
// A returned slot is reset with `git clean -fd`, so its ignored files (node_modules, build caches) stay
// for the next lease: a second Builder on the repo skips most of its install.
//   pathFor  null: treehouse picks the slot (`<pool>/<slot>/<repo>`, or the template in spec.path, which
//            must hold {slot} and {pool} or {repo}: `--worktree-path`).
//   create   `treehouse get --lease --json --lease-holder ds:<project>:<name> [-b <branch>] [--base <b>]`
//            in the repo. The holder is the intent: a slot already leased to it is adopted (a create that
//            died before its row was written is picked up by the next one), and one on another branch is
//            refused. A new branch is cut from the base (a branch name: `origin/` and `refs/heads/` are
//            dropped, HEAD means the repo's default); an existing one is checked out in a detached slot,
//            and the lease is returned again if that fails. The lease id is kept on the row.
//   remove   refuses a tree with changes other than dev-studio's own files unless forced (git.ts
//            `changes`), then `treehouse return --force --if-lease-id <lease> <path>`: the slot goes back
//            to the pool (its processes stopped, the tree reset), the folder stays. The branch is kept,
//            unless deleteBranch and it is merged into the base. A slot no longer on the row's lease is
//            reported `already`.
//   list     the slots `treehouse status --json` shows on a lease (a returned slot is not a worktree of
//            ours, though its folder is still there), each with its lease.
//   prune    `git worktree prune` of the repo; never treehouse's own prune, which would drop warm slots.
// With no treehouse binary (DS_TREEHOUSE_BIN, else `treehouse` on PATH) every call refuses with one line
// and nothing falls back to git.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Row } from "../../core/store.ts";
import { childEnv, type Out } from "../orca.ts";
import { git, lastLine, WorktreeError, type Gone, type Listed, type Made, type Provider, type RemoveOpts, type Spec } from "../worktrees.ts";
import { branchAfter, changes, hasBranch } from "./git.ts";

export const TREEHOUSE_VERSION = "v3.1.8";
const RELEASE = `https://github.com/kunchenguid/treehouse/releases/download/${TREEHOUSE_VERSION}`;
const ASSETS: Record<string, { asset: string; sha256: string }> = {
  "linux-x64": { asset: `treehouse-${TREEHOUSE_VERSION}-linux-amd64.tar.gz`, sha256: "bd6227d909ba8046263ae5d4e072ccbcf43010cac9d7289b1262126510edfeed" },
  "linux-arm64": { asset: `treehouse-${TREEHOUSE_VERSION}-linux-arm64.tar.gz`, sha256: "3d1c02c8ab13049709ace66be51d99b72fe7b6d0b73d0d0efd90f226e1aa87d1" },
  "darwin-x64": { asset: `treehouse-${TREEHOUSE_VERSION}-darwin-amd64.tar.gz`, sha256: "6be7f71cc8c6a1fbf40311af8ee3c45459c72afbab2c93dc2f80a183427bcbeb" },
  "darwin-arm64": { asset: `treehouse-${TREEHOUSE_VERSION}-darwin-arm64.tar.gz`, sha256: "007c55c26e0bd8b672b1a917465f06c3f89d93a66cd171364ffb65743d268601" },
};

/** The treehouse binary: DS_TREEHOUSE_BIN, else `treehouse` on PATH; null when there is none. */
export function treehouseBin(): string | null {
  const given = process.env.DS_TREEHOUSE_BIN;
  if (given) return existsSync(given) ? given : null;
  return Bun.which("treehouse");
}
const missing = () => `treehouse: not installed (no ${process.env.DS_TREEHOUSE_BIN ? `DS_TREEHOUSE_BIN=${process.env.DS_TREEHOUSE_BIN}` : "'treehouse' on PATH"}); `
  + `install treehouse ${TREEHOUSE_VERSION} (github.com/kunchenguid/treehouse) or use provider git`;

// treehouse in the repo (it finds its pool from the working folder), without the caller's repo variables,
// a lease holder or slot of its own, or a terminal to prompt on.
const DROP = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "TREEHOUSE_LEASE_HOLDER", "TREEHOUSE_DIR"];
export async function treehouse(repo: string, args: string[], timeoutMs = 600_000): Promise<Out> {
  const bin = treehouseBin();
  if (!bin) throw new WorktreeError(missing());
  const env = childEnv();
  for (const k of DROP) delete env[k];
  env.GIT_TERMINAL_PROMPT = "0";
  try {
    const p = Bun.spawn([bin, ...args], { cwd: repo, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  } catch (e) { return { code: -1, out: "", err: (e as Error)?.message ?? String(e) }; }
}

type Slot = { name: string; path: string; status: string; branch: string; detached?: boolean; lease_id: string; lease_holder: string };

/** `treehouse status --json` of the repo's pool. */
export async function slots(repo: string): Promise<Slot[]> {
  const o = await treehouse(repo, ["status", "--json"], 120_000);
  if (o.code !== 0) throw new WorktreeError(`treehouse: status in ${repo} failed: ${lastLine(o)}`);
  try { return (JSON.parse(o.out || "[]") ?? []) as Slot[]; } catch { throw new WorktreeError(`treehouse: status in ${repo} printed no JSON: ${lastLine(o)}`); }
}

/** The lease holder that names one spec's worktree in the repo's pool. */
export const holderOf = (spec: Pick<Spec, "project" | "name">) => `ds:${spec.project || "-"}:${spec.name}`;

// treehouse cuts from a branch only (never a tag or a sha): the base as a branch name, or "" for its default.
async function baseOf(repo: string, base: string): Promise<string> {
  if (base === "HEAD") return "";
  const b = base.replace(/^refs\/heads\//, "").replace(/^(refs\/remotes\/)?origin\//, "");
  for (const ref of [`refs/heads/${b}`, `refs/remotes/origin/${b}`]) {
    if ((await git(["-C", repo, "show-ref", "--verify", "--quiet", ref])).code === 0) return b;
  }
  throw new WorktreeError(`treehouse: base '${base}' is not a branch of ${repo} (treehouse cuts worktrees from a branch only)`);
}

const slotBranch = (sl: Slot) => (sl.detached || !sl.branch ? null : sl.branch);

const provider: Provider = {
  name: "treehouse",
  pathFor: () => null,

  async create(spec: Spec, _path: string | null): Promise<Made> {
    if (!treehouseBin()) throw new WorktreeError(missing());
    if (spec.path && !spec.path.includes("{slot}")) {
      throw new WorktreeError(`treehouse: picks the slot itself; a path is a template holding {slot} and {pool} or {repo}, not '${spec.path}'`);
    }
    const ok = await git(["check-ref-format", "--branch", spec.branch]);
    if (ok.code !== 0) throw new WorktreeError(`treehouse: '${spec.branch}' is not a branch name`);
    const holder = holderOf(spec);
    const mine = (await slots(spec.repo)).find((sl) => sl.lease_id && sl.lease_holder === holder);
    if (mine) {
      const br = slotBranch(mine);
      if (br !== spec.branch) throw new WorktreeError(`treehouse: ${mine.path} is leased to ${holder} on branch '${br ?? "(detached)"}', not '${spec.branch}'`);
      return { path: resolve(mine.path), branch: spec.branch, adopted: true, lease: mine.lease_id };
    }
    const existing = await hasBranch(spec.repo, spec.branch);
    const base = existing ? "" : await baseOf(spec.repo, spec.base);
    const args = ["get", "--lease", "--json", "--lease-holder", holder, ...(existing ? [] : ["-b", spec.branch]),
      ...(base ? ["--base", base] : []), ...(spec.path ? ["--worktree-path", spec.path] : [])];
    const got = await treehouse(spec.repo, args);
    if (got.code !== 0) throw new WorktreeError(`treehouse: get in ${spec.repo} failed: ${lastLine(got)}`);
    let lease: { path?: string; lease_id?: string };
    try { lease = JSON.parse(got.out.trim().split("\n").at(-1) ?? ""); } catch { lease = {}; }
    if (!lease.path || !lease.lease_id) throw new WorktreeError(`treehouse: get in ${spec.repo} printed no lease: ${lastLine(got)}`);
    const path = resolve(lease.path);
    if (existing) {
      const co = await git(["-C", path, "checkout", "-q", spec.branch]);
      if (co.code !== 0) {
        await treehouse(spec.repo, ["return", "--force", "--if-lease-id", lease.lease_id, path]);
        throw new WorktreeError(`treehouse: checking out '${spec.branch}' in ${path} failed (the slot was returned): ${lastLine(co)}`);
      }
    }
    return { path, branch: spec.branch, adopted: false, lease: lease.lease_id };
  },

  async remove(row: Row, opts: RemoveOpts): Promise<Gone> {
    const path = String(row.path), repo = row.repo ? String(row.repo) : "", branch = row.branch ? String(row.branch) : "", lease = row.lease ? String(row.lease) : "";
    if (!treehouseBin()) return { removed: false, already: false, branch: "none", why: missing() };
    if (!repo || !existsSync(repo)) return { removed: false, already: false, branch: "none", why: `its repo ${repo || "(unknown)"} is not there` };
    const sl = (await slots(repo)).find((x) => resolve(x.path) === path);
    if (!sl || !sl.lease_id || (lease && sl.lease_id !== lease)) {
      return { removed: true, already: true, branch: await branchAfter(repo, branch, opts), why: `no longer on lease ${lease || "(none)"}` };
    }
    if (!opts.force) {
      const why = await changes(path);
      if (why) return { removed: false, already: false, branch: "none", why };
    }
    const back = await treehouse(repo, ["return", "--force", "--if-lease-id", sl.lease_id, path]);
    if (back.code !== 0) return { removed: false, already: false, branch: "none", why: `treehouse return failed: ${lastLine(back)}` };
    return { removed: true, already: false, branch: await branchAfter(repo, branch, opts) };
  },

  async list(repo: string): Promise<Listed[]> {
    return (await slots(repo)).filter((sl) => sl.lease_id)
      .map((sl) => ({ path: resolve(sl.path), branch: slotBranch(sl), head: null, prunable: false, lease: sl.lease_id }));
  },

  prune: (repo: string) => git(["-C", repo, "worktree", "prune"]),
};

export default provider;

// Fetch the pinned treehouse release into `dir` (sha256 checked), or say why not. DS_TREEHOUSE_BIN names a
// binary to use instead; DS_TREEHOUSE_FETCH=0 fetches nothing (a test then skips).
export async function fetchTreehouse(dir: string, timeoutMs = 120_000): Promise<{ bin: string } | { skip: string }> {
  const given = process.env.DS_TREEHOUSE_BIN;
  if (given) return existsSync(given) ? { bin: given } : { skip: `DS_TREEHOUSE_BIN=${given} does not exist` };
  if (process.env.DS_TREEHOUSE_FETCH === "0") return { skip: "DS_TREEHOUSE_FETCH=0" };
  const a = ASSETS[`${process.platform}-${process.arch}`];
  if (!a) return { skip: `no pinned treehouse ${TREEHOUSE_VERSION} binary for ${process.platform}-${process.arch}` };
  let bytes: Uint8Array;
  try {
    const r = await fetch(`${RELEASE}/${a.asset}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { skip: `fetching treehouse ${TREEHOUSE_VERSION}: HTTP ${r.status}` };
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) { return { skip: `fetching treehouse ${TREEHOUSE_VERSION}: ${e instanceof Error ? e.message : String(e)}` }; }
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (sum !== a.sha256) return { skip: `treehouse ${TREEHOUSE_VERSION} download has sha256 ${sum}, expected ${a.sha256}` };
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(dir, ".unpack-"));
  try {
    const tgz = join(tmp, a.asset);
    await Bun.write(tgz, bytes);
    const out = join(tmp, "x");
    mkdirSync(out);
    const x = Bun.spawnSync(["tar", "-xzf", tgz, "-C", out], { stdout: "pipe", stderr: "pipe" });
    if (x.exitCode !== 0) return { skip: `unpacking ${a.asset}: ${x.stderr.toString().trim() || `exit ${x.exitCode}`}` };
    const found = [...new Bun.Glob("**/treehouse").scanSync({ cwd: out, onlyFiles: true })].sort((p, q) => p.length - q.length)[0];
    if (!found) return { skip: `${a.asset} holds no treehouse binary` };
    const bin = join(dir, "treehouse");
    chmodSync(join(out, found), 0o755);
    renameSync(join(out, found), bin);
    return { bin };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
