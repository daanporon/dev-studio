// member-ready.test.ts — KTD4 (board chat): memberReady() on a squad member read by worktree, on a
// copy of tests/fixtures/loop/state. Each guard refuses with its own why; an idle member with an
// empty prompt read since its last output is ready. (The Studio's handle path: studio.test.ts.)
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memberReady } from "../../bin/loop/squad/member-ready.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const WS = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo";
const B = `${WS}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function idle(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzready-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  s.upsert("observed_workers", { project: "fx", wt: B }, { state: "idle", last_output_at: T - 60, tail: "some output\n│ ❯ │\n", tail_at: T - 30, unread: 0, gone_at: null, observed_at: T });
  return s;
}
const ready = (s: Store, o: Partial<{ before: number | null; agent: string | null }> = {}, now = T) =>
  memberReady(s, "fx", B, now, { quietS: 10, agent: "claude", ...o });
const set = (s: Store, row: Row) => s.upsert("observed_workers", { project: "fx", wt: B }, row);

describe("memberReady", () => {
  test("an idle member with an empty prompt read since its last output is ready", () => {
    expect(ready(idle())).toEqual({ ready: true, why: "idle" });
  });

  test("each guard refuses with its own why", () => {
    const cases: [string, (s: Store) => void][] = [
      ["no live terminal", (s) => set(s, { gone_at: T - 5 })],
      ["busy: working", (s) => set(s, { state: "working" })],
      ["busy: terminal output", (s) => set(s, { last_output_at: T - 3, tail_at: T })],
      ["busy: transcript", (s) => s.upsert("observed_transcripts", { path: "/x/b.jsonl" }, { project: "fx", wt: B, mtime: T - 2, observed_at: T })],
      ["screen not read since its last output", (s) => set(s, { tail_at: T - 90 })],
      ["no prompt on screen", (s) => set(s, { tail: "Running tests…\n" })],
      ["text at the prompt", (s) => set(s, { tail: "│ ❯ the operator typing │\n" })],
      ["unread mail", (s) => set(s, { unread: 2 })],
      ["a picker is open", (s) => s.db.run("INSERT INTO questions (id, project, squad, asker, status, doc) VALUES ('q1', 'fx', 'demo', ?, 'open', ?)", [B, JSON.stringify({ source: "picker", tool_use_id: "toolu_1" })])],
      ["a menu is open", (s) => set(s, { tail: "What do you want to do?\n  1. Stop and wait for limit to reset\n│ ❯ │\n" })],
      ["an earlier message waits", (s) => s.request("poke", { text: "hi" }, { project: "fx", squad: "demo", member: B })],
      ["an earlier message is not taken yet", (s) => s.db.run("INSERT INTO deliveries (project, squad, member, kind, text, tries, state, at, verify_at) VALUES ('fx', 'demo', ?, 'chat', 'x', 1, 'accepted', ?, ?)", [B, T - 5, T - 4])],
    ];
    for (const [why, arrange] of cases) {
      const s = idle();
      arrange(s);
      expect([why, ready(s)]).toEqual([why, { ready: false, why }]);
    }
  });

  test("a closed picker, an answered question and another member's rows do not block", () => {
    const s = idle();
    s.db.run("INSERT INTO questions (id, project, squad, asker, status, doc) VALUES ('q1', 'fx', 'demo', ?, 'open', ?)", [B, JSON.stringify({ tool_use_id: "toolu_1" })]);
    s.upsert("observed_pickers", { project: "fx", squad: "demo", id: "q1" }, { doc: JSON.stringify({ closed: 1 }), observed_at: T });
    s.db.run("INSERT INTO questions (id, project, squad, asker, status, doc) VALUES ('q2', 'fx', 'demo', ?, 'answered', ?)", [B, JSON.stringify({ tool_use_id: "toolu_2" })]);
    s.request("poke", { text: "hi" }, { project: "fx", squad: "demo", member: `${WS}/ds-dev-studio-lead-demo` });
    // a codex driver knows no menus
    set(s, { tail: "What do you want to do?\n  1. Stop and wait\n│ ❯ │\n" });
    expect(ready(s, { agent: "codex" })).toEqual({ ready: true, why: "idle" });
  });

  test("only requests filed before `before` are ahead", () => {
    const s = idle();
    const first = Number(s.request("chat", { text: "one" }, { project: "fx", squad: "demo", member: B }).row.id);
    const second = Number(s.request("chat", { text: "two" }, { project: "fx", squad: "demo", member: B }).row.id);
    expect(ready(s, { before: first })).toEqual({ ready: true, why: "idle" });
    expect(ready(s, { before: second })).toEqual({ ready: false, why: "an earlier message waits" });
  });
});
