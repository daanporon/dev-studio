// archive-questions.test.ts — morning-brief-stale-items U2: archiving a squad drops its open questions
// (status dropped, never answered), keeps them in the archived JSON's dropped_questions, raises one
// Needs-you card when any was blocking (none on a replay), and a re-import reopens nothing. Migration 0053
// drops the open questions already left on closed squads, and only those. Hermetic: a copy of the fixture
// state and the FakeBackend, as squad-lifecycle.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson, importSquad } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import * as questions from "../../bin/loop/messages/questions.ts";
import { cardPlace } from "../../bin/board/card-place.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.DS_LOOP_RETRY_S;
});

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
async function rig() {
  const d = mkdtempSync(join(tmpdir(), "zzarchq-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  process.env.DS_LOOP_RETRY_S = "1";
  for (const [role, value] of [["lead", "claude sonnet always"], ["thinker", "claude opus always"], ["builder", "claude opus ondemand"]] as const)
    s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const reconcilers = await load<Reconciler>(DIRS.reconcilers);
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
  return { s, tick, act, now: () => at };
}
const squadFulfiller = fulfillers.find((f) => f.kinds?.includes("squad"))!;

const squad = (s: Store, topic: string) => s.db.query("SELECT * FROM squads WHERE project = 'fx' AND topic = ?").get(topic) as Row;
const qrows = (s: Store, topic = "demo") => s.db.query("SELECT * FROM questions WHERE project = 'fx' AND squad = ? ORDER BY seq").all(topic) as Row[];
const cards = (s: Store) => {
  const f = join(s.root, "fx", "alerts.json");
  return existsSync(f) ? ((JSON.parse(readFileSync(f, "utf8")) as { alerts?: Row[] }).alerts ?? []).filter((a) => a.kind === "questions_dropped") : [];
};

const ENTRIES = [
  { id: "plan-approve", asker: "lead", blocking: true, title: "Approve the plan?", question: "Approve the plan?", since: "2027-01-01T00:00:00Z" },
  { id: "soft-name", asker: "builder-u1-x", blocking: false, title: "Name the flag", question: "Which name?", since: "2027-01-01T00:01:00Z" },
];

// The two questions as squad-state writes them: in the row's doc and as open rows.
function seedQuestions(s: Store, entries: Row[] = ENTRIES) {
  const sq = squad(s, "demo");
  s.upsert("squads", { id: sq.id }, { doc: JSON.stringify({ ...JSON.parse(String(sq.doc)), waiting_on_you: entries }) });
  questions.sync(s, "fx", "demo", entries);
}

async function archive(s: Store, tick: (n?: number) => Promise<void>) {
  s.db.run("UPDATE squads SET status = 'suspended', want = 'suspended', want_result = 'done: suspended' WHERE project = 'fx' AND topic = 'demo'");
  for (const m of s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = 'demo' AND wt IS NOT NULL").all() as Row[]) {
    s.upsert("observed_workers", { project: "fx", wt: m.wt }, { presence: "none", state: "idle", observed_at: T, account_at: T });
    s.upsert("observed_worktrees", { project: "fx", wt: m.wt }, { path: s.root, branch: "main", observed_at: T });
  }
  s.want("squad", "fx/demo", "gone", { by: "close-squad" });
  await tick(4);
}

describe("archive drops a squad's open questions (morning-brief-stale-items U2)", () => {
  test("a blocking and a soft question: none left open, both kept as dropped, one card", async () => {
    const { s, tick } = await rig();
    seedQuestions(s);
    expect(questions.pending(s, "fx", "demo").length).toBe(2);
    await archive(s, tick);
    expect(squad(s, "demo").status).toBe("closed");

    // No open row is left; both are dropped (never answered), reason in answer, via archive.
    const rows = qrows(s);
    expect(rows.map((r) => [r.id, r.status, r.answer, r.answered_via])).toEqual([
      ["plan-approve", "dropped", "squad archived", "archive"],
      ["soft-name", "dropped", "squad archived", "archive"],
    ]);
    expect(rows.every((r) => r.answered_at != null)).toBe(true);
    expect(questions.list(s, "fx", "demo")).toEqual([]);   // not in the answered history
    expect(questions.answer(s, "fx", "demo", "plan-approve", "yes", "board")).toBeNull();
    const ev = s.db.query("SELECT payload FROM events WHERE kind = 'question_dropped' ORDER BY id").all() as Row[];
    expect(ev.map((e) => JSON.parse(String(e.payload)))).toEqual([
      { id: "plan-approve", title: "Approve the plan?", blocking: true, reason: "squad archived" },
      { id: "soft-name", title: "Name the flag", blocking: false, reason: "squad archived" },
    ]);

    // The archived JSON keeps them under dropped_questions, with an empty queue.
    const arch = join(s.root, "fx", "archive");
    const files = readdirSync(arch).filter((f) => /^demo-\d{8}-\d{6}\.json$/.test(f));
    const doc = JSON.parse(readFileSync(join(arch, files[files.length - 1]), "utf8")) as Row;
    expect(doc.waiting_on_you).toEqual([]);
    expect((doc.dropped_questions as Row[]).map((q) => [q.id, q.dropped, typeof q.dropped_at])).toEqual([
      ["plan-approve", "squad archived", "string"], ["soft-name", "squad archived", "string"],
    ]);
    // The row's doc lost its queue in the same write.
    expect(JSON.parse(String(squad(s, "demo").doc)).waiting_on_you).toEqual([]);

    // One Needs-you card, naming the blocking question and its asker only.
    const c = cards(s);
    expect(c.length).toBe(1);
    expect(c[0].title).toBe("Archived with a blocking question open: demo");
    expect(String(c[0].question)).toContain("Approve the plan? (asked by lead)");
    expect(String(c[0].question)).not.toContain("Name the flag");
    expect(c[0].options).toEqual(["Seen"]);
    expect(cardPlace(c[0], T + 3600)).toBe("needs");

    // More ticks raise nothing again.
    await tick(3);
    expect(cards(s).length).toBe(1);
  });

  // debrief-in-needs-you pages U1: the squad's Try it page moves to archive/ with its plans.
  test("the squad's Try it page moves to archive/; a page that only shares the prefix stays", async () => {
    const { s, tick } = await rig();
    seedQuestions(s);
    const sd = join(s.root, "fx", "squads");
    writeFileSync(join(sd, "demo-try-it.md"), "# Try it — demo\n\n1. one\n");
    writeFileSync(join(sd, "demo-x-try-it.md"), "# someone else's\n");
    await archive(s, tick);
    const arch = join(s.root, "fx", "archive");
    expect(existsSync(join(sd, "demo-try-it.md"))).toBe(false);
    expect(readFileSync(join(arch, "demo-try-it.md"), "utf8")).toContain("1. one");
    expect(existsSync(join(sd, "demo-x-try-it.md"))).toBe(true);
  });

  test("a replayed archive raises no second card and reopens nothing", async () => {
    const { s, tick, act, now } = await rig();
    seedQuestions(s);
    await archive(s, tick);
    const first = cards(s);
    expect(first.length).toBe(1);
    // The loop never runs a settled episode again; a replay is the same action run again by hand.
    const sq = squad(s, "demo");
    const replay = async () => {
      s.db.run("UPDATE squads SET status = 'suspended' WHERE id = ?", [sq.id as number]);
      const a = { project: "fx", squad: "demo", member: null, subject: `squad:${sq.id}`, kind: "squad", episode: `archive:${sq.want_at}`, payload: { id: Number(sq.id), op: "archive" } };
      return squadFulfiller.exec!(a as never, { store: s, now: now(), project: "fx", act } as never);
    };
    // A crash after the drop: nothing is open, so no card is added.
    expect(await replay()).toEqual({ done: true, result: "archived" });
    expect(cards(s).map((a) => a.id)).toEqual(first.map((a) => a.id));
    // A crash before the drop committed (the card raised, the rows still open): the same card id, still one.
    s.db.run("UPDATE questions SET status = 'open', answer = NULL, answered_via = NULL, answered_at = NULL WHERE project = 'fx' AND squad = 'demo'");
    expect(await replay()).toEqual({ done: true, result: "archived" });
    expect(cards(s).map((a) => a.id)).toEqual(first.map((a) => a.id));
    expect(questions.pending(s, "fx", "demo")).toEqual([]);
    expect(squad(s, "demo").status).toBe("closed");
  });

  test("only soft questions: dropped silently, no card", async () => {
    const { s, tick } = await rig();
    seedQuestions(s, [ENTRIES[1]]);
    await archive(s, tick);
    expect(qrows(s).map((r) => r.status)).toEqual(["dropped"]);
    expect(cards(s)).toEqual([]);
  });

  test("a re-import of the archived squad reopens nothing", async () => {
    const { s, tick } = await rig();
    seedQuestions(s);
    await archive(s, tick);
    // The whole import again (its prune syncs each squad's doc) …
    importJson(s);
    expect(questions.pending(s, "fx", "demo")).toEqual([]);
    // … a sync from the row's doc, as squad-state and the import do …
    const rowDoc = JSON.parse(String(squad(s, "demo").doc)) as Row;
    questions.sync(s, "fx", "demo", rowDoc.waiting_on_you as unknown[]);
    expect(questions.pending(s, "fx", "demo")).toEqual([]);
    // … and the archived JSON put back as the live file.
    const arch = join(s.root, "fx", "archive");
    const f = readdirSync(arch).filter((x) => /^demo-\d{8}-\d{6}\.json$/.test(x)).pop()!;
    writeFileSync(join(s.root, "fx", "squads", "demo.json"), readFileSync(join(arch, f), "utf8"));
    expect(importSquad(s, s.root, "fx", "demo", () => {})).not.toBeNull();
    expect(questions.pending(s, "fx", "demo")).toEqual([]);
    expect(qrows(s).map((r) => r.status)).toEqual(["dropped", "dropped"]);
  });
});

describe("migration 0053: the old orphans", () => {
  test("drops only closed squads' open rows, with no card, and empties their docs' queue", () => {
    const d = mkdtempSync(join(tmpdir(), "zzarchq-mig-"));
    temps.push(d);
    const s = open(d);
    stores.push(s);
    const q = (topic: string, id: string, blocking: boolean) => ({ id, asker: "lead", blocking, title: `t-${id}`, question: "?", since: "2027-01-01T00:00:00Z" });
    s.upsert("squads", { project: "p", topic: "gone" }, { status: "closed", observed_at: T, updated_at: T, doc: JSON.stringify({ waiting_on_you: [q("gone", "a", true)] }) });
    s.upsert("squads", { project: "p", topic: "live" }, { status: "running", observed_at: T, updated_at: T, doc: JSON.stringify({ waiting_on_you: [q("live", "c", true)] }) });
    s.upsert("squads", { project: "p", topic: "bad" }, { status: "closed", observed_at: T, updated_at: T, doc: "not json" });
    questions.open(s, "p", "gone", q("gone", "a", true));
    questions.open(s, "p", "gone", q("gone", "b", false));
    questions.open(s, "p", "live", q("live", "c", true));
    questions.open(s, "p", "bad", q("bad", "d", false));
    questions.answer(s, "p", "gone", "b", "earlier answer", "terminal");   // an answered row stays answered
    s.db.run(readFileSync(join(ROOT, "bin", "loop", "migrations", "0053-orphan-questions.sql"), "utf8"));
    const all = s.db.query("SELECT squad, id, status, answer, answered_via FROM questions ORDER BY seq").all() as Row[];
    expect(all.map((r) => [r.squad, r.id, r.status, r.answer, r.answered_via])).toEqual([
      ["gone", "a", "dropped", "squad archived (cleanup)", "archive"],
      ["gone", "b", "answered", "earlier answer", "terminal"],
      ["live", "c", "open", null, null],
      ["bad", "d", "dropped", "squad archived (cleanup)", "archive"],
    ]);
    const docOf = (topic: string) => String((s.db.query("SELECT doc FROM squads WHERE project = 'p' AND topic = ?").get(topic) as Row).doc);
    expect(JSON.parse(docOf("gone")).waiting_on_you).toEqual([]);
    expect(JSON.parse(docOf("live")).waiting_on_you.length).toBe(1);
    expect(docOf("bad")).toBe("not json");
    const ev = s.db.query("SELECT squad, payload FROM events WHERE kind = 'question_dropped' ORDER BY id").all() as Row[];
    expect(ev.map((e) => [e.squad, JSON.parse(String(e.payload))])).toEqual([
      ["gone", { id: "a", title: "t-a", blocking: true, reason: "squad archived (cleanup)" }],
      ["bad", { id: "d", title: "t-d", blocking: false, reason: "squad archived (cleanup)" }],
    ]);
    expect(existsSync(join(d, "p", "alerts.json"))).toBe(false);
  });
});
