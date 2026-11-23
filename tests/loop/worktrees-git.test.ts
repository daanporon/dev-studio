// worktrees-git.test.ts — orca-backend-alternatives U7: the loop makes, lists and removes worktrees with
// git alone (bin/loop/io/worktrees.ts, providers/git.ts), each recorded by path with its parent in the
// `worktrees` table; a re-create is idempotent, an unmerged branch is kept on removal, and a crash
// between git and the row is repaired on the next call. A temp repo and a temp state root.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { createWorktree, git, listWorktrees, provider, pruneWorktrees, removeWorktree, WorktreeError } from "../../bin/loop/io/worktrees.ts";
import { syncWorktrees } from "../../bin/loop/squad/worktrees.ts";

const DS = join(import.meta.dir, "..", "..", "bin", "ds");
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

type Rig = { dir: string; repo: string; wts: string; s: Store };
async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "wt-git-")); temps.push(dir);
  const repo = join(dir, "repo"), wts = join(dir, "wts");
  mkdirSync(repo); mkdirSync(join(dir, "state"));
  for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    const o = await git(["-C", repo, ...a]);
    if (o.code !== 0) throw new Error(o.err);
  }
  const s = open(join(dir, "state")); stores.push(s);
  return { dir, repo, wts, s };
}
const spec = (r: Rig, name: string, extra: Record<string, string | null> = {}) =>
  ({ repo: r.repo, name, branch: `feat/${name}`, base: "main", path: join(r.wts, name), project: "realp", squad: "sq", role: `builder-${name}`, parent: join(r.wts, "lead"), ...extra });
const row = (r: Rig, path: string): Row | null => r.s.get("worktrees", { host: "local", path });
const events = (r: Rig, kind: string): Row[] => r.s.db.query("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[];
const branches = async (r: Rig) => (await git(["-C", r.repo, "branch", "--format=%(refname:short)"])).out.split("\n").filter(Boolean).sort();
async function commitIn(path: string, file: string): Promise<void> {
  writeFileSync(join(path, file), "x\n");
  await git(["-C", path, "add", file]);
  const o = await git(["-C", path, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", file]);
  if (o.code !== 0) throw new Error(o.err);
}

describe("create", () => {
  test("makes the worktree on a new branch from the base and records it by path with its parent", async () => {
    const r = await rig();
    const out = await createWorktree(r.s, "git", spec(r, "a1"), 1000);
    const path = join(r.wts, "a1");
    expect(out.adopted).toBe(false);
    expect(existsSync(join(path, ".git"))).toBe(true);
    expect((await git(["-C", path, "branch", "--show-current"])).out.trim()).toBe("feat/a1");
    expect(row(r, path)).toMatchObject({ provider: "git", repo: r.repo, name: "a1", branch: "feat/a1", project: "realp", squad: "sq",
      role: "builder-a1", parent_path: join(r.wts, "lead"), created_at: 1000, gone_at: null });
    expect(events(r, "worktree_created").map((e) => JSON.parse(String(e.payload)))).toEqual([
      { path, provider: "git", branch: "feat/a1", adopted: false, parent: join(r.wts, "lead") }]);
  });

  test("the same spec again adopts what is there: one worktree, no second event, the row kept", async () => {
    const r = await rig();
    await createWorktree(r.s, "git", spec(r, "a1"), 1000);
    const again = await createWorktree(r.s, "git", spec(r, "a1", { squad: null, role: null, parent: null }), 2000);
    expect(again.adopted).toBe(true);
    expect(again.row).toMatchObject({ squad: "sq", role: "builder-a1", parent_path: join(r.wts, "lead"), created_at: 1000 });
    expect(events(r, "worktree_created")).toHaveLength(1);
    expect(await (await provider("git")).list(r.repo)).toHaveLength(1);
  });

  test("an existing branch is checked out as is, not made again", async () => {
    const r = await rig();
    await git(["-C", r.repo, "branch", "feat/a2"]);
    await createWorktree(r.s, "git", spec(r, "a2"));
    expect((await git(["-C", join(r.wts, "a2"), "branch", "--show-current"])).out.trim()).toBe("feat/a2");
  });

  test("refuses a path on another branch, a branch checked out elsewhere, a folder git does not know, bad names", async () => {
    const r = await rig();
    await createWorktree(r.s, "git", spec(r, "a1"));
    await expect(createWorktree(r.s, "git", spec(r, "a1", { branch: "feat/other" }))).rejects.toThrow(/recorded on branch 'feat\/a1'/);
    await expect(createWorktree(r.s, "git", spec(r, "b1", { branch: "feat/a1" }))).rejects.toThrow(/checked out in/);
    mkdirSync(join(r.wts, "c1"), { recursive: true });
    await expect(createWorktree(r.s, "git", spec(r, "c1"))).rejects.toThrow(/is not a worktree of/);
    await expect(createWorktree(r.s, "git", spec(r, "../x"))).rejects.toBeInstanceOf(WorktreeError);
    await expect(createWorktree(r.s, "git", spec(r, "d1", { branch: "bad..name" }))).rejects.toThrow(/not a branch name/);
    await expect(createWorktree(r.s, "nope", spec(r, "d1"))).rejects.toThrow(/no provider 'nope'/);
    expect(row(r, join(r.wts, "b1"))?.gone_at).not.toBeNull();   // a refused fresh create leaves its row gone
  });

  test("a failed git add marks the fresh row gone with the why", async () => {
    const r = await rig();
    await expect(createWorktree(r.s, "git", spec(r, "a1", { base: "no-such-ref" }), 500)).rejects.toThrow(/worktree add/);
    expect(row(r, join(r.wts, "a1"))).toMatchObject({ gone_at: 500 });
    expect(JSON.parse(String(events(r, "worktree_gone")[0].payload)).why).toMatch(/^create failed: /);
  });

  test("without a path it goes under DS_WORKTREE_ROOT/<project>/<name>", async () => {
    const r = await rig();
    const was = process.env.DS_WORKTREE_ROOT;
    process.env.DS_WORKTREE_ROOT = join(r.dir, "root");
    try {
      const out = await createWorktree(r.s, "git", spec(r, "e1", { path: null }));
      expect(out.row.path).toBe(join(r.dir, "root", "realp", "e1"));
    } finally { if (was === undefined) delete process.env.DS_WORKTREE_ROOT; else process.env.DS_WORKTREE_ROOT = was; }
  });
});

describe("remove", () => {
  test("keeps an unmerged branch even when asked to delete it, deletes a merged one only when asked", async () => {
    const r = await rig();
    await createWorktree(r.s, "git", spec(r, "a1"));
    await commitIn(join(r.wts, "a1"), "work.txt");
    const gone = await removeWorktree(r.s, join(r.wts, "a1"), { deleteBranch: true, base: "main" }, 3000);
    expect(gone.gone).toMatchObject({ removed: true, already: false, branch: "kept" });
    expect(existsSync(join(r.wts, "a1"))).toBe(false);
    expect(await branches(r)).toEqual(["feat/a1", "main"]);
    expect(row(r, join(r.wts, "a1"))?.gone_at).toBe(3000);

    await createWorktree(r.s, "git", spec(r, "b1"));
    expect((await removeWorktree(r.s, join(r.wts, "b1"))).gone.branch).toBe("kept");   // merged, but not asked
    await createWorktree(r.s, "git", spec(r, "c1"));
    expect((await removeWorktree(r.s, join(r.wts, "c1"), { deleteBranch: true, base: "main" })).gone.branch).toBe("deleted");
    expect(await branches(r)).toEqual(["feat/a1", "feat/b1", "main"]);
    expect(events(r, "worktree_removed")).toHaveLength(3);
  });

  test("refuses a tree with changes, but not for dev-studio's own files; --force removes it anyway", async () => {
    const r = await rig();
    const path = join(r.wts, "a1");
    await createWorktree(r.s, "git", spec(r, "a1"));
    writeFileSync(join(path, "notes.txt"), "mine\n");
    await expect(removeWorktree(r.s, path)).rejects.toThrow(/1 changed file\(s\): notes.txt/);
    expect(row(r, path)?.gone_at).toBeNull();
    rmSync(join(path, "notes.txt"));
    writeFileSync(join(path, "CLAUDE.local.md"), "brief\n");
    expect((await removeWorktree(r.s, path)).gone.removed).toBe(true);

    await createWorktree(r.s, "git", spec(r, "b1"));
    writeFileSync(join(r.wts, "b1", "notes.txt"), "mine\n");
    expect((await removeWorktree(r.s, join(r.wts, "b1"), { force: true })).gone.removed).toBe(true);
  });

  test("a path never recorded is refused; a row already gone answers already", async () => {
    const r = await rig();
    await expect(removeWorktree(r.s, join(r.wts, "zz"))).rejects.toThrow(/no worktree recorded/);
    await createWorktree(r.s, "git", spec(r, "a1"));
    await removeWorktree(r.s, join(r.wts, "a1"));
    expect((await removeWorktree(r.s, join(r.wts, "a1"))).gone.already).toBe(true);
  });
});

describe("crash recovery", () => {
  test("git made it but the row was never filled in: the next create adopts it and records it", async () => {
    const r = await rig();
    const path = join(r.wts, "a1");
    // The intent row and git's worktree, but no worktree_created (the loop died in between).
    r.s.upsert("worktrees", { host: "local", path }, { provider: "git", repo: r.repo, name: "a1", branch: "feat/a1", created_at: 100 });
    await git(["-C", r.repo, "worktree", "add", "-b", "feat/a1", path, "main"]);
    const out = await createWorktree(r.s, "git", spec(r, "a1"), 200);
    expect(out.adopted).toBe(true);
    expect(out.row).toMatchObject({ squad: "sq", parent_path: join(r.wts, "lead"), created_at: 100, gone_at: null });
    expect(events(r, "worktree_created")).toHaveLength(1);
  });

  test("the row was written but git never ran: list marks it gone, a create makes it", async () => {
    const r = await rig();
    const path = join(r.wts, "a1");
    r.s.upsert("worktrees", { host: "local", path }, { provider: "git", repo: r.repo, name: "a1", branch: "feat/a1", project: "realp", created_at: 100 });
    const listed = await listWorktrees(r.s, { project: "realp" }, 300);
    expect(listed.marked).toEqual([path]);
    expect(listed.rows).toEqual([]);
    expect(row(r, path)?.gone_at).toBe(300);
    const out = await createWorktree(r.s, "git", spec(r, "a1"), 400);
    expect(out).toMatchObject({ adopted: false, row: { gone_at: null, created_at: 400 } });
  });

  test("git removed it but the row was not marked: remove and list both repair the row", async () => {
    const r = await rig();
    await createWorktree(r.s, "git", spec(r, "a1"));
    await createWorktree(r.s, "git", spec(r, "b1"));
    await git(["-C", r.repo, "worktree", "remove", join(r.wts, "a1")]);
    await git(["-C", r.repo, "worktree", "remove", join(r.wts, "b1")]);
    expect((await removeWorktree(r.s, join(r.wts, "a1"), {}, 500)).gone).toMatchObject({ removed: true, already: true, branch: "kept" });
    expect(row(r, join(r.wts, "a1"))?.gone_at).toBe(500);
    const listed = await listWorktrees(r.s, {}, 600);
    expect(listed.marked).toEqual([join(r.wts, "b1")]);
    expect(JSON.parse(String(events(r, "worktree_gone")[0].payload)).why).toMatch(/not a git worktree of/);
  });

  test("a folder removed by hand: prune makes git forget it and marks the row gone", async () => {
    const r = await rig();
    await createWorktree(r.s, "git", spec(r, "a1"));
    rmSync(join(r.wts, "a1"), { recursive: true, force: true });
    const out = await pruneWorktrees(r.s, {}, 700);
    expect(out).toEqual({ marked: [join(r.wts, "a1")], pruned: [r.repo] });
    expect(await (await provider("git")).list(r.repo)).toEqual([]);
  });
});

test("U5's Orca sync leaves a git row alone", async () => {
  const r = await rig();
  await createWorktree(r.s, "git", spec(r, "a1"), 1000);
  const before = row(r, join(r.wts, "a1"));
  syncWorktrees(r.s, 2000);
  expect(row(r, join(r.wts, "a1"))).toEqual(before);
});

test("ds worktree create, list and rm", async () => {
  const r = await rig();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DS_MEMBER|DS_GEN|DS_LOOP_CHILD|DS_NOW|GIT_DIR|GIT_INDEX_FILE|GIT_WORK_TREE)$/.test(k)) env[k] = v;
  Object.assign(env, { DS_STATE_ROOT: join(r.dir, "state"), DS_WORKTREE_ROOT: r.wts });
  const ds = (...a: string[]) => { const p = Bun.spawnSync([DS, "worktree", ...a], { env, stdout: "pipe", stderr: "pipe" }); return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }; };
  const made = ds("create", "--repo", r.repo, "--name", "a1", "--branch", "feat/a1", "--base", "main", "--project", "realp", "--json");
  expect(made.rc).toBe(0);
  expect(JSON.parse(made.out).worktree.path).toBe(join(r.wts, "realp", "a1"));
  expect(ds("list").out).toContain(`live  git  realp  -  feat/a1  ${join(r.wts, "realp", "a1")}`);
  expect(ds("rm", join(r.wts, "realp", "a1")).out).toContain("worktree removed");
  expect(ds("rm", join(r.wts, "nope"))).toMatchObject({ rc: 1 });
  expect(ds("bogus").rc).toBe(2);
});
