// project-removal-checks.test.ts — remove-project U2: what blocks removing a project
// (squad/project-removal.ts removalBlockers), on a temp state root with real folders.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { removalBlockers, removalSummary, validLabel } from "../../bin/loop/squad/project-removal.ts";

const T = 1_800_000_000, P = "acme";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "zzremoval-"));
  temps.push(dir);
  const root = join(dir, "state");
  mkdirSync(join(root, P, "squads"), { recursive: true });
  const s = open(root);
  stores.push(s);
  const put = (table: string, row: Row) => {
    const full: Row = { observed_at: T, updated_at: T, ...row };
    const cols = Object.keys(full).filter((c) => s.columns(table).has(c));
    s.db.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => full[c] as string));
  };
  // A worktree folder; the id is Orca's `<uuid>::<path>`.
  const folder = (name: string) => { const p = join(dir, name); mkdirSync(p, { recursive: true }); return p; };
  const wt = (path: string) => `u1::${path}`;
  const absent = (name: string) => wt(join(dir, name));
  const studio = folder("studio");
  put("projects", { label: P, studio_wt: wt(studio), home_repo: `path:${folder("repo")}` });
  put("members", { project: P, squad: "_studio", role: "studio", wt: wt(studio), status: "running", want: "running" });
  put("observed_workers", { project: P, wt: wt(studio), presence: "running" });
  const squad = (topic: string, row: Row = {}) => put("squads", { project: P, topic, ...row });
  const member = (sq: string, role: string, row: Row = {}) => put("members", { project: P, squad: sq, role, ...row });
  const worker = (id: string, row: Row = {}) => put("observed_workers", { project: P, wt: id, presence: "running", ...row });
  const blockers = () => removalBlockers(s, P);
  return { s, root, dir, put, folder, wt, absent, studio, squad, member, worker, blockers };
}

describe("removalBlockers", () => {
  test("a running, a paused and a done squad with a live Lead each block and are named", () => {
    const r = rig();
    for (const [topic, status] of [["run", "running"], ["held", "paused"], ["over", "done"]]) {
      r.squad(topic, { status, doc: "{}" });
      writeFileSync(join(r.root, P, "squads", `${topic}.json`), "{}");
    }
    r.member("over", "lead", { wt: r.absent("over-lead"), status: "running", want: "running" });
    r.worker(r.absent("over-lead"));
    const got = r.blockers();
    expect(got.map((b) => [b.kind, b.squad, b.clear])).toEqual([
      ["open-squad", "held", "ds close-squad acme held"],
      ["open-squad", "over", "ds close-squad acme over"],
      ["open-squad", "run", "ds close-squad acme run"],
    ]);
  });

  test("closed squads' stale member rows with no live worker do not block", () => {
    const r = rig();
    r.squad("old", { status: "closed", doc: "{}" });
    r.member("old", "builder", { suffix: "a", wt: r.absent("a"), status: "gone", want: "running" });
    r.member("old", "builder", { suffix: "b", wt: r.absent("b"), status: null, want: "gone" });
    r.member("old", "lead", { wt: r.absent("c"), status: "suspended", want: "running" });
    r.member("old", "thinker", { wt: null, status: null, want: "running" });
    r.worker(r.absent("a"), { gone_at: T });
    expect(r.blockers()).toEqual([]);
    expect(removalSummary(r.s, P)).toMatchObject({ closedSquads: 1, memberRows: 4, neverStarted: [] });
  });

  test("a live worker of a closed squad blocks and is named", () => {
    const r = rig();
    r.squad("old", { status: "closed" });
    r.member("old", "builder", { suffix: "a", wt: r.absent("a"), status: "gone" });
    r.worker(r.absent("a"));
    expect(r.blockers()).toMatchObject([{ kind: "live-member", squad: "old", clear: "ds want member acme/old/builder/a archived" }]);
  });

  test("a closed squad with no folder on disk does not block", () => {
    const r = rig();
    r.squad("old", { status: "closed", lead_wt: r.absent("lead"), doc: JSON.stringify({ leftovers: [{ wt: r.absent("left"), path: join(r.dir, "left") }] }) });
    expect(r.blockers()).toEqual([]);
  });

  test("a never-started squad does not block; each of the five conditions makes it block", () => {
    const base = rig();
    base.squad("idea", { want: "running", want_result: "failed: no account" });
    base.member("idea", "lead", { want: "running" });
    expect(base.blockers()).toEqual([]);
    expect(removalSummary(base.s, P).neverStarted).toEqual(["idea"]);

    writeFileSync(join(base.root, P, "squads", "idea.json"), "{}");
    expect(base.blockers()).toMatchObject([{ kind: "open-squad", squad: "idea", clear: "ds close-squad acme idea" }]);

    const cases: [string, (r: ReturnType<typeof rig>) => Row][] = [
      ["status", () => ({ status: "running" })],
      ["doc", () => ({ doc: "{}" })],
      ["lead_wt", (r) => ({ lead_wt: r.absent("lead") })],
      ["open wish", () => ({ want: "running" })],
      ["live member", (r) => { r.member("idea", "lead", { wt: r.absent("m") }); r.worker(r.absent("m")); return {}; }],
    ];
    for (const [name, row] of cases) {
      const r = rig();
      r.squad("idea", row(r));
      expect([name, r.blockers().filter((b) => b.kind === "open-squad").map((b) => b.clear)]).toEqual([name, ["ds want squad acme/idea gone"]]);
    }
  });

  test("a leftover folder blocks with its path until it is gone", () => {
    const r = rig();
    const left = r.folder("left"), plain = r.folder("plain"), unrecorded = r.folder("unrecorded");
    r.squad("old", { status: "closed", doc: JSON.stringify({ leftovers: [{ wt: r.wt(left), path: left }] }) });
    r.member("old", "lead", { wt: r.wt(left), status: "gone", want: "gone" });
    r.put("worktrees", { host: "local", path: left, provider: "orca", created_at: T, project: P, squad: "old" });
    r.put("worktrees", { host: "local", path: plain, provider: "git", created_at: T, project: P, squad: "old" });
    r.member("old", "builder", { wt: r.wt(unrecorded), status: "gone", want: "gone" });
    expect(r.blockers().map((b) => [b.kind, b.path, b.squad, b.clear])).toEqual([
      ["worktree", left, "old", "the board's leftover Remove on squad 'old' (it saves the changes first)"],
      ["worktree", plain, "old", `ds worktree rm ${plain}`],
      ["worktree", unrecorded, "old", `git worktree remove ${unrecorded}   (the loop has no record of it; check it for unsaved work first)`],
    ]);
    for (const p of [left, plain, unrecorded]) rmSync(p, { recursive: true });
    expect(r.blockers()).toEqual([]);
  });

  test("a gone worker's folder is not the project's", () => {
    const r = rig();
    const other = r.folder("another-projects");
    r.worker(r.wt(other), { gone_at: T });
    expect(r.blockers()).toEqual([]);
  });

  test("the Studio's worktree and the repo clone never block", () => {
    const r = rig();
    r.put("worktrees", { host: "local", path: r.studio, provider: "orca", created_at: T, project: P, squad: "_studio", role: "studio" });
    r.put("coordinators", { project: P, squad: "old", run_id: "r1", handle: "h", created_at: T, wt: r.wt(r.studio) });
    r.put("coordinators", { project: P, squad: "older", run_id: "r2", handle: "h", created_at: T, wt: r.wt(join(r.dir, "repo")) });
    r.squad("old", { status: "closed" });
    r.member("old", "lead", { wt: r.wt(r.studio) });
    expect(r.blockers()).toEqual([]);
  });

  test("a paused project blocks with 'resume it first'", () => {
    const r = rig();
    r.s.pause({ scope: "project", project: P }, { source: "manual", by: "test" });
    expect(r.blockers()).toMatchObject([{ kind: "paused", text: "the project is paused: resume it first", clear: "ds resume project acme" }]);
  });

  test("an invalid or unknown label is refused; rows left without a folder are still a known project", () => {
    const r = rig();
    for (const bad of ["..", ".", "a/b", ".removed", "-x", ""]) expect([bad, validLabel(bad), removalBlockers(r.s, bad)[0].kind]).toEqual([bad, false, "invalid-label"]);
    expect(removalBlockers(r.s, "nobody")).toMatchObject([{ kind: "unknown-project" }]);
    r.put("squads", { project: "rows-only", topic: "t", status: "closed" });
    expect(removalBlockers(r.s, "rows-only")).toEqual([]);
  });

  test("the summary lists the Studio, the board service and open exposed entries; the checks write nothing", () => {
    const r = rig();
    r.put("services", { name: "board", project: P, topic: "", port: 8790, status: "running" });
    r.put("exposed", { project: P, squad: "old", role: "tester", name: "stack", url: "http://127.0.0.1:1", stop_cmd: "true" });
    r.put("exposed", { project: P, squad: "old", role: "tester", name: "ended", url: "http://127.0.0.1:2", gone_at: T });
    const before = r.s.db.query("SELECT total_changes() AS n").get() as { n: number };
    r.blockers();
    expect(removalSummary(r.s, P)).toMatchObject({
      studioWorktree: r.wt(r.studio),
      services: [{ name: "board", port: 8790, status: "running" }],
      exposed: [{ name: "stack", squad: "old", stop: "true" }],
    });
    expect(r.s.db.query("SELECT total_changes() AS n").get()).toEqual(before);
  });
});
