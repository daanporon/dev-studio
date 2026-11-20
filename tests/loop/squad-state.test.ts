// squad-state.test.ts — U13a: bin/role/squad-state.sh (the Bun port) on a marked state root, its questions
// table, and the callers that pass an answer (approve-handoff.sh, picker-hook.sh). Every test works in
// a temp state root; tests/squad-state.sh covers each subcommand on both backends.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SS = join(ROOT, "bin", "role", "squad-state.sh");

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed by the test */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "zzss-")); temps.push(d); return d; }
// A state root with one squad dir; marked = it carries the loop's migrated mark.
function root(marked: boolean): { root: string; file: string } {
  const r = tmp();
  mkdirSync(join(r, "p", "squads"), { recursive: true });
  if (marked) writeFileSync(join(r, ".loop-migrated"), "");
  return { root: r, file: join(r, "p", "squads", "s.json") };
}
function ss(stateRoot: string, ...args: string[]) {
  const p = Bun.spawnSync([SS, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DS_STATE_ROOT: stateRoot, BACKEND: "true" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
function store(r: string): Store { const s = open(r); stores.push(s); return s; }
const rows = (s: Store, sql: string, ...a: string[]) => s.db.query(sql).all(...a) as Record<string, unknown>[];
const doc = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("the store backend", () => {
  test("a restart wait and placement are stored on the member and its unit", () => {
    const { root: r, file } = root(true);
    expect(ss(r, file, "add-unit", "unit", "wt", "", "--tier", "hard").code).toBe(0);
    expect(ss(r, file, "add-member", "builder", "unit", "wt", "--agent", "claude", "--model", "opus").code).toBe(0);
    expect(ss(r, file, "set-member-wait", "wt", "2000000000").code).toBe(0);
    const s = store(r);
    expect(s.get("members", {wt:"wt"})?.status).toBe("waiting");
    expect(s.get("units", {project:"p",squad:"s",slug:"unit"})?.wait_until).toBe(2000000000);
    expect(ss(r, file, "set-member-model", "wt", "opus", "--agent", "claude", "--account", "acct").code).toBe(0);
    expect(s.get("members", {wt:"wt"})).toMatchObject({status:"running",account:"acct",placed_at:expect.any(Number)});
    expect(s.get("units", {project:"p",squad:"s",slug:"unit"})?.wait_until).toBeNull();
  });

  test("done needs a debrief; the debrief lives in the stored squad doc and its export (U1)", () => {
    const { root: r, file } = root(true);
    expect(ss(r, file, "set-task", "t").code).toBe(0);
    const refused = ss(r, file, "set-status", "done");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("refusing done: no debrief — write one first:");
    expect(ss(r, file, "set-debrief", "").code).toBe(1);
    expect(ss(r, file, "set-debrief", "shipped #1\nTry it: nothing to try by hand — docs only\n").code).toBe(0);
    const s = store(r);
    const stored = rows(s, "SELECT status, json_extract(doc, '$.debrief') AS debrief FROM squads WHERE project = 'p' AND topic = 's'");
    expect(stored).toEqual([{ status: "running", debrief: "shipped #1\nTry it: nothing to try by hand — docs only" }]);
    expect(ss(r, file, "set-status", "done").code).toBe(0);
    expect(doc(file)).toMatchObject({ status: "done", debrief: "shipped #1\nTry it: nothing to try by hand — docs only" });
    expect(JSON.parse(ss(r, file, "get").out).debrief).toBe("shipped #1\nTry it: nothing to try by hand — docs only");
  });

  test("a feature squad's debrief needs a Try it part; a testing squad's does not (brief-other-prs U3)", () => {
    const { root: r, file } = root(true);
    expect(ss(r, file, "set-debrief", "1. Set out to do: x\n2. Shipped: #1").code).toBe(0);
    const refused = ss(r, file, "set-status", "done");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Try it");
    expect(ss(r, file, "set-debrief", "2. Shipped: #1\n6. **Try it:** 1. open the board and see x").code).toBe(0);
    expect(ss(r, file, "set-status", "done").code).toBe(0);
    const n = root(true);
    expect(ss(n.root, n.file, "set-debrief", "- try it: nothing to try by hand — docs only").code).toBe(0);
    expect(ss(n.root, n.file, "set-status", "done").code).toBe(0);
    const t = root(true);
    expect(ss(t.root, t.file, "set-type", "testing").code).toBe(0);
    expect(ss(t.root, t.file, "set-debrief", "shipped #1").code).toBe(0);
    expect(ss(t.root, t.file, "set-status", "done").code).toBe(0);
  });

  test("done refuses a planned or held unit, once per hold kind, and names its command (squad-done-definition U2)", () => {
    const { root: r, file } = root(true);
    expect(ss(r, file, "set-task", "t").code).toBe(0);
    expect(ss(r, file, "set-debrief", "d\nTry it: nothing to try by hand — x").code).toBe(0);
    expect(ss(r, file, "add-unit", "plain").code).toBe(0);
    expect(ss(r, file, "add-unit", "fup", "--hold").code).toBe(0);
    expect(ss(r, file, "add-unit", "frozen").code).toBe(0);
    expect(ss(r, file, "set-unit-hold", "frozen", "on", "--why", "ruling").code).toBe(0);
    const refused = ss(r, file, "set-status", "done");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("unit plain is planned and not started — cancel-unit plain --why");
    expect(refused.err).toContain("unit fup is a held follow-up — promote it with add-role.sh");
    expect(refused.err).toContain("unit frozen is held (ruling) — set-unit-hold frozen off");
    expect(refused.err).toContain("or leave the squad parked; it is not done");
    for (const u of ["plain", "fup", "frozen"]) expect(ss(r, file, "cancel-unit", u, "--why", "x").code).toBe(0);
    expect(ss(r, file, "set-status", "done").code).toBe(0);
  });

  test("done with every unit done and a Tester member succeeds; a testing squad keeps the dispatched-only rule", () => {
    const { root: r, file } = root(true);
    expect(ss(r, file, "set-debrief", "d\nTry it: nothing to try by hand — x").code).toBe(0);
    expect(ss(r, file, "add-unit", "a").code).toBe(0);
    expect(ss(r, file, "set-unit-status", "a", "done", "--no-pr").code).toBe(0);
    expect(ss(r, file, "add-member", "tester", "1", "wt_t").code).toBe(0);
    expect(ss(r, file, "set-status", "done").code).toBe(0);
    const t = root(true);
    expect(ss(t.root, t.file, "set-type", "testing").code).toBe(0);
    expect(ss(t.root, t.file, "set-debrief", "d").code).toBe(0);
    expect(ss(t.root, t.file, "add-unit", "held", "--hold").code).toBe(0);
    expect(ss(t.root, t.file, "set-status", "done").code).toBe(0);
  });

  test("DS_STATE_ROOT is honoured: the mark of another root leaves a file in JSON mode", () => {
    const marked = root(true), plain = root(false);
    expect(ss(marked.root, plain.file, "set-task", "t").code).toBe(0);
    expect(existsSync(join(marked.root, "loop.db"))).toBe(false);
    expect(existsSync(join(plain.root, "loop.db"))).toBe(false);
    expect(ss(marked.root, marked.file, "set-task", "t").code).toBe(0);
    expect(rows(store(marked.root), "SELECT task_id FROM squads WHERE project = 'p' AND topic = 's'")).toEqual([{ task_id: "t" }]);
  });

  test("the mark written mid-sequence switches the next write to the store, keeping the file's state", () => {
    const { root: r, file } = root(false);
    ss(r, file, "add-unit", "u1", "", "/p.md", "--tier", "hard");
    ss(r, file, "enqueue-question", "q1", "lead", "true", "Ship?");
    expect(existsSync(join(r, "loop.db"))).toBe(false);
    writeFileSync(join(r, ".loop-migrated"), "");
    expect(ss(r, file, "set-task", "t").code).toBe(0);
    const s = store(r);
    expect(rows(s, "SELECT slug FROM units WHERE squad = 's'")).toEqual([{ slug: "u1" }]);
    expect(rows(s, "SELECT id, status FROM questions")).toEqual([{ id: "q1", status: "open" }]);
    expect(rows(s, "SELECT json_extract(payload, '$.cmd') AS cmd FROM events WHERE kind = 'squad_state'")).toEqual([{ cmd: "set-task" }]);
    expect(doc(file).task_id).toBe("t");
  });

  test("concurrent writes from two processes both land", async () => {
    const { root: r, file } = root(true);
    ss(r, file, "set-task", "t");
    const env = { ...process.env, DS_STATE_ROOT: r };
    const run = (prefix: string) => (async () => {
      for (let i = 0; i < 8; i++) {
        const p = Bun.spawn([SS, file, "add-unit", `${prefix}${i}`, "--hold", "--tier", "hard"], { env, stdout: "ignore", stderr: "ignore" });
        expect(await p.exited).toBe(0);
      }
    })();
    await Promise.all([run("a"), run("b")]);
    const slugs = (doc(file).units as { slug: string }[]).map((u) => u.slug).sort();
    expect(slugs).toEqual(["a", "b"].flatMap((x) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${x}${i}`)));
    expect(rows(store(r), "SELECT COUNT(*) AS n FROM units WHERE squad = 's'")).toEqual([{ n: 16 }]);
  });

  test("an unknown id exits as today and answers nothing", () => {
    const { root: r, file } = root(true);
    ss(r, file, "enqueue-question", "q1", "lead", "true", "Ship?");
    const res = ss(r, file, "resolve-question", "nope", "--answer", "x");
    expect(res.code).toBe(0);
    expect(rows(store(r), "SELECT id, status FROM questions")).toEqual([{ id: "q1", status: "open" }]);
    expect(rows(store(r), "SELECT COUNT(*) AS n FROM events WHERE kind = 'question_answered'")).toEqual([{ n: 0 }]);
  });

  test("re-resolving keeps the first answer; a re-asked id is a new question", () => {
    const { root: r, file } = root(true);
    ss(r, file, "enqueue-question", "q1", "lead", "true", "Ship?", "", "", "", "", "Ship it");
    ss(r, file, "resolve-question", "q1", "--answer", "yes", "--via", "board");
    ss(r, file, "resolve-question", "q1", "--answer", "no", "--via", "terminal");
    const s = store(r);
    expect(rows(s, "SELECT answer, answered_via FROM questions WHERE id = 'q1'")).toEqual([{ answer: "yes", answered_via: "board" }]);
    const ev = rows(s, "SELECT payload FROM events WHERE kind = 'question_answered'");
    expect(ev.map((e) => JSON.parse(String(e.payload)))).toEqual([{ id: "q1", title: "Ship it", answer: "yes", via: "board" }]);
    ss(r, file, "enqueue-question", "q1", "lead", "true", "Ship now?");
    ss(r, file, "resolve-question", "q1", "--answer", "now");
    expect(ss(r, file, "answered-questions").out.split("\n").filter(Boolean).map((l) => l.split("\t")[5])).toEqual(["now", "yes"]);
    expect(ss(r, file, "answered-questions", "--limit", "1").out.split("\t")[5]).toBe("now\n");
    const first = ss(r, file, "answered-questions", "--limit", "1").out.split("\t")[0];
    expect(ss(r, file, "answered-questions", "--before", first).out.split("\t")[5]).toBe("yes\n");
  });

  test("a question that leaves the queue another way is kept, answered via reality", () => {
    const { root: r, file } = root(true);
    ss(r, file, "add-member", "builder", "u2", "wt-b");
    ss(r, file, "add-unit", "u2", "wt-b", "/p.md", "--tier", "hard");
    ss(r, file, "enqueue-question", "sweep-s.builder-u2-123", "sweep", "false", "stuck?");
    expect(ss(r, file, "cancel-unit", "u2").code).toBe(0);
    expect(doc(file).waiting_on_you).toEqual([]);
    expect(rows(store(r), "SELECT status, answered_via FROM questions")).toEqual([{ status: "answered", answered_via: "reality" }]);
  });
});

describe("callers pass the answer", () => {
  test("approve-handoff.sh on a marked root answers plan-<short> with approved", () => {
    const { root: r, file } = root(true);
    const plan = join(r, "p", "squads", "s-feature-plan.md");
    writeFileSync(plan, "# Plan\n\nU1 — First thing — deps: none — Tier: standard\n");
    ss(r, file, "set-lead", "wt-lead");
    ss(r, file, "enqueue-question", "plan-feature", "lead", "true", "Approve the plan?");
    // orch.sh is the only outward call; a stub records it instead.
    const bin = tmp(), log = join(bin, "orch.log");
    writeFileSync(join(bin, "orch.sh"), `#!/usr/bin/env bash\necho "$*" >> ${log}\n`, { mode: 0o755 });
    const p = Bun.spawnSync([join(ROOT, "bin", "role", "approve-handoff.sh"), file, plan, "wt-lead"], { stdout: "pipe", stderr: "pipe",
      env: { ...process.env, DS_STATE_ROOT: r, BACKEND: "true", ORCH: join(bin, "orch.sh") } });
    expect(p.exitCode, p.stderr.toString()).toBe(0);
    expect(readFileSync(log, "utf8")).toStartWith("send-worker wt-lead handoff");
    expect(rows(store(r), "SELECT answer, status FROM questions WHERE id = 'plan-feature'"), p.stderr.toString()).toEqual([{ answer: "approved", status: "answered" }]);
  });

  test("the picker hook's post records the chosen option via picker", () => {
    const { root: r, file } = root(true);
    const fixture = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "picker-post.json"), "utf8"));
    const id = `picker-${String(fixture.tool_use_id).slice(-8)}`;
    ss(r, file, "enqueue-question", id, "builder-a", "true", "Which color for the banner?", "wt-a", "", "", "", "", "[]",
      JSON.stringify({ source: "picker", tool_use_id: fixture.tool_use_id, transcript_path: "/t.jsonl", picker_answerable: true }));
    const p = Bun.spawnSync([join(ROOT, "bin", "hooks", "picker-hook.sh"), "post", file, "builder-a", "wt-a"], {
      stdin: Buffer.from(JSON.stringify(fixture)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, DS_STATE_ROOT: r, BACKEND: "true" } });
    expect(p.exitCode).toBe(0);
    expect(rows(store(r), "SELECT answer, answered_via FROM questions WHERE id = ?", id)).toEqual([{ answer: "Blue", answered_via: "picker" }]);
    expect(doc(file).waiting_on_you).toEqual([]);
  });
});

describe("plan paths canonicalize to the absolute form (U181)", () => {
  // A state root nested one level down, so a relative plan resolves inside this temp dir:
  // the dev-studio root (the state root's parent) is `base` itself.
  const devRoot = (): { base: string; root: string; file: string } => {
    const base = tmp();
    const r = join(base, "state");
    mkdirSync(join(r, "p", "squads"), { recursive: true });
    writeFileSync(join(r, ".loop-migrated"), "");
    return { base, root: r, file: join(r, "p", "squads", "s.json") };
  };
  const rel = "state/p/squads/x-plan.md";
  const ssCwd = (cwd: string, stateRoot: string, ...args: string[]) => {
    const p = Bun.spawnSync([SS, ...args], { stdout: "pipe", stderr: "pipe", cwd,
      env: { ...process.env, DS_STATE_ROOT: stateRoot, BACKEND: "true" } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test("register-plan with a relative path stores the absolute plan", () => {
    const { base, root: r, file } = devRoot();
    const planFile = join(r, "p", "squads", "x-plan.md");
    writeFileSync(planFile, "# Plan\n\nU1 — First thing — deps: none — Tier: standard\n");
    const res = ssCwd(base, r, file, "register-plan", rel);
    expect(res.code, res.err).toBe(0);
    expect(doc(file).units[0].plan).toBe(realpathSync(planFile));
  });

  test("add-unit with a relative plan stores the absolute plan", () => {
    const { base, root: r, file } = devRoot();
    const abs = join(realpathSync(base), rel);
    expect(ss(r, file, "add-unit", "u1", "", rel, "--tier", "standard").code).toBe(0);
    expect(doc(file).units[0].plan).toBe(abs);
  });

  test("approve-plan stores the absolute path; plan-approved agrees in every form", () => {
    const { base, root: r, file } = devRoot();
    const abs = join(realpathSync(base), rel);
    expect(ss(r, file, "approve-plan", rel).code).toBe(0);
    expect(doc(file).approved_plans).toEqual([abs]);
    expect(ss(r, file, "plan-approved", rel).out).toBe("yes\n");
    expect(ss(r, file, "plan-approved", abs).out).toBe("yes\n");
    expect(ssCwd(base, r, file, "plan-approved", rel).out).toBe("yes\n");  // cwd-independent
    const home = process.env.HOME;
    process.env.HOME = base;
    try {
      expect(ss(r, file, "plan-approved", `~/${rel}`).out).toBe("yes\n");
    } finally {
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    }
    expect(ss(r, file, "plan-approved", join(realpathSync(base), "state/p/squads/other.md")).out).toBe("no\n");
  });
});
