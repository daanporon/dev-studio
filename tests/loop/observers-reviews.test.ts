// observers-reviews.test.ts — the review-state observer (U4) on real git worktrees and a fixture /proc:
// a live marker reads reviewing (round = reviews logged + 1), a dead, reused or 6h-old one is ignored,
// a receipt with findings reads fixing, an open alert or a stop count of 2 reads stopped, nothing reads
// coding; a unit no longer dispatched loses its row, a missing worktree gets none, and the git dir is
// never written.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { reviewsObserver } from "../../bin/loop/observers/reviews.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzreviews-")); temps.push(d); return d; };

const BTIME = 1_700_000_000, T = 1_800_000_000, SHA = "a".repeat(40);
// A fixture /proc: btime, and each pid's stat with its start time (epoch seconds) as starttime ticks.
function procRoot(pids: Record<number, number>): string {
  const root = tmp();
  writeFileSync(join(root, "stat"), `cpu  1 2 3 4\nbtime ${BTIME}\n`);
  for (const [pid, startedAt] of Object.entries(pids)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, "stat"), `${pid} (bun) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${(startedAt - BTIME) * 100} 0 0\n`);
  }
  return root;
}
function worktree(): { wt: string; gdir: string } {
  const wt = tmp();
  spawnSync("git", ["init", "-q", wt]);
  return { wt, gdir: join(wt, ".git") };
}
const files = (gdir: string, f: Record<string, string>) => { for (const [k, v] of Object.entries(f)) writeFileSync(join(gdir, k), v); };
const logLine = (ago: number, kind: string, reason = "why", engine = "claude:opus") => `${T - ago}\t${SHA}\t${kind}\t${reason}\t-\t${engine}\n`;

function setup(proc = procRoot({})) {
  const s = open(tmp()); stores.push(s);
  const l = new Loop(s, { observers: [reviewsObserver(proc)], reconcilers: [] }, { act() {} }, { projects: () => [] });
  l.boot(T);
  return { s, l };
}
function unit(s: Store, slug: string, wt: string | null, status = "dispatched", project = "p", squad = "sq") {
  s.upsert("units", { project, squad, slug }, { status, builder_wt: wt === null ? null : `repo1::${wt}`, observed_at: 1, updated_at: 1 });
}
const rows = (s: Store) => Object.fromEntries((s.db.query("SELECT * FROM observed_reviews ORDER BY slug").all() as Row[]).map((r) => [r.slug, r]));
const one = async (gfiles: Record<string, string>, proc?: string, extra?: (s: Store, wt: string) => void) => {
  const { wt, gdir } = worktree();
  files(gdir, gfiles);
  const { s, l } = setup(proc);
  unit(s, "u", wt);
  extra?.(s, wt);
  await l.tick(T);
  return rows(s).u;
};

describe("reviews observer", () => {
  test("a marker whose pid is alive reads reviewing: since, kind, head, round = reviews logged + 1", async () => {
    const log = logLine(9000, "full") + logLine(8000, "retry", "the lead said so") + logLine(7000, "carried", "unchanged")
      + logLine(6000, "delta", "reused run-1") + logLine(5000, "delta", "since x") + logLine(4000, "full", "why", "-");
    const r = await one({ "ds-review-log": log, "ds-review-start": `${T - 240}\t${SHA}\tdelta\t4242\n`,
      "ds-review": `${SHA}\t${T - 5000}\torigin/main\t3\tclaude:opus\tproof=1\n` }, procRoot({ 4242: T - 250 }));
    expect(r).toMatchObject({ state: "reviewing", since: T - 240, kind: "delta", round: 3, head: SHA, findings: null, observed_at: T });
  });

  test("a dead pid, a reused pid (started after the marker) and a marker over 6h old are ignored", async () => {
    const m = (ago: number, pid: number) => ({ "ds-review-start": `${T - ago}\t${SHA}\tfull\t${pid}\n` });
    expect((await one(m(60, 4242), procRoot({}))).state).toBe("coding");
    expect((await one(m(60, 4242), procRoot({ 4242: T - 10 }))).state).toBe("coding");
    expect((await one(m(6 * 3600 + 1, 4242), procRoot({ 4242: T - 7 * 3600 }))).state).toBe("coding");
    expect((await one(m(6 * 3600 - 60, 4242), procRoot({ 4242: T - 7 * 3600 }))).state).toBe("reviewing");
    expect((await one({ "ds-review-start": "garbage\n" }, procRoot({ 4242: T - 10 }))).state).toBe("coding");
  });

  test("a receipt with an actionable count above 0 and no live marker reads fixing; a count of 0 reads coding", async () => {
    const receipt = (n: number) => ({ "ds-review": `${SHA}\t${T - 720}\torigin/main\t${n}\tclaude:opus\tproof=1\n`, "ds-review-log": logLine(800, "full") });
    expect(await one(receipt(6))).toMatchObject({ state: "fixing", findings: 6, since: T - 720, round: 1, head: SHA, kind: null });
    expect(await one(receipt(0))).toMatchObject({ state: "coding", findings: null, since: null, round: 1 });
  });

  test("an open review_stopped alert for the worktree or the unit, or a stop count of 2, reads stopped", async () => {
    const live = { "ds-review-start": `${T - 60}\t${SHA}\tfull\t4242\n` }, proc = procRoot({ 4242: T - 70 });
    const alert = (doc: Row) => (s: Store) => s.upsert("observed_alerts", { project: "p", id: "review-stopped:b" },
      { doc: JSON.stringify({ kind: "review_stopped", branch: "b", failures: 2, ...doc }), observed_at: T });
    expect((await one(live, proc, (s, wt) => alert({ wt })(s))).state).toBe("stopped");
    expect((await one(live, proc, alert({ squad: "sq", slug: "u" }))).state).toBe("stopped");
    expect((await one(live, proc, alert({ squad: "sq", slug: "other", wt: "/nowhere" }))).state).toBe("reviewing");
    expect(await one({ "ds-review-stop": `2\t${T - 30}\thash\tskill\tmd\terr\n`, ...live }, proc)).toMatchObject({ state: "stopped", since: T - 30 });
    expect((await one({ "ds-review-stop": `1\t${T - 30}\thash\tskill\tmd\terr\n`, ...live }, proc)).state).toBe("reviewing");
    // U2: off-script failures stop at 3, tooling ones (named or not) at 2.
    const stop = (n: number, cls: string) => ({ "ds-review-stop": `${n}\t${T - 30}\thash|skill|md\terr${cls ? `\t${cls}` : ""}\n`, ...live });
    expect((await one(stop(2, "off-script"), proc)).state).toBe("reviewing");
    expect((await one(stop(3, "off-script"), proc)).state).toBe("stopped");
    expect((await one(stop(2, "tooling"), proc)).state).toBe("stopped");
    expect((await one(stop(2, ""), proc)).state).toBe("stopped");
  });

  test("no review files read coding with round 0", async () => {
    expect(await one({})).toMatchObject({ state: "coding", since: null, kind: null, round: 0, findings: null, head: null });
  });

  test("a unit no longer dispatched loses its row; a missing worktree or a non-git path gets none and does not throw", async () => {
    const a = worktree(), b = worktree(), plain = tmp();
    const { s, l } = setup();
    unit(s, "a", a.wt); unit(s, "b", b.wt); unit(s, "gone", "/no/such/worktree"); unit(s, "plain", plain); unit(s, "nowt", null);
    unit(s, "planned", a.wt, "planned");
    await l.tick(T);
    expect(Object.keys(rows(s))).toEqual(["a", "b"]);
    expect(rows(s).a.wt).toBe(a.wt);
    unit(s, "b", b.wt, "done");
    await l.tick(T + 60);
    expect(Object.keys(rows(s))).toEqual(["a"]);
    expect(rows(s).a.observed_at).toBe(T + 60);
  });

  test("it never writes into a Builder's git dir", async () => {
    const { wt, gdir } = worktree();
    files(gdir, { "ds-review-start": `${T - 9 * 3600}\t${SHA}\tfull\t4242\n`, "ds-review": `${SHA}\t${T}\t-\t2\te\tproof=1\n` });
    const snap = () => readdirSync(gdir).sort().map((f) => { try { return [f, readFileSync(join(gdir, f), "utf8")]; } catch { return [f, "dir"]; } });
    const before = snap();
    const { s, l } = setup();
    unit(s, "u", wt);
    await l.tick(T);
    expect(rows(s).u.state).toBe("fixing");
    expect(snap()).toEqual(before);
  });
});
