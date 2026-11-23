// worktrees-orca.test.ts — orca-backend-alternatives U8b: the `orca` worktree provider
// (bin/loop/io/providers/orca.ts) makes worktrees through the adapter's wt-make (no agent, no Run),
// nested under a parent and recorded with Orca's id; a re-create adopts; removal keeps an unmerged
// branch; a worktree Orca stops listing while git still has it keeps its row and is re-linked by path.
// Orca is the in-memory FakeBackend (bin/loop/fakes/orca.ts), whose wt-make makes real git worktrees
// in a temp repo; a temp state root.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { useOrca } from "../../bin/loop/io/providers/orca.ts";
import { canon, createWorktree, git, listWorktrees, removeWorktree, WorktreeError } from "../../bin/loop/io/worktrees.ts";
import { syncWorktrees } from "../../bin/loop/squad/worktrees.ts";

const temps: string[] = [], stores: Store[] = [];
const envWas = process.env.DS_ORCA_WORKSPACES;
let fake: FakeBackend;
beforeEach(() => { fake = new FakeBackend(); useOrca(fake); });
afterEach(() => {
  useOrca(null);
  if (envWas === undefined) delete process.env.DS_ORCA_WORKSPACES; else process.env.DS_ORCA_WORKSPACES = envWas;
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

type Rig = { repo: string; lead: string; s: Store };
async function rig(): Promise<Rig> {
  const dir = canon(mkdtempSync(join(tmpdir(), "wt-orca-"))); temps.push(dir);
  const repo = join(dir, "repo"), lead = join(dir, "lead");
  mkdirSync(repo); mkdirSync(join(dir, "state"));
  for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    const o = await git(["-C", repo, ...a]);
    if (o.code !== 0) throw new Error(o.err);
  }
  fake.wtRoot = process.env.DS_ORCA_WORKSPACES = join(dir, "ws");
  const s = open(join(dir, "state")); stores.push(s);
  return { repo, lead, s };
}
const spec = (r: Rig, name: string, extra: Record<string, string | null> = {}) =>
  ({ repo: r.repo, name, branch: `feat/${name}`, base: "main", project: "realp", squad: "sq", role: `builder-${name}`, parent: r.lead, ...extra });
const pathOf = (name: string) => join(fake.wtRoot, "repo", name);
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
  test("makes it through wt-make with no agent, nested under the parent, and records Orca's id by path", async () => {
    const r = await rig();
    const out = await createWorktree(r.s, "orca", spec(r, "a1"), 1000);
    const path = pathOf("a1");
    expect(out.adopted).toBe(false);
    expect(fake.of("wt-make").map((c) => c.args)).toEqual([[r.repo, "a1", "feat/a1", "main", r.lead]]);
    expect(fake.wts.get(path)?.parent).toBe(`R::${r.lead}`);
    expect((await git(["-C", path, "branch", "--show-current"])).out.trim()).toBe("feat/a1");
    expect(row(r, path)).toMatchObject({ provider: "orca", repo: r.repo, name: "a1", branch: "feat/a1", orca_id: `R::${path}`,
      parent_path: r.lead, squad: "sq", role: "builder-a1", created_at: 1000, gone_at: null });
    expect(events(r, "worktree_created").map((e) => JSON.parse(String(e.payload)))).toEqual([
      { path, provider: "orca", branch: "feat/a1", adopted: false, parent: r.lead }]);
  });

  test("no parent is a top-level worktree", async () => {
    const r = await rig();
    await createWorktree(r.s, "orca", spec(r, "a1", { parent: null }), 1000);
    expect(fake.of("wt-make")[0].args[4]).toBe("");
    expect(fake.wts.get(pathOf("a1"))?.parent).toBeNull();
  });

  test("the same spec again adopts what Orca shows: one wt-make, no second event", async () => {
    const r = await rig();
    await createWorktree(r.s, "orca", spec(r, "a1"), 1000);
    const again = await createWorktree(r.s, "orca", spec(r, "a1"), 2000);
    expect(again.adopted).toBe(true);
    expect(fake.of("wt-make")).toHaveLength(1);
    expect(events(r, "worktree_created")).toHaveLength(1);
    expect(again.row).toMatchObject({ orca_id: `R::${pathOf("a1")}`, created_at: 1000, gone_at: null });
  });

  test("a row a crash left before wt-make answered is filled in by the next create", async () => {
    const r = await rig();
    fake.fail("wt-make", { code: 1, out: "", err: "runtime_busy" });
    await expect(createWorktree(r.s, "orca", spec(r, "a1"), 1000)).rejects.toThrow(/worktree create a1 failed: runtime_busy/);
    expect(row(r, pathOf("a1"))?.gone_at).toBe(1000);
    const out = await createWorktree(r.s, "orca", spec(r, "a1"), 2000);
    expect(out.row).toMatchObject({ orca_id: `R::${pathOf("a1")}`, gone_at: null });
  });

  test("refuses an existing branch (Orca would make <branch>-2) and makes nothing", async () => {
    const r = await rig();
    await git(["-C", r.repo, "branch", "feat/a1"]);
    await expect(createWorktree(r.s, "orca", spec(r, "a1"), 1000)).rejects.toThrow(/branch 'feat\/a1' already exists/);
    expect(fake.of("wt-make")).toHaveLength(0);
  });

  test("a worktree Orca made under another path or branch is removed again and refused", async () => {
    const r = await rig();
    fake.answer = (c) => c.op === "wt-make"
      ? { code: 0, out: `${JSON.stringify({ id: "R::/elsewhere/a1-2", path: "/elsewhere/a1-2", branch: "refs/heads/feat/a1-2", head: null, parentWorktreeId: null })}\n`, err: "" }
      : undefined;
    await expect(createWorktree(r.s, "orca", spec(r, "a1"), 1000)).rejects.toThrow(/Orca made \/elsewhere\/a1-2 on 'feat\/a1-2'.*removed it again/);
    expect(fake.of("worktree-rm").map((c) => c.args)).toEqual([["id:R::/elsewhere/a1-2", "force"]]);
    expect(row(r, pathOf("a1"))?.gone_at).toBe(1000);
  });

  test("refuses a folder at the path that Orca does not know", async () => {
    const r = await rig();
    mkdirSync(pathOf("a1"), { recursive: true });
    await expect(createWorktree(r.s, "orca", spec(r, "a1"), 1000)).rejects.toBeInstanceOf(WorktreeError);
    expect(fake.of("wt-make")).toHaveLength(0);
  });
});

describe("remove", () => {
  test("an unmerged branch is kept, even with deleteBranch; the folder and Orca's entry go", async () => {
    const r = await rig();
    await createWorktree(r.s, "orca", spec(r, "a1"), 1000);
    const path = pathOf("a1");
    await commitIn(path, "work.txt");
    const out = await removeWorktree(r.s, path, { deleteBranch: true, base: "main" }, 2000);
    expect(out.gone).toEqual({ removed: true, already: false, branch: "kept" });
    expect(fake.of("worktree-rm").map((c) => c.args)).toEqual([[`id:R::${path}`, "force"]]);
    expect(existsSync(path)).toBe(false);
    expect(fake.wts.size).toBe(0);
    expect(await branches(r)).toEqual(["feat/a1", "main"]);
    expect(out.row.gone_at).toBe(2000);
  });

  test("a merged branch is deleted with deleteBranch", async () => {
    const r = await rig();
    await createWorktree(r.s, "orca", spec(r, "a1"), 1000);
    const out = await removeWorktree(r.s, pathOf("a1"), { deleteBranch: true, base: "main" }, 2000);
    expect(out.gone.branch).toBe("deleted");
    expect(await branches(r)).toEqual(["main"]);
  });

  test("refuses a tree with changes unless forced; the row stays live", async () => {
    const r = await rig();
    await createWorktree(r.s, "orca", spec(r, "a1"), 1000);
    writeFileSync(join(pathOf("a1"), "draft.txt"), "x\n");
    await expect(removeWorktree(r.s, pathOf("a1"), {}, 2000)).rejects.toThrow(/1 changed file\(s\): draft.txt/);
    expect(fake.of("worktree-rm")).toHaveLength(0);
    expect(row(r, pathOf("a1"))?.gone_at).toBeNull();
    expect((await removeWorktree(r.s, pathOf("a1"), { force: true }, 3000)).gone.removed).toBe(true);
  });
});

describe("list", () => {
  test("Orca losing its list leaves the row live and re-links it by path", async () => {
    const r = await rig();
    await createWorktree(r.s, "orca", spec(r, "a1"), 1000);
    const path = pathOf("a1"), w = fake.wts.get(path)!;
    fake.unlisted.add(path);
    w.id = `R2::${path}`;   // Orca knows it under a new id now
    const out = await listWorktrees(r.s, { provider: "orca" }, 2000);
    expect(out.marked).toEqual([]);
    expect(fake.of("wt-show").map((c) => c.args)).toEqual([[`path:${path}`]]);
    expect(row(r, path)).toMatchObject({ gone_at: null, orca_id: `R2::${path}` });
    expect(events(r, "worktree_gone")).toHaveLength(0);
  });

  test("a worktree neither Orca nor git still has is marked gone", async () => {
    const r = await rig();
    await createWorktree(r.s, "orca", spec(r, "a1"), 1000);
    const path = pathOf("a1");
    fake.unlisted.add(path);
    rmSync(path, { recursive: true, force: true });
    await git(["-C", r.repo, "worktree", "prune"]);
    const out = await listWorktrees(r.s, { provider: "orca" }, 2000);
    expect(out.marked).toEqual([path]);
    expect(row(r, path)?.gone_at).toBe(2000);
  });

  test("the Orca observer's sync leaves a provider-made row alone, an Orca gone mark included", async () => {
    const r = await rig();
    await createWorktree(r.s, "orca", spec(r, "a1"), 1000);
    const path = pathOf("a1");
    r.s.db.run("INSERT INTO observed_worktrees (project, wt, path, branch, doc, observed_at, gone_at, parent) VALUES ('realp', ?, ?, 'feat/a1', '{}', 500, 900, NULL)",
      [`R::${path}`, path]);
    syncWorktrees(r.s, 1500);
    expect(row(r, path)).toMatchObject({ gone_at: null, squad: "sq", role: "builder-a1", parent_path: r.lead });
  });
});
