// observers-update.test.ts — the dev-studio update observer on a temp bare origin + clone: behind 0, behind with
// classes and need, ahead + dirty, detached, a branch gone from origin, an unreachable origin keeping the last
// good counts, a slow fetch that does not block run(), squads-rev.json behind HEAD, and the outcome file.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { gitIn, updateObserver, type Git } from "../../bin/loop/observers/update.ts";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzupd-")); temps.push(d); return d; };
const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
function put(repo: string, path: string, text: string) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); }
function commit(repo: string, title: string, ...paths: string[]) {
  for (const p of paths) put(repo, p, `${title} ${Math.random()}\n`);
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", title);
  return sh(repo, "rev-parse", "HEAD");
}
// origin (bare) + the checkout under test + a second clone that pushes new commits to origin.
function fixture() {
  const base = tmp(), origin = join(base, "origin.git"), co = join(base, "co"), other = join(base, "other");
  sh(base, "init", "-q", "--bare", "-b", "main", origin);
  sh(base, "clone", "-q", origin, co); sh(co, "checkout", "-q", "-b", "main");
  commit(co, "first", "bin/a.ts"); sh(co, "push", "-q", "-u", "origin", "main");
  sh(base, "clone", "-q", origin, other);
  return { base, origin, co, other, push: (title: string, ...p: string[]) => { const r = commit(other, title, ...p); sh(other, "push", "-q", "origin", "main"); return r; } };
}
function run(root: string, state = tmp(), opts: { git?: Git; budgetMs?: number } = {}) {
  const s = open(state); stores.push(s);
  const l = new Loop(s, { observers: [updateObserver(root, opts)], reconcilers: [] }, { act() {} }, { projects: () => [] });
  return { s, l, state };
}
const row = (s: Store) => s.db.query("SELECT * FROM observed_update").get() as Row | null;
const j = (v: unknown) => JSON.parse(v as string);
describe("update observer", () => {
  test("behind 0 on a current checkout", async () => {
    const f = fixture(), { s, l } = run(f.co);
    l.boot(1000); await l.tick(1000);
    expect(row(s)).toMatchObject({ branch: "main", behind: 0, ahead: 0, dirty: 0, state: "ok", need: "none", error: null, checked_at: 1000, every_s: 600, observed_at: 1000 });
    expect(j(row(s)!.commits)).toEqual([]);
    expect(j(row(s)!.squads)).toEqual({});
    expect(row(s)!.last_update).toBeNull();
  });
  test("behind 2 gives commits (newest first) with classes and the strongest need", async () => {
    const f = fixture(), { s, l } = run(f.co);
    f.push("code only", "bin/b.ts");
    const top = f.push("role words", "roles/builder.md", "bin/c.ts");
    l.boot(1000); await l.tick(1000);
    const r = row(s)!;
    expect(r).toMatchObject({ behind: 2, ahead: 0, state: "ok", need: "reload", upstream: top });
    expect(j(r.classes)).toEqual(["instructions", "code"]);
    expect(j(r.commits).map((c: Row) => [c.title, c.classes])).toEqual([["role words", ["instructions", "code"]], ["code only", ["code"]]]);
    f.push("a skill", "skills/x/SKILL.md");
    await l.tick(1000 + 600);
    expect(row(s)).toMatchObject({ behind: 3, need: "restart" });
  });
  test("commits are capped at 20 but behind counts all", async () => {
    const f = fixture(), { s, l } = run(f.co);
    for (let i = 0; i < 22; i++) f.push(`c${i}`, `bin/f${i}.ts`);
    l.boot(1000); await l.tick(1000);
    expect(row(s)!.behind).toBe(22);
    expect(j(row(s)!.commits).length).toBe(20);
    expect(j(row(s)!.commits)[0].title).toBe("c21");
  });
  test("ahead and dirty are reported", async () => {
    const f = fixture(), { s, l } = run(f.co);
    commit(f.co, "local", "bin/local.ts");
    f.push("up", "bin/up.ts");
    put(f.co, "bin/a.ts", "edited\n");
    l.boot(1000); await l.tick(1000);
    expect(row(s)).toMatchObject({ behind: 1, ahead: 1, dirty: 1 });
  });
  test("a detached HEAD says so and does not fetch", async () => {
    const f = fixture(), calls: string[][] = [], real = gitIn(f.co);
    const { s, l } = run(f.co, tmp(), { git: (a, o) => { calls.push(a); return real(a, o); } });
    sh(f.co, "checkout", "-q", "--detach");
    l.boot(1000); await l.tick(1000);
    expect(row(s)).toMatchObject({ state: "detached", branch: null, behind: 0 });
    expect(calls.some((a) => a[0] === "fetch")).toBe(false);
  });
  test("a branch deleted on origin is no_upstream", async () => {
    const f = fixture(); sh(f.co, "checkout", "-q", "-b", "gone"); sh(f.co, "push", "-q", "-u", "origin", "gone");
    const { s, l } = run(f.co);
    sh(f.co, "push", "-q", "origin", "--delete", "gone");
    l.boot(1000); await l.tick(1000);
    expect(row(s)).toMatchObject({ state: "no_upstream", branch: "gone", error_at: 1000 });
    expect(row(s)!.error).toBeTruthy();
  });
  test("an unreachable origin keeps the last good counts and says fetch_failed", async () => {
    const f = fixture(), { s, l } = run(f.co);
    f.push("one", "bin/b.ts");
    l.boot(1000); await l.tick(1000);
    renameSync(f.origin, f.origin + ".away");
    await l.tick(1000 + 600);
    expect(row(s)).toMatchObject({ state: "fetch_failed", behind: 1, checked_at: 1000, error_at: 1600 });
    expect(row(s)!.error).toBeTruthy();
    expect(j(row(s)!.commits).length).toBe(1);
    renameSync(f.origin + ".away", f.origin);
    await l.tick(1000 + 1200);
    expect(row(s)).toMatchObject({ state: "ok", error: null, error_at: null, checked_at: 2200 });
  });
  test("no fetch between checks; one when every_s has passed", async () => {
    const f = fixture(), calls: string[][] = [], real = gitIn(f.co);
    const { l } = run(f.co, tmp(), { git: (a, o) => { calls.push(a); return real(a, o); } });
    l.boot(1000); await l.tick(1000); await l.tick(1030); await l.tick(1060);
    expect(calls.filter((a) => a[0] === "fetch").length).toBe(1);
    await l.tick(1600);
    expect(calls.filter((a) => a[0] === "fetch").length).toBe(2);
  });
  test("DS_LOOP_UPDATE_S=0 never fetches but still compares with the local ref", async () => {
    const f = fixture(), calls: string[][] = [], real = gitIn(f.co);
    process.env.DS_LOOP_UPDATE_S = "0";
    try {
      const { s, l } = run(f.co, tmp(), { git: (a, o) => { calls.push(a); return real(a, o); } });
      l.boot(1000); await l.tick(1000);
      expect(calls.some((a) => a[0] === "fetch")).toBe(false);
      expect(row(s)).toMatchObject({ state: "ok", behind: 0, every_s: 0, checked_at: null });
    } finally { delete process.env.DS_LOOP_UPDATE_S; }
  });
  test("a slow fetch does not block run(); its answer lands on a later tick", async () => {
    const f = fixture(), real = gitIn(f.co);
    f.push("one", "bin/b.ts");
    const { s, l } = run(f.co, tmp(), { budgetMs: 20, git: async (a, o) => { if (a[0] === "fetch") await Bun.sleep(400); return real(a, o); } });
    l.boot(1000);
    const t0 = Date.now(); await l.tick(1000);
    expect(Date.now() - t0).toBeLessThan(300);
    expect(row(s)!.behind).toBeNull();
    await Bun.sleep(900);
    await l.tick(1030);
    expect(row(s)).toMatchObject({ behind: 1, checked_at: 1000 });
  });
  test("a project's squads-rev.json behind HEAD fills squads; a current one does not", async () => {
    const f = fixture(), state = tmp();
    const old = sh(f.co, "rev-parse", "HEAD");
    commit(f.co, "skill", "skills/y/SKILL.md"); commit(f.co, "code", "bin/z.ts");
    for (const [label, rev] of [["alpha", old], ["beta", sh(f.co, "rev-parse", "HEAD")], ["gamma", "0000000000000000000000000000000000000000"]]) {
      mkdirSync(join(state, label, "squads"), { recursive: true }); writeFileSync(join(state, label, "squads-rev.json"), JSON.stringify({ rev }));
    }
    const { s, l } = run(f.co, state);
    l.boot(1000); await l.tick(1000);
    const sq = j(row(s)!.squads);
    expect(Object.keys(sq).sort()).toEqual(["alpha", "gamma"]);
    expect(sq.alpha).toMatchObject({ rev: old, behind: 2, classes: ["skills", "code"], need: "restart" });
    expect(sq.gamma).toMatchObject({ need: "restart", unknown: true });
  });
  test("update-host's outcome file lands in last_update", async () => {
    const f = fixture(), state = tmp();
    mkdirSync(join(state, "loop"), { recursive: true });
    const out = { at: 5, outcome: "advanced", line: "DS-UPDATE: advanced a -> b", branch: "main", before: "a", after: "b" };
    writeFileSync(join(state, "loop", "host-update.json"), JSON.stringify(out));
    const { s, l } = run(f.co, state);
    l.boot(1000); await l.tick(1000);
    expect(j(row(s)!.last_update)).toEqual(out);
  });
});
