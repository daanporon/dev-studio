// cleanup-apply.test.ts — host-disk-cleanup U3: host_tidy apply. The reconciler asks for one
// cleanup.act at a time (only on exactly `apply`, never while paused); the fulfiller reads reality
// again before each removal and writes one event per action. Every root is a fixture: a fake /proc,
// a temp Claude temp root, temp clones; signals go to a recorder, never to a real pid.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LoopActuator, type Exec } from "../../bin/loop/core/actuator.ts";
import cardFulfiller, { cardText } from "../../bin/loop/fulfil/cleanup.ts";
import { cleanupAct, CLEANUP_ACT, type ActOpts } from "../../bin/loop/fulfil/cleanup-act.ts";
import type { Out, Via } from "../../bin/loop/io/orca.ts";
import { pause } from "../../bin/loop/pause/pause.ts";
import type { Action } from "../../bin/loop/core/plugins.ts";
import cleanupReconciler, { reconcile } from "../../bin/loop/reconcilers/cleanup.ts";
import type { Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { inUse } from "../../bin/loop/io/tidy.ts";
import { clone, fakeProc, git, project, store, tmp, UID, worktree } from "./cleanup-fixture.ts";

const NOW = Math.floor(Date.now() / 1000), H = 3600;
const age = (p: string, at: number) => utimesSync(p, at, at);

type Seed = { class: string; key: string; path?: string | null; mtime?: number | null; size?: number; orphaned?: number | null; facts?: Record<string, unknown> };
function seed(s: Store, r: Seed): void {
  s.db.query(`INSERT INTO observed_cleanup (project, class, key, path, size_kb, mtime, first_seen, orphaned_since, verdict, facts, observed_at)
    VALUES ('p', ?, ?, ?, ?, ?, ?, ?, 'removable', ?, ?)`).run(r.class, r.key, r.path === undefined ? r.key : r.path, r.size ?? 10, r.mtime ?? null,
    NOW - 30 * H, r.orphaned ?? NOW - 30 * H, JSON.stringify(r.facts ?? {}), NOW - 60);
  s.db.query("INSERT OR REPLACE INTO observed_cleanup_scan (host, started_at, ms, entries, ps_error, loose_count, loose_kb, observed_at) VALUES ('h', ?, 1, 1, NULL, 0, 0, ?)").run(NOW - 60, NOW - 60);
}
// The cleanup keys are host keys (U25): this host's override, never a project row.
const setLimit = (s: Store, key: string, value: string) => s.upsert("host_config", { host: "local", key }, { value, set_at: 1 });
let tickNo = 0;
const ctx = (s: Store, now = NOW) => ({ store: s, project: "p", tick: ++tickNo, now, fired: [], poked: new Set<string>() });
const acts = (s: Store, now = NOW) => reconcile(ctx(s, now), UID).filter((a) => a.kind === CLEANUP_ACT);
const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
const row = (s: Store, key: string) => s.db.query("SELECT * FROM observed_cleanup WHERE key = ?").get(key) as Record<string, unknown> & { facts: string };

// The backend: worktree-rm and terminal-close-worktree recorded, worktree-rm answering `rm`.
function backend(rm: Out = { code: 0, out: "", err: "" }) {
  const calls: string[] = [];
  return { calls, orca: { async run(op: string, args: string[], _via?: Via): Promise<Out> { calls.push(`${op} ${args.join(" ")}`); return op === "worktree-rm" ? rm : { code: 0, out: "", err: "" }; } } };
}
async function exec(s: Store, a: Action, o: ActOpts, b = backend(), now = NOW): Promise<{ done?: boolean; result?: string; wait?: string; dropped?: string }> {
  const x = { ...ctx(s, now), act: { orca: b.orca, childActivity: () => ({}) } } as unknown as Exec;
  const r = await cleanupAct(o).exec(a, x);
  return "background" in r ? (await r.background) as never : r as never;
}
const act = (cls: string, key: string, path: string | null = key): Action =>
  ({ project: "p", subject: `cleanup.act:${cls}:${key}`, kind: CLEANUP_ACT, episode: "1", payload: { class: cls, key, path } });

// A Claude temp dir 49 hours old under a fixture temp root, as the scan would have recorded it.
function tempDir(s: Store) {
  const root = tmp(), slug = "-w-ds-p-u1", dir = join(root, slug);
  mkdirSync(dir); writeFileSync(join(dir, "f"), "x".repeat(5000));
  age(join(dir, "f"), NOW - 49 * H); age(dir, NOW - 49 * H);
  seed(s, { class: "b", key: dir, mtime: NOW - 49 * H, facts: { slug, slug_wt: null, wt: "/nowhere/ds-p-u1", uid: UID, holder: null, partial: false } });
  return { root, dir, proc: fakeProc([]) };
}
function fixture(mode: string | null = "apply"): Store {
  const s = store();
  project(s, "p");
  if (mode !== null) setLimit(s, "host_tidy", mode);
  return s;
}

describe("the act action (R4, KTD9)", () => {
  test("only exactly `apply` asks for a removal; report, unset and `Apply` ask for none and remove nothing (AE6)", async () => {
    for (const mode of ["report", null, "Apply", "apply-ish"]) {
      const s = fixture(mode), t = tempDir(s);
      expect(acts(s)).toEqual([]);
      expect(await exec(s, act("b", t.dir), { proc: t.proc, tmpRoot: t.root, uid: UID })).toEqual({ done: true, result: "kept: host_tidy is not apply" });
      expect(existsSync(t.dir)).toBe(true);
    }
    const s = fixture(), t = tempDir(s);
    expect(acts(s)).toMatchObject([{ subject: `cleanup.act:b:${t.dir}`, payload: { class: "b", key: t.dir, path: t.dir } }]);
  });

  test("one at a time per project, processes first then largest; a waiting one is asked for again; a settled episode is not", () => {
    const s = fixture();
    const tmpFacts = (slug: string) => ({ slug, slug_wt: null, wt: `/nowhere/${slug}`, uid: UID, holder: null, partial: false });
    seed(s, { class: "b", key: "/t/small", size: 1, mtime: NOW - 49 * H, facts: tmpFacts("small") });
    seed(s, { class: "b", key: "/t/big", size: 900, mtime: NOW - 49 * H, facts: tmpFacts("big") });
    seed(s, { class: "a", key: "7:1", path: "/w/ds-p-u1", size: 0 });
    const [first] = acts(s);
    expect(first.subject).toBe("cleanup.act:a:7:1");
    const claim = (a: Action, state: string, more: Record<string, unknown> = {}) => s.upsert("episodes", { project: "p", subject: a.subject, kind: `action:${CLEANUP_ACT}` },
      { episode_key: a.episode, state, action: JSON.stringify({ action: a, tries: 0 }), source: "loop", observed_at: 1, ended_at: null, ...more });
    claim(first, "running");
    expect(acts(s)).toEqual([]);
    claim(first, "pending", { next_at: NOW });
    expect(acts(s).map((a) => a.subject)).toEqual([first.subject]);
    claim(first, "done", { ended_at: NOW });
    expect(acts(s).map((a) => a.subject)).toEqual(["cleanup.act:b:/t/big"]);
  });

  test("a refused project asks for none", () => {
    const s = fixture();
    s.upsert("squads", { project: "p", topic: "q" }, { status: "running", observed_at: 1, updated_at: 1 });
    seed(s, { class: "b", key: "/t/old", mtime: NOW - 49 * H, facts: { uid: UID } });
    expect(acts(s)).toEqual([]);
  });
});

describe("a removal reads reality again (R11)", () => {
  test("apply: a removable temp dir is gone after one pass, with exactly one cleanup_removed event and the card's totals", async () => {
    const s = fixture(), t = tempDir(s);
    const [a] = acts(s);
    expect(await exec(s, a, { proc: t.proc, tmpRoot: t.root, uid: UID })).toEqual({ done: true, result: "removed" });
    expect(existsSync(t.dir)).toBe(false);
    const ev = events(s, "cleanup_removed");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ class: "b", path: t.dir, reason: "untouched 48h, no live member, no open file" });
    expect(ev[0].kb).toBeGreaterThan(0);
    expect(row(s, t.dir).gone_at).toBe(NOW);
  });

  test("paused project (AE5): no action asked for; one already claimed waits, nothing changes, no event", async () => {
    const s = fixture(), t = tempDir(s);
    const [a] = acts(s);
    pause(s, { scope: "project", project: "p" }, {}, NOW);
    expect(acts(s)).toEqual([]);
    expect(await exec(s, a, { proc: t.proc, tmpRoot: t.root, uid: UID })).toEqual({ wait: "paused" });
    expect(existsSync(t.dir)).toBe(true);
    expect(events(s, "cleanup_removed")).toEqual([]);
    expect(cardText(s, "p", { now: NOW })).toContain(t.dir);
  });

  test("a file opened under the dir before exec (AE1): kept, the result names the pid", async () => {
    const s = fixture(), t = tempDir(s);
    const proc = fakeProc([{ pid: 4242, cwd: "/", fds: [join(t.dir, "f")] }]);
    expect(await exec(s, act("b", t.dir), { proc, tmpRoot: t.root, uid: UID })).toEqual({ done: true, result: "kept: in use by pid 4242" });
    expect(existsSync(t.dir)).toBe(true);
    expect(row(s, t.dir).verdict).toBe("in use by pid 4242");
  });

  test("a member row appears for an orphan entity before exec: kept, the backend is never called", async () => {
    const s = fixture(), id = "r::/w/ds-p-u9";
    seed(s, { class: "d", key: `entity:${id}`, path: "/w/ds-p-u9", facts: { entity: id, wt_id: id, wt: "/w/ds-p-u9", exists: false, probe: null } });
    s.upsert("members", { project: "p", squad: "q", role: "builder", suffix: "u9" }, { wt: id, status: "running", observed_at: 1, updated_at: 1 });
    const b = backend();
    expect(await exec(s, act("d", `entity:${id}`, "/w/ds-p-u9"), { proc: fakeProc([]), ps: async () => [{ worktreeId: id, path: "/w/ds-p-u9" }] }, b))
      .toEqual({ done: true, result: "kept: live member" });
    expect(b.calls).toEqual([]);
  });

  test("an orphan entity: its terminals closed, then worktree-rm; a refused worktree-rm is cleanup_failed and the card names it", async () => {
    const s = fixture(), id = "r::/w/ds-p-u8", key = `entity:${id}`;
    seed(s, { class: "d", key, path: "/w/ds-p-u8", facts: { entity: id, wt_id: id, wt: "/w/ds-p-u8", exists: false, probe: null } });
    const o = { proc: fakeProc([]), ps: async () => [{ worktreeId: id, path: "/w/ds-p-u8" }] };
    const b = backend({ code: 1, out: "", err: "worktree busy" });
    expect(await exec(s, act("d", key, "/w/ds-p-u8"), o, b)).toEqual({ done: true, result: "failed: worktree busy" });
    expect(b.calls).toEqual([`terminal-close-worktree id:${id}`, `worktree-rm id:${id}`]);
    expect(events(s, "cleanup_failed")).toMatchObject([{ class: "d", key, error: "worktree busy" }]);
    const card = cardText(s, "p", { now: NOW })!;
    expect(card).toContain("failed: worktree busy");
    expect(card).toContain("Last 24 hours: removed 0 (0 kB), stopped 0 processes, failed 1.");
    const ok = backend();
    expect(await exec(s, act("d", key, "/w/ds-p-u8"), o, ok)).toEqual({ done: true, result: "removed" });
    expect(ok.calls).toEqual([`terminal-close-worktree id:${id}`, `worktree-rm id:${id}`]);
  });

  test("an entity whose checkout gains an untracked file before exec: no worktree-rm", async () => {
    const s = fixture(), { repo, root } = clone(), path = worktree(repo, join(root, "ds-p-u7"), "u7"), id = `r::${path}`;
    seed(s, { class: "d", key: `entity:${id}`, path, facts: { entity: id, wt_id: id, wt: path, exists: true, probe: { dirty: 0, unpushed: 0, unique: 0, detached: false } } });
    writeFileSync(join(path, "new.txt"), "x");
    const b = backend();
    expect(await exec(s, act("d", `entity:${id}`, path), { proc: fakeProc([]), ps: async () => [{ worktreeId: id, path }] }, b)).toEqual({ done: true, result: "kept: dirty" });
    expect(b.calls).toEqual([]);
  });
});

describe("helper checkouts (class c)", () => {
  function helper() {
    const { repo } = clone(), path = worktree(repo, join(repo, ".claude", "worktrees", "h1"), "h1");
    // A commit on the helper's branch whose patch main already has (AE3: patch-equal, so nothing unique).
    writeFileSync(join(path, "b.txt"), "b\n"); git(path, "add", "b.txt"); git(path, "commit", "-qm", "b");
    git(repo, "cherry-pick", "h1"); git(repo, "push", "-q", "origin", "main");
    return { repo, path };
  }
  const facts = { branch: "h1", locked: false, detached: false, exists: true, probe: { dirty: 0, unpushed: 1, unique: 0, detached: false } };

  test("patch-equal (AE3): the worktree is removed without force and its branch stays", async () => {
    const s = fixture(), { repo, path } = helper();
    seed(s, { class: "c", key: path, facts });
    expect(await exec(s, act("c", path), { proc: fakeProc([]) })).toEqual({ done: true, result: "removed" });
    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", "h1").trim()).toBe("h1");
    expect(events(s, "cleanup_removed")).toMatchObject([{ class: "c", path, branch: "h1" }]);
  });

  test("an untracked file appears before exec: git worktree remove is not run", async () => {
    const s = fixture(), { repo, path } = helper();
    seed(s, { class: "c", key: path, facts });
    writeFileSync(join(path, "scratch.txt"), "x");
    expect(await exec(s, act("c", path), { proc: fakeProc([]) })).toEqual({ done: true, result: "kept: dirty" });
    expect(existsSync(join(path, "scratch.txt"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(path);
  });
});

describe("processes (class a)", () => {
  const proc = (start: number) => fakeProc([{ pid: 4243, ppid: 1, start, cwd: "/w/ds-p-u5/sub (deleted)" }]);
  const facts = { cwd: "/w/ds-p-u5/sub", deleted: true, wt: "/w/ds-p-u5", wt_gone_at: NOW - 20 * 60 };

  test("the pid's start time changed before exec: not signalled, the row is gone", async () => {
    const s = fixture(), sent: string[] = [];
    seed(s, { class: "a", key: "4243:500", path: "/w/ds-p-u5", facts });
    const r = await exec(s, act("a", "4243:500", "/w/ds-p-u5"), { proc: proc(600), kill: (pid, sig) => sent.push(`${pid} ${sig}`), waitMs: 0 });
    expect(r).toEqual({ done: true, result: "kept: the process is gone" });
    expect(sent).toEqual([]);
  });

  test("the same start time: TERM then KILL to the recorder, one cleanup_stopped with its pid", async () => {
    const s = fixture(), sent: string[] = [];
    seed(s, { class: "a", key: "4243:500", path: "/w/ds-p-u5", facts });
    const r = await exec(s, act("a", "4243:500", "/w/ds-p-u5"), { proc: proc(500), kill: (pid, sig) => sent.push(`${pid} ${sig}`), waitMs: 0 });
    expect(r).toEqual({ done: true, result: "stopped" });
    expect(sent).toEqual(["4243 SIGTERM", "4243 SIGKILL"]);
    expect(events(s, "cleanup_stopped")).toMatchObject([{ class: "a", pids: [4243], killed: [4243] }]);
  });
});

describe("glob files (class e, KTD9)", () => {
  // `now` is read after the matches exist: NOW is fixed when the file loads, and an entry made after
  // NOW + 10 (a slow runner, after the 60,000-file test) would be newer than the age floor.
  function globDir(s: Store, n: number, more?: (dir: string) => void) {
    const dir = tmp(), glob = join(dir, "zzdebris-*");
    for (let i = 0; i < n; i++) writeFileSync(join(dir, `zzdebris-${i}`), "");
    if (more) { more(dir); n += 1; }
    setLimit(s, "cleanup_tmp_globs", glob); setLimit(s, "cleanup_tmp_age_h", "0");
    seed(s, { class: "e", key: glob, path: dir, facts: { count: n, removable: n, too_new: 0, not_ours: 0, in_use: 0 } });
    return { dir, glob, now: Math.floor(Date.now() / 1000) + 10 };
  }

  test("60,000 matches: the first pass removes 50,000 with one event, the next episode the rest; the event loop is never held a second", async () => {
    const s = fixture(), { dir, glob, now } = globDir(s, 60_000), o = { proc: fakeProc([]), uid: UID };
    let lag = 0, last = performance.now();
    const timer = setInterval(() => { const t = performance.now(); lag = Math.max(lag, t - last - 20); last = t; }, 20);
    try {
      const [first] = acts(s, now);
      expect(await exec(s, first, o, backend(), now)).toEqual({ done: true, result: "removed 50000 (capped)" });
      s.upsert("episodes", { project: "p", subject: first.subject, kind: `action:${CLEANUP_ACT}` }, { episode_key: first.episode, state: "done", source: "loop", ended_at: NOW, observed_at: 1 });
      const [second] = acts(s, now);
      expect(second.episode).not.toBe(first.episode);
      expect(await exec(s, second, o, backend(), now)).toEqual({ done: true, result: "removed 10000" });
    } finally { clearInterval(timer); }
    expect(readdirSync(dir)).toEqual([]);
    expect(events(s, "cleanup_removed").map((e) => [e.glob, e.count, e.sample.length])).toEqual([[glob, 50_000, 20], [glob, 10_000, 20]]);
    expect(lag).toBeLessThan(1000);
    expect(acts(s, now)).toEqual([]);
  }, 180_000);

  test("a matching symlink that points outside the root: the link is removed, its target is untouched", async () => {
    const s = fixture(), target = join(tmp(), "keep.txt");
    writeFileSync(target, "keep");
    const { dir, now } = globDir(s, 0, (d) => symlinkSync(target, join(d, "zzdebris-link")));
    const [a] = acts(s, now);
    expect(await exec(s, a, { proc: fakeProc([]), uid: UID }, backend(), now)).toEqual({ done: true, result: "removed 1" });
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });
});

describe("trimmed folders (class f, investigate-disk-cleanup U2)", () => {
  // <dir>/zzcache-v1/ with `old` files 72 h old and `fresh` ones just written; the row as the scan wrote it.
  function cacheDir(s: Store, old: number, fresh: number) {
    const dir = tmp(), folder = join(dir, "zzcache-v1"), glob = join(dir, "zzcache-*");
    mkdirSync(folder);
    for (let i = 0; i < old; i++) { writeFileSync(join(folder, `old-${i}`), "x"); age(join(folder, `old-${i}`), NOW - 72 * H); }
    for (let i = 0; i < fresh; i++) writeFileSync(join(folder, `fresh-${i}`), "x");
    setLimit(s, "cleanup_trim_globs", glob);
    seed(s, { class: "f", key: glob, path: dir, facts: { folders: 1, count: old + fresh, removable: old, too_new: fresh, not_ours: 0, in_use: 0 } });
    return { dir, folder, glob };
  }

  test("1,000 old files, 10 fresh, 1 old one held open: one pass removes exactly the 1,000, one class f event; the folder stays", async () => {
    const s = fixture(), { folder, glob } = cacheDir(s, 1000, 10), held = join(folder, "held");
    writeFileSync(held, "x"); age(held, NOW - 72 * H);
    const [a] = acts(s);
    expect(a).toMatchObject({ subject: `cleanup.act:f:${glob}`, payload: { class: "f", key: glob } });
    expect(await exec(s, a, { proc: fakeProc([{ pid: 77, cwd: "/home", fds: [held] }]), uid: UID })).toEqual({ done: true, result: "removed 1000" });
    expect(readdirSync(folder).sort()).toEqual([...Array.from({ length: 10 }, (_, i) => `fresh-${i}`), "held"].sort());
    expect(events(s, "cleanup_removed").map((e) => [e.class, e.glob, e.count, e.capped])).toEqual([["f", glob, 1000, false]]);
    expect(JSON.parse(row(s, glob).facts)).toMatchObject({ removable: 0, count: 10 }); // the seeded 1,010 less the removed
  }, 60_000);

  test("a capped pass asks for the next one under a new episode, which removes the rest", async () => {
    const s = fixture(), { folder } = cacheDir(s, 30, 0), o = { proc: fakeProc([]), uid: UID, batch: 20 };
    const [first] = acts(s);
    expect(await exec(s, first, o)).toEqual({ done: true, result: "removed 20 (capped)" });
    s.upsert("episodes", { project: "p", subject: first.subject, kind: `action:${CLEANUP_ACT}` }, { episode_key: first.episode, state: "done", source: "loop", ended_at: NOW, observed_at: 1 });
    const [second] = acts(s);
    expect(second.episode).not.toBe(first.episode);
    expect(await exec(s, second, o)).toEqual({ done: true, result: "removed 10" });
    expect([readdirSync(folder), existsSync(folder)]).toEqual([[], true]);
  });

  test("report: no act asked for and nothing trimmed, the row reads removable; a glob taken out of the key trims nothing", async () => {
    const s = fixture("report"), { folder, glob } = cacheDir(s, 3, 0);
    expect(acts(s)).toEqual([]);
    expect(await exec(s, act("f", glob), { proc: fakeProc([]), uid: UID })).toEqual({ done: true, result: "kept: host_tidy is not apply" });
    expect(cardText(s, "p")).toContain(`Trim ${glob}: 1 folder kept, 3 entries inside`);
    setLimit(s, "host_tidy", "apply"); setLimit(s, "cleanup_trim_globs", "-");
    expect((await exec(s, act("f", glob), { proc: fakeProc([]), uid: UID })).result).toContain("no longer configured");
    expect(readdirSync(folder)).toHaveLength(3);
  });
});

describe("through the loop", () => {
  test("one tick removes; the same episode acted again is a no-op; the card shows the totals without the removed row", async () => {
    const s = fixture(), t = tempDir(s), b = backend();
    const fulfillers = [cardFulfiller, cleanupAct({ proc: t.proc, tmpRoot: t.root, uid: UID, inUse })];
    const actuator = new LoopActuator({ orca: b.orca, fulfillers });
    const loop = new Loop(s, { observers: [], reconcilers: [cleanupReconciler] }, actuator, { projects: () => ["p"] });
    const one = await loop.tick(NOW);
    await actuator.drain();
    expect(one.acted.map((a) => a.kind).sort()).toEqual([CLEANUP_ACT, "cleanup.report"]);
    expect(existsSync(t.dir)).toBe(false);
    const two = await loop.tick(NOW + 5);
    await actuator.drain();
    expect(two.acted.filter((a) => a.kind === CLEANUP_ACT)).toEqual([]);
    expect(events(s, "cleanup_removed")).toHaveLength(1);
    const card = cardText(s, "p", { now: NOW });
    expect(card === null || !card.includes(t.dir)).toBe(true);
  });
});
