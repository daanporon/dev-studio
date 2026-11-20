// event-log-filters U1: GET /api/events' new filters (eventsQuery / eventsPage) and GET
// /api/events/lists (eventsLists) on a temp loop.db built through the store and its migrations.
// The routes' 400s and 403 are in tests/board-serve.sh.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventsLists, eventsPage, eventsQuery } from "../../bin/board/board-data.ts";
import { CATS, CAT_SQL, NOISE, OTHER, catKinds, catList, catOf, catWhere, isCat } from "../../bin/board/event-cats.ts";
import { FACTS } from "../../bin/loop/core/kinds.ts";
import { open } from "../../bin/loop/core/store.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const T0 = 1_800_000_000;   // a fixed clock: day 1 starts here
const DAY = 86_400;
const wt = (role: string, squad: string, project = "p") => `0a1b2c3d-0000-4000-8000-00000000d3a0::/x/ds-${project}-${role}-${squad}`;

// Project p: live squad `alpha` (lead live, builder gone), closed squad `beta`, a squad `gamma` with
// rows and no squads row, the Studio, and rows with no squad. Project q holds a squad `alpha` too.
function fixture() {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "evapi-")); roots.push(root);
  const s = open(root);
  const ev = (at: number, project: string | null, squad: string | null, member: string | null, kind: string, payload: unknown = {}) =>
    s.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, ?, ?, ?, ?, ?)", [at, project, squad, member, kind, JSON.stringify(payload)]);
  const sq = (project: string, topic: string, status: string) =>
    s.db.run("INSERT INTO squads (project, topic, status, observed_at, updated_at) VALUES (?, ?, ?, ?, ?)", [project, topic, status, T0, T0]);
  const mem = (project: string, squad: string, w: string, role: string, status: string, want = "running") =>
    s.db.run("INSERT INTO members (project, squad, wt, role, status, want, observed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [project, squad, w, role, status, want, T0, T0]);
  sq("p", "alpha", "running"); sq("p", "beta", "closed"); sq("p", "delta", "suspended"); sq("q", "alpha", "running");
  mem("p", "alpha", wt("lead", "alpha"), "lead", "running");
  mem("p", "alpha", wt("builder-u1-x", "alpha"), "builder", "gone", "gone");
  mem("p", "_studio", "0a1b2c3d-0000-4000-8000-00000000d3a0::/x/studio", "studio", "running");
  // Day 1
  ev(T0 + 10, "p", "alpha", wt("lead", "alpha"), "unit_dispatched");
  ev(T0 + 20, "p", "alpha", wt("builder-u1-x", "alpha"), "message_sent", { key: "k1" });
  ev(T0 + 30, "p", "alpha", wt("lead", "alpha"), "tick_slow");
  ev(T0 + 40, "p", "beta", null, "unit_done");
  ev(T0 + 50, "p", "_studio", "0a1b2c3d-0000-4000-8000-00000000d3a0::/x/studio", "studio_adopted");
  ev(T0 + 60, "p", null, null, "service_started");
  ev(T0 + 70, null, null, null, "loop_restart");          // host-wide
  // Day 2
  ev(T0 + DAY + 10, "p", "gamma", "builder/u2-y", "want");
  ev(T0 + DAY + 20, "p", "alpha", wt("lead", "alpha"), "brand_new_kind");
  ev(T0 + DAY + 30, "p", "alpha", wt("lead", "alpha"), "message_read", { ids: [1] });
  ev(T0 + DAY + 40, "q", "alpha", wt("lead", "alpha", "q"), "unit_done");
  ev(T0 + DAY + 50, "q", "_studio", null, "studio_adopted");
  ev(T0 + DAY + 60, "p", "alpha", "aaaaaaaa-0000-0000-0000-000000000000::/x/other/ds-p-lead-alpha", "pick");   // a second worktree with the short name "lead"
  s.close();
  return root;
}
const root = fixture();
const page = (o: Parameters<typeof eventsPage>[0]) => eventsPage(o, root) as any;
const kinds = (o: Parameters<typeof eventsPage>[0]) => page(o).events.map((e: any) => e.kind);

test("squad=_studio reads the Studio's rows (no 'bad squad' anywhere below the route)", () => {
  expect(kinds({ project: "p", squad: "_studio" })).toEqual(["studio_adopted"]);
});

test("nosquad=1 keeps the rows with no squad: the project's and the host-wide ones", () => {
  expect(kinds({ project: "p", nosquad: true })).toEqual(["loop_restart", "service_started"]);
});

test("a squad page is that project's squad only: the same name in another project stays out", () => {
  const evs = page({ project: "p", squad: "alpha" }).events;
  expect(evs.every((e: any) => e.project === "p" && e.squad === "alpha")).toBe(true);
  expect(evs.length).toBe(6);
  // A host-wide board names the project; without one a squad name reads across projects.
  expect(page({ project: "q", squad: "alpha" }).events.map((e: any) => e.project)).toEqual(["q"]);
  expect(page({ squad: "alpha" }).events.length).toBe(7);
});

test("member keeps one worktree of the squad", () => {
  expect(kinds({ project: "p", squad: "alpha", member: wt("builder-u1-x", "alpha") })).toEqual(["message_sent"]);
  expect(kinds({ project: "p", squad: "alpha", member: wt("lead", "alpha") })).toEqual(["message_read", "brand_new_kind", "tick_slow", "unit_dispatched"]);
});

test("cat keeps one category; cat=other keeps the kinds no category lists; every row carries its cat", () => {
  expect(kinds({ project: "p", cat: "messages" })).toEqual(["message_read", "message_sent"]);
  expect(kinds({ project: "p", cat: "other" })).toEqual(["brand_new_kind"]);
  const evs = page({ project: "p", squad: "alpha" }).events;
  expect(Object.fromEntries(evs.map((e: any) => [e.kind, e.cat]))).toEqual({
    pick: "crew", message_read: "messages", brand_new_kind: "other", tick_slow: "loop", message_sent: "messages", unit_dispatched: "work",
  });
});

test("noise=hide leaves the noise kinds out, but not a kind the exact-event picker names", () => {
  expect(kinds({ project: "p", squad: "alpha", noise: true })).not.toContain("tick_slow");
  expect(kinds({ project: "p", noise: true })).toContain("want");   // a wish request, not noise (the `wish` fact is)
  expect(kinds({ project: "p", squad: "alpha", noise: true, kind: "tick_slow" })).toEqual(["tick_slow"]);
  // The API default still shows all, and the old hide= keeps working.
  expect(kinds({ project: "p", squad: "alpha" })).toContain("tick_slow");
  expect(kinds({ project: "p", squad: "alpha", hide: ["tick_slow"] })).not.toContain("tick_slow");
});

test("until starts the page at the newest row at or before that time, and pages on by id", () => {
  const p = page({ project: "p", until: T0 + DAY - 1, limit: 3 });
  expect(p.events.map((e: any) => e.kind)).toEqual(["loop_restart", "service_started", "studio_adopted"]);
  expect(p.older).not.toBeNull();
  expect(p.newer).not.toBeNull();   // day 2 is newer
  expect(page({ project: "p", before: p.older, limit: 3 }).events.map((e: any) => e.kind)).toEqual(["unit_done", "tick_slow", "message_sent"]);
  // A time before any row: an empty page, no error.
  expect(page({ project: "p", until: T0 - 1 }).events).toEqual([]);
  // A future time behaves as now.
  expect(page({ project: "p", until: T0 + 10 * DAY }).events.length).toBe(page({ project: "p" }).events.length);
});

test("lists: false leaves the old pickers out; the default keeps them", () => {
  const p = page({ project: "p", lists: false });
  expect("squads" in p || "kinds" in p).toBe(false);
  const d = page({ project: "p" });
  expect(d.squads).toEqual(["_studio", "alpha", "beta", "gamma"]);
  expect(d.kinds).toContain("loop_restart");
});

test("eventsQuery: a squad drops the project-or-host-wide OR (index-ready); a filterless host-wide page is '1'", () => {
  expect(eventsQuery({ project: "p", squad: "alpha", member: "w" })).toEqual({ where: "project = ? AND squad = ? AND member = ?", args: ["p", "alpha", "w"] });
  expect(eventsQuery({ project: "p" }).where).toBe("(project = ? OR project IS NULL)");
  expect(eventsQuery({}).where).toBe("1");
  expect(eventsQuery({ project: "p", nosquad: true }).where).toBe("(project = ? OR project IS NULL) AND squad IS NULL");
  // member is only read with a squad (the route refuses it alone).
  expect(eventsQuery({ project: "p", member: "w" }).where).not.toContain("member");
  expect(eventsQuery({ cat: "messages" }).where).toMatch(/^kind IN \('message_sent'/);
});

test("lists: squads grouped live/closed from squads.status, _studio only as the studio flag", () => {
  const l = eventsLists({ project: "p" }, root) as any;
  expect(l.squads).toEqual([
    { project: "p", squad: "alpha", group: "live" },
    { project: "p", squad: "beta", group: "closed" },
    { project: "p", squad: "delta", group: "live" },     // a suspended squad with no rows yet is still live
    { project: "p", squad: "gamma", group: "closed" },   // rows but no squads row
  ]);
  expect(l.studio).toBe(true);
  expect(l.studios).toEqual(["p"]);
  expect(l.kinds).toContain("loop_restart");
  expect(l.kinds).not.toContain("unit_done_q");
  expect(l.cats.map((c: any) => c.key)).toEqual([...CATS.map((c) => c[0]), "other"]);
  expect(l.noise).toEqual([...NOISE]);
  expect(l.crew).toEqual([]);
});

test("lists on a host-wide board: two projects' squads of one name are two entries", () => {
  const l = eventsLists({}, root) as any;
  expect(l.squads.filter((s: any) => s.squad === "alpha")).toEqual([
    { project: "p", squad: "alpha", group: "live" },
    { project: "q", squad: "alpha", group: "live" },
  ]);
  expect(l.studios).toEqual(["p", "q"]);
  expect(l.squads.some((s: any) => s.squad === "_studio")).toBe(false);
});

test("lists crew: the squad's members by short name, gone marked, a second name numbered", () => {
  const l = eventsLists({ project: "p", squad: "alpha" }, root) as any;
  expect(l.crew).toEqual([
    { wt: wt("lead", "alpha"), name: "lead", gone: false },
    { wt: wt("builder-u1-x", "alpha"), name: "builder-u1-x", gone: true },
    { wt: "aaaaaaaa-0000-0000-0000-000000000000::/x/other/ds-p-lead-alpha", name: "lead (2)", gone: true },
  ]);
  // The other project's alpha crew stays out; a role/slug member key reads as itself.
  expect((eventsLists({ project: "q", squad: "alpha" }, root) as any).crew.map((c: any) => c.name)).toEqual(["lead"]);
  expect((eventsLists({ project: "p", squad: "gamma" }, root) as any).crew).toEqual([{ wt: "builder/u2-y", name: "builder/u2-y", gone: true }]);
  expect((eventsLists({ project: "p", squad: "_studio" }, root) as any).crew).toEqual([{ wt: "0a1b2c3d-0000-4000-8000-00000000d3a0::/x/studio", name: "studio", gone: false }]);
});

// Every kind on the live log when the plan was written (127, plus two seen since) and every FACTS
// key has a category: a new kind must be placed in event-cats.ts, not left in Other.
const LIVE_KINDS = `account_credits_held account_disabled account_enabled account_limit_corrected account_limit_lifted action action_done
action_dropped action_failed action_pending action_unhandled auto_merge_armed auto_merge_poke_failed briefing_schedule claude_tmp_kept
claude_tmp_removed cleanup_removed cleanup_stopped cleared coordinator coordinator_rebound delivery_escalated delivery_sent delivery_verified
dependency_wait_released duplicate_agent_closed exposed github_error github_rate_limited host_migrated leftover_dropped leftover_procs_stopped
leftover_recorded limit_cleared limit_wait limited loop_exit loop_restart member_account member_avoid member_closed member_drift_cleared
member_phase member_placed member_rebound member_rebound_settled member_record member_requested member_start_failed member_started
member_stopped member_suspended member_unbound member_waiting message_delivered message_read message_replied message_sent orca_call_settled
override_cleared override_set owner_dependency_resolved parked pause_checkpoint pause_cleared pause_closed pause_requested
pause_resume_finished pause_resumed pick plugin_error pr_question_asked question_answered question_reopened question_replied
question_reply_refused question_unit_linked queued_given_up ready_deferred ready_unapproved refusal reload_ack replay_path_moved request
request_done request_settled run_mail_given_up run_mail_relayed run_mail_resent run_mail_superseded service_failed service_restarted
service_started service_starting service_stopped settings_migrated spend squad_all_done squad_reimported squad_run squad_state
squad_suspended squad_task stop_checkpoint stray_terminal_closed studio_adopted tester_pass_done tick_slow toast unexposed
unit_builder_moved unit_dispatched unit_done unit_into_merged unit_pr unit_pr_blocked unit_waiting verification_admission
verification_wait want wish wish_done wish_dropped wish_failed wish_given_up wish_reopened wish_seeded worker_stopped wt_parent_set`.split(/\s+/);

test("every live kind and every FACTS key has a category other than other", () => {
  expect(LIVE_KINDS.length).toBe(129);
  const unplaced = [...LIVE_KINDS, ...Object.keys(FACTS)].filter((k) => catOf(k) === OTHER);
  expect(unplaced).toEqual([]);
});

test("the category table: SQL, filter and code agree; noise kinds are categorised; unknown keys refused", () => {
  for (const [key] of CATS) {
    expect(isCat(key)).toBe(true);
    expect(catWhere(key)).toBe(`kind IN (${catKinds(key).map((k) => `'${k}'`).join(", ")})`);
    for (const k of catKinds(key)) expect(catOf(k)).toBe(key);
  }
  expect(isCat("other")).toBe(true);
  expect(isCat("nope")).toBe(false);
  expect(catWhere("nope")).toBeNull();
  expect(catKinds("other")).toEqual([]);
  expect(catList().at(-1)).toEqual({ key: "other", label: "Other" });
  for (const k of NOISE) expect(catOf(k)).not.toBe(OTHER);
  expect(CAT_SQL).toContain("ELSE 'other' END");
});
