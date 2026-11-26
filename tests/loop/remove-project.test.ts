// remove-project.test.ts — remove-project U3: the `remove-project` request through the real actuator with fake
// Orca. A clear project ends with its Studio worktree saved and removed and its branch renamed, its services
// wished stopped, state/<label>/ in state/.removed/<label>-<date>/ with loop-rows.db and removed.json, and no row
// of the label left; a blocked one fails with nothing moved; a folder back after the move goes into the archive;
// a squad start is refused while the removal is open.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { dbPath, open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { openRemoval } from "../../bin/loop/squad/project-removal.ts";
import { planKey } from "../../bin/loop/fulfil/remove-project.ts";
import { fakeContract } from "../../bin/loop/fakes/contract.ts";
import { createWorktree } from "../../bin/loop/io/worktrees.ts";
import { copyRows, deleteRows } from "../../bin/loop/db/project-rows.ts";

const REPO = join(import.meta.dir, "..", "..");
const T = 1_800_000_000, DAY = new Date(T * 1000).toISOString().slice(0, 10);
const ENV = ["DS_CLOSE_ROLE", "BACKEND", "FAKE_LOG", "DS_NOW"];
const temps: string[] = [], stores: Store[] = [];
const saved = new Map(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzremove-project-")); temps.push(d); return d; };
const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args]);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}
// A bare origin with main, and the Studio's clone on branch ds-fx-studio with one uncommitted edit.
function studioRepo() {
  const d = tmp(), bare = join(d, "origin.git"), seed = join(d, "seed"), wt = join(d, "studio");
  mkdirSync(bare); mkdirSync(seed);
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "base");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "main");
  Bun.spawnSync(["git", "clone", "-q", bare, wt]);
  git(wt, "checkout", "-q", "-b", "ds-fx-studio");
  writeFileSync(join(wt, "a.txt"), "base\nstudio edit\n");
  return { wt, seed, d };
}

// Project fx (closed squad t1, a Studio worktree, a services row) beside project other, which must stay whole.
function rig(opts: { running?: boolean; studio?: string; off?: ReturnType<typeof fakeContract> } = {}) {
  const t = tmp(), S = join(t, "state");
  for (const f of ["bin", "conventions", "roles", "AGENTS.md"]) symlinkSync(join(REPO, f), join(t, f));
  for (const p of ["fx", "other"]) {
    mkdirSync(join(S, p, "squads"), { recursive: true });
    writeFileSync(join(S, p, "dispatcher.json"), JSON.stringify({ home_repo: p }));
    writeFileSync(join(S, p, "squads", "t1.json"), JSON.stringify({
      topic: "t1", repo: p, type: "feature", status: "running", run_id: `run-${p}`, lead_wt: `wtl-${p}`, worktrees: [`wtl-${p}`],
      members: [{ role: "lead", wt: `wtl-${p}` }], units: [],
    }));
  }
  writeFileSync(join(S, "fx", "notes.md"), "keep me\n");
  const s = open(S);
  stores.push(s);
  importJson(s);
  writeFileSync(join(S, ".loop-migrated"), "");
  if (!opts.running) {
    s.db.run("UPDATE squads SET status = 'closed' WHERE project = 'fx'");
    s.db.run("UPDATE members SET status = 'gone', want = 'gone' WHERE project = 'fx'");
    rmSync(join(S, "fx", "squads", "t1.json"));
  }
  if (opts.studio && !opts.off) s.upsert("projects", { label: "fx" }, { studio_wt: "wts-fx", studio_path: opts.studio });
  s.db.run(`INSERT INTO services (name, project, topic, want, status, observed_at, updated_at) VALUES ('board', 'fx', '', 'running', 'stopped', ${T}, ${T})`);
  s.event("note", { project: "fx", payload: { n: 1 } });
  const fake = join(t, "fakeb");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_LOG"\ncase "$1" in current) echo wt-elsewhere ;; ps) echo '{"result":{"worktrees":[]}}' ;; *) echo '{}' ;; esac\n`);
  chmodSync(fake, 0o755);
  Object.assign(process.env, { DS_CLOSE_ROLE: join(t, "bin", "close-role.sh"), BACKEND: fake, FAKE_LOG: join(t, "backend.log") });
  const orca = new FakeOrca();
  const off = opts.off;
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds), ...(off ? { backends: () => ({ backend: off, caps: off.caps }) } : {}) });
  const loop = new Loop(s, { observers: [], reconcilers: [...fulfillers] }, act, { projects: () => ["fx", "other"].filter((p) => existsSync(join(S, p))) });
  loop.boot(T);
  let at = T;
  const tick = async () => { at += 2; process.env.DS_NOW = String(at); await loop.tick(at); await act.drain(); };
  const file = () => Number(s.requestAny("remove-project", { label: "fx", by: "test" }, { by: "test" }).row.id);
  const req = (id: number) => s.get("requests", { id })!;
  const result = (id: number) => JSON.parse(String(req(id).result ?? "null"));
  const step = () => String(s.get("episodes", planKey("fx"))?.state ?? "");
  // Ticks until the request is done, or until `until` holds.
  const run = async (id: number, until?: () => boolean) => {
    for (let i = 0; i < 40 && req(id).done_at == null && !until?.(); i++) await tick();
    return result(id);
  };
  return { s, S, orca, file, run, result, step, tick };
}
const labelRows = (s: Store) => (s.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[])
  .map((r) => String(r.name))
  .filter((t) => (s.db.query(`PRAGMA table_info(${t})`).all() as Row[]).some((c) => c.name === "project"))
  .flatMap((t) => (s.db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE project = 'fx'`).get() as { n: number }).n ? [t] : []);
const events = (s: Store, kind: string) => s.db.query("SELECT project, payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[];

describe("ds remove-project through the loop (remove-project U3)", () => {
  test("a clear project: Studio saved and removed, branch renamed, folder and rows archived", async () => {
    const st = studioRepo(), r = rig({ studio: st.wt });
    const otherBefore = (r.s.db.query("SELECT COUNT(*) AS n FROM squads WHERE project = 'other'").get() as { n: number }).n;
    const id = r.file();
    const res = await r.run(id);
    const archive = join(r.S, ".removed", `fx-${DAY}`);
    expect(res).toMatchObject({ ok: true, step: "removed", label: "fx", archive });
    // The folder moved, with the Studio's saved changes inside it.
    expect(existsSync(join(r.S, "fx"))).toBe(false);
    expect(readFileSync(join(archive, "notes.md"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(archive, "pages", "_studio", "leftovers", "wts-fx"))).toBe(true);
    // The Studio worktree went through Orca, its branch moved aside.
    expect(r.orca.of("worktree-rm").map((c) => c.args)).toEqual([["id:wts-fx", "force"]]);
    expect(git(st.wt, "branch", "--list").includes(`ds-fx-studio-removed-`)).toBe(true);
    // The rows: in the archive, none left; the other project whole; the request and its events project NULL.
    expect(labelRows(r.s)).toEqual([]);
    const a = new Database(join(archive, "loop-rows.db"), { readonly: true });
    expect((a.query("SELECT COUNT(*) AS n FROM squads WHERE project = 'fx'").get() as { n: number }).n).toBe(1);
    a.close();
    expect((r.s.db.query("SELECT COUNT(*) AS n FROM squads WHERE project = 'other'").get() as { n: number }).n).toBe(otherBefore);
    const rec = JSON.parse(readFileSync(join(archive, "removed.json"), "utf8"));
    expect(rec).toMatchObject({ label: "fx", by: "test", request: id, archive, studio: { branch: "ds-fx-studio" } });
    expect(rec.studio.branch_now).toStartWith("ds-fx-studio-removed-");
    expect(events(r.s, "project_removed").map((e) => e.project)).toEqual([null]);
    expect(openRemoval(r.s, "fx")).toBe(null);
  }, 60_000);

  test("the board's service is wished stopped", async () => {
    const r = rig();
    const id = r.file();
    await r.run(id, () => ["quiet", "moving", "moved", "copied"].includes(r.step()));
    expect(r.s.db.query("SELECT want FROM services WHERE project = 'fx'").all()).toEqual([{ want: "stopped" }]);
    expect((await r.run(id)).ok).toBe(true);
  }, 60_000);

  test("a blocked project fails with nothing moved and nothing deleted", async () => {
    const r = rig({ running: true });
    const before = labelRows(r.s);
    const id = r.file();
    const res = await r.run(id);
    expect(res).toMatchObject({ ok: false, step: "check", label: "fx" });
    expect(res.error).toContain("'fx' cannot be removed");
    expect(existsSync(join(r.S, "fx", "notes.md"))).toBe(true);
    expect(existsSync(join(r.S, ".removed"))).toBe(false);
    expect(labelRows(r.s)).toEqual(before);
    expect(events(r.s, "project_remove_failed").map((e) => e.project)).toEqual([null]);
  }, 60_000);

  test("a folder back after the move goes into the archive as after-move/", async () => {
    const r = rig();
    const id = r.file();
    await r.run(id, () => r.step() === "moved");
    mkdirSync(join(r.S, "fx"));
    writeFileSync(join(r.S, "fx", "late.txt"), "late\n");
    const res = await r.run(id);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(res.archive, "after-move", "late.txt"), "utf8")).toBe("late\n");
    expect(existsSync(join(r.S, "fx"))).toBe(false);
  }, 60_000);

  test("a squad start is refused while the removal is open", async () => {
    const r = rig();
    const id = r.file();
    expect(openRemoval(r.s, "fx")).toBe(id);
    const { row } = r.s.requestAny("squad-start", { framing: "do a thing" }, { project: "fx", by: "test" });
    await r.tick();
    const start = JSON.parse(String(r.s.get("requests", { id: row.id })!.result ?? "null"));
    expect(start).toMatchObject({ ok: false });
    expect(String(start.error)).toContain("is being removed");
    expect((await r.run(id)).ok).toBe(true);
  }, 60_000);

  test("a Studio off Orca is closed and removed through its contract and its recorded provider", async () => {
    const st = studioRepo(), off = fakeContract({}, { name: "tmux", now: () => T });
    const r = rig({ off });
    const path = join(st.d, "wts", "studio");
    await createWorktree(r.s, "git", { repo: st.seed, name: "studio", branch: "ds-fx-studio-off", base: "main", path, project: "fx", squad: "_studio", role: "studio", parent: null } as never, T);
    writeFileSync(join(path, "a.txt"), "base\noff edit\n");
    const proj = r.s.get("projects", { label: "fx" });
    r.s.upsert("projects", { label: "fx" }, { studio_wt: `local::${path}`, doc: JSON.stringify({ ...JSON.parse(String(proj?.doc ?? "{}")), studio_backend: "tmux" }), observed_at: T });
    const term = await off.call("terminal.create", { cwd: path, label: "studio", group: "_studio" } as never);
    if (!term.ok) throw new Error("fake create");
    const res = await r.run(r.file());
    expect(res).toMatchObject({ ok: true, step: "removed" });
    expect(existsSync(path)).toBe(false);
    expect(r.orca.of("worktree-rm")).toEqual([]);
    expect(existsSync(join(res.archive, "pages", "_studio", "leftovers"))).toBe(true);
    expect(off.terms.has(term.terminal.id)).toBe(false);
  }, 60_000);

  // The copied step on its own: the plan stopped at `moved`, the copy made here, the plan set to `copied` with its
  // counts, as a loop that died right after saving that step left it.
  async function atCopied(r: ReturnType<typeof rig>, id: number, plan: Record<string, unknown> = {}) {
    await r.run(id, () => r.step() === "moved");
    const ep = r.s.get("episodes", planKey("fx"))!, p = JSON.parse(String(ep.result));
    const c = copyRows(dbPath(r.S), "fx", join(p.archive, "loop-rows.db"));
    r.s.upsert("episodes", planKey("fx"), { state: "copied", result: JSON.stringify({ ...p, step: "copied", copies: 1, copy: { counts: c.counts, rows: c.rows, set_aside: c.set_aside }, ...plan }) });
    return { p, c };
  }
  const plan = (r: ReturnType<typeof rig>) => JSON.parse(String(r.s.get("episodes", planKey("fx"))!.result));

  test("a replay after the delete committed finishes, the archive kept", async () => {
    const r = rig();
    const id = r.file();
    const { p } = await atCopied(r, id);
    expect(deleteRows(r.s, "fx", plan(r).copy.counts).ok).toBe(true);
    const res = await r.run(id);
    expect(res).toMatchObject({ ok: true, step: "removed", archive: p.archive });
    expect(plan(r).copies).toBe(1);
    const a = new Database(join(p.archive, "loop-rows.db"), { readonly: true });
    expect((a.query("SELECT COUNT(*) AS n FROM squads WHERE project = 'fx'").get() as { n: number }).n).toBe(1);
    a.close();
    expect(labelRows(r.s)).toEqual([]);
  }, 60_000);

  test("a row added after the copy copies again, then deletes", async () => {
    const r = rig();
    const id = r.file();
    await atCopied(r, id);
    r.s.event("note", { project: "fx", payload: { late: true } });
    const res = await r.run(id);
    expect(res.ok).toBe(true);
    expect(plan(r).copies).toBe(2);
    expect(labelRows(r.s)).toEqual([]);
    const a = new Database(join(res.archive, "loop-rows.db"), { readonly: true });
    expect((a.query("SELECT COUNT(*) AS n FROM events WHERE project = 'fx' AND kind = 'note'").get() as { n: number }).n).toBe(2);
    a.close();
  }, 60_000);

  test("rows that keep changing fail the removal after 5 copies, the archive kept", async () => {
    const r = rig();
    const id = r.file();
    const { p } = await atCopied(r, id, { copies: 5 });
    r.s.event("note", { project: "fx", payload: { late: true } });
    const res = await r.run(id);
    expect(res).toMatchObject({ ok: false, step: "copied" });
    expect(res.error).toContain("kept changing");
    expect(existsSync(join(p.archive, "loop-rows.db"))).toBe(true);
    expect(labelRows(r.s)).toContain("events");
  }, 60_000);
});
