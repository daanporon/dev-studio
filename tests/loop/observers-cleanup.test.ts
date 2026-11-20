// observers-cleanup.test.ts — host-disk-cleanup U2: the cleanup observer's raw facts per class on
// fixture roots (fake /proc, fake Claude temp root, temp git clones, a fake backend list), the
// write's row lifecycle, and the off-tick scan with its in-flight guard.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupObserver, measureCleanup, scanCleanup, writeCleanup, writeSizes, type CleanupScan } from "../../bin/loop/observers/cleanup.ts";
import { cardText } from "../../bin/loop/fulfil/cleanup.ts";
import type { Du } from "../../bin/loop/io/du.ts";
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

describe("the measuring pass (investigate-disk-cleanup U1)", () => {
  const glob = (s: Store, g: string) => s.upsert("config", { project: "p", file: "limits.conf", key: "cleanup_tmp_globs" }, { value: g, observed_at: 1 });
  const seed = (s: Store, cls: string, key: string, kb: number, facts: Record<string, unknown>) =>
    s.db.query(`INSERT INTO observed_cleanup (project, class, key, path, size_kb, first_seen, facts, observed_at) VALUES ('p', ?, ?, ?, ?, ?, ?, ?)`)
      .run(cls, key, key, kb, AT, JSON.stringify(facts), AT);
  const row = (s: Store, cls: string) => {
    const r = s.db.query("SELECT size_kb, facts FROM observed_cleanup WHERE class = ?").get(cls) as { size_kb: number; facts: string };
    return { kb: r.size_kb, facts: JSON.parse(r.facts) as Record<string, unknown> };
  };
  const realDu = (p: string) => Number(Bun.spawnSync(["du", "-sk", p]).stdout.toString().split("\t")[0]);
  const folder = (d: string, subdirs: number, files: number) => {
    mkdirSync(d);
    for (let i = 0; i < subdirs; i++) { mkdirSync(join(d, `s${i}`)); for (let j = 0; j < files; j++) writeFileSync(join(d, `s${i}`, `f${j}`), "x"); }
  };

  test("a class e glob matching a folder of 3,000 files: the scan counts its inode and marks it partial; one pass sizes it like du -sk", async () => {
    const s = store(), dir = tmp();
    project(s, "p"); glob(s, `${dir}/zzcache-*`);
    folder(join(dir, "zzcache-a"), 30, 100);
    writeFileSync(join(dir, "zzcache-f"), "x".repeat(10_000));
    const scan = await scanCleanup(s, AT, opts({ proc: fakeProc([]), tmpRoot: tmp() }));
    expect(rows(scan, "e")[0].facts).toMatchObject({ count: 2, dirs: 1, partial: true });
    writeCleanup(s, scan);
    const walk = row(s, "e").kb;
    writeSizes(s, await measureCleanup(s), AT + 5);
    const want = realDu(join(dir, "zzcache-a")) + realDu(join(dir, "zzcache-f"));
    const got = row(s, "e");
    expect(walk).toBeLessThan(want / 10);
    expect(Math.abs(got.kb - want) / want).toBeLessThan(0.05);
    expect(got.facts).toMatchObject({ size_from: "du", size_at: AT + 5, partial: true, count: 2 });
    expect(cardText(s, "p")).toContain(`(${(got.kb / 1024).toFixed(1)} MB)`);
    expect(cardText(s, "p")).not.toContain("≥");
  }, 30_000);

  test("largest first, one du at a time, each capped by what is left of the pass; the pass stops at its cap; whole rows only", async () => {
    const s = store(), d = tmp();
    for (const [n, kb] of [["small", 100], ["big", 900], ["mid", 500]] as const) { mkdirSync(join(d, n)); seed(s, "c", join(d, n), kb, { partial: true }); }
    mkdirSync(join(d, "whole")); seed(s, "d", join(d, "whole"), 5000, { partial: false });
    seed(s, "a", "1:1", 9999, { partial: true });
    const calls: [string, number][] = [];
    let running = 0, most = 0;
    const du: Du = async (p, t) => { calls.push([p, t]); most = Math.max(most, ++running); await Bun.sleep(600); running--; return { kb: 7 }; };
    const out = await measureCleanup(s, { du, duS: 50, duTotalS: 1 });
    expect(calls).toEqual([[join(d, "big"), 1], [join(d, "mid"), 1]]);
    expect(most).toBe(1);
    expect(out.map((m) => m.key)).toEqual([join(d, "big"), join(d, "mid")]);
  });

  test("a row measured before waits behind every unmeasured one; a later failed du makes its size read ≥ again", async () => {
    const s = store(), d = tmp();
    project(s, "p");
    mkdirSync(join(d, "known")); seed(s, "d", join(d, "known"), 9000, { partial: true, size_from: "du", size_at: AT });
    mkdirSync(join(d, "new")); seed(s, "c", join(d, "new"), 100, { partial: true });
    const calls: string[] = [];
    const out = await measureCleanup(s, { du: async (p) => { calls.push(p); return p.endsWith("known") ? { error: "du exited 1" } : { kb: 50 }; } });
    expect(calls).toEqual([join(d, "new"), join(d, "known")]);
    writeSizes(s, out, AT + 5);
    expect(row(s, "d")).toEqual({ kb: 9000, facts: { partial: true, size_at: AT, size_error: "du exited 1" } });
    expect(cardText(s, "p")).toContain(`≥ 8.8 MB · ${join(d, "known")}`);
  });

  test("a du past DS_LOOP_CLEANUP_DU_S is killed: the walk's size stays with size_error, and the card still reads ≥", async () => {
    const s = store(), d = tmp(), bin = join(tmp(), "bin");
    project(s, "p");
    mkdirSync(join(d, "slow")); seed(s, "c", join(d, "slow"), 2048, { partial: true });
    mkdirSync(bin); writeFileSync(join(bin, "du"), "#!/bin/sh\nexec sleep 30\n"); chmodSync(join(bin, "du"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    const t0 = performance.now();
    let out;
    try { out = await measureCleanup(s, { duS: 1 }); } finally { process.env.PATH = path; }
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(out).toEqual([{ project: "p", class: "c", key: join(d, "slow"), error: "du timed out after 1 s" }]);
    writeSizes(s, out, AT + 5);
    expect(row(s, "c")).toEqual({ kb: 2048, facts: { partial: true, size_error: "du timed out after 1 s" } });
    expect(cardText(s, "p")).toContain(`≥ 2.0 MB · ${join(d, "slow")}`);
  });

  test("a path gone before its du or during it is skipped; a row gone before the write keeps its old size", async () => {
    const s = store(), d = tmp();
    for (const n of ["before", "during", "after"]) { mkdirSync(join(d, n)); seed(s, "d", join(d, n), 10, { partial: true }); }
    rmSync(join(d, "before"), { recursive: true });
    const du: Du = async (p) => { if (p.endsWith("during")) { rmSync(p, { recursive: true }); return { error: "du exited 1" }; } return { kb: 4242 }; };
    const out = await measureCleanup(s, { du });
    expect(out).toEqual([{ project: "p", class: "d", key: join(d, "after"), kb: 4242 }]);
    s.db.query("UPDATE observed_cleanup SET gone_at = ? WHERE key = ?").run(AT + 1, join(d, "after"));
    writeSizes(s, out, AT + 5);
    expect(s.db.query("SELECT key, size_kb FROM observed_cleanup ORDER BY key").all()).toEqual(
      ["after", "before", "during"].map((n) => ({ key: join(d, n), size_kb: 10 })));
  });

  test("the next scan keeps the measured size while the walk is still under it, and drops it once the walk passes it", async () => {
    const s = store(), ws = tmp(), root = tmp();
    project(s, "p");
    observedWt(s, "p", "g", `${ws}/ds-p-g`, AT - 900);
    const dir = join(root, mangle(`${ws}/ds-p-g`)); mkdirSync(dir); writeFileSync(join(dir, "out"), "x".repeat(8192)); writeFileSync(join(dir, "out2"), "x");
    const o = opts({ proc: fakeProc([]), tmpRoot: root, tmpSizeEntries: 2 });            // the folder and one file: partial
    writeCleanup(s, await scanCleanup(s, AT, o));
    writeSizes(s, await measureCleanup(s, { du: async () => ({ kb: 999_999 }) }), AT + 5);
    writeCleanup(s, await scanCleanup(s, AT + 3600, o));
    expect(row(s, "b")).toMatchObject({ kb: 999_999, facts: { partial: true, size_from: "du", size_at: AT + 5 } });
    writeSizes(s, await measureCleanup(s, { du: async () => ({ kb: 1 }) }), AT + 3605);   // under the walk's 8 kB
    writeCleanup(s, await scanCleanup(s, AT + 7200, o));
    const r = row(s, "b");
    expect(r.kb).toBeGreaterThan(0);
    expect(r.facts.size_from).toBeUndefined();
  });

  test("through the observer: the tick that writes a scan starts its pass, a later tick writes its sizes, and no scan starts meanwhile", async () => {
    const s = store(), d = tmp();
    project(s, "p");
    let release: () => void = () => {}, scans = 0;
    const gate = new Promise<void>((r) => { release = r; });
    mkdirSync(join(d, "x"));
    const ob = cleanupObserver(opts({ proc: fakeProc([]), tmpRoot: tmp(), ps: async () => { scans++; return []; },
      du: async () => { await gate; return { kb: 31_337 }; } }));
    const ctx = (now: number) => ({ store: s, project: "", tick: 1, now, fired: [], poked: new Set<string>() });
    ob.run(ctx(AT)); await Bun.sleep(50);
    seed(s, "d", join(d, "x"), 10, { partial: true });       // as if the scan had found it
    ob.run(ctx(AT + 1));                                      // writes the scan (an empty backend list keeps class d rows), starts the pass
    ob.run(ctx(AT + 3601));                                   // due, but the pass is in flight
    expect(scans).toBe(1);
    release(); await ob.idle();
    ob.run(ctx(AT + 3602));
    expect(row(s, "d")).toMatchObject({ kb: 31_337, facts: { size_from: "du", size_at: AT + 3602 } });
    await ob.idle();
    expect(scans).toBe(2);
  });
});
