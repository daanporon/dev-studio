// briefing-input.test.ts — morning-briefing U4: `ds briefing-input`, the read-only facts collector for
// the Studio's morning brief, on a seeded store with a pinned clock (DS_NOW, host zone Europe/Berlin).
// The briefing request rows follow the KTD4 payload U3 writes: {action, label, date, since, until, spend, line}.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, openReadOnly, type Store } from "../../bin/loop/core/store.ts";
import { collect, MAX_LINES, render, windowOf } from "../../bin/commands/briefing-input.ts";

process.env.TZ = "Europe/Berlin";
const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const L = "fx";
const H = 3600, DAY = 86_400;
const MON = Date.UTC(2026, 10, 9, 8) / 1000;          // Mon 9 Nov 2026 09:00 Berlin: the first brief
const TUE = MON + DAY;                                 // Tue 09:00: the brief under test
const T = TUE + 60;                                    // the clock the command runs at
const EMAIL = "someone@example.com";

let dir = "", plan = "";

function insert(s: Store, table: string, row: Record<string, unknown>) {
  const k = Object.keys(row);
  s.db.run(`INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`, k.map((x) => {
    const v = row[x];
    return v !== null && typeof v === "object" ? JSON.stringify(v) : v as string | number | null;
  }) as never);
}

function seed(s: Store) {
  const ins = (table: string, row: Record<string, unknown>) => insert(s, table, row);
  const at = { observed_at: T, updated_at: T };
  // Squad "alpha": 4 units (one cancelled): u1 done in the window, u0 done before it, u2 in progress, u3 planned.
  ins("squads", { project: L, topic: "alpha", status: "running", doc: { topic: "alpha" }, ...at });
  ins("units", { project: L, squad: "alpha", slug: "u0-old", ord: 0, status: "done", pr: "40", plan, done_at: MON - 2 * H, ...at });
  ins("units", { project: L, squad: "alpha", slug: "u1-new", ord: 1, status: "done", pr: "41", plan, done_at: MON + 2 * H, ...at });
  ins("units", { project: L, squad: "alpha", slug: "u2-doing", ord: 2, status: "dispatched", plan, ...at });
  ins("units", { project: L, squad: "alpha", slug: "u3-todo", ord: 3, status: "planned", plan, ...at });
  ins("units", { project: L, squad: "alpha", slug: "u4-dropped", ord: 4, status: "cancelled", plan, ...at });
  ins("events", { at: MON - 2 * H, project: L, squad: "alpha", unit: "u0-old", kind: "unit_done", payload: { pr: 40 } });
  ins("events", { at: MON + 2 * H, project: L, squad: "alpha", unit: "u1-new", kind: "unit_done", payload: { pr: 41 } });
  ins("observed_prs", { project: L, ref: "o/r#40", pr: 40, state: "MERGED", merged_at: MON - 2 * H, unit: "alpha/u0-old", title: "Old thing shipped", observed_at: T });
  ins("observed_prs", { project: L, ref: "o/r#41", pr: 41, state: "MERGED", merged_at: MON + 2 * H, unit: "alpha/u1-new", title: "New thing shipped", observed_at: T });
  ins("observed_prs", { project: L, ref: "o/r#42", pr: 42, state: "OPEN", verdict: "blocked", reasons: JSON.stringify("ci-failed"), unit: "alpha/u2-doing", title: "Doing thing", observed_at: T });
  // Creation: u0..u3 existed before the window; u5-added was added in it. u2 was dispatched and u1 finished in it.
  for (const u of ["u0-old", "u1-new", "u2-doing", "u3-todo", "u4-dropped"]) ins("events", { at: MON - 3 * DAY, project: L, squad: "alpha", kind: "squad_state", payload: { cmd: "add-unit", args: [u] } });
  ins("units", { project: L, squad: "alpha", slug: "u5-added", ord: 5, status: "planned", plan, ...at });
  ins("events", { at: MON + 3 * H, project: L, squad: "alpha", kind: "squad_state", payload: { cmd: "add-unit", args: ["u5-added"] } });
  ins("events", { at: MON + H, project: L, squad: "alpha", unit: "u2-doing", kind: "unit_dispatched", payload: {} });
  ins("events", { at: MON + 2 * H, project: L, squad: "alpha", unit: "u2-doing", kind: "unit_pr", payload: { pr: 42 } });
  ins("events", { at: MON - 2 * H, project: L, squad: "alpha", unit: "u0-old", kind: "unit_pr", payload: { pr: 40 } });
  ins("events", { at: MON + 4 * H, project: L, squad: "alpha", unit: "u1-new", kind: "unit_pr", payload: { pr: 41 } });
  // A merged PR with no unit (conventional-commit prefix and a [PRD-…] tag in its title), one merged two days before.
  ins("observed_prs", { project: L, ref: "o/r#70", pr: 70, state: "MERGED", merged_at: MON + 5 * H, title: "fix(console): Stop the flicker [PRD-12345]", observed_at: T });
  ins("observed_prs", { project: L, ref: "o/r#71", pr: 71, state: "MERGED", merged_at: MON - 2 * DAY, title: "Ancient", observed_at: T });
  // Squads started in the window; questions answered in it and the day before.
  ins("events", { at: MON + 6 * H, project: L, squad: "stuck", kind: "squad_run", payload: { id: 1 } });
  ins("events", { at: MON + 7 * H, project: L, squad: "alpha", kind: "question_answered", payload: { id: "qa", title: "Approve plan: x?", answer: "approved", via: "board" } });
  ins("events", { at: MON - H, project: L, squad: "alpha", kind: "question_answered", payload: { id: "qb", title: "Earlier?", answer: "yes", via: "board" } });
  // Squad "stuck": waiting on the operator, no unit progress, restarted three times in the window.
  ins("squads", { project: L, topic: "stuck", status: "waiting-on-you", doc: { topic: "stuck" }, ...at });
  ins("units", { project: L, squad: "stuck", slug: "s1", ord: 0, status: "planned", plan, ...at });
  for (const t of [MON - DAY, MON + H, MON + 2 * H, MON + 3 * H]) ins("events", { at: t, project: L, squad: "stuck", member: "builder/s1", kind: "member_started", payload: {} });
  // Squad "shipped" went done in the window (still live, not closed); "old-done" went done before it.
  ins("squads", { project: L, topic: "shipped", status: "done", doc: { topic: "shipped", debrief: `Shipped: the widget.\nAsk ${EMAIL} for access.` }, ...at });
  ins("units", { project: L, squad: "shipped", slug: "w1", ord: 0, status: "done", pr: "60", plan, done_at: MON + 8 * H, ...at });
  ins("events", { at: MON + 9 * H, project: L, squad: "shipped", kind: "squad_state", payload: { cmd: "set-status", args: ["done"] } });
  ins("squads", { project: L, topic: "old-done", status: "done", doc: { topic: "old-done", debrief: "Long ago." }, ...at });
  ins("events", { at: MON - 2 * DAY, project: L, squad: "old-done", kind: "squad_state", payload: { cmd: "set-status", args: ["done"] } });
  // Questions: one open, one answered.
  ins("questions", { id: "q-open", project: L, squad: "stuck", title: `Which API shape? Ask ${EMAIL}`, asked_at: MON + 4 * H, status: "open", blocking: 1 });
  ins("questions", { id: "q-old", project: L, squad: "alpha", title: "Old open one", asked_at: MON - 2 * DAY, status: "open" });
  ins("questions", { id: "q-done", project: L, squad: "alpha", title: "Answered already?", asked_at: MON + H, status: "answered" });
  // Accounts: one expired (label holds an email), one fine.
  ins("observed_accounts", { agent: "claude", account: "acct-a", label: EMAIL, note: "expired", observed_at: T });
  // Broken skills + limited past the window; an expired account that is disabled is left out.
  ins("observed_accounts", { agent: "claude", account: "acct-c", skills: "broken: no ce-work", limited_until: String(T + DAY), observed_at: T });
  ins("observed_accounts", { agent: "codex", account: "off", note: "expired", observed_at: T });
  // U241: a refused usage check (with stale figures) is not a login problem.
  ins("observed_accounts", { agent: "claude", account: "acct-r", session_pct: "45", weekly_pct: "20", note: `refused@${T - 60}`, observed_at: T });
  ins("accounts", { agent: "codex", account: "off", state: "disabled", observed_at: T });
  ins("observed_accounts", { agent: "claude", account: "acct-b", label: `other-${EMAIL}`, session_pct: "12", weekly_pct: "40", skills: "ok", observed_at: T });
  // Studio alert, plus the brief's own alert (left out).
  ins("observed_alerts", { project: L, id: "loop-x", doc: { title: "Poke unanswered", question: "The Lead went quiet.", since: new Date((MON + 5 * H) * 1000).toISOString() }, observed_at: T });
  ins("observed_alerts", { project: L, id: "brief-2026-11-09", doc: { title: "New morning brief", question: "Read it." }, observed_at: T });
  // Archived squads: one closed in the window with a debrief, one without, one closed before the window.
  const arch = (topic: string, closed: number, extra: Record<string, unknown>) =>
    ins("documents", { project: L, path: `${L}/archive/${topic}-x.json`, mtime: closed, body: { topic, closed_at: new Date(closed * 1000).toISOString(), status: "closed", units: [{ slug: "a1", status: "done" }], ...extra }, observed_at: T });
  arch("closed-debrief", MON + 6 * H, { debrief: "Set out to do: X.\nShipped: #50.\nLearned: Y.\nStill open: none.\nCost: 2M." });
  arch("closed-bare", MON + 7 * H, {});
  arch("closed-old", MON - 3 * DAY, { debrief: "Ancient." });
  // Spend: alpha grew 1M → 3M; "fresh" is new since Monday's brief; "idle" did not move.
  ins("observed_spend", { project: L, squad: "alpha", since: MON - 5 * DAY, total: 3_000_000, observed_at: T });
  ins("observed_spend", { project: L, squad: "stuck", since: MON - 5 * DAY, total: 500_000, observed_at: T });
  const req = (date: string, since: number, until: number, spend: Record<string, number>) =>
    ins("requests", { project: L, kind: "studio", key: `briefing:${L}:${date}`, created_at: until, payload: { action: "briefing", label: L, date, since, until, spend, line: `briefing: write the morning brief for ${L}, ${date}` } });
  req("2026-11-09", MON - DAY, MON, { alpha: 1_000_000, idle: 700, stuck: 500_000 });
  // A retry of Monday's brief the loop gave up on never reached the Studio: it is no spend baseline.
  ins("requests", { project: L, kind: "studio", key: `briefing:${L}:2026-11-09:gave-up`, created_at: MON + H, done_at: MON + 2 * H, result: { ok: false },
    payload: { action: "briefing", label: L, date: "2026-11-09", since: MON - DAY, until: MON + H, spend: { alpha: 2_900_000 } } });
  req("2026-11-10", MON, TUE, { alpha: 3_000_000, fresh: 250_000, idle: 700, stuck: 500_000 });
  req("2026-11-11", TUE, TUE + DAY, { alpha: 3_100_000, fresh: 250_000, idle: 700, stuck: 500_000 });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ds-briefing-input-"));
  plan = join(dir, "fx-plan.md");
  writeFileSync(plan, ["- U1 — `u1-new` New unit title — deps: none", "- U2 — `u2-doing` Doing unit title — deps: none", "- U3 — `u3-todo` Todo unit title — deps: u2-doing"].join("\n"));
  const s = open(dir);
  seed(s);
  s.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  s.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const facts = (opt: { date?: string; since?: string } = { date: "2026-11-10" }) => {
  const s = openReadOnly(dir);
  try { return collect(s, windowOf(s, L, opt, T)); } finally { s.close(); }
};
const ds = (...args: string[]) => {
  const r = Bun.spawnSync([DS, "briefing-input", L, ...args], { env: { ...process.env, DS_STATE_ROOT: dir, DS_NOW: String(T), TZ: "Europe/Berlin" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

describe("ds briefing-input", () => {
  test("the window comes from the dated request", () => {
    const f = facts();
    expect([f.since, f.until, f.date]).toEqual([MON, TUE, "2026-11-10"]);
  });

  test("PRs merged in the window are squad PRs only, grouped by squad with cleaned titles; the day before is a count", () => {
    const m = facts().merged;
    expect([m.total, m.before]).toEqual([1, 1]);   // 41 in the window; 40 the day before; #70 has no unit
    expect(m.squads.map((g) => [g.squad, g.prs])).toEqual([["alpha", [{ pr: 41, title: "New thing shipped" }]]]);
    expect(render(facts()).join("\n")).not.toContain("other (no unit)");
    expect(render(facts()).join("\n")).not.toContain("Ancient");
  });

  test("opened PRs, and which are still open with a problem; squads started; units started; decisions with the day before", () => {
    const f = facts();
    expect(f.opened).toEqual({ total: 2, before: 1, stuck: [{ pr: 42, title: "Doing thing", why: "ci-failed" }] });
    expect(f.started).toEqual({ squads: ["stuck"], units: 1 });
    expect([f.decided.total, f.decided.before, f.decided.items]).toEqual([1, 1, [{ squad: "alpha", title: "Approve plan: x?", answer: "approved" }]]);
    const md = render(f).join("\n");
    expect(md).toContain("- opened: 2 (day before: 1); still open with a problem: Doing thing (#42) — ci-failed");
    expect(md).toContain("- you decided: 1 (day before: 1):");
  });

  test("progress is % done at the window's start and now: a unit finished in the window, a unit added, a cancelled one left out; no `N of M`", () => {
    const f = facts();
    // before: u0 done of u0..u3 (u4 cancelled, u5 added later) = 1/4; now: u0 + u1 of five = 2/5.
    expect(f.progress.map((p) => [p.squad, p.before, p.now, p.added])).toEqual([["alpha", 25, 40, 1]]);   // shipped (1 of 1) did not move in the window
    expect(render(f).join("\n")).toContain("- alpha: 25% → 40% (+1 unit)");
    expect(render(f).join("\n")).not.toMatch(/\d+ of \d+/);
  });

  test("squads that merged nothing are quiet; waiting vs new needs-you", () => {
    const f = facts();
    expect(f.quiet).toEqual(["stuck"]);
    expect(f.needs.questions.map((q) => [q.id, q.new])).toEqual([["q-old", false], ["q-open", true]]);
    expect(f.needs.alerts.map((a) => a.new)).toEqual([true]);
    const md = render(f).join("\n");
    expect(md).toMatch(/- waiting \d+d question \(alpha\): Old open one/);
    expect(md).toContain("- new question (stuck, blocking): Which API shape?");
  });

  test("an open question, an alert, a waiting squad and an expired account need you; an answered question does not", () => {
    const n = facts().needs;
    expect(n.questions.map((q) => [q.id, q.squad, q.blocking])).toEqual([["q-old", "alpha", false], ["q-open", "stuck", true]]);
    expect(n.alerts.map((a) => a.title)).toEqual(["Poke unanswered"]);
    expect(n.squads).toEqual([{ squad: "stuck", status: "waiting-on-you" }]);
    expect(n.accounts.map((a) => a.account)).toEqual(["claude:acct-a", "claude:acct-c"]);
    expect(n.accounts[0].problem).toBe("login expired");   // acct-r (note refused@…) is not listed
    expect(n.accounts[1].problem).toMatch(/^skills broken: no ce-work; limited until /);
    const md = render(facts()).join("\n");
    expect(md).toContain("Which API shape?");
    expect(md).not.toContain("Answered already?");
    expect(md).not.toContain("New morning brief");
  });

  test("a squad finished in the window shows its debrief, or `no debrief`; one finished earlier is absent", () => {
    const f = facts();
    expect(f.finished.map((x) => [x.squad, x.how, x.debrief?.split("\n")[0] ?? null])).toEqual([
      ["shipped", "done", "Shipped: the widget."], ["closed-bare", "closed", null], ["closed-debrief", "closed", "Set out to do: X."]]);
    const md = render(f).join("\n");
    expect(md).toMatch(/closed-debrief \(closed [^)]+\): debrief:\n {2}> Set out to do: X\.\n {2}> Shipped: #50\./);
    expect(md).toMatch(/closed-bare \(closed [^)]+\): no debrief/);
    expect(md).toMatch(/shipped \(done [^)]+\): debrief:\n {2}> Shipped: the widget\./);
    expect(md).not.toContain("closed-old");
    expect(md).not.toContain("old-done");
    expect(f.progress.map((p) => p.squad)).toEqual(["alpha"]);   // progress lists only squads that moved
  });

  test("spend = this request's snapshot minus the previous one; a squad new since then is `since start`", () => {
    const sp = facts().spend;
    expect(sp.squads).toEqual([{ squad: "alpha", tokens: 2_000_000, since_start: false }, { squad: "fresh", tokens: 250_000, since_start: true }]);
    expect(sp.total).toBe(2_250_000);
    expect(sp.before).toBeNull();   // no brief before Monday's: no day-before figure
    const md = render(facts()).join("\n");
    expect(md).toContain("- alpha: 2.0M tokens\n");
    expect(md).toContain("- fresh: 250k tokens (since start)");
    expect(md).toContain("- account claude:acct-b: session 12%, weekly 40%");
  });

  test("spend of the day before = the previous snapshot minus the one before it, when both are known", () => {
    const sp = facts({ date: "2026-11-11" }).spend;
    expect(sp.total).toBe(100_000);          // alpha 3.0M → 3.1M
    expect(sp.before).toBe(2_250_000);       // alpha 1M → 3M, fresh 0 → 250k
    expect(render(facts({ date: "2026-11-11" })).join("\n")).toContain("- total: 100k tokens (day before: 2.3M)");
  });

  test("the first brief has no baseline: live squads count since they started", () => {
    const sp = facts({ date: "2026-11-09" }).spend;
    expect(sp.baseline).toBe(false);
    expect(sp.squads.map((x) => [x.squad, x.since_start])).toEqual([["alpha", true], ["stuck", true]]);   // idle: no live squad
  });

  test("signals: a live squad with no unit progress, and more than one restart", () => {
    expect(facts().signals).toEqual({ no_progress: ["stuck"], restarts: [{ squad: "stuck", count: 3 }] });
  });

  test("--since is a manual window to now, with the last earlier brief as the spend baseline", () => {
    const f = facts({ since: String(TUE + 10) });
    expect([f.since, f.until]).toEqual([TUE + 10, T]);
    expect(f.spend.squads).toEqual([]);   // nothing moved since Tuesday's snapshot
  });

  test("--date with no such request: a clear error, exit 1; a bad date or no window: usage, exit 2", () => {
    const miss = ds("--date", "2026-11-12");
    expect(miss.code).toBe(1);
    expect(miss.err).toContain(`no briefing request for ${L} on 2026-11-12`);
    expect(ds("--date", "11/11").code).toBe(2);
    expect(ds().code).toBe(2);
    expect(ds("--date", "2026-11-10", "--since", String(MON)).code).toBe(2);
  });

  test("--json parses; no output line holds an email address; the command never writes", () => {
    const db = join(dir, "loop.db"), before = statSync(db).mtimeMs;
    const j = ds("--date", "2026-11-10", "--json");
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out).label).toBe(L);
    const md = ds("--date", "2026-11-10");
    expect(md.code).toBe(0);
    // The seeded address sits in a question title, a debrief and the account labels.
    for (const out of [j.out, md.out]) expect(out).not.toMatch(/@example\.com/);
    expect(md.out).toContain("Which API shape? Ask <email>");
    expect(md.out).toContain("> Ask <email> for access.");
    expect(md.out).toContain("claude:acct-a: login expired");
    expect(statSync(db).mtimeMs).toBe(before);
  });

  test("a busy window (150 waiting squads, 40 questions, 30 alerts, 5,000 noise events) is cut at the line cap", () => {
    const busy = mkdtempSync(join(tmpdir(), "ds-briefing-busy-"));
    try {
      const s = open(busy);
      const at = { observed_at: T, updated_at: T };
      s.tx(() => {
        for (let q = 0; q < 150; q++) {
          insert(s, "squads", { project: L, topic: `sq-${q}`, status: "waiting-on-you", doc: {}, ...at });
          for (let u = 0; u < 10; u++) insert(s, "units", { project: L, squad: `sq-${q}`, slug: `u${u}`, ord: u, status: "dispatched", ...at });
        }
        for (let q = 0; q < 40; q++) insert(s, "questions", { id: `q${q}`, project: L, squad: "sq-0", title: `Question ${q}?`, asked_at: MON, status: "open" });
        for (let a = 0; a < 30; a++) insert(s, "observed_alerts", { project: L, id: `al-${a}`, doc: { title: `Alert ${a}` }, observed_at: T });
        for (let i = 0; i < 5000; i++) {
          insert(s, "events", { at: MON + 60 + i, project: L, squad: `sq-${i % 60}`, unit: `u${i % 10}`, member: `builder/u${i % 10}`,
            kind: ["action", "spend", "unit_done", "member_started", "unit_pr"][i % 5], payload: { pr: 1000 + i } });
        }
        insert(s, "requests", { project: L, kind: "studio", key: `briefing:${L}:2026-11-10`, created_at: TUE, payload: { since: MON, until: TUE, spend: {} } });
      });
      s.close();
      const r = Bun.spawnSync([DS, "briefing-input", L, "--date", "2026-11-10"], { env: { ...process.env, DS_STATE_ROOT: busy, DS_NOW: String(T), TZ: "Europe/Berlin" } });
      expect(r.exitCode).toBe(0);
      const out = r.stdout.toString().trimEnd().split("\n");
      expect(out.length).toBe(MAX_LINES);
      expect(out.at(-1)).toMatch(/^… \d+ more lines cut \(cap 200\)$/);
      expect(out).toContain("  - … and 25 more open questions");
      expect(out).toContain("  - … and 20 more alerts");
    } finally { rmSync(busy, { recursive: true, force: true }); }
  });
});

// brief-other-prs U2: "Elsewhere in <repo>" and "try it:".
describe("Elsewhere and try it", () => {
  const REPO = "acme/app", ELS = "fx2";
  const hdr = `## Elsewhere in ${REPO}`;
  function world(setup: (s: Store, add: (pr: number, title: string, who: string, at: number, extra?: Record<string, unknown>) => void) => void, gh: Record<string, unknown> = {}) {
    const d = mkdtempSync(join(tmpdir(), "ds-briefing-els-"));
    const s = open(d);
    insert(s, "config", { project: ELS, file: "github", key: "repo:path:/x/app", value: REPO, observed_at: T });
    insert(s, "observed_github", { repo: REPO, default_branch: "main", merges_from: MON - 4 * DAY, merges_until: T, merges_ok_at: T, observed_at: T, ...gh });
    insert(s, "requests", { project: ELS, kind: "studio", key: `briefing:${ELS}:2026-11-10`, created_at: TUE, payload: { since: MON, until: TUE, spend: {} } });
    const add = (pr: number, title: string, who: string, at: number, extra: Record<string, unknown> = {}) =>
      insert(s, "observed_merges", { repo: REPO, pr, title, author_login: who, author_name: who.toUpperCase(), base: "main", merged_at: at, observed_at: T, ...extra });
    setup(s, add);
    s.close();
    const run = (...a: string[]) => Bun.spawnSync([DS, "briefing-input", ELS, ...a], { env: { ...process.env, DS_STATE_ROOT: d, DS_NOW: String(T), TZ: "Europe/Berlin" } });
    return { d, md: () => run("--date", "2026-11-10").stdout.toString(), json: () => JSON.parse(run("--date", "2026-11-10", "--json").stdout.toString()) };
  }
  const block = (md: string) => { const i = md.indexOf(hdr), j = md.indexOf("\n## 4.", i); return md.slice(i, j).trimEnd().split("\n"); };

  test("a merge that is also a unit PR shows only in section 3; groups, people, days, link and the day before", () => {
    const w = world((s, add) => {
      insert(s, "squads", { project: ELS, topic: "sq", status: "running", doc: {}, observed_at: T, updated_at: T });
      insert(s, "units", { project: ELS, squad: "sq", slug: "u1", ord: 0, status: "done", pr: "11", observed_at: T, updated_at: T });
      insert(s, "observed_prs", { project: ELS, ref: `${REPO}#10`, repo: REPO, pr: 10, state: "MERGED", merged_at: MON + H, unit: "sq/u1", title: "squad thing", observed_at: T });
      add(10, "feat(core): squad thing", "ann", MON + H);
      add(11, "feat(core): other squad pr by number", "ann", MON + H);
      add(12, "fix(ui): Button [ABC-123] mail me@x.io", "bob", MON + 2 * H);
      add(13, "fix(ui): second", "cy", MON + DAY - 5 * H);
      add(14, "chore: no scope", "ann", MON + 3 * H);
      add(15, "old", "ann", MON - H);
    });
    try {
      const md = w.md();
      expect(md).toContain("Window:");
      const b = block(md);
      expect(b[0]).toContain(hdr);
      expect(b.join("\n")).not.toContain("squad thing");
      expect(b).toContain(`- link: https://github.com/${REPO}/pulls?q=is%3Apr+is%3Amerged+merged%3A${encodeURIComponent(new Date(MON * 1000).toISOString().replace(/\.\d+Z/, "Z"))}..${encodeURIComponent(new Date(TUE * 1000).toISOString().replace(/\.\d+Z/, "Z"))}`);
      expect(b).toContain("- 3 merged by 3 people (day before: 1); read: complete");
      const ui = b.find((l) => l.startsWith("- ui (2)"))!;
      expect(ui).toMatch(/BOB — Mon 9 Nov/);
      expect(ui).toMatch(/CY — Tue 10 Nov/);
      expect(ui).toContain("titles: Button mail <email>; second");
      expect(ui).not.toMatch(/ABC-123|@x\.io/);
      expect(b.some((l) => l.startsWith("- chore (1)"))).toBe(true);
      expect(w.json().elsewhere[0].groups.map((g: { scope: string }) => g.scope)).toEqual(["ui", "chore"]);
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  });

  test("a never-read record says `incomplete:`, lists no groups and gives no repo total", () => {
    const w = world((_s, add) => add(1, "feat(a): x", "ann", MON + H), { merges_from: null, merges_until: null });
    try {
      const b = block(w.md());
      expect(b.filter((l) => l.startsWith("- read: incomplete:") && l.includes("not read yet"))).toHaveLength(1);
      expect(b).toContain("- repo total: unknown (merges not read yet); the squad count is not the repo total");
      expect(b.some((l) => /^- a \(/.test(l))).toBe(false);
      const e = w.json().elsewhere[0];
      expect(e.total).toBeNull();
      expect(e.read).toMatchObject({ complete: false, state: "incomplete" });
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  });

  test("a record that starts late, ends past the tolerance, or failed its last read is `partial:` and still shows its groups", () => {
    for (const [gh, why] of [[{ merges_from: MON + H }, "starts"], [{ merges_until: TUE - 20 * 60 }, "covers up to"], [{ merges_error: "boom" }, "failed"]] as [Record<string, unknown>, string][]) {
      const w = world((_s, add) => add(1, "feat(a): x", "ann", MON + 2 * H), gh);
      try {
        const b = block(w.md());
        expect(b.filter((l) => l.includes("read: partial:") && l.includes(why))).toHaveLength(1);
        expect(b.some((l) => /^- a \(1\)/.test(l))).toBe(true);
        expect(b.some((l) => l.startsWith("- repo total: 1 merged (squads: 0, others: 1)"))).toBe(true);
        const e = w.json().elsewhere[0];
        expect(e.read).toMatchObject({ complete: false, state: "partial" });
        expect(e.total).toBe(1);
      } finally { rmSync(w.d, { recursive: true, force: true }); }
    }
  });

  test("the 19 Nov case: a record 8 minutes short of the close shows the block, `complete up to`, the lag line and the repo total", () => {
    const w = world((s, add) => {
      insert(s, "observed_prs", { project: ELS, ref: `${REPO}#10`, repo: REPO, pr: 10, state: "MERGED", merged_at: MON + H, unit: "sq/u1", title: "squad thing", observed_at: T });
      add(10, "feat(core): squad thing", "ann", MON + H);
      add(11, "fix(ui): a", "bob", MON + 2 * H);
      add(12, "fix(ui): b", "cy", MON + 3 * H);
    }, { merges_until: TUE - 8 * 60 });
    try {
      const b = block(w.md());
      expect(b.some((l) => /^- 2 merged by 2 people .*; read: complete up to /.test(l))).toBe(true);
      expect(b.some((l) => l.startsWith("- the last 8 min before ") && l.includes("may be missing"))).toBe(true);
      expect(b).toContain("- repo total: 3 merged (squads: 1, others: 2)");
      expect(b.some((l) => l.startsWith("- ui (2)"))).toBe(true);
      const e = w.json().elsewhere[0];
      expect(e.read).toMatchObject({ complete: true, state: "lag", upto: TUE - 480 });
      expect(e.repo_total).toEqual({ all: 3, squads: 1, others: 2 });
      expect(w.md()).toContain("## 3. Squad PRs merged in the window:");
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  });

  test("briefing_merges_lag_min 0 makes any lag partial; a wider one accepts it", () => {
    for (const [lag, state] of [["0", "partial"], ["30", "lag"]] as const) {
      const w = world((s, add) => { add(1, "feat(a): x", "ann", MON + H); insert(s, "config", { project: ELS, file: "limits.conf", key: "briefing_merges_lag_min", value: lag, observed_at: T }); }, { merges_until: TUE - 20 * 60 });
      try { expect(w.json().elsewhere[0].read.state).toBe(state); } finally { rmSync(w.d, { recursive: true, force: true }); }
    }
  });

  test("the previous brief's record end carries its unread minutes into this block; no merges_upto carries nothing", () => {
    for (const carry of [true, false]) {
      const w = world((s, add) => {
        insert(s, "requests", { project: ELS, kind: "studio", key: `briefing:${ELS}:2026-11-09`, created_at: MON, payload: { date: "2026-11-09", since: MON - DAY, until: MON, spend: {}, ...(carry ? { merges_upto: { [REPO]: MON - 8 * 60 } } : {}) } });
        add(1, "feat(a): late one", "ann", MON - 5 * 60);
        add(2, "feat(a): in window", "ann", MON + H);
      });
      try {
        const e = w.json().elsewhere[0];
        const b = block(w.md());
        expect(e.total).toBe(carry ? 2 : 1);
        expect(b.some((l) => l.startsWith("- includes 1 merged ") && l.endsWith("after the last brief's record ended"))).toBe(carry);
        expect(e.carried).toEqual(carry ? { count: 1, from: MON - 480, to: MON } : null);
      } finally { rmSync(w.d, { recursive: true, force: true }); }
    }
  });

  test("20 scopes give 15 groups and one `and N more` line, and the block stays within 40 lines", () => {
    const w = world((_s, add) => { for (let i = 0; i < 20; i++) for (let j = 0; j <= 20 - i; j++) add(100 * i + j + 1, `feat(s${String(i).padStart(2, "0")}): t${j}`, `p${j % 7}`, MON + H + j); });
    try {
      const b = block(w.md());
      expect(b.filter((l) => /^- s\d\d \(/.test(l))).toHaveLength(15);
      expect(b.filter((l) => l.startsWith("- and "))).toHaveLength(1);
      expect(b.find((l) => l.startsWith("- and "))).toMatch(/^- and \d+ more in 5 small groups: s15, s16/);
      expect(b.length).toBeLessThanOrEqual(40);
      expect(b.find((l) => l.startsWith("- s00 ("))).toMatch(/titles: t\d+; t\d+; t\d+$/);
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  });

  test("a merge into a non-default base gives the one extra line and is not in a group", () => {
    const w = world((_s, add) => { add(1, "feat(a): x", "ann", MON + H); add(2, "fix(rel): y", "bob", MON + 2 * H, { base: "release/2" }); });
    try {
      const b = block(w.md());
      expect(b).toContain("- 1 merged into a branch other than the default (mostly release/2): rel");
      expect(b.some((l) => l.startsWith("- rel ("))).toBe(false);
      expect(b).toContain("- 2 merged by 2 people (day before: 0); read: complete");
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  });

  test("a finished squad's debrief gives `try it: N steps`, `nothing to try — why`, or `missing`", () => {
    const w = world((s) => {
      const sq = (topic: string, debrief?: string) => {
        insert(s, "squads", { project: ELS, topic, status: "done", doc: debrief === undefined ? { topic } : { topic, debrief }, observed_at: T, updated_at: T });
        insert(s, "events", { at: MON + 9 * H, project: ELS, squad: topic, kind: "squad_state", payload: { cmd: "set-status", args: ["done"] } });
      };
      sq("steps", "Shipped: x.\n6. **Try it:** 1. Open the board. 2. Click Briefs. 3. See the block.");
      sq("lines", "Shipped: x.\nTry it:\n1. one\n2. two");
      sq("none", "Shipped: x.\nTry it: nothing to try by hand — docs only");
      sq("bare", "Shipped: x.");
    });
    try {
      const f = w.json().finished as { squad: string; try_it: unknown }[];
      const of = (n: string) => f.find((x) => x.squad === n)!.try_it;
      expect(of("steps")).toEqual({ kind: "steps", steps: 3 });
      expect(of("lines")).toEqual({ kind: "steps", steps: 2 });
      expect(of("none")).toEqual({ kind: "nothing", why: "docs only" });
      expect(of("bare")).toEqual({ kind: "missing" });
      const md = w.md();
      expect(md).toMatch(/- steps \(done [^)]+\): debrief:\n(?: {2}> .*\n)* {2}try it: 3 steps/);
      expect(md).toMatch(/- none \(done [^)]+\): debrief:\n(?: {2}> .*\n)* {2}try it: nothing to try — docs only/);
      expect(md).toMatch(/- bare \(done [^)]+\): debrief:\n(?: {2}> .*\n)* {2}try it: missing/);
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  });
});
