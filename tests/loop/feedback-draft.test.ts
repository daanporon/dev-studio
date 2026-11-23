// feedback-draft.test.ts — ds-feedback-github-issues U2: the feedback reconciler offers the due notes once
// feedback_repo is set and the leak word list holds a word (else one Studio card, no pass); the drafter
// (stub `claude` and `gh` on PATH) writes one draft per new-issue verdict, an add-to draft naming its
// issue, leaves a project-only note with no draft, stores a draft holding a listed word as blocked, keeps
// a note it gave no verdict, and a replay writes nothing.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reconciler from "../../bin/loop/reconcilers/feedback.ts";
import fulfiller from "../../bin/loop/fulfil/feedback-draft.ts";
import { alertGone } from "../../bin/loop/reconcilers/alerts.ts";
import { addNote, NOBODY } from "../../bin/loop/feedback/notes.ts";
import { finalBody, parseAnswer } from "../../bin/loop/feedback/prompt.ts";
import { draftKey, writeVerdicts } from "../../bin/loop/feedback/draft.ts";
import type { Action, TickCtx } from "../../bin/loop/core/plugins.ts";
import type { Exec, Result } from "../../bin/loop/core/actuator.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_900_000_000;
const ENV = ["PATH", "DS_LEAK_WORDS", "STUB_ANSWER", "STUB_ISSUES", "STUB_PROMPT", "STUB_CALLS"] as const;
const saved: Record<string, string | undefined> = {};
const temps: string[] = [], stores: Store[] = [];
beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; });
afterEach(() => {
  for (const s of stores.splice(0)) s.close?.();
  for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true });
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

function fixture(opts: { words?: string | null } = {}) {
  const d = mkdtempSync(join(tmpdir(), "zzfeedback-")); temps.push(d);
  const state = join(d, "state"), conv = join(d, "conv"), bin = join(d, "bin");
  mkdirSync(join(state, "realp", "squads"), { recursive: true });
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(state, "accounts.tsv"));
  const s = open(state); stores.push(s);
  importConfig(s, state, conv);
  for (const r of accountRows(state)) s.upsert(r.table, r.key, r.set);
  s.upsert("config", { project: "", file: "limits.conf", key: "feedback_repo" }, { value: "example-org/dev-studio", observed_at: T });

  const words = join(d, "leak-words.txt");
  if (opts.words !== null) writeFileSync(words, opts.words ?? "zebraquux\n");
  process.env.DS_LEAK_WORDS = words;

  mkdirSync(bin);
  const files = { answer: join(d, "answer.json"), issues: join(d, "issues.json"), prompt: join(d, "prompt.txt"), calls: join(d, "calls"), run: join(d, "run.txt") };
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash
echo claude >> "$STUB_CALLS"
{ pwd; echo "state: $(ls -A state 2>/dev/null | tr '\\n' ' ')"; [ -f AGENTS.md ] && echo has-agents; printf '%s\n' "$@"; } > "$STUB_RUN"
cat > "$STUB_PROMPT"
python3 -c 'import json,sys; print(json.dumps({"type":"result","is_error":False,"result":open(sys.argv[1]).read()}))' "$STUB_ANSWER"
`);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_CALLS"
cat "$STUB_ISSUES"
`);
  for (const f of ["claude", "gh"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(files.issues, JSON.stringify([
    { number: 7, title: "Board hides a stuck unit", body: "It hides.\n\n<!-- ds-feedback v1 area:board kind:bug -->\n<!-- ds-key:fd:aaaa -->" },
    { number: 9, title: "Not ours", body: "no marker here" },
  ]));
  writeFileSync(files.calls, "");
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH ?? process.env.PATH}`, STUB_ANSWER: files.answer, STUB_ISSUES: files.issues, STUB_PROMPT: files.prompt, STUB_CALLS: files.calls, STUB_RUN: files.run });

  const note = (text: string, at: number) => String(addNote(s, { ...NOBODY, project: "realp", role: "builder" }, text, at).row.key);
  const ctx = (now = T): TickCtx => ({ store: s, project: "", tick: 1, now, fired: [], poked: new Set() } as unknown as TickCtx);
  const exec = async (a: Action, now = T): Promise<Result> => {
    const x = { store: s, project: "", tick: 1, now, fired: [], poked: new Set(), act: { orca: { run: async () => ({ code: 0, out: "", err: "" }) } } } as unknown as Exec;
    const r = await fulfiller.exec(a, x);
    return "background" in r ? await r.background : r;
  };
  const answer = (verdicts: unknown[]) => writeFileSync(files.answer, JSON.stringify({ checked: "x", verdicts }));
  const calls = () => readFileSync(files.calls, "utf8").split("\n").filter(Boolean);
  const notes = () => s.db.query("SELECT * FROM feedback_notes ORDER BY at").all() as Row[];
  const drafts = () => s.db.query("SELECT * FROM feedback_drafts ORDER BY id").all() as Row[];
  const events = () => s.db.query("SELECT * FROM events WHERE kind = 'feedback_drafted'").all() as Row[];
  return { s, note, ctx, exec, answer, calls, notes, drafts, events, files };
}

const drafts = (acts: Action[]) => acts.filter((a) => a.kind === "feedback.draft");

test("one pass: issue, add-to, project-only, blocked, no verdict; a replay writes nothing", async () => {
  const f = fixture();
  const a = f.note("the Lead's watch tick prints the same message twice", T - 500);
  const b = f.note("same: watch shows a message twice after an ack", T - 400);
  const c = f.note("board should show the unit's stuck time too", T - 300);
  const d = f.note("the project's own CI is flaky on macOS", T - 200);
  const e = f.note("roles/builder.md misreads a path", T - 100);
  const g = f.note("something vague", T - 50);
  f.answer([
    { verdict: "issue", notes: [a, b], title: "watch.sh repeats an acked message", body: "After an ack the next tick prints it again.", area: "loop", kind: "bug", evidence: "bin/lib/watch.sh" },
    { verdict: "add-to", notes: [c], issue: 7, body: "Also show how long it was stuck.", area: "board", kind: "idea" },
    { verdict: "project-only", notes: [d], reason: "the project's CI, not dev-studio" },
    { verdict: "issue", notes: [e], title: "builder.md names a zebraquux path", body: "It says zebraquux.", area: "roles", kind: "snag" },
  ]);

  const acts = drafts(reconciler.run(f.ctx()));
  expect(acts).toHaveLength(1);
  expect(acts[0]).toMatchObject({ project: "", subject: "feedback.draft", payload: { repo: "example-org/dev-studio", keys: [a, b, c, d, e, g] } });
  expect(await f.exec(acts[0])).toMatchObject({ done: true, result: { drafts: 3, blocked: 1, kept: 1 } });

  const ds = f.drafts();
  expect(ds.map((r) => [r.kind, r.title, r.target, r.leak, r.state])).toEqual([
    ["issue", "watch.sh repeats an acked message", null, "ok", "review"],
    ["add-to", null, 7, "ok", "review"],
    ["issue", "builder.md names a zebraquux path", null, "blocked", "review"],
  ]);
  expect(ds[0]).toMatchObject({ key: draftKey("issue", [a, b], null), area: "loop", label: "bug", repo: "example-org/dev-studio" });
  expect(String(ds[0].body)).not.toContain("ds-feedback v1");       // the marker is added at post time
  expect(String(ds[2].leak_why)).toBe("a word of the host-local list");
  const by = Object.fromEntries(f.notes().map((n) => [n.key, n]));
  expect([a, b].map((k) => [by[k].state, by[k].draft_id])).toEqual([["drafted", ds[0].id], ["drafted", ds[0].id]]);
  expect(by[c]).toMatchObject({ state: "drafted", draft_id: ds[1].id });
  expect(by[d]).toMatchObject({ state: "project-only", reason: "the project's CI, not dev-studio", draft_id: null });
  expect(by[g]).toMatchObject({ state: "new", reason: "the drafter gave no verdict" });
  expect(f.events()).toHaveLength(1);

  // The prompt is data only: no project label, the marker issue in, the other issue out.
  const prompt = readFileSync(f.files.prompt, "utf8");
  expect(prompt).not.toContain("realp");
  expect(prompt).toContain("Board hides a stuck unit");
  expect(prompt).not.toContain("Not ours");

  // The drafter ran in a snapshot of HEAD (no private state), with Read, Grep and Glob only and Read denied on the state root.
  const run = readFileSync(f.files.run, "utf8").split("\n");
  expect(run[0]).not.toBe(ROOT);
  expect(run).toContain("has-agents");
  expect(run).toContain("state: SCHEMA.json ");                   // only the tracked schema: no loop.db, no project

  expect(run[run.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob");
  const deny = run[run.indexOf("--disallowedTools") + 1].split(",");
  expect(deny).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", `Read(/${f.s.root}/**)`]));
  expect(existsSync(run[0])).toBe(false);                         // the snapshot is gone after the pass

  // A replay of the same action: the notes are no longer due, nothing is called or written.
  const before = f.calls().length;
  expect(await f.exec(acts[0])).toEqual({ done: true, result: "nothing new" });
  expect(f.calls().length).toBe(before);
  expect(f.drafts()).toHaveLength(3);
  expect(f.events()).toHaveLength(1);

  // The kept note waits a day before the reconciler offers it again.
  f.s.upsert("episodes", { project: "", subject: "feedback.draft", kind: "action:feedback.draft" }, { state: "done", started_at: T, ended_at: T, episode_key: "x", source: "loop", observed_at: T });
  expect(drafts(reconciler.run(f.ctx(T + 3600)))).toEqual([]);
  expect(drafts(reconciler.run(f.ctx(T + 86_401)))[0]?.payload).toMatchObject({ keys: [g] });
});

test("a dismissed note is never sent, and a note that leaves `new` during a pass is not moved", () => {
  const f = fixture();
  const a = f.note("the board drops a card", T - 300);
  const b = f.note("a private aside the operator dismissed", T - 200);
  const c = f.note("watch.sh ticks twice", T - 100);
  f.s.db.run("UPDATE feedback_notes SET state = 'dismissed' WHERE key = ?", [b]);
  expect(drafts(reconciler.run(f.ctx()))[0]?.payload).toMatchObject({ keys: [a, c] });

  // c is dismissed while the drafter runs: its verdict writes the draft but leaves the note as the operator set it.
  f.s.db.run("UPDATE feedback_notes SET state = 'dismissed' WHERE key = ?", [c]);
  const w = writeVerdicts(f.s, [a, c], [
    { verdict: "project-only", notes: [a], reason: "the project's own board" },
    { verdict: "issue", notes: [c], title: "watch.sh ticks twice", body: "It ticks twice.", area: "loop", kind: "bug", evidence: "", leak: { ok: true } },
  ], { repo: "example-org/dev-studio", head: "", model: null, account: null, at: T });
  expect(w).toMatchObject({ notes: 1, drafts: 1 });
  const by = Object.fromEntries(f.notes().map((n) => [n.key, n]));
  expect([by[a].state, by[b].state, by[c].state, by[c].draft_id]).toEqual(["project-only", "dismissed", "dismissed", null]);
});

test("no word list: one Studio card and no pass; the card clears once the list holds a word", async () => {
  const f = fixture({ words: null });
  const k = f.note("a snag", T - 10);
  const acts = reconciler.run(f.ctx());
  expect(drafts(acts)).toEqual([]);
  const alerts = acts.filter((a) => a.kind === "alert");
  expect(alerts).toHaveLength(1);
  const id = String((alerts[0].payload as Row).id);
  expect(id).toMatch(/^sweep-feedback\.words-[0-9]+$/);
  expect(alerts[0].project).toBe("realp");
  expect(alertGone(f.s, "realp", { id }, T)).toBe(false);

  // The drafter refuses too, even for an action already queued.
  expect(await f.exec({ project: "", subject: "feedback.draft", kind: "feedback.draft", episode: "e", payload: { repo: "example-org/dev-studio", keys: [k] } }))
    .toMatchObject({ dropped: expect.stringContaining("no leak word list") });
  expect(f.drafts()).toEqual([]);
  expect(f.calls()).toEqual([]);

  writeFileSync(process.env.DS_LEAK_WORDS!, "# a comment\nzebraquux\n");
  expect(drafts(reconciler.run(f.ctx(T + 1)))).toHaveLength(1);
  expect(alertGone(f.s, "realp", { id }, T + 1)).toBe("the leak word list is in place");
});

test("feedback_repo '-' offers nothing; a pass in flight blocks the next; a failed pass waits", () => {
  const f = fixture();
  f.note("a snag", T - 10);
  f.s.upsert("config", { project: "", file: "limits.conf", key: "feedback_repo" }, { value: "-", observed_at: T });
  expect(reconciler.run(f.ctx())).toEqual([]);
  f.s.upsert("config", { project: "", file: "limits.conf", key: "feedback_repo" }, { value: "example-org/dev-studio", observed_at: T });
  const claim = { project: "", subject: "feedback.draft", kind: "action:feedback.draft" };
  f.s.upsert("episodes", claim, { state: "running", started_at: T, ended_at: null, episode_key: "x", source: "loop", observed_at: T });
  expect(drafts(reconciler.run(f.ctx()))).toEqual([]);
  f.s.upsert("episodes", claim, { state: "failed", ended_at: T });
  expect(drafts(reconciler.run(f.ctx(T + 60)))).toEqual([]);
  const later = drafts(reconciler.run(f.ctx(T + 1801)));
  expect(later).toHaveLength(1);
  expect(later[0].episode).toEndWith(`|${T}`);
});

test("project row only: the reconciler offers a pass; with no word list, the card and no pass", () => {
  const f = fixture();
  f.s.db.query("DELETE FROM config WHERE project = '' AND key = 'feedback_repo'").run();
  f.s.upsert("config", { project: "realp", file: "limits.conf", key: "feedback_repo" }, { value: "example-org/dev-studio", observed_at: T });
  f.note("a snag", T - 10);
  expect(drafts(reconciler.run(f.ctx()))).toHaveLength(1);
  rmSync(process.env.DS_LEAK_WORDS!);
  const acts = reconciler.run(f.ctx(T + 1));
  expect(drafts(acts)).toEqual([]);
  expect(acts.length).toBeGreaterThan(0);
});

test("parseAnswer: an add-to to an unknown issue, an already-fixed with no evidence and a fence", () => {
  expect(finalBody("Body.\n", "loop", "bug", "fd:0123")).toBe("Body.\n\n<!-- ds-feedback v1 area:loop kind:bug -->\n<!-- ds-key:fd:0123 -->\n");
  const input = { repo: "o/r", head: "abc", issues: [{ number: 7, title: "t", body: "b" }],
    notes: [{ key: "n1", role: null, text: "x" }, { key: "n2", role: null, text: "y" }, { key: "n3", role: null, text: "z" }] };
  const v = parseAnswer("```json\n" + JSON.stringify({ verdicts: [
    { verdict: "add-to", notes: ["n1"], issue: 99, body: "more" },
    { verdict: "already-fixed", notes: ["n2", "n1"] },
    { verdict: "already-fixed", notes: ["n3"], evidence: "abc123 fix(loop): it" },
  ] }) + "\n```", input);
  expect(v).toEqual([
    { verdict: "keep", notes: ["n1"], reason: "the drafter named #99, which is not an open ds-feedback issue" },
    { verdict: "keep", notes: ["n2"], reason: "the drafter said already fixed but gave no evidence" },
    { verdict: "already-fixed", notes: ["n3"], evidence: "abc123 fix(loop): it" },
  ]);
  expect(() => parseAnswer("I think these are fine.", input)).toThrow("not JSON");
});
