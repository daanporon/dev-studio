// chat-key-buttons U2: GET api/chat's `questions` (the open questions whose card opens a chat with the member) and the
// menu text the screen scan returns (`screen.prompt`, `screen.options`).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatJson, menuText } from "../../bin/board/board-data.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { open as openQuestion } from "../../bin/loop/messages/questions.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const LEAD = "0a1b2c3d-0000-4000-8000-00000000d3a0::/w/ds-demo-lead", BUILDER = "0a1b2c3d-0000-4000-8000-00000000d3a0::/w/ds-demo-builder-a";
function seed(waiting: any[]) {
  const d = mkdtempSync(join(tmpdir(), "zzchatq-")); temps.push(d);
  const s = open(d); stores.push(s);
  for (const [wt, role] of [[LEAD, "lead"], [BUILDER, "builder"]])
    s.db.run("INSERT INTO members (project, squad, wt, role, suffix, agent, status, observed_at, updated_at) VALUES ('demo', 'sq', ?, ?, '', 'claude', 'running', 1, 1)", [wt, role]);
  s.db.run("INSERT INTO squads (project, topic, status, observed_at, updated_at, doc) VALUES ('demo', 'sq', 'running', 1, 1, ?)",
    [JSON.stringify({ status: "running", lead_wt: LEAD, members: [{ role: "lead", wt: LEAD }, { role: "builder", wt: BUILDER }] })]);
  for (const q of waiting) openQuestion(s, "demo", "sq", q);
  return d;
}

test("chatJson lists the open questions of the member whose card opens its chat, blocking first, and marks a terminal-only picker", () => {
  const d = seed([
    { id: "q-late", asker: "builder", question: "Which colour?", title: "Colour", blocking: false, since: "2026-11-25T10:00:00Z", card_wt: BUILDER, options: ["red", "blue"] },
    { id: "q-lead", asker: "thinker", question: "Ship it?", blocking: true, since: "2026-11-25T11:00:00Z", choices: [{ label: "Yes", does: "merge" }] },
    { id: "q-blk", asker: "builder", question: "Which db?", blocking: true, since: "2026-11-25T12:00:00Z", card_wt: BUILDER, source: "picker", picker_answerable: true, choices: [{ label: "pg" }] },
    { id: "q-multi", asker: "builder", question: "Pick several", blocking: true, since: "2026-11-25T09:00:00Z", card_wt: BUILDER, source: "picker", picker_answerable: false, choices: [{ label: "a" }] },
  ]);
  const b = chatJson({ project: "demo", topic: "sq", wt: BUILDER }, d) as any;
  expect(b.questions.map((q: any) => q.id)).toEqual(["q-multi", "q-blk", "q-late"]);
  expect(b.questions[0]).toMatchObject({ id: "q-multi", answerable: false, source: "picker", blocking: true, since: "2026-11-25T09:00:00Z" });
  expect(b.questions[1].answerable).toBe(true);
  expect(b.questions[2]).toMatchObject({ title: "Colour", question: "Which colour?", choices: [{ label: "red", does: null }, { label: "blue", does: null }], blocking: false });
  // The card without a worktree of its own goes to the Lead; the Builder never sees it.
  const l = chatJson({ project: "demo", topic: "sq", wt: LEAD }, d) as any;
  expect(l.questions.map((q: any) => q.id)).toEqual(["q-lead"]);
  expect(l.questions[0]).toMatchObject({ title: "Ship it?", choices: [{ label: "Yes", does: "merge" }] });
  // The crew carries a count for the "?" mark.
  expect(Object.fromEntries(b.crew.map((m: any) => [m.role, m.asks]))).toEqual({ lead: 1, builder: 3 });
});

test("no waiting question: an empty list", () => {
  expect((chatJson({ project: "demo", topic: "sq", wt: BUILDER }, seed([])) as any).questions).toEqual([]);
});

test("menuText returns the prompt lines above the option run and the labels, with marker and number stripped", () => {
  const t = menuText("noise\n\n Bash command\n   git push\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No, and tell Claude (esc)\n");
  expect(t.count).toBe(3);
  expect(t.options).toEqual(["Yes", "Yes, and don't ask again", "No, and tell Claude (esc)"]);
  expect(t.prompt).toEqual(["noise", "Bash command", "git push", "Do you want to proceed?"]);
  // A numbered list in plain output (no selection marker) is no menu: no prompt, no options.
  expect(menuText("Steps:\n1. first\n2. second\n3. third\n\n> ")).toEqual({ count: 0, prompt: [], options: [] });
  expect(menuText("❯ 1. only")).toEqual({ count: 0, prompt: [], options: [] });
});

test("chatJson's screen carries the menu's prompt and options beside the count", () => {
  const d = seed([]);
  const s = open(d); stores.push(s);
  s.db.run("INSERT INTO observed_workers (project, wt, state, tail, tail_at, observed_at) VALUES ('demo', ?, 'waiting', ?, 5, 5)", [BUILDER, "Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"]);
  const b = chatJson({ project: "demo", topic: "sq", wt: BUILDER }, d) as any;
  expect(b.screen).toMatchObject({ menu: 2, prompt: ["Do you want to proceed?"], options: ["Yes", "No"] });
});
