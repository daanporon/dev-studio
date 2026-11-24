// feedback-notes.test.ts — ds-feedback-github-issues U1: a ds-feedback note is one `feedback_notes` row
// (migration 0057) with the writer's member from DS_MEMBER, else its worktree, else project `-`;
// `ds feedback import` reads the old file once (idempotent) and renames it; with loop.db unopenable the
// note goes to the old file as before.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { feedbackLine, feedbackSummary } from "../../bin/board/board-data.ts";
import { addNote, fileLine, importFile, noteKey, parseFile, stamp, noteLine, whoFromPrefix, whoOf } from "../../bin/loop/feedback/notes.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const FEEDBACK = join(ROOT, "bin", "role", "ds-feedback.sh");
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(): string { const d = mkdtempSync(join(tmpdir(), "zzfb-")); temps.push(d); return d; }
function store(root: string): Store { const s = open(root); stores.push(s); return s; }
const notes = (root: string): Row[] => store(root).db.query("SELECT * FROM feedback_notes ORDER BY id").all() as Row[];

function env(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^(DS_MEMBER|DS_WT|DS_GEN|DS_LOOP_CHILD|DS_NOW|DS_FEEDBACK_LOG|ORCA_TERMINAL_HANDLE|CLAUDE_PROJECT_DIR)$/.test(k)) e[k] = v;
  return { ...e, DS_STATE_ROOT: root, ...extra };
}
function sh(argv: string[], o: { cwd?: string; env: Record<string, string> }): { rc: number; out: string; err: string } {
  const p = Bun.spawnSync(argv, { cwd: o.cwd, env: o.env, stdout: "pipe", stderr: "pipe" });
  return { rc: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}
function gitWorktree(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const r = Bun.spawnSync(["git", "init", "-q", dir], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return dir;
}

describe("whoOf", () => {
  test("DS_MEMBER names the writer", () => {
    const s = store(temp());
    expect(whoOf(s, null, { DS_MEMBER: "zzfb/sq/builder-u1-x" })).toEqual({ project: "zzfb", squad: "sq", role: "builder-u1-x", member: "zzfb/sq/builder-u1-x", wt: null });
  });
  test("the worktree's member when there is no DS_MEMBER", () => {
    const s = store(temp());
    s.upsert("members", { project: "zzfb", squad: "sq", role: "thinker", suffix: "" }, { wt: "/w/zzfb-thinker", status: "running", observed_at: 1, updated_at: 1 });
    const w = whoOf(s, "/w/zzfb-thinker", {});
    expect(w).toMatchObject({ project: "zzfb", squad: "sq", role: "thinker", member: "zzfb/sq/thinker" });
  });
  test("nobody: project -", () => {
    const s = store(temp());
    expect(whoOf(s, "/nowhere", {})).toEqual({ project: "-", squad: null, role: null, member: null, wt: "/nowhere" });
  });
});

describe("addNote", () => {
  test("one row in state new, one feedback_noted event, the same note again adds none", () => {
    const root = temp(), s = store(root);
    const who = whoOf(s, null, { DS_MEMBER: "zzfb/sq/lead" });
    const a = addNote(s, who, "lead on zzfb: the tick is slow", 1_800_000_000);
    expect(a.created).toBe(true);
    expect(a.row).toMatchObject({ project: "zzfb", squad: "sq", role: "lead", member: "zzfb/sq/lead", state: "new", source: "cli", at: 1_800_000_000 });
    expect(a.row.key).toBe(noteKey(stamp(1_800_000_000), "lead on zzfb: the tick is slow"));
    expect(addNote(s, who, "lead on zzfb: the tick is slow", 1_800_000_000).created).toBe(false);
    expect(notes(root)).toHaveLength(1);
    expect((s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'feedback_noted'").get() as { n: number }).n).toBe(1);
  });
});

describe("the old file", () => {
  test("parses lines, joins a continuation, reads the prefix", () => {
    const { notes: ns, skipped } = parseFile("junk\n- 2026-10-01T00:00:00Z — Builder on zzfb/sq: one\n  two\n- 2026-10-02T00:00:00Z — x\n");
    expect(skipped).toBe(1);
    expect(ns.map((n) => n.text)).toEqual(["Builder on zzfb/sq: one\n  two", "x"]);
    expect(whoFromPrefix(ns[0].text, ["zzfb"])).toMatchObject({ project: "zzfb", squad: "sq", role: "builder" });
    expect(whoFromPrefix("Lead on elsewhere: y", ["zzfb"])).toMatchObject({ project: "?", squad: null, role: "lead" });
    expect(whoFromPrefix("no prefix", ["zzfb"]).project).toBe("?");
  });

  test("import is idempotent: a line twice is one row, a line already a row is skipped, the file is renamed", () => {
    const root = temp(), s = store(root);
    mkdirSync(join(root, "zzfb", "squads"), { recursive: true });
    const at = 1_800_000_000;
    addNote(s, whoOf(s, null, { DS_MEMBER: "zzfb/sq/lead" }), "already a row", at);
    const file = join(root, "dev-studio-feedback");
    const body = fileLine("2026-10-01T00:00:00Z", "Lead on zzfb/sq: one") + fileLine("2026-10-01T00:00:00Z", "Lead on zzfb/sq: one") + fileLine(stamp(at), "already a row");
    writeFileSync(file, body);
    const r = importFile(s, file, at);
    expect(r).toMatchObject({ lines: 3, added: 1, known: 1, missing: false });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(r.renamed as string, "utf8")).toBe(body);
    const imp = notes(root).find((n) => n.source === "import") as Row;
    expect(imp).toMatchObject({ project: "zzfb", squad: "sq", role: "lead", member: null, state: "new", at: Date.parse("2026-10-01T00:00:00Z") / 1000 });
    // the same file again (put back by hand): nothing new, renamed beside the first copy
    writeFileSync(file, body);
    const again = importFile(s, file, at);
    expect(again).toMatchObject({ added: 0, known: 2 });
    expect(again.renamed).toBe(`${r.renamed}-2`);
    expect(notes(root)).toHaveLength(2);
    expect(importFile(s, file, at)).toMatchObject({ missing: true, added: 0 });
  });
});

describe("the commands", () => {
  test("ds-feedback.sh in a role worktree writes that member's row", () => {
    const t = temp(), root = join(t, "state"), wt = gitWorktree(join(t, "wt"));
    const s = store(root);
    s.upsert("members", { project: "zzfb", squad: "sq", role: "builder", suffix: "u1-x" }, { wt, status: "running", observed_at: 1, updated_at: 1 });
    s.close();
    const r = sh([FEEDBACK, "the board froze"], { cwd: wt, env: env(root) });
    expect(r.rc).toBe(0);
    expect(r.out).toContain("does not reach the operator");
    expect(notes(root)).toEqual([expect.objectContaining({ project: "zzfb", squad: "sq", role: "builder-u1-x", member: "zzfb/sq/builder-u1-x", text: "the board froze", state: "new" })]);
  });

  test("outside a member: project -; ds feedback list shows it", () => {
    const t = temp(), root = join(t, "state"), out = join(t, "out");
    mkdirSync(out);
    expect(sh([FEEDBACK, "a", "b"], { cwd: out, env: env(root) }).rc).toBe(0);
    const l = sh([DS, "feedback", "list", "--json"], { env: env(root) });
    expect(JSON.parse(l.out)).toEqual([expect.objectContaining({ project: "-", member: null, text: "a b" })]);
    expect(sh([DS, "feedback", "list", "--status", "bogus"], { env: env(root) }).rc).toBe(2);
    expect(sh([DS, "feedback", "list"], { env: env(root) }).out).toContain("1 new");
  });

  test("loop.db unopenable: the note goes to the old file and the command says so", () => {
    const t = temp(), root = join(t, "state");
    mkdirSync(join(root, "loop.db"), { recursive: true }); // a folder where the file should be
    const r = sh([FEEDBACK, "fallback note"], { cwd: t, env: env(root) });
    expect(r.rc).toBe(0);
    expect(r.err).toContain("loop.db could not be opened");
    expect(r.out).toContain(join(root, "dev-studio-feedback"));
    expect(readFileSync(join(root, "dev-studio-feedback"), "utf8")).toMatch(/^- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ — fallback note\n$/);
  });

  test("loop.db opens but the write fails: the note still goes to the old file", () => {
    const t = temp(), root = join(t, "state");
    const s = open(root);
    s.db.run("DROP TABLE feedback_notes"); // the insert now throws after a good open
    s.close();
    const r = sh([FEEDBACK, "write-failed note"], { cwd: t, env: env(root) });
    expect(r.rc).toBe(0);
    expect(r.err).toContain("loop.db could not be opened");
    expect(readFileSync(join(root, "dev-studio-feedback"), "utf8")).toMatch(/ — write-failed note\n$/);
  });

  test("ds feedback import renames the file and reports", () => {
    const t = temp(), root = join(t, "state");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "dev-studio-feedback"), fileLine("2026-10-01T00:00:00Z", "x"));
    const r = sh([DS, "feedback", "import"], { env: env(root) });
    expect(r.rc).toBe(0);
    expect(r.out).toContain("1 added");
    expect(readdirSync(root).some((f) => f.startsWith("dev-studio-feedback.imported-"))).toBe(true);
  });
});

describe("noteLine and the summary (minor snags)", () => {
  const row = (r: Row) => ({ id: 1, at: 1_700_000_000, project: "fx", squad: null, role: "builder", text: "a note", ...r });
  test("a filed and a closed note show their issue; fixed keeps its PR", () => {
    expect(noteLine(row({ state: "filed", issue: 12 }))).toContain("  filed #12  ");
    expect(noteLine(row({ state: "closed", issue: 12 }))).toContain("  closed #12  ");
    expect(noteLine(row({ state: "fixed", issue: 12, fix_pr: 9 }))).toContain("  fixed in #9  ");
    expect(noteLine(row({ state: "filed", issue: null }))).toContain("  filed  ");
  });
  test("feedbackSummary counts closed apart from fixed", () => {
    const s = store(temp());
    for (const [i, state] of ["fixed", "closed", "new"].entries())
      s.upsert("feedback_notes", { key: `fb:${i}` }, { project: "fx", text: "t", source: "cli", state, at: 1, updated_at: 1 });
    const db = { s, all: (q: string, ...a: any[]) => s.db.query(q).all(...a) as Row[], one: (q: string, ...a: any[]) => (s.db.query(q).get(...a) as Row) ?? null };
    const f = feedbackSummary(db as any);
    expect([f.fixed, f.closed, f.notes]).toEqual([1, 1, 3]);
    expect(feedbackLine({ ...f, on: true })).toContain("1 fixed, 1 closed,");
  });
});
