// permission-answer.test.ts — permission-prompt-needs-you U2: Yes or No on a safety-check card presses one digit
// only when a fresh screen still shows that prompt (bin/loop/chat/permission.ts), through the answer fulfiller
// against the fake Orca's screen. tests/board-serve.sh covers the board's 409s.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { answer, open as ask, pressRefused } from "../../bin/loop/messages/questions.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { checkable, permissionKey } from "../../bin/loop/chat/permission.ts";
import { claudePrompt } from "../../bin/loop/chat/menu.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const WT = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-builder-demo";
const RULE = "─".repeat(60);

// Claude Code's dialog as 2.1.x draws it: a full-width rule, the tool's lines, the question, the menu.
const screen = (cmd: string[], opts = ["Yes", "No"], question = "Do you want to proceed?", above = "● Bash(ls)\n  ⎿  done") =>
  [above, RULE, " Bash command", "", ...cmd.map((l) => `   ${l}`), "   Push the branch", "",
    " Claude Code can't be sure it read this command the way the shell will.", question,
    ...opts.map((o, i) => `${i ? "  " : "❯"} ${i + 1}. ${o}`), "", " Esc to cancel · Tab to amend"].join("\n");
const PUSH = screen(["git push origin work"]);

describe("permissionKey (the screen check)", () => {
  const bash = { tool: "Bash", shown: "git push origin work", description: "Push the branch" };
  test("Yes and No press their own digit", () => {
    expect(permissionKey(PUSH, bash, "Yes")).toEqual({ digit: 1 });
    expect(permissionKey(PUSH, bash, "No")).toEqual({ digit: 2 });
  });
  test("never another answer, and never 'Yes, and don't ask again'", () => {
    expect(permissionKey(PUSH, bash, "Yes, and don't ask again")).toHaveProperty("why");
    const three = screen(["git push origin work"], ["Yes", "Yes, and don't ask again for git push", "No, and tell Claude what to do differently (esc)"]);
    expect(permissionKey(three, bash, "Yes")).toEqual({ digit: 1 });
    expect(permissionKey(three, bash, "No")).toHaveProperty("why");   // a changed menu: no option reads exactly No
  });
  test("a different command, a cut command or no prompt presses nothing", () => {
    expect(permissionKey(screen(["git push --force origin main"]), bash, "Yes")).toHaveProperty("why");
    expect(permissionKey(PUSH, { ...bash, shown: "git push origin work\n… (cut)" }, "Yes")).toHaveProperty("why");
    expect(permissionKey("$ ls\n❯ 1. Yes\n  2. No", bash, "Yes")).toHaveProperty("why");
    expect(permissionKey("", bash, "Yes")).toHaveProperty("why");
  });
  test("the command must be in the dialog, not in the conversation above its rule", () => {
    const s = screen(["rm -rf build"], ["Yes", "No"], "Do you want to proceed?", "● Bash(git push origin work)\n  ⎿  Waiting…");
    expect(permissionKey(s, bash, "Yes")).toHaveProperty("why");
  });
  test("a long command the dialog wraps matches as a whole", () => {
    const long = `for f in $(ls ./build); do echo "$f" | sed -e 's/a/b/g' -e 's/c/d/g' >> ./out/list-of-every-file.txt; done`;
    const wrapped = screen([long.slice(0, 50), long.slice(50)]);
    expect(permissionKey(wrapped, { ...bash, shown: long }, "Yes")).toEqual({ digit: 1 });
  });
  test("a command sharing a long prefix, a longer command or a second line after it presses nothing", () => {
    const cd = "cd /home/user/orca/workspaces/demo/ds-dev-studio-builder-demo-with-a-long-worktree-name && ";
    const mine = { ...bash, shown: `${cd}npm test` };
    expect(permissionKey(screen([`${cd}npm test`]), mine, "Yes")).toEqual({ digit: 1 });
    expect(permissionKey(screen([`${cd}git push --force origin main`]), mine, "Yes")).toHaveProperty("why");
    expect(permissionKey(screen(["git push origin work --force"]), bash, "Yes")).toHaveProperty("why");
    expect(permissionKey(screen(["git push origin", "work --force"]), bash, "Yes")).toHaveProperty("why");
    expect(permissionKey(screen(["git push origin work", "rm -rf ./build"]), bash, "Yes")).toHaveProperty("why");
  });
  test("the call's own command and description decide, and no description presses nothing", () => {
    expect(permissionKey(PUSH, { tool: "Bash", shown: "git push origin work" }, "Yes")).toHaveProperty("why");
    expect(permissionKey(PUSH, { ...bash, description: "Delete the build" }, "Yes")).toHaveProperty("why");
  });
  test("a command with a redacted secret is a refusal, never a key (U4)", () => {
    const command = "PGPASSWORD=zzabc123 psql -c 'select 1'";
    const hidden = { ...bash, shown: "PGPASSWORD=[redacted] psql -c 'select 1'", command };
    // Its own screen, another prompt with another secret, and a screen that prints the card's text.
    for (const cmd of [command, "PGPASSWORD=zzother psql -c 'select 1'", hidden.shown]) {
      for (const a of ["Yes", "No"]) {
        expect(permissionKey(screen([cmd]), hidden, a)).toHaveProperty("why");
        expect(permissionKey(screen([cmd]), { ...hidden, command: undefined }, a)).toHaveProperty("why");
      }
    }
    // An entry an older hook queued with the secret still in it.
    expect(permissionKey(screen([command]), { ...bash, shown: command }, "Yes")).toHaveProperty("why");
    expect(checkable("Bash", { command }, hidden.shown)).toBe(false);
    expect(checkable("Bash", { command }, command)).toBe(false);
  });
  test("a file change matches on its file's name in the question", () => {
    const edit = screen(["(diff)"], ["Yes", "No"], "Do you want to make this edit to notes.md?");
    expect(permissionKey(edit, { tool: "Edit", shown: "/w/docs/notes.md\nnew text" }, "No")).toEqual({ digit: 2 });
    expect(permissionKey(edit, { tool: "Edit", shown: "/w/docs/other.md\nnew text" }, "Yes")).toHaveProperty("why");
  });
  test("claudePrompt keeps only the dialog's lines", () => {
    expect(claudePrompt(PUSH)).toMatchObject({ question: "Do you want to proceed?", options: ["Yes", "No"] });
    expect(claudePrompt(PUSH)?.dialog).not.toContain("Bash(ls)");
  });
  test("checkable: a Bash command or a file change shown in full", () => {
    expect(checkable("Bash", { command: "ls" }, "ls")).toBe(true);
    expect(checkable("Bash", { command: "ls" }, "ls\n… (cut)")).toBe(false);
    expect(checkable("Write", { file_path: "/a/b.md" }, "/a/b.md\nhi")).toBe(true);
    expect(checkable("WebFetch", { url: "https://example.com" }, '{"url":"https://example.com"}')).toBe(false);
  });
});

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzperm-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}
const fulfillers = (await load<Fulfiller & Reconciler>(DIRS.fulfil)).filter((f) => f.kinds);

// One open permission entry, answered on the board with `ans` while the fake screen shows `tail`.
async function press(ans: string, tail: string, over: Row = {}, answered = false) {
  const s = imported(), orca = new FakeOrca();
  orca.answer = (c) => (c.op === "screen-tail" ? { code: 0, out: tail, err: "" } : undefined);
  const act = new LoopActuator({ orca, fulfillers });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const t = join(s.root, "t.jsonl"), tid = String(over.tool_use_id ?? "toolu_01perm");
  const line = (c: unknown) => `${JSON.stringify(c)}\n`;
  writeFileSync(t, line({ type: "assistant", message: { content: [{ type: "tool_use", id: tid, name: "Bash", input: { command: "git push origin work", description: "Push the branch" } }] } })
    + (answered ? line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: tid, content: "ok" }] } }) : ""));
  const entry = { id: "picker-perm0001", asker: "builder-u1", blocking: true, question: "run this command?", since: "2026-11-26T15:00:00Z",
    source: "picker", picker_kind: "permission", picker_answerable: true, tool: "Bash", shown: "git push origin work",
    tool_use_id: tid, transcript_path: t, card_wt: WT, choices: [{ label: "Yes" }, { label: "No" }], ...over };
  const seq = ask(s, "fx", "demo", entry);
  answer(s, "fx", "demo", entry.id, ans, "board", seq);
  const id = Number(s.request("answer", { id: entry.id, answer: ans, seq, card_wt: WT, via: "board", choices: entry.choices, transcript: t, tool_use_id: tid },
    { project: "fx", squad: "demo", member: WT, by: "board" }).row.id);
  await loop.tick(T); await act.drain();
  const r = s.db.query("SELECT result FROM requests WHERE id = ?").get(id) as Row;
  const q = s.db.query("SELECT status FROM questions WHERE seq = ?").get(seq) as Row;
  return { keys: orca.of("keys").map((c) => c.args), result: JSON.parse(String(r.result ?? "{}")), status: q.status, refused: pressRefused(s, "fx", "demo", entry.id, tid) };
}

describe("the answer fulfiller on a permission prompt", () => {
  test("Yes presses 1 and No presses 2, with no Enter", async () => {
    expect((await press("Yes", PUSH)).keys).toEqual([[WT, "1"]]);
    const no = await press("No", PUSH);
    expect(no.keys).toEqual([[WT, "2"]]);
    expect(no.result).toMatchObject({ ok: true, picked: 2, option: "No" });
  });
  test("a different command types nothing, reopens the card and marks the prompt terminal-only", async () => {
    const r = await press("Yes", screen(["rm -rf ./build"]));
    expect(r.keys).toEqual([]);
    expect(r.result).toMatchObject({ ok: false, prompt_changed: true });
    expect(r.result.error).toContain("answer it in the terminal");
    expect(r.status).toBe("open");
    expect(r.refused).toBe("the screen shows a different command");
  });
  test("a changed menu, a cut command, a synthetic id or an answered prompt types nothing", async () => {
    const three = screen(["git push origin work"], ["Yes", "Yes, and don't ask again", "No, and tell Claude what to do differently (esc)"]);
    for (const r of [await press("No", three), await press("Yes", PUSH, { shown: "git push origin work\n… (cut)" }),
      await press("Yes", PUSH, { tool_use_id: "permission-1a2b3c4d" }), await press("Yes", PUSH, { picker_answerable: false }),
      await press("Yes", PUSH, {}, true)]) {
      expect(r.keys).toEqual([]);
      expect(r.result).toMatchObject({ ok: false, prompt_changed: true });
    }
  });
  test("a redacted prompt types nothing, even on its own screen (U4)", async () => {
    const r = await press("Yes", screen(["curl -u admin:zzhunter2 https://example.com"]), { shown: "curl -u admin:[redacted] https://example.com" });
    expect(r.keys).toEqual([]);
    expect(r.result).toMatchObject({ ok: false, prompt_changed: true });
    expect(r.refused).toBe("the card hides a secret in it");
  });
  test("an unreadable screen types nothing", async () => {
    const r = await press("Yes", "");
    expect(r.keys).toEqual([]);
    expect(r.refused).toBe("the screen shows no permission prompt");
  });
});
