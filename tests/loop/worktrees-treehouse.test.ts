// worktrees-treehouse.test.ts — orca-backend-alternatives U8: the `treehouse` worktree provider
// (bin/loop/io/providers/treehouse.ts) leases a slot of treehouse's warm pool, records it in `worktrees`
// like a git worktree (same columns, plus the lease id), adopts its own lease after a create that died
// before the row, returns the slot on removal with its ignored files kept for the next lease, and refuses
// with one line when there is no treehouse binary. Against the pinned treehouse release in a temp HOME;
// those cases are skipped with the reason printed when it can't be fetched (DS_TREEHOUSE_FETCH=0, or
// DS_TREEHOUSE_BIN for a local binary).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { createWorktree, git, listWorktrees, provider, removeWorktree, WorktreeError } from "../../bin/loop/io/worktrees.ts";
import { fetchTreehouse, holderOf, slots, treehouse } from "../../bin/loop/io/providers/treehouse.ts";

const dir = mkdtempSync(join(tmpdir(), "wt-treehouse-"));
const ENV = ["HOME", "XDG_CONFIG_HOME", "TREEHOUSE_ROOT", "DS_TREEHOUSE_BIN", "TREEHOUSE_NO_UPDATE_CHECK"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const restore = () => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } } });
afterAll(() => { restore(); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
type Rig = { repo: string; s: Store };
async function rig(): Promise<Rig> {
  const at = join(dir, `r${++n}`), repo = join(at, "repo");
  mkdirSync(repo, { recursive: true }); mkdirSync(join(at, "state"));
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  const id = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  for (const a of [["init", "-q", "-b", "main"], ["add", ".gitignore"], [...id, "commit", "-q", "-m", "init"]]) {
    const o = await git(["-C", repo, ...a]);
    if (o.code !== 0) throw new Error(o.err);
  }
  const s = open(join(at, "state")); stores.push(s);
  return { repo, s };
}
const spec = (r: Rig, name: string, extra: Record<string, string | null> = {}) =>
  ({ repo: r.repo, name, branch: `feat/${name}`, base: "main", project: "realp", squad: "sq", role: `builder-${name}`, parent: join(dir, "lead"), ...extra });
const row = (r: Rig, path: string): Row | null => r.s.get("worktrees", { host: "local", path });
const live = (r: Rig): Row[] => r.s.db.query("SELECT * FROM worktrees WHERE gone_at IS NULL ORDER BY path").all() as Row[];
const events = (r: Rig, kind: string): Row[] => r.s.db.query("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[];
const branchIn = async (path: string) => (await git(["-C", path, "branch", "--show-current"])).out.trim();

describe("no treehouse binary", () => {
  test("create refuses with one line and records nothing; list marks nothing; remove refuses", async () => {
    process.env.DS_TREEHOUSE_BIN = join(dir, "no-such-treehouse");
    try {
      const r = await rig();
      const err = await createWorktree(r.s, "treehouse", spec(r, "a1"), 1000).catch((e) => e);
      expect(err).toBeInstanceOf(WorktreeError);
      expect(err.message).toMatch(/^treehouse: not installed \(no DS_TREEHOUSE_BIN=.*\); install treehouse v3\.1\.8/);
      expect(err.message).not.toContain("\n");
      expect(live(r)).toEqual([]);
      r.s.upsert("worktrees", { host: "local", path: join(dir, "elsewhere") }, { provider: "treehouse", repo: r.repo, name: "x", branch: "feat/x", lease: "L1", created_at: 1 });
      expect((await listWorktrees(r.s, {}, 2000)).marked).toEqual([]);
      const rm = await removeWorktree(r.s, join(dir, "elsewhere")).catch((e) => e);
      expect(rm.message).toMatch(/not removed: treehouse: not installed/);
      expect(row(r, join(dir, "elsewhere"))?.gone_at).toBeNull();
    } finally { restore(); }
  });
});

const got = await fetchTreehouse(join(dir, "bin"));
if ("skip" in got) {
  console.log(`worktrees-treehouse: the treehouse cases are skipped: ${got.skip}`);
  describe("treehouse pool", () => { test.skip(`lease, adopt, return, warm reuse (skipped: ${got.skip})`, () => {}); });
} else {
  const use = () => {
    process.env.DS_TREEHOUSE_BIN = got.bin;
    process.env.HOME = join(dir, "home");
    process.env.XDG_CONFIG_HOME = join(dir, "home", ".config");
    process.env.TREEHOUSE_ROOT = join(dir, "pools");
    // No update check: treehouse runs it in the background and its update-check.json can land in the temp
    // HOME after afterAll removed it (tests/ci.sh's temp-dirs check then fails).
    process.env.TREEHOUSE_NO_UPDATE_CHECK = "1";
    mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  };
  const T = 120_000;

  describe("treehouse pool", () => {
    test("create leases a slot on a new branch from the base and records it like a git worktree, with the lease", async () => {
      use();
      try {
        const r = await rig();
        const out = await createWorktree(r.s, "treehouse", spec(r, "a1"), 1000);
        const path = String(out.row.path);
        expect(out.adopted).toBe(false);
        expect(path.startsWith(join(dir, "pools"))).toBe(true);
        expect(await branchIn(path)).toBe("feat/a1");
        expect(out.row).toMatchObject({ provider: "treehouse", repo: r.repo, name: "a1", branch: "feat/a1", project: "realp", squad: "sq",
          role: "builder-a1", parent_path: join(dir, "lead"), created_at: 1000, gone_at: null });
        const sl = (await slots(r.repo)).find((x) => x.path === path);
        expect(sl).toMatchObject({ lease_holder: holderOf({ project: "realp", name: "a1" }), lease_id: out.row.lease });
        expect(String(out.row.lease)).not.toBe("");
        expect(events(r, "worktree_created").map((e) => JSON.parse(String(e.payload)))).toEqual([
          { path, provider: "treehouse", branch: "feat/a1", adopted: false, parent: join(dir, "lead") }]);
        expect((await listWorktrees(r.s, {}, 2000)).marked).toEqual([]);
      } finally { restore(); }
    }, T);

    test("the same spec again adopts its lease: one slot, no second event; a create that died before its row is adopted too", async () => {
      use();
      try {
        const r = await rig();
        const first = await createWorktree(r.s, "treehouse", spec(r, "a1"), 1000);
        const again = await createWorktree(r.s, "treehouse", spec(r, "a1", { squad: null, role: null }), 2000);
        expect(again).toMatchObject({ adopted: true, row: { path: first.row.path, lease: first.row.lease, squad: "sq", role: "builder-a1", created_at: 1000 } });
        expect(events(r, "worktree_created")).toHaveLength(1);
        // The crash: treehouse leased a slot, the row was never written.
        const made = await (await provider("treehouse")).create({ ...spec(r, "b1"), repo: r.repo }, null);
        expect(live(r).map((x) => x.name)).toEqual(["a1"]);
        const picked = await createWorktree(r.s, "treehouse", spec(r, "b1"), 3000);
        expect(picked).toMatchObject({ adopted: true, row: { path: made.path, lease: made.lease, branch: "feat/b1", created_at: 3000 } });
        expect((await slots(r.repo)).filter((x) => x.lease_id)).toHaveLength(2);
        // Same name, another branch: refused before treehouse runs.
        const err = await createWorktree(r.s, "treehouse", spec(r, "a1", { branch: "feat/other" }), 4000).catch((e) => e);
        expect(err.message).toMatch(/'a1' is recorded at .* on branch 'feat\/a1', not 'feat\/other'/);
      } finally { restore(); }
    }, T);

    test("an existing branch is checked out in the slot; a sha base and a fixed path are refused", async () => {
      use();
      try {
        const r = await rig();
        await git(["-C", r.repo, "branch", "feat/a2"]);
        const out = await createWorktree(r.s, "treehouse", spec(r, "a2"), 1000);
        expect(await branchIn(String(out.row.path))).toBe("feat/a2");
        const sha = (await git(["-C", r.repo, "rev-parse", "HEAD"])).out.trim();
        const bad = await createWorktree(r.s, "treehouse", spec(r, "a3", { base: sha }), 1000).catch((e) => e);
        expect(bad.message).toMatch(/base '[0-9a-f]+' is not a branch .*from a branch only/);
        const fixed = await createWorktree(r.s, "treehouse", spec(r, "a4", { path: join(dir, "fixed") }), 1000).catch((e) => e);
        expect(fixed.message).toMatch(/picks the slot itself/);
        expect(live(r).map((x) => x.name)).toEqual(["a2"]);
        // refs/heads/<branch> as the base is the branch.
        const o = await createWorktree(r.s, "treehouse", spec(r, "a5", { base: "refs/heads/main" }), 1000);
        expect(await branchIn(String(o.row.path))).toBe("feat/a5");
      } finally { restore(); }
    }, T);

    test("remove refuses changes unless forced, returns the lease, keeps the branch; the next lease reuses the slot warm", async () => {
      use();
      try {
        const r = await rig();
        const out = await createWorktree(r.s, "treehouse", spec(r, "a1"), 1000);
        const path = String(out.row.path);
        mkdirSync(join(path, "node_modules", "dep"), { recursive: true });
        writeFileSync(join(path, "node_modules", "dep", "index.js"), "warm\n");
        writeFileSync(join(path, "CLAUDE.local.md"), "brief\n");
        writeFileSync(join(path, "work.txt"), "x\n");
        const refused = await removeWorktree(r.s, path, {}, 2000).catch((e) => e);
        expect(refused.message).toMatch(/not removed: 1 changed file\(s\): work\.txt/);
        expect(row(r, path)?.gone_at).toBeNull();
        rmSync(join(path, "work.txt"));
        const gone = await removeWorktree(r.s, path, {}, 3000);
        expect(gone.gone).toMatchObject({ removed: true, already: false, branch: "kept" });
        expect(row(r, path)?.gone_at).toBe(3000);
        expect((await slots(r.repo)).find((x) => x.path === path)?.lease_id || "").toBe("");
        expect((await git(["-C", r.repo, "show-ref", "--verify", "refs/heads/feat/a1"])).code).toBe(0);
        // The next Builder gets the same slot, its node_modules still there.
        const next = await createWorktree(r.s, "treehouse", spec(r, "b1"), 4000);
        expect(next.row.path).toBe(path);
        expect(next.row.lease).not.toBe(out.row.lease);
        expect(readFileSync(join(path, "node_modules", "dep", "index.js"), "utf8")).toBe("warm\n");
        expect(existsSync(join(path, "CLAUDE.local.md"))).toBe(false);
        expect(await branchIn(path)).toBe("feat/b1");
        expect(row(r, path)).toMatchObject({ name: "b1", branch: "feat/b1", gone_at: null, created_at: 4000 });
      } finally { restore(); }
    }, T);

    test("a lease returned by hand: list marks the row gone, and remove reports it already gone", async () => {
      use();
      try {
        const r = await rig();
        const a = await createWorktree(r.s, "treehouse", spec(r, "a1"), 1000);
        const b = await createWorktree(r.s, "treehouse", spec(r, "b1"), 1000);
        for (const w of [a, b]) expect((await treehouse(r.repo, ["return", "--force", String(w.row.path)])).code).toBe(0);
        const { marked } = await listWorktrees(r.s, {}, 2000);
        expect([...marked].sort()).toEqual([String(a.row.path), String(b.row.path)].sort());
        expect(events(r, "worktree_gone").map((e) => JSON.parse(String(e.payload)).why)).toEqual([
          `not a treehouse worktree of ${r.repo}`, `not a treehouse worktree of ${r.repo}`]);
        const c = await createWorktree(r.s, "treehouse", spec(r, "c1"), 3000);
        await treehouse(r.repo, ["return", "--force", String(c.row.path)]);
        const gone = await removeWorktree(r.s, String(c.row.path), {}, 4000);
        expect(gone.gone).toMatchObject({ removed: true, already: true, branch: "kept" });
        // Returned by hand with no list since: the next lease gets the slot, and the stale row is not taken over.
        const d = await createWorktree(r.s, "treehouse", spec(r, "d1"), 5000);
        await treehouse(r.repo, ["return", "--force", String(d.row.path)]);
        const e = await createWorktree(r.s, "treehouse", spec(r, "e1", { squad: null, role: null, parent: null }), 6000);
        expect(e.row.path).toBe(d.row.path);
        expect(e.row).toMatchObject({ name: "e1", squad: null, role: null, parent_path: null, created_at: 6000, lease: expect.any(String) });
        expect(e.row.lease).not.toBe(d.row.lease);
        expect(events(r, "worktree_gone").map((x) => JSON.parse(String(x.payload)).why).at(-1)).toBe("'e1' now holds it");
      } finally { restore(); }
    }, T);
  });
}
