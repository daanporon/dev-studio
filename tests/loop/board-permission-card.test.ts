// board-permission-card.test.ts — permission-prompt-needs-you U5: what board.json says about a safety-check card
// around a board press. While its answer request is open the card stays listed, pending; a refused press turns it
// terminal-only with the reason; a finished press removes it. A helper agent's prompt says so in its title.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { answer, open as ask, reopen } from "../../bin/loop/messages/questions.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { buildBoard } from "../../bin/board/board-data.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const WT = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-builder-demo";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzpermcard-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}
const ENTRY = { id: "picker-perm0007", asker: "builder-u1", blocking: true, question: "run this command?", title: "builder-u1 asks: run this command?",
  since: "2026-11-26T15:00:00Z", source: "picker", picker_kind: "permission", picker_answerable: true, tool: "Bash", shown: "git push origin work",
  tool_use_id: "toolu_01perm7", card_wt: WT, choices: [{ label: "Yes" }, { label: "No" }] };

const card = (s: Store, id = ENTRY.id) => ((buildBoard("fx", "", s.root) as any).needs_you as Row[]).find((n) => n.id === id) ?? null;
// What /api/answer does for a Yes: the row answered via board, then one answer request for the loop to press.
function pressYes(s: Store, seq: number): number {
  answer(s, "fx", "demo", ENTRY.id, "Yes", "board", seq);
  return Number(s.request("answer", { id: ENTRY.id, answer: "Yes", seq, card_wt: WT, via: "board", tool_use_id: ENTRY.tool_use_id }, { project: "fx", squad: "demo", member: WT, by: "board" }).row.id);
}
const finish = (s: Store, id: number, result: Row) => s.db.run("UPDATE requests SET done_at = 1, result = ? WHERE id = ?", [JSON.stringify(result), id]);

test("while the press is open the card stays listed, pending; a finished press removes it", () => {
  const s = imported();
  const seq = ask(s, "fx", "demo", ENTRY);
  expect(card(s)).toMatchObject({ pending: false, picker_answerable: true });
  const req = pressYes(s, seq);
  expect(card(s)).toMatchObject({ id: ENTRY.id, pending: true, picker_answerable: true, picker_refused: null });
  finish(s, req, { ok: true, pressed: "1" });
  expect(card(s)).toBeNull();
});

test("a refused press lists the card terminal-only with the reason, not pending", () => {
  const s = imported();
  const seq = ask(s, "fx", "demo", ENTRY);
  const req = pressYes(s, seq);
  finish(s, req, { ok: false, prompt_changed: 1, why: "the screen shows a different command" });
  reopen(s, "fx", "demo", ENTRY.id, seq);
  expect(card(s)).toMatchObject({ pending: false, picker_answerable: false, picker_refused: "the screen shows a different command" });
});

test("another kind of question answered on the board leaves at once, as before", () => {
  const s = imported();
  const q = { id: "q-lead01", asker: "builder-u1", blocking: true, question: "which way?", title: "which way?", since: "2026-11-26T15:00:00Z", choices: [{ label: "A" }, { label: "B" }] };
  const seq = ask(s, "fx", "demo", q);
  answer(s, "fx", "demo", q.id, "A", "board", seq);
  s.request("answer", { id: q.id, answer: "A", seq, via: "board" }, { project: "fx", squad: "demo", by: "board" });
  expect(card(s, q.id)).toBeNull();
});

test("a helper agent's prompt says so in its title, answerable or terminal-only", () => {
  const s = imported();
  ask(s, "fx", "demo", { ...ENTRY, agent: "general-purpose" });
  ask(s, "fx", "demo", { ...ENTRY, id: "picker-perm0008", tool_use_id: "toolu_01perm8", agent: "general-purpose", picker_answerable: false });
  expect(card(s)?.title).toBe("builder-u1's helper agent (general-purpose) asks: run this command?");
  expect(card(s, "picker-perm0008")).toMatchObject({ picker_answerable: false, title: "builder-u1's helper agent (general-purpose) asks: run this command?" });
  // An agent with no type: no empty brackets.
  ask(s, "fx", "demo", { ...ENTRY, id: "picker-perm0009", tool_use_id: "toolu_01perm9", agent: "helper agent" });
  expect(card(s, "picker-perm0009")?.title).toBe("builder-u1's helper agent asks: run this command?");
});
