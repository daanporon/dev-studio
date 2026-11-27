// reconcilers-cleanup.test.ts — host-disk-cleanup U2: verdicts from loop.db alone. The keep-set
// (KTD8, each source alone), the refusals, the R9 floors per class and the fixed verdict words, on
// seeded observed_cleanup rows; no filesystem, no processes.
import { describe, expect, test } from "bun:test";
import { CLEANUP_REPORT, keepSet, reconcile, VERDICTS } from "../../bin/loop/reconcilers/cleanup.ts";
import { cardText, needsYou } from "../../bin/loop/fulfil/cleanup.ts";
import type { Store } from "../../bin/loop/core/store.ts";
import { project, store, UID } from "./cleanup-fixture.ts";

const AT = 2_000_000_000, H = 3600;
const WT = "r::/w/ds-p-u1", PATH = "/w/ds-p-u1";
type Seed = { project?: string; class: string; key: string; path?: string; mtime?: number; first_seen?: number; orphaned_since?: number | null;
  verdict?: string | null; facts?: Record<string, unknown> };
function seed(s: Store, r: Seed): void {
  s.db.query(`INSERT INTO observed_cleanup (project, class, key, path, size_kb, mtime, first_seen, orphaned_since, verdict, facts, observed_at)
    VALUES (?, ?, ?, ?, 10, ?, ?, ?, ?, ?, ?)`).run(r.project ?? "p", r.class, r.key, r.path ?? r.key, r.mtime ?? null, r.first_seen ?? AT,
    r.orphaned_since ?? null, r.verdict ?? null, JSON.stringify(r.facts ?? {}), AT);
}
function scan(s: Store, psError: string | null = null): void {
  s.db.query("INSERT OR REPLACE INTO observed_cleanup_scan (host, started_at, ms, entries, ps_error, loose_count, loose_kb, observed_at) VALUES ('h', ?, 1, 1, ?, 0, 0, ?)")
    .run(AT, psError, AT);
}
let tickNo = 0; // each run is its own tick: the keep-set is built once a tick
const run = (s: Store, now = AT, p = "p", tick = ++tickNo) => reconcile({ store: s, project: p, tick, now, fired: [], poked: new Set() }, UID);
const verdict = (s: Store, key: string) => (s.db.query("SELECT verdict FROM observed_cleanup WHERE key = ?").get(key) as { verdict: string }).verdict;
const clean = { exists: true, probe: { dirty: 0, unpushed: 0, unique: 0, detached: false } };
function fixture(): Store {
  const s = store();
  project(s, "p");
  scan(s);
  return s;
}

describe("keep-set (KTD8)", () => {
  const d = (s: Store) => seed(s, { class: "d", key: `entity:${WT}`, path: PATH, first_seen: AT - 30 * H, facts: { entity: WT, wt_id: WT, wt: PATH, ...clean } });
  const sources: [string, (s: Store) => void][] = [
    ["a member not gone, no squad JSON anywhere (AE2)", (s) => s.upsert("members", { project: "p", squad: "q", role: "builder", suffix: "u1" }, { wt: WT, status: "running", observed_at: 1, updated_at: 1 })],
    ["squads.lead_wt", (s) => s.upsert("squads", { project: "p", topic: "q" }, { lead_wt: WT, observed_at: 1, updated_at: 1 })],
    ["a leftover in squads.doc", (s) => s.upsert("squads", { project: "p", topic: "q" }, { doc: JSON.stringify({ leftovers: [{ path: PATH }] }), observed_at: 1, updated_at: 1 })],
    ["projects.studio_wt", (s) => s.upsert("projects", { label: "p" }, { studio_wt: WT, observed_at: 1 })],
    ["a coordinator", (s) => s.upsert("coordinators", { project: "p", squad: "q" }, { wt: WT, run_id: "run_x", handle: "h", created_at: 1 })],
    ["a cancelled unit's builder_wt", (s) => s.upsert("units", { project: "p", squad: "q", slug: "u1" }, { builder_wt: WT, status: "cancelled", observed_at: 1, updated_at: 1 })],
    ["an observed_workers row running", (s) => s.upsert("observed_workers", { project: "p", wt: WT }, { presence: "running", observed_at: 1 })],
    ["a pending action", (s) => s.upsert("episodes", { project: "p", subject: "x", kind: "action:close" }, { state: "pending", episode_key: "e", source: "loop",
      action: JSON.stringify({ action: { payload: { wt: WT } } }), observed_at: 1 })],
    ["another project's member", (s) => s.upsert("members", { project: "other", squad: "q", role: "builder", suffix: "u1" }, { wt: WT, status: "running", observed_at: 1, updated_at: 1 })],
  ];
  for (const [name, add] of sources) test(`${name} alone keeps the worktree`, () => {
    const s = fixture();
    d(s); add(s);
    run(s);
    expect(verdict(s, `entity:${WT}`)).toBe("live member");
  });

  test("nothing names it: removable once 24 hours orphaned; a gone member wanted gone no longer keeps it", () => {
    const s = fixture();
    d(s);
    s.upsert("members", { project: "p", squad: "q", role: "builder", suffix: "u1" }, { wt: WT, status: "gone", want: "gone", observed_at: 1, updated_at: 1 });
    s.upsert("members", { project: "p", squad: "q", role: "lead", suffix: "" }, { wt: "r::/w/ds-p-lead", status: "running", observed_at: 1, updated_at: 1 });
    run(s);
    expect(verdict(s, `entity:${WT}`)).toBe("removable");
    expect(keepSet(s).has(WT)).toBe(false);
    expect(keepSet(s).why("/w/ds-p-lead")).toBe("member");
  });

  test("squads but an empty keep-set: the project is refused, every row report only, the card says so", () => {
    const s = fixture();
    s.upsert("squads", { project: "p", topic: "q" }, { status: "running", observed_at: 1, updated_at: 1 });
    d(s);
    const [a] = run(s);
    expect(verdict(s, `entity:${WT}`)).toBe("report only");
    expect(a).toMatchObject({ project: "p", subject: "cleanup:p", kind: CLEANUP_REPORT, payload: { refused: expect.stringContaining("has squads") } });
  });

  test("a failed backend list refuses c and d for the pass; a, b and e are judged", () => {
    const s = store();
    project(s, "p"); scan(s, "failed (boom)");
    d(s);
    seed(s, { class: "c", key: "/r/.claude/worktrees/h", first_seen: AT - 30 * H, facts: clean });
    seed(s, { class: "b", key: "/t/slug", mtime: AT - 50 * H, facts: { uid: UID } });
    run(s);
    expect([verdict(s, `entity:${WT}`), verdict(s, "/r/.claude/worktrees/h"), verdict(s, "/t/slug")]).toEqual(["report only", "report only", "removable"]);
  });

  test("a row with no project is report only (KTD13)", () => {
    const s = fixture();
    seed(s, { project: "", class: "b", key: "/t/x", mtime: AT - 50 * H });
    run(s, AT, "");
    expect(verdict(s, "/t/x")).toBe("report only");
  });
});

describe("floors and words (R9)", () => {
  test("a: a deleted cwd under a gone tree is removable 10 minutes after it went; a live member's process is live member", () => {
    const s = fixture();
    s.upsert("members", { project: "p", squad: "q", role: "builder", suffix: "u2" }, { wt: "r::/w/ds-p-u2", status: "running", observed_at: 1, updated_at: 1 });
    seed(s, { class: "a", key: "1:1", path: "/w/ds-p-gone", facts: { deleted: true, wt: "/w/ds-p-gone", wt_gone_at: AT - 11 * 60 } });
    seed(s, { class: "a", key: "2:1", path: "/w/ds-p-gone2", facts: { deleted: true, wt: "/w/ds-p-gone2", wt_gone_at: AT - 9 * 60 } });
    seed(s, { class: "a", key: "3:1", path: "/w/ds-p-u2", facts: { deleted: false, wt: "/w/ds-p-u2", wt_id: "r::/w/ds-p-u2" } });
    seed(s, { class: "a", key: "4:1", path: "/w/ds-p-old", first_seen: AT - 25 * H, facts: { deleted: false, wt: "/w/ds-p-old" } });
    run(s);
    expect(["1:1", "2:1", "3:1", "4:1"].map((k) => verdict(s, k))).toEqual(["removable", "too new", "live member", "removable"]);
  });

  test("b: older than cleanup_tmp_age_h is removable, newer too new; held: in use by pid N; another uid: not ours", () => {
    const s = fixture();
    seed(s, { class: "b", key: "/t/old", mtime: AT - 49 * H, facts: { uid: UID } });
    seed(s, { class: "b", key: "/t/new", mtime: AT - 47 * H, facts: { uid: UID } });
    seed(s, { class: "b", key: "/t/held", mtime: AT - 49 * H, facts: { uid: UID, holder: 4242 } });
    seed(s, { class: "b", key: "/t/theirs", mtime: AT - 49 * H, facts: { uid: UID + 1 } });
    run(s);
    expect(["/t/old", "/t/new", "/t/held", "/t/theirs"].map((k) => verdict(s, k))).toEqual(["removable", "too new", "in use by pid 4242", "not ours"]);
    s.db.run("INSERT OR REPLACE INTO host_config (host, key, value, set_at) VALUES ('local', 'cleanup_tmp_age_h', ?, 1)", ["46"]);
    run(s);
    expect(verdict(s, "/t/new")).toBe("removable");
  });

  test("b: a walk the size budget cut short, or no mtime, is too new however old the dir", () => {
    const s = fixture();
    seed(s, { class: "b", key: "/t/cut", mtime: 0, facts: { uid: UID, partial: true } });
    seed(s, { class: "b", key: "/t/cut-old", mtime: AT - 49 * H, facts: { uid: UID, partial: true } });
    seed(s, { class: "b", key: "/t/none", facts: { uid: UID } });
    run(s);
    expect(["/t/cut", "/t/cut-old", "/t/none"].map((k) => verdict(s, k))).toEqual(["too new", "too new", "too new"]);
  });

  test("a and c: another uid is not ours and a holder is in use, before any class rule", () => {
    const s = fixture();
    seed(s, { class: "a", key: "5:1", path: "/w/ds-p-o", first_seen: AT - 25 * H, facts: { deleted: false, wt: "/w/ds-p-o", uid: UID + 1 } });
    seed(s, { class: "a", key: "6:1", path: "/w/ds-p-h", first_seen: AT - 25 * H, facts: { deleted: true, wt: "/w/ds-p-h", wt_gone_at: AT - H, holder: 77 } });
    seed(s, { class: "c", key: "c-held", first_seen: AT - 25 * H, facts: { ...clean, holder: 78 } });
    seed(s, { class: "c", key: "c-theirs", first_seen: AT - 25 * H, facts: { ...clean, uid: UID + 1 } });
    run(s);
    expect(["5:1", "6:1", "c-held", "c-theirs"].map((k) => verdict(s, k))).toEqual(["not ours", "in use by pid 77", "in use by pid 78", "not ours"]);
  });

  test("c: detached from the probe alone; exists but not probed yet: too new; gone from disk 25 h: removable", () => {
    const s = fixture();
    const c = (key: string, facts: Record<string, unknown>) => seed(s, { class: "c", key, first_seen: AT - 25 * H, facts });
    c("probe-detached", { exists: true, probe: { dirty: 0, unpushed: 0, unique: 0, detached: true } });
    c("unprobed", { exists: true });
    c("vanished", { exists: false });
    run(s);
    expect(["probe-detached", "unprobed", "vanished"].map((k) => verdict(s, k))).toEqual(["detached", "too new", "removable"]);
  });

  test("the keep-set is built once a tick: a member added within the same tick is seen on the next", () => {
    const s = fixture();
    seed(s, { class: "d", key: "/w/ds-p-u1", first_seen: AT - 25 * H, facts: { git: true, wt: PATH, wt_id: WT, ...clean } });
    run(s, AT, "p", 9_000);
    s.upsert("members", { project: "p", squad: "q", role: "builder", suffix: "u1" }, { wt: WT, status: "running", observed_at: 1, updated_at: 1 });
    run(s, AT, "p", 9_000);
    expect(verdict(s, "/w/ds-p-u1")).toBe("removable");
    run(s, AT, "p", 9_001);
    expect(verdict(s, "/w/ds-p-u1")).toBe("live member");
  });

  test("b: a live tree's older session dir is judged by age even though its worktree is kept", () => {
    const s = fixture();
    s.upsert("members", { project: "p", squad: "q", role: "builder", suffix: "u1" }, { wt: WT, status: "running", observed_at: 1, updated_at: 1 });
    seed(s, { class: "b", key: "/t/slug/s-old", mtime: AT - 49 * H, facts: { uid: UID, session: "s-old", wt: PATH } });
    seed(s, { class: "b", key: "/t/slug2", mtime: AT - 49 * H, facts: { uid: UID, slug_wt: WT } });
    run(s);
    expect([verdict(s, "/t/slug/s-old"), verdict(s, "/t/slug2")]).toEqual(["removable", "live member"]);
  });

  test("c: clean and pushed 25 h, patch-equal: removable; unique commit, untracked file (AE4), detached, locked, 23 h: kept", () => {
    const s = fixture();
    const c = (key: string, facts: Record<string, unknown>, hours = 25) => seed(s, { class: "c", key, first_seen: AT - hours * H, facts: { ...clean, ...facts } });
    c("clean", {});
    c("landed", { probe: { dirty: 0, unpushed: 1, unique: 0, detached: false } });
    c("ahead", { probe: { dirty: 0, unpushed: 1, unique: 1, detached: false } });
    c("dirty", { probe: { dirty: 1, unpushed: 0, unique: 0, detached: false } });
    c("detached", { detached: true });
    c("locked", { locked: true });
    c("young", {}, 23);
    run(s);
    expect(["clean", "landed", "ahead", "dirty", "detached", "locked", "young"].map((k) => verdict(s, k)))
      .toEqual(["removable", "removable", "unpushed", "dirty", "detached", "locked", "too new"]);
  });

  test("d: a folder git lists, clean, first seen 25 h ago: removable; first seen this pass: too new; git does not list it: report only; a dirty entity: dirty", () => {
    const s = fixture();
    seed(s, { class: "d", key: "/w/ds-p-old", first_seen: AT - 25 * H, facts: { git: true, wt: "/w/ds-p-old", ...clean } });
    seed(s, { class: "d", key: "/w/ds-p-new", first_seen: AT, facts: { git: true, wt: "/w/ds-p-new", ...clean } });
    seed(s, { class: "d", key: "/w/ds-p-stray", first_seen: AT - 25 * H, facts: { git: false, wt: "/w/ds-p-stray", exists: true } });
    seed(s, { class: "d", key: "entity:r::/w/ds-p-e", first_seen: AT - 25 * H, facts: { entity: "r::/w/ds-p-e", exists: true, probe: { dirty: 2, unpushed: 0, unique: 0, detached: false } } });
    seed(s, { class: "d", key: "entity:r::/w/ds-p-np", first_seen: AT - 25 * H, facts: { entity: "r::/w/ds-p-np", exists: true, probe: null } });
    run(s);
    expect(["/w/ds-p-old", "/w/ds-p-new", "/w/ds-p-stray", "entity:r::/w/ds-p-e", "entity:r::/w/ds-p-np"].map((k) => verdict(s, k)))
      .toEqual(["removable", "too new", "report only", "dirty", "too new"]);
  });

  test("a row first seen 3 days ago that became unreferenced this pass is too new; its clock then runs from now", () => {
    const s = fixture();
    seed(s, { class: "d", key: "/w/ds-p-u1", first_seen: AT - 72 * H, verdict: "live member", facts: { git: true, wt: PATH, ...clean } });
    run(s);
    expect(verdict(s, "/w/ds-p-u1")).toBe("too new");
    expect(s.db.query("SELECT orphaned_since FROM observed_cleanup").get()).toEqual({ orphaned_since: AT });
    run(s, AT + 24 * H);
    expect(verdict(s, "/w/ds-p-u1")).toBe("removable");
    s.upsert("members", { project: "p", squad: "q", role: "builder", suffix: "u1" }, { wt: PATH, status: "running", observed_at: 1, updated_at: 1 });
    run(s, AT + 25 * H);
    expect(s.db.query("SELECT verdict, orphaned_since FROM observed_cleanup").get()).toEqual({ verdict: "live member", orphaned_since: null });
  });

  test("e: the verdict is removable when any match is, else the commonest kept reason", () => {
    const s = fixture();
    seed(s, { class: "e", key: "/t/a-*", facts: { count: 3, removable: 1, too_new: 2 } });
    seed(s, { class: "e", key: "/t/b-*", facts: { count: 3, removable: 0, too_new: 1, not_ours: 2 } });
    seed(s, { class: "e", key: "/t/c-*", facts: { count: 1, removable: 0, in_use: 1, in_use_pid: 9 } });
    run(s);
    expect(["/t/a-*", "/t/b-*", "/t/c-*"].map((k) => verdict(s, k))).toEqual(["removable", "not ours", "in use by pid 9"]);
  });

  test("f: a trim glob's row is judged like e: removable when any entry inside is, else the commonest kept reason", () => {
    const s = fixture();
    seed(s, { class: "f", key: "/t/cache-*", facts: { folders: 1, count: 3, removable: 1, too_new: 2 } });
    seed(s, { class: "f", key: "/t/keep-*", facts: { folders: 2, count: 3, removable: 0, not_ours: 2, too_new: 1 } });
    run(s);
    expect(["/t/cache-*", "/t/keep-*"].map((k) => verdict(s, k))).toEqual(["removable", "not ours"]);
  });

  test("every verdict written is one of the fixed words", () => {
    expect([...VERDICTS]).toEqual(["removable", "in use by pid N", "dirty", "unpushed", "detached", "locked", "too new", "live member", "not ours", "report only"]);
    const s = fixture();
    seed(s, { class: "b", key: "/t/x", mtime: AT, facts: { uid: UID, holder: 5 } });
    seed(s, { class: "c", key: "/c/x", facts: { ...clean, locked: true } });
    run(s);
    const words = (s.db.query("SELECT verdict FROM observed_cleanup").all() as { verdict: string }[]).map((r) => r.verdict.replace(/pid \d+$/, "pid N"));
    for (const w of words) expect(VERDICTS as readonly string[]).toContain(w);
  });
});

describe("the report action", () => {
  test("one cleanup.report per project; its episode follows the card text; no card and no rows: no action", () => {
    const s = fixture();
    expect(run(s)).toEqual([]);
    seed(s, { class: "b", key: "/t/old", mtime: AT - 49 * H, facts: { uid: UID } });
    const [one] = run(s);
    expect(one).toMatchObject({ project: "p", subject: "cleanup:p", kind: CLEANUP_REPORT });
    expect(run(s)[0].episode).toBe(one.episode);
    seed(s, { class: "b", key: "/t/old2", mtime: AT - 49 * H, facts: { uid: UID } });
    expect(run(s)[0].episode).not.toBe(one.episode);
  });

  test("a rejected trim glob alone is a report action whose card names it", () => {
    const s = fixture();
    s.db.run("INSERT OR REPLACE INTO host_config (host, key, value, set_at) VALUES ('local', 'cleanup_trim_globs', ?, 1)", ["relative-*"]);
    const [one] = run(s);
    expect(one).toMatchObject({ project: "p", subject: "cleanup:p", kind: CLEANUP_REPORT });
    expect(cardText(s, "p")).toContain("Invalid trim glob relative-*");
    expect(needsYou(s, "p")).toContain("invalid trim glob relative-*");
  });
});
