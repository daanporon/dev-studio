// board-messages-counts.test.ts — unread-counts-mismatch U1: one definition of unread / waiting for a reply / ended
// (messages.ts UNREAD, WAITING, ENDED). The squad chip (board.squads[].messages), the member badge (crew unread and
// reply_due), the panel header and the rows `open=1` returns all come from it; mail to or from an ended member
// is shown (state ended) and never counted, and 250 older rows do not hide the one still waiting.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBoard, messagesJson, renderText } from "../../bin/board/board-data.ts";
import { open } from "../../bin/loop/core/store.ts";

const REPO = join(import.meta.dir, "../..");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzboardmsg-")); roots.push(root);
  mkdirSync(join(root, "p", "squads"), { recursive: true });
  writeFileSync(join(root, "p", "squads", "a.json"), JSON.stringify({ task_id: "a", run_id: "run_a", repo: "path:/r/p", status: "running", worktrees: [],
    members: [{ role: "lead", wt: "lead-a" }, { role: "builder", suffix: "u1", wt: "wt-u1" }],
    units: [{ slug: "u1", status: "dispatched", deps: [], builder_wt: "wt-u1" }] }));
  writeFileSync(join(root, "seed.json"), JSON.stringify({ workers: [["lead-a", "working"], ["wt-u1", "working"]] }));
  const env = { ...process.env, DS_STATE_ROOT: root };
  for (const cmd of [[join(REPO, "bin/ds"), "import"], [process.execPath, join(REPO, "tests/board-db.ts"), join(root, "seed.json"), "p"]]) {
    const r = spawnSync(cmd[0], cmd.slice(1), { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  }
  const s = open(root);
  // Two ended members: a Tester (receiver) and a Builder (asker); a fresh Builder on the same unit is live.
  for (const [role, suffix, wt] of [["tester", "t1", "wt-t1"], ["builder", "old", "wt-old"]])
    s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, observed_at, updated_at) VALUES ('p', 'a', ?, ?, ?, 'gone', 1, 1)", [wt, role, suffix]);
  let n = 0;
  const msg = (o: Record<string, unknown>) => {
    const r = { project: "p", squad: "a", to_role: "lead", to_suffix: "", from_role: "operator", from_member: null, subject: "s", body: "b", needs_reply: 0,
      sent_at: 1_800_000_000 + n, read_at: null, replied_at: null, reply_to: null, key: `k${n++}`, ...o } as Record<string, unknown>;
    const cols = Object.keys(r);
    s.db.run(`INSERT INTO messages (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => r[c] as any));
    return Number((s.db.query("SELECT last_insert_rowid() AS i").get() as any).i);
  };
  const builder = { from_role: "builder", from_suffix: "u1", from_member: "wt-u1", from_project: "p", from_squad: "a" };
  const gone = { from_role: "builder", from_suffix: "old", from_member: "wt-old", from_project: "p", from_squad: "a" };
  msg({ to_role: "builder", to_suffix: "u1", subject: "unread to live" });
  msg({ to_role: "tester", to_suffix: "t1", subject: "unread to ended" });
  msg({ ...gone, needs_reply: 1, read_at: 1_800_000_100, subject: "question from ended asker" });
  msg({ ...builder, needs_reply: 1, read_at: 1_800_000_100, subject: "question from live asker" });
  msg({ needs_reply: 1, read_at: 1_800_000_100, subject: "question from the operator" });
  const answered = msg({ ...builder, needs_reply: 1, read_at: 1_800_000_100, subject: "answered by reply_to" });
  msg({ from_role: "lead", to_role: "builder", to_suffix: "u1", kind: "reply", reply_to: answered, read_at: 1_800_000_500, subject: "re" });
  // 250 older rows, read, and one question still waiting.
  const oldest = msg({ needs_reply: 1, read_at: 1_700_000_100, subject: "old but waiting", sent_at: 1_700_000_000 });
  for (let i = 0; i < 250; i++) msg({ subject: `old ${i}`, sent_at: 1_700_000_001 + i, read_at: 1_700_000_002 + i });
  s.close();
  return { root, oldest };
}

test("chip = panel header = rows open=1 returns; badge = Inbox header; ended is shown, never counted", () => {
  const f = fixture();
  const b = buildBoard("p", "", f.root) as any;
  const sq = b.squads.find((x: any) => x.topic === "a");
  // unread: the one to the live Builder. waiting: live asker, operator, and the old one. ended: unread to the ended Tester, question from the ended asker.
  expect(sq.messages).toEqual({ unread: 1, reply_due: 3, ended: 2 });

  const squad = messagesJson({ project: "p", topic: "a" }, f.root) as any;
  expect([squad.unread, squad.reply_due, squad.ended]).toEqual([1, 3, 2]);
  const open = messagesJson({ project: "p", topic: "a", open: true }, f.root) as any;
  expect(open.messages.length).toBe(squad.unread + squad.reply_due);
  expect(open.messages.map((m: any) => m.state).sort()).toEqual(["unread", "waiting", "waiting", "waiting"]);
  expect(open.messages.some((m: any) => m.id === f.oldest && m.state === "waiting" && m.waited_s > 0)).toBe(true); // beyond the 200-row page
  expect(open.messages.every((m: any) => m.waited_s != null)).toBe(true);

  const all = messagesJson({ project: "p", topic: "a" }, f.root) as any;
  expect(all.messages.length).toBe(200);
  const ended = (messagesJson({ project: "p", topic: "a" }, f.root) as any).messages.filter((m: any) => m.state === "ended");
  expect(ended.map((m: any) => m.ended_why).sort()).toEqual(["asker ended", "to an ended member"]);

  // The crew badge of each live member equals its Inbox header.
  let checked = 0;
  for (const m of sq.members) {
    if (!m.wt) continue;
    const inbox = messagesJson({ project: "p", topic: "a", wt: m.wt }, f.root) as any;
    if ("missing" in inbox) continue;
    expect([m.unread, m.reply_due]).toEqual([inbox.unread, inbox.reply_due]); checked++;
    expect(messagesJson({ project: "p", topic: "a", wt: m.wt, open: true }, f.root) as any).toHaveProperty("messages");
  }
  expect(checked).toBeGreaterThanOrEqual(2);
  const lead = messagesJson({ project: "p", topic: "a", wt: "lead-a" }, f.root) as any;
  expect([lead.unread, lead.reply_due]).toEqual([0, 3]);
  const bld = messagesJson({ project: "p", topic: "a", wt: "wt-u1" }, f.root) as any;
  expect([bld.unread, bld.reply_due]).toEqual([1, 0]);
  expect(renderText(b)).toContain("waiting for a reply");
});

// U1 (answered-questions-stop-count): a later plain message from the receiver to the asker answers a question.
test("answered: a later receiver → asker message ends the wait; other messages do not", () => {
  const f = fixture();
  const s = open(f.root);
  let k = 0;
  const ins = (o: Record<string, unknown>) => {
    const r = { project: "p", squad: "a", to_role: "lead", to_suffix: "", from_role: "operator", from_member: null, from_project: null, from_squad: null, subject: "s", body: "b",
      needs_reply: 0, sent_at: 1_800_001_000 + k, read_at: 1_800_001_000 + k, replied_at: null, reply_to: null, key: `ans${k++}`, ...o } as Record<string, unknown>;
    const cols = Object.keys(r);
    s.db.run(`INSERT INTO messages (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => r[c] as any));
    return Number((s.db.query("SELECT last_insert_rowid() AS i").get() as any).i);
  };
  const b = { from_project: "p", from_squad: "a", from_role: "builder", from_suffix: "u1", from_member: "wt-u1" };
  const lead = { from_project: "p", from_squad: "a", from_role: "lead", from_suffix: "" };
  const toB = { to_role: "builder", to_suffix: "u1" };
  // Q1: the Builder asks the Lead; the Lead answers with a plain message → answered.
  const q1 = ins({ ...b, needs_reply: 1, subject: "q1" });
  const a1 = ins({ ...lead, ...toB, subject: "plain answer" });
  ins({ ...lead, ...toB, subject: "earlier" }); // sent before q2..q4, so it answers none of them
  // Q2: a later message to someone else (the Tester) does not answer.
  const q2 = ins({ ...b, needs_reply: 1, subject: "q2" });
  ins({ ...lead, to_role: "tester", to_suffix: "t1", subject: "elsewhere" });
  // Q3: a later message from the asker itself does not answer.
  const q3 = ins({ ...b, needs_reply: 1, subject: "q3" });
  ins({ ...b, subject: "asker follows up" });
  // Q4: a message before the question does not answer it.
  const q4 = ins({ ...b, needs_reply: 1, subject: "q4" });
  s.close();

  const all = messagesJson({ project: "p", topic: "a" }, f.root) as any;
  const by = (id: number) => all.messages.find((m: any) => m.id === id);
  expect(by(q1)).toMatchObject({ state: "answered", answered_by: a1, reply_due: false });
  for (const q of [q2, q3, q4]) expect(by(q)).toMatchObject({ state: "waiting", answered_by: null });
  // The fixture had 3 waiting; "plain answer" also answers its Builder → Lead question, so 2 remain, plus q2..q4.
  expect(all.reply_due).toBe(2 + 3);
  const openRows = messagesJson({ project: "p", topic: "a", open: true }, f.root) as any;
  expect(openRows.messages.some((m: any) => m.id === q1)).toBe(false);
  const sq = (buildBoard("p", "", f.root) as any).squads.find((x: any) => x.topic === "a");
  expect(sq.messages.reply_due).toBe(all.reply_due);
  expect(all.ended).toBe(2); // an answered question is history, not "ended"
});
