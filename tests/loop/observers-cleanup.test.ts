// observers-cleanup.test.ts — host-disk-cleanup U2: the cleanup observer's raw facts per class on
// fixture roots (fake /proc, fake Claude temp root, temp git clones, a fake backend list), the
// write's row lifecycle, and the off-tick scan with its in-flight guard.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupObserver, scanCleanup, writeCleanup, type CleanupScan } from "../../bin/loop/observers/cleanup.ts";
import { mangle } from "../../bin/loop/observers/orca.ts";
import type { Store } from "../../bin/loop/core/store.ts";
import { streamDir, type DirReader } from "../../bin/loop/io/tidy.ts";
import { aged, clone, fakeProc, git, observedWt, opts, project, store, tmp, UID, worktree } from "./cleanup-fixture.ts";

const AT = Math.floor(Date.now() / 1000);
const rows = (s: CleanupScan, cls: string) => s.rows.filter((r) => r.class === cls);
const db = (st: Store) => st.db.query("SELECT project, class, key, first_seen, gone_at FROM observed_cleanup ORDER BY class, key").all() as
  { project: string; class: string; key: string; first_seen: number; gone_at: number | null }[];

describe("class a: processes", () => {
  test("deleted or ds-* cwd, attributed; never the loop's family, an agent's child, another uid or elsewhere", async () => {
    const s = store(), ws = tmp();
    project(s, "p"); project(s, "p-x");
    observedWt(s, "p", "g", `${ws}/ds-p-gone`, AT - 900);
    observedWt(s, "p", "l", `${ws}/ds-p-live`);
    s.upsert("observed_workers", { project: "p", wt: "l" }, { pid: 103, started_at: 1005, presence: "running", observed_at: 1 });
    const proc = fakeProc([
      { pid: 100, cwd: `${ws}/ds-p-gone (deleted)`, comm: "node" },
      { pid: 101, cwd: `${ws}/ds-p-live/sub` },
      { pid: 103, cwd: "/home" },                                  // the agent (start 500 = 1005)
      { pid: 102, ppid: 103, cwd: `${ws}/ds-p-live` },              // under the agent: spared
      { pid: 104, cwd: "/elsewhere" },
      { pid: 105, cwd: `${ws}/ds-p-live`, uid: UID + 1 },
      { pid: 999_999, cwd: `${ws}/ds-p-live` },                     // the loop itself
      { pid: 106, cwd: `${ws}/ds-p-x-builder-1` },                  // no row: attributed by the longest label
    ]);
    const r = await scanCleanup(s, AT, opts({ proc, tmpRoot: tmp() }));
    expect(rows(r, "a").sort((x, y) => Number(x.pid) - Number(y.pid)).map((x) => [x.pid, x.project, x.path, x.facts.deleted, x.facts.wt_id])).toEqual([
      [100, "p", `${ws}/ds-p-gone`, true, "g"], [101, "p", `${ws}/ds-p-live`, false, "l"], [106, "p-x", `${ws}/ds-p-x-builder-1`, false, null]]);
    expect(rows(r, "a").find((x) => x.pid === 100)).toMatchObject({ key: "100:500", mtime: 1005, facts: { wt_gone_at: AT - 900, comm: "node" } });
  });
});

describe("class b: the Claude temp root (KTD14)", () => {
  test("a gone tree's slug and a live tree's older sessions are rows; live, colliding and foreign slugs and loose files are not", async () => {
    const s = store(), ws = tmp(), root = tmp();
    project(s, "p");
    observedWt(s, "p", "g", `${ws}/ds-p-gone`, AT - 900);
    observedWt(s, "p", "l", `${ws}/ds-p-live`);
    observedWt(s, "p", "ab", `${ws}/ds-p-a.b`);                   // alive; ds-p-a-b mangles alike
    observedWt(s, "p", "ab2", `${ws}/ds-p-a-b`, AT - 900);
    s.upsert("observed_transcripts", { path: "/x/projects/s-new.jsonl" }, { project: "p", wt: "l", mtime: 5, observed_at: 1 });
    s.upsert("observed_transcripts", { path: "/x/projects/s-old.jsonl" }, { project: "p", wt: "l", mtime: 1, observed_at: 1 });
    for (const d of [mangle(`${ws}/ds-p-gone`), join(mangle(`${ws}/ds-p-live`), "s-old"), join(mangle(`${ws}/ds-p-live`), "s-new"),
      mangle(`${ws}/ds-p-a-b`), "-home-other"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, mangle(`${ws}/ds-p-gone`), "out"), "x".repeat(5000));
    writeFileSync(join(root, "loose.txt"), "x");
    const r = await scanCleanup(s, AT, opts({ proc: fakeProc([]), tmpRoot: root }));
    expect(rows(r, "b").map((x) => [x.key, x.project, x.facts.slug_wt ?? null, x.facts.session ?? null])).toEqual([
      [join(root, mangle(`${ws}/ds-p-live`), "s-old"), "p", null, "s-old"],
      [join(root, mangle(`${ws}/ds-p-gone`)), "p", "g", null]]);
    expect(rows(r, "b")[1].size_kb).toBeGreaterThan(0);
    expect([r.looseCount, r.looseKb > 0]).toEqual([1, true]);
  });

  test("class b sizes come from their own pool: a helper checkout that drains the c/d pool does not starve them", async () => {
    const s = store(), { repo } = clone(), ws = tmp(), root = tmp();
    project(s, "p", repo);
    mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
    const h = worktree(repo, join(repo, ".claude", "worktrees", "h"), "h");
    for (let i = 0; i < 20; i++) writeFileSync(join(h, `big${i}`), "x");
    for (const n of ["g1", "g2", "g3"]) {
      observedWt(s, "p", n, `${ws}/ds-p-${n}`, AT - 900);
      const d = join(root, mangle(`${ws}/ds-p-${n}`)); mkdirSync(d); writeFileSync(join(d, "out"), "x".repeat(5000));
    }
    const r = await scanCleanup(s, AT, opts({ proc: fakeProc([]), tmpRoot: root, sizeEntries: 10 }));
    expect(rows(r, "c")[0].facts.partial).toBe(true);
    expect(rows(r, "b")).toHaveLength(3);
    for (const b of rows(r, "b")) expect([b.size_kb! > 0, b.mtime! > 0, b.facts.partial]).toEqual([true, true, false]);
  });

  test("a class b pool too small for a dir leaves that row partial", async () => {
    const s = store(), ws = tmp(), root = tmp();
    project(s, "p");
    observedWt(s, "p", "g", `${ws}/ds-p-g`, AT - 900);
    const d = join(root, mangle(`${ws}/ds-p-g`)); mkdirSync(d); writeFileSync(join(d, "out"), "x");
    const r = await scanCleanup(s, AT, opts({ proc: fakeProc([]), tmpRoot: root, tmpSizeEntries: 1 }));
    expect(rows(r, "b")[0].facts.partial).toBe(true);
  });

  test("an fd under a candidate dir records its holder (AE1)", async () => {
    const s = store(), ws = tmp(), root = tmp();
    project(s, "p");
    observedWt(s, "p", "g", `${ws}/ds-p-gone`, AT - 900);
    const dir = join(root, mangle(`${ws}/ds-p-gone`));
    mkdirSync(dir);
    const r = await scanCleanup(s, AT, opts({ proc: fakeProc([{ pid: 77, cwd: "/home", fds: [join(dir, "log")] }]), tmpRoot: root }));
    expect(rows(r, "b")[0].facts.holder).toBe(77);
  });
});

describe("classes c and d: git and the backend", () => {
  test("helper checkouts carry locked, detached, dirty, unpushed and git cherry facts", async () => {
    const s = store(), { repo } = clone(), h = (n: string) => join(repo, ".claude", "worktrees", n);
    project(s, "p", repo);
    worktree(repo, h("clean"), "clean");
    worktree(repo, h("locked"), "locked"); git(repo, "worktree", "lock", h("locked"));
    git(repo, "worktree", "add", "-q", "--detach", h("detached"), "origin/main");
    worktree(repo, h("dirty"), "dirty"); writeFileSync(join(h("dirty"), "new.txt"), "x");
    worktree(repo, h("ahead"), "ahead"); writeFileSync(join(h("ahead"), "b.txt"), "b"); git(h("ahead"), "add", "b.txt"); git(h("ahead"), "commit", "-q", "-m", "b");
    worktree(repo, h("landed"), "landed"); writeFileSync(join(h("landed"), "c.txt"), "c"); git(h("landed"), "add", "c.txt"); git(h("landed"), "commit", "-q", "-m", "c");
    git(repo, "checkout", "-q", "main"); git(repo, "cherry-pick", "-x", git(h("landed"), "rev-parse", "HEAD")); git(repo, "push", "-q", "origin", "main"); git(repo, "fetch", "-q");
    const r = await scanCleanup(s, AT, opts({ proc: fakeProc([]), tmpRoot: tmp() }));
    const by = Object.fromEntries(rows(r, "c").map((x) => [String(x.key).split("/").pop(), x.facts]));
    expect(Object.keys(by).sort()).toEqual(["ahead", "clean", "detached", "dirty", "landed", "locked"]);
    expect(by.clean).toMatchObject({ locked: false, detached: false, exists: true, probe: { dirty: 0, unpushed: 0, unique: 0, detached: false } });
    expect(by.locked.locked).toBe(true);
    expect(by.detached).toMatchObject({ detached: true, probe: { detached: true } });
    expect(by.dirty).toMatchObject({ probe: { dirty: 1, files: ["new.txt"] } });
    expect(by.ahead).toMatchObject({ probe: { unpushed: 1, unique: 1 } });
    expect(by.landed).toMatchObject({ probe: { unpushed: 1, unique: 0 } });
  });

  test("d: entities, folders git lists but the backend does not, and folders git does not list; labels p and p-x", async () => {
    const s = store(), { repo } = clone(), ws = tmp();
    project(s, "p", repo); project(s, "p-x");
    worktree(repo, `${ws}/ds-p-old`, "old");
    worktree(repo, `${ws}/ds-p-ent`, "ent"); writeFileSync(join(ws, "ds-p-ent", "untracked.txt"), "x");
    git(repo, "worktree", "lock", `${ws}/ds-p-ent`); // an entity's git lock reaches its row
    mkdirSync(`${ws}/ds-p-stray`); mkdirSync(`${ws}/u79-x`);
    const ps = async () => [{ worktreeId: `r::${ws}/ds-p-ent`, path: `${ws}/ds-p-ent` }, { worktreeId: `r::${ws}/ds-p-x-builder-1`, path: `${ws}/ds-p-x-builder-1` },
      { worktreeId: "r::/elsewhere/u5", path: "/elsewhere/u5" }];
    const r = await scanCleanup(s, AT, opts({ proc: fakeProc([]), tmpRoot: tmp(), ps }));
    expect(rows(r, "d").map((x) => [x.project, x.key, x.facts.git ?? null])).toEqual([
      ["p", `entity:r::${ws}/ds-p-ent`, null], ["p-x", `entity:r::${ws}/ds-p-x-builder-1`, null],
      ["p", `${ws}/ds-p-old`, true], ["p", `${ws}/ds-p-stray`, false]]);
    expect(rows(r, "d")[0].facts).toMatchObject({ exists: true, probe: { dirty: 1 }, locked: true, detached: false });
    expect(rows(r, "d")[2].facts).toMatchObject({ exists: true, probe: { dirty: 0, unpushed: 0 } });
    expect(r.psError).toBeNull();
  });

  test("a failed, unparseable or empty backend list refuses d: no d rows, and the earlier ones stay", async () => {
    const s = store(), { repo } = clone(), ws = tmp();
    project(s, "p", repo);
    worktree(repo, `${ws}/ds-p-old`, "old");
    const o = opts({ proc: fakeProc([]), tmpRoot: tmp() });
    writeCleanup(s, await scanCleanup(s, AT, o));
    expect(db(s).filter((x) => x.class === "d").map((x) => x.gone_at)).toEqual([null]);
    for (const [ps, err] of [[async () => { throw new Error("boom"); }, "failed (boom)"], [async () => [{ nope: 1 }], "could not be parsed"],
      [async () => [], "was empty"]] as const) {
      const r = await scanCleanup(s, AT + 10, { ...o, ps });
      expect([r.psError, rows(r, "d").length]).toEqual([err, 0]);
      writeCleanup(s, r);
      expect(db(s).filter((x) => x.class === "d").map((x) => x.gone_at)).toEqual([null]);
      expect((s.db.query("SELECT ps_error FROM observed_cleanup_scan").get() as { ps_error: string }).ps_error).toBe(err);
    }
  });
});

describe("class e: globs (KTD5)", () => {
  const glob = (s: Store, g: string) => s.upsert("config", { project: "p", file: "limits.conf", key: "cleanup_tmp_globs" }, { value: g, observed_at: 1 });

  test("100,000 entries, 10 matches: one row, the parent iterated through the reader and never read whole", async () => {
    const s = store(), dir = tmp();
    project(s, "p"); glob(s, `${dir}/zzdebris-*`);
    for (let i = 0; i < 10; i++) { writeFileSync(join(dir, `zzdebris-${i}`), "x"); aged(join(dir, `zzdebris-${i}`), AT - 72 * 3600); }
    let yielded = 0;
    const dirs: DirReader = (d) => d !== dir ? streamDir(d) : (async function* () {
      for (let i = 0; i < 100_000; i++) { yielded++; yield i % 10_000 === 0 ? `zzdebris-${i / 10_000}` : `other-${i}`; }
    })();
    const r = await scanCleanup(s, AT, opts({ proc: fakeProc([]), tmpRoot: tmp(), dirs }));
    expect(yielded).toBe(100_000);
    expect(rows(r, "e")).toHaveLength(1);
    expect(rows(r, "e")[0]).toMatchObject({ project: "p", key: `${dir}/zzdebris-*`, path: dir, facts: { count: 10, removable: 10, too_new: 0 } });
    expect((rows(r, "e")[0].facts.sample as string[]).length).toBe(10);
  });

  test("a file newer than cleanup_tmp_age_h is too new; another uid's is not ours; a held one is in use", async () => {
    const s = store(), dir = tmp();
    project(s, "p"); glob(s, `${dir}/zzdebris-*`);
    for (const n of ["old", "new", "held"]) writeFileSync(join(dir, `zzdebris-${n}`), "x");
    aged(join(dir, "zzdebris-old"), AT - 49 * 3600); aged(join(dir, "zzdebris-held"), AT - 49 * 3600);
    const proc = fakeProc([{ pid: 55, cwd: "/home", fds: [join(dir, "zzdebris-held")] }]);
    const r = await scanCleanup(s, AT, opts({ proc, tmpRoot: tmp() }));
    expect(rows(r, "e")[0].facts).toMatchObject({ count: 3, removable: 1, too_new: 1, in_use: 1, in_use_pid: 55, not_ours: 0 });
    const other = await scanCleanup(s, AT, opts({ proc, tmpRoot: tmp(), uid: UID + 1 }));
    expect(rows(other, "e")[0].facts).toMatchObject({ count: 3, not_ours: 3, removable: 0 });
  });

  test("100,000 matching files give one row with count 100,000", async () => {
    const s = store(), dir = tmp();
    project(s, "p"); glob(s, `${dir}/zzdebris-*`);
    for (let i = 0; i < 100_000; i++) writeFileSync(join(dir, `zzdebris-${i}`), "");
    const r = await scanCleanup(s, AT, opts({ proc: fakeProc([]), tmpRoot: tmp() }));
    expect(rows(r, "e").map((x) => [x.key, x.facts.count])).toEqual([[`${dir}/zzdebris-*`, 100_000]]);
  }, 60_000);
});

describe("the write and the schedule (KTD4)", () => {
  test("first_seen stays while a row stays; a row not seen gets gone_at; one back from gone starts over", async () => {
    const s = store(), ws = tmp(), root = tmp();
    project(s, "p");
    observedWt(s, "p", "g", `${ws}/ds-p-gone`, AT - 900);
    const dir = join(root, mangle(`${ws}/ds-p-gone`));
    mkdirSync(dir);
    const o = opts({ proc: fakeProc([]), tmpRoot: root });
    writeCleanup(s, await scanCleanup(s, AT, o));
    writeCleanup(s, await scanCleanup(s, AT + 3600, o));
    expect(db(s).map((x) => [x.class, x.first_seen, x.gone_at])).toEqual([["b", AT, null]]);
    Bun.spawnSync(["rmdir", dir]);
    writeCleanup(s, await scanCleanup(s, AT + 7200, o));
    expect(db(s).map((x) => x.gone_at)).toEqual([AT + 7200]);
    mkdirSync(dir);
    writeCleanup(s, await scanCleanup(s, AT + 10_800, o));
    expect(db(s).map((x) => [x.first_seen, x.gone_at])).toEqual([[AT + 10_800, null]]);
  });

  test("a due tick starts the scan off the tick; a second run while it is in flight starts no second scan; the next tick writes it", async () => {
    const s = store();
    project(s, "p");
    let calls = 0, release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const ob = cleanupObserver(opts({ proc: fakeProc([]), tmpRoot: tmp(), ps: async () => { calls++; await gate; return []; } }));
    const ctx = (now: number) => ({ store: s, project: "", tick: 1, now, fired: [], poked: new Set<string>() });
    ob.run(ctx(AT));
    ob.run(ctx(AT + 5));
    expect(calls).toBe(1);
    release();
    await ob.idle();
    expect(s.db.query("SELECT COUNT(*) AS n FROM observed_cleanup_scan").get()).toEqual({ n: 0 });
    ob.run(ctx(AT + 10));
    expect(s.db.query("SELECT started_at, ps_error FROM observed_cleanup_scan").get()).toEqual({ started_at: AT, ps_error: "was empty" });
    expect(calls).toBe(1);                                     // not due again until DS_LOOP_CLEANUP_S
    ob.run(ctx(AT + 3600)); await ob.idle();
    expect(calls).toBe(2);
  });
});
