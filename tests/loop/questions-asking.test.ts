// questions-asking.test.ts — reasked-question-shows-answered U1: two rows share an id when a question is asked
// again; answer() with a seq closes only that asking, without one every open row of the id (as before).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../../bin/loop/core/store.ts";
import * as questions from "../../bin/loop/messages/questions.ts";

function rig() {
  const d = mkdtempSync(join(tmpdir(), "zzasking-"));
  const s = open(d);
  const e = (since: string) => ({ id: "plan-x", asker: "thinker", blocking: true, question: "ok?", since });
  const a = questions.open(s, "zzp", "sq", e("2026-11-23T10:00:00Z"));
  const b = questions.open(s, "zzp", "sq", e("2026-11-23T11:00:00Z"));
  return { s, a, b, done: () => { s.close(); rmSync(d, { recursive: true, force: true }); } };
}
const status = (s: any) => (s.db.query("SELECT seq, status FROM questions WHERE project = 'zzp' ORDER BY seq").all() as any[]).map((r) => r.status);

test("answer() with a seq leaves the other open row with the same id open", () => {
  const r = rig();
  expect(questions.answer(r.s, "zzp", "sq", "plan-x", "go", "board", r.b)?.seq).toBe(r.b);
  expect(status(r.s)).toEqual(["open", "answered"]);
  r.done();
});

test("answer() with a seq that is not open changes nothing", () => {
  const r = rig();
  questions.answer(r.s, "zzp", "sq", "plan-x", "go", "board", r.a);
  expect(questions.answer(r.s, "zzp", "sq", "plan-x", "again", "board", r.a)).toBeNull();
  expect(status(r.s)).toEqual(["answered", "open"]);
  r.done();
});

test("answer() without a seq closes every open row of the id", () => {
  const r = rig();
  questions.answer(r.s, "zzp", "sq", "plan-x", "go", "board");
  expect(status(r.s)).toEqual(["answered", "answered"]);
  r.done();
});
