// phases.test.ts — U22: a Builder whose unit PR is open is restarted fresh on the babysit row.
// reconcilers/phases.ts phases the member and writes the wish; the pick reconciler (U9) picks it
// through the ladder (`builder-hard-babysit`, haiku in the fixture roster), and the member
// fulfiller starts it on the fake Orca in its own worktree with the babysit prompt. Works on a copy
// of tests/fixtures/loop/state (unit u2 is dispatched with PR 93) and of conventions/.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import phases, { babysitPrompt, phaseFor } from "../../bin/loop/reconcilers/phases.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const U2 = "u2-sqlite-store-migrations-and";
const WT = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-builder-u2-sqlite-store-migrations-and-demo";
const BRANCH = "acme-org/ds-dev-studio-builder-u2-sqlite-store-migrations-and-demo";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
// The fixture plus u2's Builder: running on opus since its start, idle for 10 minutes, PR 93 open.
function fixture(): { s: Store; id: number } {
  const d = mkdtempSync(join(tmpdir(), "zzloop-")), conv = mkdtempSync(join(tmpdir(), "zzconv-"));
  temps.push(d, conv);
  cpSync(join(ROOT, "tests", "fixtures", "loop", "state"), d, { recursive: true });
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(d, "accounts.tsv"));
  const s = open(d);
  stores.push(s);
  importJson(s);
  importConfig(s, d, conv);
  s.db.run(`INSERT INTO members (project, squad, wt, role, suffix, agent, model, effort, status, phase, want, want_by, want_at, want_result, observed_at, updated_at)
    VALUES ('fx', 'demo', ?, 'builder', ?, 'claude', 'opus', 'high', 'running', 'build', 'running', 'loop', ?, 'fresh', ?, ?)`, [WT, U2, T - 3600, T - 3600, T - 3600]);
  const id = Number((s.db.query("SELECT id FROM members WHERE wt = ?").get(WT) as Row).id);
  s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "idle", since: T - 600, unread: 0, presence: "running", walk: "running", account_at: T - 1, observed_at: T });   // its agent is live
  s.upsert("observed_prs", { project: "fx", ref: `demo/${U2}` }, { pr: 93, state: "OPEN", head: BRANCH, base: "main", unit: `demo/${U2}`, observed_at: T });
  s.upsert("coordinators", { project: "fx", squad: "demo" }, { handle: "term_loop", run_id: "run_demo", created_at: T - 3600, bound_at: T - 3600 });   // the decider's stop needs its pane
  return { s, id };
}

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
// The production order: phases (p) before the decider, then the fulfillers.
function rig(s: Store) {
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [phases, decider, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { const r = await loop.tick(at); await act.drain(); return r; };
  return { orca, tick };
}
const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;
const phased = (s: Store) => s.db.query("SELECT * FROM events WHERE kind = 'member_phase'").all() as Row[];
const starts = (o: FakeOrca) => o.of("worker-start").filter((c) => c.args[1] === WT);

describe("phases", () => {
  test("an idle Builder with an open PR is phased once and started fresh on the babysit row", async () => {
    const { s, id } = fixture();
    const { orca, tick } = rig(s);
    await tick(T);
    expect(member(s, id).phase).toBe("babysit");
    const ev = phased(s);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.unit).toBe(U2);
    const p = JSON.parse(String(ev[0]!.payload));
    expect(p).toMatchObject({ phase: "babysit", was: "build", unit: U2, pr: 93, model: "haiku", row: "builder-hard-babysit" });

    // U154: the decider stops it when idle; the observer then reads no agent.
    expect(orca.of("worker-stop").filter((c) => c.args[1] === WT)).toHaveLength(1);
    expect(starts(orca)).toHaveLength(0);
    s.upsert("observed_workers", { project: "fx", wt: WT }, { presence: "none", account_at: T + 1, observed_at: T + 1 });

    await tick(T + 1);
    const st = starts(orca);
    expect(st).toHaveLength(1);
    const [, wt, prompt, agent, model] = st[0]!.args.map(String);
    expect([wt, agent, model]).toEqual([WT, "claude", "haiku"]);
    expect(prompt).toContain("PR: #93");
    expect(prompt).toContain(`Branch: ${BRANCH}`);
    expect(prompt).toContain(join(s.root, "fx", "journals", `demo-builder-${U2}.md`));
    expect(prompt).toContain(`review-unit.sh fx origin/main`);
    expect(prompt).toContain(`finish-unit.sh ${join(s.root, "fx", "squads", "demo.json")} ${U2}`);
    expect(member(s, id)).toMatchObject({ model: "haiku", want: "running", want_result: "fresh" });

    // A second tick (the new session idle again at once) does nothing: babysit is never re-phased.
    s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "idle", since: T - 600 });
    await tick(T + 60);
    await tick(T + 600);
    expect(phased(s)).toHaveLength(1);
    expect(starts(orca)).toHaveLength(1);
    expect(orca.of("worker-stop").filter((c) => c.args[1] === WT)).toHaveLength(1);
  });

  const none = async (setup: (s: Store, id: number) => void) => {
    const { s, id } = fixture();
    setup(s, id);
    const { orca, tick } = rig(s);
    await tick(T);
    expect(member(s, id).phase).toBe("build");
    expect(phased(s)).toHaveLength(0);
    expect(starts(orca)).toHaveLength(0);
  };
  test("a Builder done for the quiet window is phased like an idle one", async () => {
    const { s, id } = fixture();
    s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "done", since: T - 600 });
    const { orca, tick } = rig(s);
    await tick(T);
    expect(member(s, id).phase).toBe("babysit");
    expect(phased(s)).toHaveLength(1);
    expect(orca.of("worker-stop").filter((c) => c.args[1] === WT)).toHaveLength(1);
    s.upsert("observed_workers", { project: "fx", wt: WT }, { presence: "none", account_at: T + 1, observed_at: T + 1 });
    await tick(T + 1);
    expect(starts(orca)).toHaveLength(1);
  });
  test("a busy Builder is not phased", () => none((s) => s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "working" })));
  test("a waiting Builder is not phased", () => none((s) => s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "waiting" })));
  test("a Builder done for under the quiet window is not phased", () => none((s) => s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "done", since: T - 60 })));
  test("a Builder idle for under the quiet window is not phased", () => none((s) => s.upsert("observed_workers", { project: "fx", wt: WT }, { since: T - 30 })));
  test("a Builder with an undelivered poke is not phased", () => none((s) =>
    s.db.run("INSERT INTO deliveries (project, squad, member, kind, text, tries, state, at) VALUES ('fx', 'demo', ?, 'poke', 'PR 93 has a failing check', 1, 'accepted', ?)", [WT, T - 5])));
  test("a Builder with an unread message is not phased", () => none((s) => s.upsert("observed_workers", { project: "fx", wt: WT }, { unread: 1 })));
  test("a unit with no PR is not phased", () => none((s) => s.db.run("UPDATE units SET pr = NULL WHERE project = 'fx' AND slug = ?", [U2])));
  test("a unit whose PR is not open is not phased", () => none((s) => s.upsert("observed_prs", { project: "fx", ref: `demo/${U2}` }, { state: "MERGED" })));
  test("local-only mode is never phased", () => none((s) => s.upsert("config", { project: "fx", file: "ship-mode", key: "mode" }, { value: "local-only", observed_at: T })));

  test("U154: babysit is monotonic — a closed and reopened PR causes no second restart", async () => {
    const { s, id } = fixture();
    const { orca, tick } = rig(s);
    await tick(T);
    expect(member(s, id).phase).toBe("babysit");
    expect(orca.of("worker-stop").filter((c) => c.args[1] === WT)).toHaveLength(1);
    s.upsert("observed_workers", { project: "fx", wt: WT }, { presence: "none", account_at: T + 1, observed_at: T + 1 });
    await tick(T + 1);
    expect(starts(orca)).toHaveLength(1);
    // The PR closes, then reopens: the phase stays babysit, so no second stop and no second start.
    s.upsert("observed_prs", { project: "fx", ref: `demo/${U2}` }, { state: "MERGED", observed_at: T + 700 });
    await tick(T + 700);
    expect(member(s, id).phase).toBe("babysit");
    s.upsert("observed_prs", { project: "fx", ref: `demo/${U2}` }, { state: "OPEN", observed_at: T + 800 });
    await tick(T + 800);
    expect(phased(s)).toHaveLength(1);
    expect(orca.of("worker-stop").filter((c) => c.args[1] === WT)).toHaveLength(1);
    expect(starts(orca)).toHaveLength(1);
  });

  test("U92 phaseFor: a Builder with an open PR reads as babysit, one without as build", () => {
    const { s } = fixture();
    const m = { role: "builder", squad: "demo", suffix: U2, wt: WT };
    expect(phaseFor(s, "fx", m)).toBe("babysit");
    s.db.run("UPDATE units SET pr = NULL WHERE project = 'fx' AND slug = ?", [U2]);
    expect(phaseFor(s, "fx", m)).toBe("build");
  });

  test("U182: the babysitter brief says merge the base in, not rebase (base_update rebase keeps rebase)", () => {
    const { s } = fixture();
    const p = { project: "fx", squad: "demo", slug: U2, pr: 93, url: null, branch: BRANCH, base: "main", wt: WT, run: "run_demo" };
    const brief = babysitPrompt(s, p);
    expect(brief).toContain("merge origin/main in (not a rebase) on a conflict");
    expect(brief).not.toContain("rebase onto");
    expect(brief).not.toContain("rebase/resolve");
    s.upsert("config", { project: "fx", file: "limits.conf", key: "base_update" }, { value: "rebase", observed_at: T });
    expect(babysitPrompt(s, p)).toContain("rebase onto its base on a conflict");
  });

  test("with no babysit row the ladder falls back to the builder row", async () => {
    const { s, id } = fixture();
    // Neither roster has one (U267: the default's babysit rows fill a project roster that lacks them).
    s.db.run("DELETE FROM config WHERE project IN ('fx', '') AND file = 'roles.conf' AND key LIKE '%-babysit'");
    const { orca, tick } = rig(s);
    await tick(T);
    expect(member(s, id).phase).toBe("babysit");
    expect(JSON.parse(String(phased(s)[0]!.payload))).toMatchObject({ model: "sonnet", row: "builder" });
    expect(orca.of("worker-stop").filter((c) => c.args[1] === WT)).toHaveLength(1);
    s.upsert("observed_workers", { project: "fx", wt: WT }, { presence: "none", account_at: T + 1, observed_at: T + 1 });
    await tick(T + 1);
    expect(starts(orca).map((c) => String(c.args[4]))).toEqual(["sonnet"]);
  });
});
