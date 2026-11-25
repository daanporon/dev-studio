// needs-clear.test.ts — U4 (needs-you-cleanup): Needs-you cards clear themselves when the loop can tell
// they are over: Red PR still blocked (merged / closed / unblocked / a new stretch), Agent broke again
// (its member runs again), and the old Loop-stalled cards. Judged by alertGone over a hermetic root.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { alertGone, dropAlerts } from "../../bin/loop/reconcilers/alerts.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const T = 1_800_000_000, NWO = "o/r", LEAD = "wt-lead::/ws/ds-lead-lc", B = "wt-b1::/ws/ds-builder-u1-lc";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function fx(): Store {
  const root = mkdtempSync(join(tmpdir(), "zzclear-")); temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, "fx", "squads", "demo.json"), { force: true });
  rmSync(join(root, "fx", "sweep", "pr-health.json"), { force: true });
  writeFileSync(join(root, "fx", "squads", "lc.json"), JSON.stringify({ type: "feature", status: "running", repo: "path:/x/repo", lead_wt: LEAD,
    members: [{ role: "lead", suffix: "", wt: LEAD }, { role: "builder", suffix: "u1", wt: B }],
    units: [{ slug: "u1", status: "dispatched", builder_wt: B, deps: [], hold: false, pr: "7" }], leftovers: [] }, null, 2) + "\n");
  const s = open(root); stores.push(s);
  importJson(s); importConfig(s);
  return s;
}
const pr = (s: Store, set: Row) => s.upsert("observed_prs", { project: "fx", ref: `${NWO}#7` },
  { pr: 7, repo: NWO, head: "feat-u1", state: "OPEN", verdict: "blocked", since: T - 100, observed_at: T, ...set });
const gone = (s: Store, a: Row) => alertGone(s, "fx", a, T + 60);
const since = new Date(T * 1000).toISOString();

describe("Red PR still blocked", () => {
  const card = (extra: Row = {}): Row => ({ asker: "sweep", id: "loop-x-1", title: "Red PR still blocked", kind: "pr_stale", ref: `${NWO}#7`, pr: 7,
    blocked_since: T - 100, question: "PR #7 https://github.com/o/r/pull/7 (lc/u1) is still not merge-ready", since, ...extra });
  test("stays while the PR is open, blocked, in the same stretch", () => {
    const s = fx(); pr(s, {});
    expect(gone(s, card())).toBe(false);
  });
  test("goes on merge, close, gone, unblock and a new stretch", () => {
    const s = fx();
    pr(s, { state: "MERGED" }); expect(gone(s, card())).toBe("the PR merged");
    pr(s, { state: "CLOSED" }); expect(gone(s, card())).toBe("the PR closed");
    pr(s, { state: "OPEN", gone_at: T }); expect(gone(s, card())).toBe("the PR closed");
    pr(s, { state: "OPEN", gone_at: null, verdict: "ready" }); expect(gone(s, card())).toBe("the PR is no longer blocked");
    pr(s, { verdict: "blocked", since: T - 5 }); expect(gone(s, card())).toBe("a new blocked stretch began");
  });
  test("no row for the PR: not judged", () => {
    expect(gone(fx(), card({ ref: "o/r#99" }))).toBeNull();
  });
  test("an old card (no kind, no ref) is found by the number in its text", () => {
    const s = fx(); pr(s, { state: "MERGED" });
    expect(gone(s, card({ kind: undefined, ref: undefined, blocked_since: undefined, question: "PR #7 (lc/u1) is still not merge-ready (x) 120 min after" }))).toBe("the PR merged");
  });
});

describe("Agent broke again", () => {
  const card = (): Row => ({ asker: "sweep", id: "loop-y-1", title: "Agent broke again", kind: "agent_rebroke", member: B, since,
    question: `The builder u1 of lc (${B}) is gone again within 30 min of a restart; the loop does not restart it again.` });
  test("stays while its member is down, goes when it runs again or the member is gone", () => {
    const s = fx();
    expect(gone(s, card())).toBe(false);
    s.upsert("observed_workers", { project: "fx", wt: B }, { state: "idle", since: null, observed_at: T });
    expect(gone(s, card())).toBe("its member runs again");
    expect(gone(s, { ...card(), member: "wt-none::/ws/none" })).toBe("its member no longer exists");
  });
});

describe("old Loop-stalled cards", () => {
  test("loop-stall-<pid> cards go", () => {
    expect(gone(fx(), { asker: "sweep", id: "loop-stall-1234", title: "Loop stalled", question: "the loop stalled", since })).toBe("loop stalls are shown on the board's loop line now");
  });
});

describe("loopnotes U3: Lifecycle failed and archived squads", () => {
  const setSquad = (s: Store, set: Row) => s.upsert("squads", { project: "fx", topic: "lc" }, set);
  const life = (extra: Row = {}): Row => ({ asker: "sweep", id: "sweep-life-1", title: "Lifecycle failed", squad: "lc",
    question: "The loop could not make the running squad lc: boom", since, ...extra });

  test("a squad Lifecycle-failed card stays while the squad wants running, and goes once its want moved on", () => {
    const s = fx();
    setSquad(s, { want: "running", status: null });
    expect(gone(s, life())).toBe(false);
    setSquad(s, { want: "gone" });
    expect(gone(s, life())).toBe("the squad's wish moved on");
    setSquad(s, { want: "running", status: "running" });
    expect(gone(s, life())).toBe("the squad's wish moved on");
  });

  const red = (extra: Row = {}): Row => ({ asker: "sweep", id: "loop-x-1", title: "Red PR still blocked", kind: "pr_stale", ref: `${NWO}#7`, pr: 7, squad: "lc", blocked_since: T - 100, question: "PR #7 is still not merge-ready", since, ...extra });
  const reply = (extra: Row = {}): Row => ({ asker: "sweep", id: "sweep-msg-reply-3", title: "No reply", squad: "lc", question: "asked, no reply", since, ...extra });
  test("an archived squad's cards are gone; a running squad's are not", () => {
    const s = fx();
    pr(s, {});
    setSquad(s, { want: "running", status: "running" });
    expect(gone(s, red())).toBe(false);
    expect(gone(s, reply())).not.toBe("its squad was archived");
    setSquad(s, { status: "closed" });
    expect(gone(s, red())).toBe("its squad was archived");
    expect(gone(s, reply())).toBe("its squad was archived");
    setSquad(s, { status: "running", want: "gone", want_result: "done: archived" });
    expect(gone(s, reply())).toBe("its squad was archived");
  });
  test("the debrief, dropped-questions and stop-failed cards of a closed squad stay", () => {
    const s = fx();
    setSquad(s, { status: "closed" });
    for (const c of [reply({ id: "sweep-debrief-lc-1", title: "Debrief: lc" }), reply({ id: "loop-debrief-lc-1uy1p7", reason: "debrief-lc", title: "Debrief: lc" }), reply({ kind: "questions_dropped", title: "Archived with a blocking question open: lc" }), reply({ title: "Stop command failed" })])
      expect(gone(s, c)).not.toBe("its squad was archived");
  });
  test("an old-id debrief card is never gone on its own and dropAlerts keeps it at two days", () => {
    const s = fx();
    setSquad(s, { status: "closed" });
    const c = reply({ id: "loop-debrief-lc-1uy1p7", reason: "debrief-lc", title: "Debrief: lc", since: new Date((T - 2 * 86_400) * 1000).toISOString() });
    expect(gone(s, c)).toBe(false);
    s.db.run("INSERT INTO observed_alerts (project, id, doc, observed_at) VALUES ('fx', ?, ?, ?)", [String(c.id), JSON.stringify(c), T]);
    expect(dropAlerts({ store: s, project: "fx", now: T + 60 } as TickCtx)).toEqual([]);
  });
});
