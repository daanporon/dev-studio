// pr-questions.test.ts — the loop asks the PR questions: human gates, ask, withdraw, poke
// suppression and answer routing, over a hermetic squad (lc) with observed PR rows.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { Action, Actuator } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import lifecycle from "../../bin/loop/reconcilers/lifecycle.ts";
import answerFulfiller from "../../bin/loop/fulfil/answer.ts";
import { open as askOpen, answer } from "../../bin/loop/messages/questions.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const T = 1_800_000_000;
const LEAD = "wt-lead::/ws/ds-lead-lc", B = "wt-b1::/ws/ds-builder-u1-lc";
const NWO = "o/r";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function squad(): { s: Store; root: string } {
  const root = mkdtempSync(join(tmpdir(), "zzpq-")); temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, "fx", "squads", "demo.json"));
  rmSync(join(root, "fx", "sweep", "pr-health.json"));
  const doc = {
    type: "feature", status: "running", repo: "path:/x/repo", lead_wt: LEAD,
    members: [{ role: "lead", suffix: "", wt: LEAD }, { role: "builder", suffix: "u1", wt: B }],
    units: [{ slug: "u1", status: "dispatched", builder_wt: B, deps: [], hold: false, pr: "7" }],
    leftovers: [],
  };
  writeFileSync(join(root, "fx", "squads", "lc.json"), JSON.stringify(doc, null, 2) + "\n");
  const s = open(root); stores.push(s);
  importJson(s);
  s.upsert("config", { project: "fx", file: "github", key: "repo:path:/x/repo" }, { value: NWO, observed_at: T });
  s.upsert("observed_worktrees", { project: "fx", wt: B }, { path: "/ws/ds-builder-u1-lc", branch: "feat-u1", observed_at: T });
  s.upsert("observed_workers", { project: "fx", wt: B }, { state: "idle", since: T, observed_at: T });
  s.upsert("observed_workers", { project: "fx", wt: LEAD }, { state: "idle", since: T, observed_at: T });
  return { s, root };
}
const cr = (name: string, status: string, conclusion: string | null = null) => ({ __typename: "CheckRun", name, databaseId: 1, status, conclusion, isRequired: false });
const docWith = (checks: unknown[], head = "aaa") => JSON.stringify({
  headRefOid: head, url: "https://github.com/o/r/pull/7",
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] }, reviews: { nodes: [] },
});
function pr(s: Store, set: Row) {
  s.upsert("observed_prs", { project: "fx", ref: `${NWO}#7` },
    { pr: 7, repo: NWO, head: "feat-u1", base: "main", state: "OPEN", verdict: "blocked", reasons: JSON.stringify("checks-failing"), url: "https://github.com/o/r/pull/7", observed_at: T, ...set });
}
function loop(s: Store) {
  const got: Action[] = [];
  const act: Actuator = { act(a) { got.push(a); } };
  const l = new Loop(s, { observers: [], reconcilers: [lifecycle] }, act, { projects: () => ["fx"] });
  l.boot(T);
  return { got, tick: async (at: number) => (await l.tick(at)).acted };
}
const openQs = (s: Store) => s.db.query("SELECT * FROM questions WHERE project = 'fx' AND squad = 'lc' AND status = 'open'").all() as Row[];
const entry = (q: Row) => JSON.parse(String(q.doc)) as Row;
const pokesTo = (a: Action[], wt: string) => a.filter((x) => x.kind === "poke" && x.member === wt);

describe("the loop asks the PR questions", () => {
  test("a board answer keeps the Builder waiting until its delivery request finishes", async () => {
    const { s } = squad();
    const seq = askOpen(s, "fx", "lc", { id: "routing", asker: "lead", blocking: true, unit: "u1", question: "Route the upstream fix" });
    const { row } = s.request("answer", { id: "routing", seq, answer: "Proceed" }, { project: "fx", squad: "lc", member: LEAD });
    answer(s, "fx", "lc", "routing", "Proceed", "board");
    pr(s, { verdict: "blocked", reasons: JSON.stringify("conflicting"), problem: "conflicting", since: T, detail: "full", doc: docWith([]) });
    const l = loop(s);
    expect(pokesTo(await l.tick(T), B)).toEqual([]);
    expect(pokesTo(await l.tick(T + 60), B)).toEqual([]);
    s.db.run("UPDATE requests SET done_at = ? WHERE id = ?", [T + 60, Number(row.id)]);
    expect(pokesTo(await l.tick(T + 120), B).length).toBe(1);
  });

  test.each([["question", "conflict"], ["question", "new head"]])("withdrawing an obsolete PR question does not bypass a separate %s after %s", async (waiting, change) => {
    const { s } = squad();
    pr(s, { reasons: JSON.stringify("required:signoff"), verdict: "waiting", doc: docWith([]) });
    const l = loop(s);
    await l.tick(T);
    expect(openQs(s).length).toBe(1);
    askOpen(s, "fx", "lc", { id: "routing", asker: "lead", blocking: true, unit: "u1", question: "Route the upstream fix" }); // U160: a hold no longer silences a dispatched unit
    pr(s, change === "conflict"
      ? { verdict: "blocked", reasons: JSON.stringify("conflicting"), problem: "conflicting", since: T, doc: docWith([]) }
      : { verdict: "waiting", reasons: JSON.stringify("required:signoff"), doc: docWith([], "bbb") });
    expect(pokesTo(await l.tick(T + 60), B)).toEqual([]);
    expect(openQs(s).some((q) => q.id === "pr-7")).toBe(false);
    expect(openQs(s).map((q) => q.id)).toEqual(["routing"]);
  });

  test("a pending review-bot check holds the ask; once it finishes the loop asks with the gate and link, and pokes the Builder nothing", async () => {
    const { s } = squad();
    pr(s, { doc: docWith([cr("capy/review", "IN_PROGRESS"), cr("Proof hold", "COMPLETED", "FAILURE")]), reasons: JSON.stringify("checks-failing,checks-running") });
    const l = loop(s);
    await l.tick(T);
    expect(openQs(s)).toEqual([]);
    pr(s, { doc: docWith([cr("capy/review", "COMPLETED", "SUCCESS"), cr("Proof hold", "COMPLETED", "FAILURE")]), reasons: JSON.stringify("checks-failing") });
    const acted = await l.tick(T + 5);
    expect(openQs(s).length).toBe(1);
    expect(String(entry(openQs(s)[0]).question)).toContain("PR #7 (lc/u1) waits on: Proof hold");
    expect(String(entry(openQs(s)[0]).question)).toContain("https://github.com/o/r/pull/7");
    expect(entry(openQs(s)[0]).options).toEqual(["Done — I cleared the gates", "Send back to the Builder"]);
    expect(pokesTo(acted, B)).toEqual([]);
    await l.tick(T + 10);
    expect(openQs(s).length).toBe(1); // one ask per head
  });

  test("a thread posted after the ask withdraws it and pokes the Builder; clearing it re-asks once", async () => {
    const { s } = squad();
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")]) });
    const l = loop(s);
    await l.tick(T);
    expect(openQs(s).length).toBe(1);
    pr(s, { verdict: "blocked", reasons: JSON.stringify("threads:1"), threads: 1, problem: "threads" });
    const acted = await l.tick(T + 5);
    expect(openQs(s)).toEqual([]);
    const closed = s.db.query("SELECT answer, answered_via FROM questions WHERE id = 'pr-7' ORDER BY seq DESC LIMIT 1").get() as Row;
    expect(String(closed.answer)).toContain("withdrawn");
    expect(pokesTo(acted, B).length).toBeGreaterThan(0);
    pr(s, { verdict: "blocked", reasons: JSON.stringify("checks-failing"), threads: 0, problem: "checks-failing" });
    await l.tick(T + 10);
    expect(openQs(s).length).toBe(1);
    await l.tick(T + 15);
    expect(openQs(s).length).toBe(1);
  });

  test("no ask while the Builder still works; the ask lands once it stops", async () => {
    const { s } = squad();
    s.upsert("observed_workers", { project: "fx", wt: B }, { state: "working", observed_at: T });
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")]) });
    const l = loop(s);
    await l.tick(T);
    expect(openQs(s)).toEqual([]);
    s.upsert("observed_workers", { project: "fx", wt: B }, { state: "idle", observed_at: T });
    await l.tick(T + 5);
    expect(openQs(s).length).toBe(1);
  });

  test("a red non-gate check after the ask withdraws it", async () => {
    const { s } = squad();
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")], "aaa") });
    const l = loop(s);
    await l.tick(T);
    expect(openQs(s).length).toBe(1);
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE"), cr("build", "COMPLETED", "FAILURE")], "aaa"), reasons: JSON.stringify("checks-failing") });
    await l.tick(T + 5);
    expect(openQs(s)).toEqual([]);
    expect(String((s.db.query("SELECT answer FROM questions WHERE id = 'pr-7' ORDER BY seq DESC LIMIT 1").get() as Row).answer)).toContain("withdrawn");
  });

  test("a project human_checks entry makes a custom check a gate", async () => {
    const { s } = squad();
    s.upsert("config", { project: "fx", file: "github", key: "human_checks" }, { value: "Deploy hold", observed_at: T });
    pr(s, { verdict: "waiting", reasons: JSON.stringify("required:Deploy hold"), doc: docWith([]) });
    await loop(s).tick(T);
    expect(openQs(s).length).toBe(1);
    expect(String(entry(openQs(s)[0]).question)).toContain("waits on: Deploy hold");
  });

  test("answer routing: Send back pokes the Builder with the operator's words and copies the Lead; Done pokes no one", async () => {
    const { s } = squad();
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")]) });
    await loop(s).tick(T);
    expect(openQs(s).length).toBe(1);
    const poked: { wt: string; text: string }[] = [];
    const exec = async (ans: string) => {
      const { row } = s.request("answer", { id: "pr-7", answer: ans, via: "board" }, { project: "fx", squad: "lc", member: LEAD });
      // The board marks the question answered before the loop routes it.
      s.db.run("UPDATE questions SET status = 'answered', answer = ?, answered_via = 'board' WHERE id = 'pr-7' AND status = 'open'", [ans]);
      const a: Action = { project: "fx", squad: "lc", member: LEAD, subject: `req:${row.id}`, kind: "answer", episode: `req:${row.id}`, payload: { id: "pr-7", answer: ans, via: "board", request: Number(row.id) } };
      const x = { store: s, project: "fx", now: T + 100, poked: new Set<string>(),
        act: { seat: () => ({ send: async () => ({ code: 0, out: "", err: "" }) }),
          driver: () => ({ poke: async (m: Row, text: string) => { poked.push({ wt: String(m.wt), text }); return "sent"; } }) } };
      return answerFulfiller.exec(a, x as never);
    };
    expect(await exec("Send back to the Builder: please rebase first")).toMatchObject({ done: true });
    expect(poked.some((p) => p.wt === B && p.text.includes("please rebase first"))).toBe(true);
    expect(poked.some((p) => p.wt === LEAD)).toBe(true);
    poked.length = 0;
    // Ask again (the answer closed the first), then Done.
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")], "bbb") });
    await loop(s).tick(T + 200);
    expect(await exec("Done — I cleared the gates")).toMatchObject({ done: true });
    expect(poked).toEqual([]);
    const ep = s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:pr-question" }) as Row;
    expect(ep).toMatchObject({ state: "done-wait", episode_key: "7|bbb|Proof hold", next_at: T + 100 + 86400 });
    await loop(s).tick(T + 200);
    expect(openQs(s)).toEqual([]); // Done does not re-ask on the next tick
  });

  test("a new push withdraws the question even while the gates still remain", async () => {
    const { s } = squad();
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")], "aaa") });
    const l = loop(s);
    await l.tick(T);
    expect(openQs(s).length).toBe(1);
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")], "bbb") });
    await l.tick(T + 5);
    expect(openQs(s)).toEqual([]);
    expect(String((s.db.query("SELECT answer FROM questions WHERE id = 'pr-7' ORDER BY seq DESC LIMIT 1").get() as Row).answer)).toContain("new push");
  });

  test("Done waits a quiet day, reminds once, then alerts", async () => {
    const { s } = squad();
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")], "aaa") });
    const l = loop(s);
    await l.tick(T);
    expect(openQs(s).length).toBe(1);
    // The operator answers Done while the gates are still open (as fulfil/answer records it).
    s.db.run("UPDATE questions SET status = 'answered', answer = 'Done', answered_via = 'board' WHERE id = 'pr-7'");
    s.upsert("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:pr-question" }, { squad: "lc", episode_key: "7|aaa|Proof hold", state: "done-wait", next_at: T + 86400, source: "loop", observed_at: T });
    await l.tick(T + 3600);
    expect(openQs(s)).toEqual([]); // no re-ask until the head or gates change, or a quiet day
    const acted = await l.tick(T + 86400);
    expect(openQs(s).length).toBe(1); // the reminder
    s.db.run("UPDATE questions SET status = 'answered', answer = 'Done', answered_via = 'board' WHERE id = 'pr-7' AND status = 'open'");
    const ep = s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:pr-question" }) as Row;
    s.upsert("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:pr-question" }, { state: "done-wait", next_at: T + 2 * 86400, observed_at: T + 86400 });
    expect(Number(ep.count)).toBe(2);
    const alerted = await l.tick(T + 2 * 86400);
    expect(alerted.some((a) => a.kind === "alert")).toBe(true);
    expect(openQs(s)).toEqual([]);
  });

  test("a question answered in a terminal follows the Done path on the next tick", async () => {
    const { s } = squad();
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")], "aaa") });
    const l = loop(s);
    await l.tick(T);
    expect(openQs(s).length).toBe(1);
    s.db.run("UPDATE questions SET status = 'answered', answer = 'done', answered_via = 'terminal' WHERE id = 'pr-7'");
    await l.tick(T + 5);
    const ep = s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:pr-question" }) as Row;
    expect(ep).toMatchObject({ state: "done-wait", next_at: T + 5 + 86400 });
    expect(openQs(s)).toEqual([]);
  });

  test("merging the PR closes the loop's open question", async () => {
    const { s } = squad();
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")], "aaa") });
    const l = loop(s);
    await l.tick(T);
    expect(openQs(s).length).toBe(1);
    pr(s, { state: "MERGED", verdict: "merged" });
    await l.tick(T + 5);
    expect(openQs(s)).toEqual([]);
  });

  test("with the Builder gone the answer reaches the Lead", async () => {
    const { s } = squad();
    pr(s, { doc: docWith([cr("Proof hold", "COMPLETED", "FAILURE")]) });
    await loop(s).tick(T);
    s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [B]);
    const poked: { wt: string; text: string }[] = [];
    const { row } = s.request("answer", { id: "pr-7", answer: "Send back: fix the typo", via: "board" }, { project: "fx", squad: "lc", member: LEAD });
    s.db.run("UPDATE questions SET status = 'answered', answer = 'x', answered_via = 'board' WHERE id = 'pr-7' AND status = 'open'");
    const a: Action = { project: "fx", squad: "lc", member: LEAD, subject: `req:${row.id}`, kind: "answer", episode: `req:${row.id}`, payload: { id: "pr-7", answer: "Send back: fix the typo", via: "board", request: Number(row.id) } };
    const x = { store: s, project: "fx", now: T + 100, poked: new Set<string>(),
      act: { seat: () => ({ send: async () => ({ code: 0, out: "", err: "" }) }),
        driver: () => ({ poke: async (m: Row, text: string) => { poked.push({ wt: String(m.wt), text }); return "sent"; } }) } };
    expect(await answerFulfiller.exec(a, x as never)).toMatchObject({ done: true });
    expect(poked.map((p) => p.wt)).toEqual([LEAD]);
    expect(poked[0].text).toContain("fix the typo");
  });
});
