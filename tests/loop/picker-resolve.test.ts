// picker-resolve.test.ts — permission-prompt-needs-you U5: the `picker` fulfiller (bin/loop/fulfil/picker.ts) carries out
// the reaper's {op: resolve} request (reconcilers/alerts.ts reapPickers) as squad-state.sh resolve-question does, so a
// permission card answered in the terminal, on the chat key pad or by Claude's auto-block leaves Needs you.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { answer, open as ask } from "../../bin/loop/messages/questions.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { pickerClosed } from "../../bin/loop/observers/state.ts";
import { pickerStale } from "../../bin/loop/reconcilers/alerts.ts";
import { buildBoard } from "../../bin/board/board-data.ts";
import { viaOf } from "../../bin/loop/fulfil/picker.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const WT = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-builder-demo";

// squad-state.sh clears the card note through $BACKEND ping: a fake that records its arguments.
let bin = "", oldBackend: string | undefined;
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "zzpickbin-"));
  writeFileSync(join(bin, "backend.sh"), `#!/usr/bin/env bash\necho "$*" >> "${bin}/calls"\n`);
  chmodSync(join(bin, "backend.sh"), 0o755);
  oldBackend = process.env.BACKEND;
  process.env.BACKEND = join(bin, "backend.sh");
});
afterAll(() => {
  if (oldBackend === undefined) delete process.env.BACKEND; else process.env.BACKEND = oldBackend;
  rmSync(bin, { recursive: true, force: true });
});

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzpick-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  writeFileSync(join(d, ".loop-migrated"), "");   // squad-state.sh serves the store, as on a live host
  return s;
}
const fulfillers = (await load<Fulfiller & Reconciler>(DIRS.fulfil)).filter((f) => f.kinds);

const ENTRY = { id: "picker-perm0005", asker: "builder-u1", blocking: true, question: "run this command?", title: "builder-u1 asks: run this command?",
  since: "2026-11-26T15:00:00Z", source: "picker", picker_kind: "permission", picker_answerable: true, tool: "Bash", shown: "git push origin work",
  tool_use_id: "toolu_01perm", card_wt: WT, choices: [{ label: "Yes" }, { label: "No" }] };

// File one picker request (with `payload`) on a store that holds ENTRY open (unless `asked` is false), run a tick.
async function resolve(payload: Row, opts: { asked?: boolean; answered?: boolean } = {}) {
  const s = imported(), orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const seq = opts.asked === false ? null : ask(s, "fx", "demo", ENTRY);
  if (seq !== null && opts.answered) answer(s, "fx", "demo", ENTRY.id, "Yes", "board", seq);
  const before = (s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'question_answered'").get() as { n: number }).n;
  const id = Number(s.request("picker", payload, { project: "fx", squad: "demo", by: "loop:alerts" }).row.id);
  await loop.tick(T); await act.drain();
  const req = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  const q = seq === null ? null : s.db.query("SELECT status, answered_via, answer FROM questions WHERE seq = ?").get(seq) as Row;
  const events = (s.db.query("SELECT payload FROM events WHERE kind = 'question_answered'").all() as { payload: string }[]).slice(before).map((r) => JSON.parse(r.payload) as Row);
  return { s, req, result: JSON.parse(String(req.result ?? "{}")) as Row, q, events };
}
const cards = (s: Store) => {
  const b = buildBoard("fx", "", s.root) as any;
  return [...(b.needs_you ?? []), ...(b.loop_notes ?? [])].filter((c: Row) => JSON.stringify(c).includes(ENTRY.id));
};

describe("the picker fulfiller, op resolve", () => {
  test("a closed picker: request done, entry resolved via terminal, question_answered, card gone", async () => {
    const reason = "its picker closed (tool_result in the transcript)";
    const r = await resolve({ op: "resolve", id: ENTRY.id, squad: "demo", reason });
    expect(r.req.done_at).not.toBeNull();
    expect(r.result).toMatchObject({ ok: true, changed: true, via: "terminal" });
    expect(r.q).toMatchObject({ status: "answered", answered_via: "terminal", answer: reason });
    expect(r.events).toEqual([expect.objectContaining({ id: ENTRY.id, via: "terminal" })]);
    expect(cards(r.s)).toEqual([]);
    expect(readFileSync(join(bin, "calls"), "utf8")).toContain(`ping ${WT}`);   // the card's NEEDS YOU note is cleared
  });
  test("a gone worktree, a gone terminal or an over-age entry resolves via reality", async () => {
    for (const reason of ["its agent's worktree is gone", "its agent has no live terminal", "its agent is idle and the entry is over 2 min old"]) {
      expect(viaOf(reason)).toBe("reality");
    }
    const r = await resolve({ op: "resolve", id: ENTRY.id, squad: "demo", reason: "its agent's worktree is gone" });
    expect(r.q).toMatchObject({ status: "answered", answered_via: "reality" });
    expect(viaOf("its picker closed (picker-done tombstone)")).toBe("terminal");
  });
  test("an id the board already answered, or one not in the state, is a no-op done", async () => {
    const answered = await resolve({ op: "resolve", id: ENTRY.id, squad: "demo", reason: "its picker closed (tool_result in the transcript)" }, { answered: true });
    expect(answered.req.done_at).not.toBeNull();
    expect(answered.result).toMatchObject({ ok: true, changed: false });
    expect(answered.q).toMatchObject({ status: "answered", answered_via: "board" });
    expect(answered.events).toEqual([]);
    const unknown = await resolve({ op: "resolve", id: "picker-nosuch00", squad: "demo", reason: "its picker closed (tool_result in the transcript)" }, { asked: false });
    expect(unknown.result).toMatchObject({ ok: true, changed: false });
  });
  test("an unknown op fails the request with a reason", async () => {
    const r = await resolve({ op: "reopen", id: ENTRY.id, squad: "demo", reason: "x" });
    expect(r.req.done_at).not.toBeNull();
    expect(r.result).toMatchObject({ ok: false });
    expect(String(r.result.error)).toContain("unknown op");
    expect(r.q).toMatchObject({ status: "open" });
  });
});

describe("Claude's auto-block clears the card", () => {
  test("its denial tool_result counts as closed, and the reaped entry leaves the board", async () => {
    const d = mkdtempSync(join(tmpdir(), "zzpickt-")); temps.push(d);
    const t = join(d, "t.jsonl"), line = (c: unknown) => `${JSON.stringify(c)}\n`;
    // The transcript an auto-block leaves (the Tester saw it on picker-AjDvvEWB): the call, then a denial result.
    writeFileSync(t, line({ type: "assistant", message: { content: [{ type: "tool_use", id: ENTRY.tool_use_id, name: "Bash", input: { command: ENTRY.shown, description: "Push the branch" } }] } })
      + line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: ENTRY.tool_use_id, is_error: true, content: "The permission prompt timed out, so the request was blocked to avoid holding up an unattended session." }] } }));
    expect(pickerClosed(t, ENTRY.tool_use_id)).toBe(true);
    const reason = pickerStale({} as Store, "fx", "demo", { ...ENTRY, closed: true }, T);
    expect(reason).toBe("its picker closed (tool_result in the transcript)");
    const r = await resolve({ op: "resolve", id: ENTRY.id, squad: "demo", reason: String(reason) });
    expect(r.q).toMatchObject({ status: "answered", answered_via: "terminal" });
    expect(cards(r.s)).toEqual([]);
  });
});
