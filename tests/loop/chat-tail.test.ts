// chat-tail.test.ts — crew-terminal-access U1: the chat observer keeps each live member's recent
// conversation in observed_chat. A Claude transcript, a Codex rollout and a muse member's screen tail
// (tests/fixtures/chat/) give text turns and one-line tool calls only, secrets redacted, capped, read
// incrementally; an ended member's row is emptied. Secret-shaped strings are built here at run time
// and substituted into the fixtures, so none is committed.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capTurns, chatLine, MAX_BYTES, MAX_RUN_LIST, remark, toolTurn, type Turn } from "../../bin/loop/chat/turns.ts";
import { redact } from "../../bin/loop/chat/redact.ts";
import { screenTurns } from "../../bin/loop/chat/screen.ts";
import { parse as claudeParse } from "../../bin/loop/chat/claude.ts";
import { chatObserver, READ_WINDOW } from "../../bin/loop/observers/chat.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIX = join(ROOT, "tests", "fixtures", "chat");
const T = 1_800_000_000, P = "demo";
const REPO = "0a1b2c3d-0000-4000-8000-00000000d3a0";

// Built at run time: a token and a key block of the shapes KTD3 names.
const GHP = "ghp_" + "Ab1".repeat(12);
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA" + "x".repeat(40), "-----END RSA PRIVATE KEY-----"].join("\n");
const BEARER = "eyJhbGciOi" + "Q".repeat(20);

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzchat-")); temps.push(d); return d; };

type Fx = { s: Store; d: string; claudeWt: string; codexWt: string; museWt: string; claudePath: string; codexPath: string; logs: string[]; o: ReturnType<typeof chatObserver> };

function member(s: Store, wt: string, role: string, agent: string, extra: Row = {}) {
  s.db.run("INSERT INTO members (project, squad, wt, role, suffix, agent, status, observed_at, updated_at) VALUES (?, 'sq', ?, ?, '', ?, 'running', ?, ?)", [P, wt, role, agent, T, T]);
  s.upsert("observed_workers", { project: P, wt }, { agent, started_at: T - 100, gone_at: null, observed_at: T, ...extra });
}
const fill = (src: string, cwd = "") => readFileSync(join(FIX, src), "utf8").replaceAll("__GHP__", GHP)
  .replaceAll("__PEM__", JSON.stringify(PEM).slice(1, -1)).replaceAll("__BEARER__", BEARER).replaceAll("__CWD__", cwd);

function setup(): Fx {
  const d = tmp(), s = open(join(d, "state")); stores.push(s);
  const claudeWt = `${REPO}::${d}/ds-demo-builder-a`, codexWt = `${REPO}::${d}/ds-demo-builder-b`, museWt = `${REPO}::${d}/ds-demo-tester`;
  const claudePath = join(d, "claude.jsonl"), codexPath = join(d, "rollout-1.jsonl");
  writeFileSync(claudePath, fill("claude.jsonl"));
  writeFileSync(codexPath, fill("codex.jsonl", `${d}/ds-demo-builder-b`));
  member(s, claudeWt, "builder", "claude");
  member(s, codexWt, "builder", "codex");
  member(s, museWt, "tester", "muse", { tail: fill("screen.txt"), tail_at: T - 5 });
  s.upsert("observed_transcripts", { path: claudePath }, { project: P, wt: claudeWt, mtime: T, size: statSync(claudePath).size, entrypoint: "cli", observed_at: T });
  // A reviewer's headless transcript beside it is never the member's.
  s.upsert("observed_transcripts", { path: join(d, "headless.jsonl") }, { project: P, wt: claudeWt, mtime: T + 1, size: 1, entrypoint: "sdk-cli", observed_at: T });
  s.upsert("observed_rollouts", { path: codexPath }, { cwd: `${d}/ds-demo-builder-b`, originator: "codex_cli_rs", mtime: T, size: statSync(codexPath).size, observed_at: T });
  s.upsert("observed_rollouts", { path: join(d, "rollout-review.jsonl") }, { cwd: `${d}/ds-demo-builder-b`, originator: "codex_exec", mtime: T + 1, size: 1, observed_at: T });
  const logs: string[] = [];
  return { s, d, claudeWt, codexWt, museWt, claudePath, codexPath, logs, o: chatObserver({ log: (l) => logs.push(l) }) };
}
const tick = (f: Fx, at = T) => f.o.run({ store: f.s, project: P, tick: at, now: at, fired: [], poked: new Set() } as TickCtx);
const row = (f: Fx, wt: string) => f.s.get("observed_chat", { project: P, wt }) as Row;
const turns = (f: Fx, wt: string) => JSON.parse(String(row(f, wt).turns)) as Turn[];
const changes = (s: Store) => (s.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
const userLine = (text: string, ts = "2026-11-17T11:00:00Z") => `${JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: ts })}\n`;

describe("chat observer: turns per provider", () => {
  test("Claude: user and assistant text, one-line tool calls, no tool output, thinking, sidechain or harness text", () => {
    const f = setup(); tick(f);
    const r = row(f, f.claudeWt), ts = turns(f, f.claudeWt), all = String(r.turns);
    expect(r.source).toBe("transcript");
    expect(r.path).toBe(f.claudePath);
    expect(ts.map((t) => [t.role, t.tool ?? null, t.text.split("\n")[0]])).toEqual([
      ["user", null, "Build U1 please; the old token was [redacted]"],
      ["assistant", null, "Reading the observer first."],
      ["assistant", "2 tools", "2 tools · last: Bash gh pr view 12 --json state | jq .state"],
      ["assistant", null, "Found the key in the env file:"],
    ]);
    expect(ts[2].tools).toEqual(["Read bin/x.ts", "Bash gh pr view 12 --json state | jq .state"]);
    expect(ts[2].counts).toEqual({ Read: 1, Bash: 1 });
    expect(ts[3].text).toBe("Found the key in the env file:\n[redacted]\nI will not use it.");
    expect(ts[0].at).toBe(Date.parse("2026-11-17T10:00:01Z") / 1000);
    for (const bad of ["TOOL OUTPUT", "PRIVATE THOUGHT", "SIDECHAIN", "COMPACT SUMMARY", "ATTACHMENT", "LOCAL COMMAND", "Caveat", GHP, "PRIVATE KEY", "MIIEow"]) expect(all).not.toContain(bad);
    expect(r.read_to).toBe(statSync(f.claudePath).size);
    expect(r.gone_at).toBeNull();
  });

  test("Codex: the same shape from a rollout; developer, instruction and environment blocks dropped", () => {
    const f = setup(); tick(f);
    const r = row(f, f.codexWt), ts = turns(f, f.codexWt), all = String(r.turns);
    expect(r.source).toBe("transcript");
    expect(r.path).toBe(f.codexPath);
    expect(ts.map((t) => [t.role, t.tool ?? null, t.text])).toEqual([
      ["user", null, "Please fix the failing test"],
      ["assistant", null, "Looking at the test."],
      ["assistant", "2 tools", "2 tools · last: exec cat AGENTS.md"],
      ["assistant", null, "Done; the token [redacted] was in the log."],
    ]);
    for (const bad of ["TOOL OUTPUT", "DEVELOPER", "AGENTS BODY", "ENVIRONMENT", "ENCRYPTED", GHP]) expect(all).not.toContain(bad);
  });

  test("an agent without a reader (muse) gets one screen turn from the observed tail, redacted", () => {
    const f = setup(); tick(f);
    const r = row(f, f.museWt), ts = turns(f, f.museWt);
    expect(r.source).toBe("screen");
    expect(r.path).toBeNull();
    expect(ts).toHaveLength(1);
    expect(ts[0]).toEqual({ role: "screen", text: "● Reviewing the plan\n  Authorization: Bearer [redacted]\n\n>", at: T - 5 });
    // The screen moved: the turn follows it.
    f.s.upsert("observed_workers", { project: P, wt: f.museWt }, { tail: "> done", tail_at: T + 10 });
    tick(f, T + 10);
    expect(turns(f, f.museWt)).toEqual([{ role: "screen", text: "> done", at: T + 10 }]);
    expect(row(f, f.museWt).updated_at).toBe(T + 10);
  });

  test("ds observed chat shows each member's turns", () => {
    const f = setup(); tick(f); f.s.close();
    const p = Bun.spawnSync([join(ROOT, "bin", "ds"), "observed", "chat", "--project", P], { env: { ...process.env, DS_STATE_ROOT: join(f.d, "state") } });
    const out = p.stdout.toString();
    expect(p.exitCode).toBe(0);
    for (const s of ["Read bin/x.ts", "Looking at the test.", "Reviewing the plan", "[redacted]"]) expect(out).toContain(s);
    for (const bad of ["TOOL OUTPUT", GHP, "MIIEow", BEARER]) expect(out).not.toContain(bad);
  });
});

describe("redaction and caps", () => {
  test("each secret shape is [redacted]", () => {
    const shapes = [GHP, "gho_" + "a1".repeat(15), "github_pat_" + "B2_".repeat(10), "sk-ant-api03-" + "z9".repeat(10),
      "sk-proj-" + "Y8".repeat(12), "xoxb-" + "123-".repeat(4) + "abc", "AKIA" + "ABCDEFGH23456789", PEM];
    for (const sh of shapes) expect(redact(`before ${sh} after`)).toBe("before [redacted] after");
    expect(redact(`Authorization: Bearer ${BEARER}`)).toBe("Authorization: Bearer [redacted]");
    // A key block cut before its END line is redacted to the end.
    expect(redact(`x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r`)).toBe("x\n[redacted]");
    expect(redact("plain words, a sk-short and ghp_x stay")).toBe("plain words, a sk-short and ghp_x stay");
    // A key whose BEGIN line scrolled off the screen's top is redacted up to its END line.
    expect(redact(`MIIEowIBAAKCAQEA${"x".repeat(40)}\n-----END RSA PRIVATE KEY-----\n$ ls`)).toBe("[redacted]\n$ ls");
  });

  test("a screen tail is redacted before it is cut, so a token across the cut is not left in clear", () => {
    // The 3999-character cut falls 4 characters into the token.
    const tail = "z".repeat(10) + " " + GHP + " " + "q".repeat(3999 - GHP.length + 4 - 1);
    const t = screenTurns({ tail, tail_at: T } as Row)[0];
    expect(t.text).not.toContain(GHP.slice(4));
    expect(t.text).not.toContain(GHP.slice(8, 30));
  });

  test("a tool call is one line with an 80-character target", () => {
    const t = toolTurn("Bash", { command: `echo ${"a".repeat(200)}\nrm -rf x`, description: "d" }, null);
    expect(t.text.startsWith("Bash echo aaa")).toBe(true);
    expect(t.text.length).toBeLessThanOrEqual("Bash ".length + 80);
    expect(t.text).not.toContain("\n");
    expect(toolTurn("Grep", { pattern: "foo", path: "bin" }, null).text).toBe("Grep bin");
    expect(toolTurn("TodoWrite", { todos: [] }, null).text).toBe("TodoWrite");
  });

  test("30 turns are capped to the newest 20, and a 40 KB turn is cut to the cap", () => {
    const f = setup();
    appendFileSync(f.claudePath, Array.from({ length: 30 }, (_, i) => userLine(`message ${i}`)).join(""));
    tick(f);
    const ts = turns(f, f.claudeWt);
    expect(ts).toHaveLength(20);
    expect(ts[0].text).toBe("message 10");
    expect(ts[19].text).toBe("message 29");
    appendFileSync(f.claudePath, userLine("w".repeat(40 * 1024)));
    tick(f, T + 1);
    expect(Buffer.byteLength(String(row(f, f.claudeWt).turns))).toBeLessThanOrEqual(MAX_BYTES);
    expect(turns(f, f.claudeWt).at(-1)!.text.startsWith("www")).toBe(true);
    // Multi-byte text alone over the cap is cut until it fits.
    const big = capTurns([{ role: "user", text: "é".repeat(12000), at: null }]);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(MAX_BYTES);
  });
});

const toolLine = (name: string, input: Record<string, unknown>, ts: string) =>
  `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t" + ts, name, input }] }, timestamp: ts })}\n`;
const at = (m: number) => `2026-11-17T12:${String(m).padStart(2, "0")}:00Z`;

describe("crew-terminal-access U5: a conversation, not a tool log", () => {
  test("an operator line stays in the window after 30 tool calls follow it, read over several ticks", () => {
    const f = setup(); tick(f);
    appendFileSync(f.claudePath, userLine(chatLine("rebase on main please"), at(0)));
    for (let i = 0; i < 3; i++) {
      appendFileSync(f.claudePath, Array.from({ length: 10 }, (_, k) => i * 10 + k).map((n) =>
        n % 3 === 0 ? toolLine("Read", { file_path: `f${n}.ts` }, at(n + 1)) : toolLine("Bash", { command: `git step ${n}` }, at(n + 1))).join(""));
      tick(f, T + 10 + i);
    }
    const ts = turns(f, f.claudeWt), op = ts.findIndex((t) => t.from === "operator" && !t.via);
    expect(op).toBeGreaterThanOrEqual(0);
    expect(ts[op]).toMatchObject({ role: "user", text: "rebase on main please", from: "operator", at: Date.parse(at(0)) / 1000 });
    // Thirty calls across three ticks are one turn after it: every call counted, the newest ten listed.
    expect(ts.slice(op + 1)).toHaveLength(1);
    const run = ts[op + 1];
    expect(run.tool).toBe("30 tools");
    expect(run.counts).toEqual({ Read: 10, Bash: 20 });
    expect(run.tools).toHaveLength(MAX_RUN_LIST);
    expect(run.tools!.at(-1)).toBe("Bash git step 29");
    expect(run.text).toBe("30 tools · last: Bash git step 29");
    expect(run.at).toBe(Date.parse(at(30)) / 1000);
  });

  test("the operator mark: the board's prefix is stripped; a Lead's mail or a wake is plain input", () => {
    const ts = capTurns([
      { role: "user", text: "Lead: main moved", at: 1 }, { role: "user", text: "N new messages for you", at: 2 },
      { role: "user", text: "rebase please", at: 3, from: "operator" }]);
    expect(ts.map((t) => t.from ?? null)).toEqual([null, null, "operator"]);
    const f = setup(); tick(f);
    appendFileSync(f.claudePath, userLine("dev-studio board, the operator says: look again") + userLine("dev-studio: 1 new message for you"));
    tick(f, T + 1);
    const last = turns(f, f.claudeWt).slice(-2);
    expect(last.map((t) => [t.text, t.from ?? null])).toEqual([["look again", "operator"], ["dev-studio: 1 new message for you", null]]);
  });

  test("U7: typed, multi-line and pasted lines are operator turns via the terminal; loop and harness lines are not", () => {
    const f = setup(); tick(f);
    const lines = ["use the second approach", "first line\nsecond line", `<pasted_content id="x">${"E".repeat(900)}</pasted_content>`,
      "dev-studio: 1 new message for you", "dev-studio loop: poke", "dev-studio stop checkpoint: write a journal",
      "<task-notification>done</task-notification>", "You are working inside Orca, a multi-agent IDE.",
      "[Request interrupted by user for tool use]", "<script>alert(1)</script>"];
    appendFileSync(f.claudePath, lines.map((l, i) => userLine(l, `2026-11-17T12:00:0${i % 10}Z`)).join(""));
    tick(f, T + 2);
    const last = turns(f, f.claudeWt).slice(-lines.length);
    expect(last.map((t) => [t.from ?? null, t.via ?? null])).toEqual([
      ["operator", "terminal"], ["operator", "terminal"], ["operator", "terminal"], [null, null], [null, null], [null, null],
      [null, null], [null, null], ["interrupted", null], ["operator", "terminal"]]);
    expect(last[1].text).toBe("first line\nsecond line");
    expect(last[2].text).toBe(`${"E".repeat(599)}…`);
    expect(last[9].text).toBe("<script>alert(1)</script>");
  });

  test("U7: a board line keeps its mark and no via; a stored pre-U7 row is re-marked on the next tick", () => {
    expect(remark([{ role: "user", text: "typed", at: 1 }, { role: "user", text: "dev-studio: poke", at: 2 },
      { role: "user", text: "[Request interrupted by user]", at: 3 }, { role: "assistant", text: "typed", at: 4 }, { role: "user", text: "b", at: 5, from: "operator" }]))
      .toEqual([{ role: "user", text: "typed", at: 1, from: "operator", via: "terminal" }, { role: "user", text: "dev-studio: poke", at: 2 },
        { role: "user", text: "[Request interrupted by user]", at: 3, from: "interrupted" }, { role: "assistant", text: "typed", at: 4 }, { role: "user", text: "b", at: 5, from: "operator" }]);
    const f = setup(); tick(f);
    appendFileSync(f.claudePath, userLine(chatLine("from the board"), "2026-11-17T12:30:00Z"));
    tick(f, T + 1);
    expect(turns(f, f.claudeWt).at(-1)).toMatchObject({ text: "from the board", from: "operator" });
    expect(turns(f, f.claudeWt).at(-1)?.via).toBeUndefined();
    // Stored before U7: a typed line without a mark; the transcript has not grown.
    const r = row(f, f.claudeWt), old = JSON.parse(String(r.turns)) as Turn[];
    old.push({ role: "user", text: "old typed line", at: 9 });
    f.s.upsert("observed_chat", { project: P, wt: f.claudeWt }, { turns: JSON.stringify(old) });
    tick(f, T + 2);
    expect(turns(f, f.claudeWt).at(-1)).toMatchObject({ text: "old typed line", from: "operator", via: "terminal" });
  });

  test("the window keeps 20 messages however many tool calls sit between them, within 32 KB", () => {
    const many: Turn[] = [];
    for (let i = 0; i < 25; i++) {
      many.push({ role: "assistant", text: `reply ${i}`, at: i });
      for (let k = 0; k < 15; k++) many.push(toolTurn("Bash", { command: `cmd ${i}.${k} ${"z".repeat(60)}` }, i));
    }
    const ts = capTurns(many);
    expect(ts.filter((t) => !t.tool).map((t) => t.text)).toEqual(Array.from({ length: 20 }, (_, i) => `reply ${i + 5}`));
    expect(ts.filter((t) => t.tool)).toHaveLength(20);
    expect(ts.filter((t) => t.tool).every((t) => t.tool === "15 tools")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(ts))).toBeLessThanOrEqual(MAX_BYTES);
    expect(MAX_BYTES).toBe(32 * 1024);
  });
});

describe("incremental reads", () => {
  test("a second tick after a 1-line append reads only the appended bytes", () => {
    const f = setup(); tick(f);
    const before = Number(row(f, f.claudeWt).read_to), n = turns(f, f.claudeWt).length;
    // Blank out the bytes already read (same size): a re-read of them would lose the old turns.
    writeFileSync(f.claudePath, " ".repeat(before - 1) + "\n");
    const line = userLine("one more thing");
    appendFileSync(f.claudePath, line);
    tick(f, T + 1);
    const r = row(f, f.claudeWt), ts = turns(f, f.claudeWt);
    expect(Number(r.read_to) - before).toBe(Buffer.byteLength(line));
    expect(ts).toHaveLength(n + 1);
    expect(ts[0].text).toBe("Build U1 please; the old token was [redacted]");
    expect(ts.at(-1)!.text).toBe("one more thing");
    expect(r.updated_at).toBe(T + 1);
  });

  test("a new 5 MB transcript is read from at most 256 KB before its end", () => {
    const f = setup();
    const filler = `${JSON.stringify({ type: "attachment", attachment: { text: "f".repeat(1000) } })}\n`;
    writeFileSync(f.claudePath, userLine("EARLY MARK") + filler.repeat(Math.ceil((5 * 1024 * 1024) / filler.length)) + userLine("LATE MARK"));
    tick(f);
    const r = row(f, f.claudeWt);
    expect(turns(f, f.claudeWt).map((t) => t.text)).toEqual(["LATE MARK"]);
    expect(r.read_to).toBe(statSync(f.claudePath).size);
    expect(statSync(f.claudePath).size).toBeGreaterThan(5 * 1024 * 1024);
    expect(READ_WINDOW).toBe(256 * 1024);
  });

  const asst = (text: string) => `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, timestamp: "2026-11-17T11:05:00Z" })}\n`;
  const blob = (type: string, kb: number, extra: Record<string, unknown> = {}) => `${JSON.stringify({ type, ...extra, attachment: { text: "z".repeat(kb * 1024) } })}\n`;

  test("a compaction burst over the read window keeps the board line and the reply in order", () => {
    const f = setup(); tick(f);
    appendFileSync(f.claudePath, asst("first answer"));
    tick(f, T + 1);
    appendFileSync(f.claudePath, userLine("dev-studio board, the operator says: please summarise"));
    const burst = JSON.stringify({ type: "system", subtype: "compact_boundary" }) + "\n"
      + JSON.stringify({ type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "COMPACT SUMMARY TEXT" } }) + "\n"
      + blob("attachment", 160) + blob("api-request-blob", 60) + blob("api-request-blob", 60);
    appendFileSync(f.claudePath, burst);
    expect(Buffer.byteLength(burst)).toBeGreaterThan(READ_WINDOW);
    appendFileSync(f.claudePath, asst("the reply after compaction"));
    tick(f, T + 2);
    const ts = turns(f, f.claudeWt), texts = ts.map((t) => t.text);
    const i = texts.indexOf("please summarise"), j = texts.indexOf("the reply after compaction");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(ts[i].from).toBe("operator");
    expect(texts.some((x) => String(x).includes("COMPACT SUMMARY"))).toBe(false);
    expect(row(f, f.claudeWt).read_to).toBe(statSync(f.claudePath).size);
  });

  test("a line longer than the read window is parsed whole across chunks", () => {
    const f = setup(); tick(f);
    appendFileSync(f.claudePath, userLine("x".repeat(READ_WINDOW + 5000)) + asst("after the long line"));
    tick(f, T + 1);
    const texts = turns(f, f.claudeWt).map((t) => String(t.text));
    expect(texts.some((x) => x.startsWith("xxx"))).toBe(true);
    expect(texts.at(-1)).toBe("after the long line");
  });

  test("an append over FOLLOW_MAX jumps to the end window and logs once", () => {
    const f = setup();
    f.o = chatObserver({ log: (l) => f.logs.push(l), followMax: 1024 * 1024 });
    tick(f);
    const n = turns(f, f.claudeWt).length;
    appendFileSync(f.claudePath, userLine("LOST MARK") + blob("attachment", 1100) + asst("tail reply"));
    tick(f, T + 1);
    const texts = turns(f, f.claudeWt).map((t) => String(t.text));
    expect(texts).toHaveLength(n + 1);
    expect(texts.at(-1)).toBe("tail reply");
    expect(texts).not.toContain("LOST MARK");
    appendFileSync(f.claudePath, blob("attachment", 1100) + asst("again"));
    tick(f, T + 2);
    expect(f.logs.filter((l) => l.includes("in one tick"))).toHaveLength(1);
  });

  test("a half-written line is not parsed until it completes", () => {
    const f = setup(); tick(f);
    const before = Number(row(f, f.claudeWt).read_to), n = turns(f, f.claudeWt).length;
    const line = userLine("finished later");
    appendFileSync(f.claudePath, line.slice(0, 20));
    tick(f, T + 1);
    expect(Number(row(f, f.claudeWt).read_to)).toBe(before);
    expect(turns(f, f.claudeWt)).toHaveLength(n);
    appendFileSync(f.claudePath, line.slice(20));
    tick(f, T + 2);
    expect(Number(row(f, f.claudeWt).read_to)).toBe(before + Buffer.byteLength(line));
    expect(turns(f, f.claudeWt).at(-1)!.text).toBe("finished later");
  });

  test("a tick where no transcript grew reads no file content and writes no row", () => {
    const f = setup(); tick(f);
    // Unreadable but still stat-able: any read would fail and log.
    chmodSync(f.claudePath, 0o000); chmodSync(f.codexPath, 0o000);
    try {
      const c = changes(f.s);
      tick(f, T + 30);
      expect(changes(f.s)).toBe(c);
      expect(f.logs).toEqual([]);
    } finally { chmodSync(f.claudePath, 0o644); chmodSync(f.codexPath, 0o644); }
  });

  test("an unreadable path leaves the last turns in place and logs one line", () => {
    const f = setup(); tick(f);
    const kept = row(f, f.claudeWt).turns;
    rmSync(f.claudePath);
    tick(f, T + 1); tick(f, T + 2);
    expect(row(f, f.claudeWt).turns).toBe(kept);
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain(f.claudePath);
  });
});

describe("ended members", () => {
  test("an ended member's row gets gone_at and its turns emptied; it is not deleted", () => {
    const f = setup(); tick(f);
    f.s.upsert("observed_workers", { project: P, wt: f.codexWt }, { gone_at: T + 5 });
    f.s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [f.museWt]);
    tick(f, T + 10);
    for (const wt of [f.codexWt, f.museWt]) {
      expect(row(f, wt).gone_at).toBe(T + 10);
      expect(row(f, wt).turns).toBe("[]");
    }
    expect(turns(f, f.claudeWt).length).toBeGreaterThan(0);
    // A member that comes back reads its transcript again from the window.
    f.s.upsert("observed_workers", { project: P, wt: f.codexWt }, { gone_at: null });
    tick(f, T + 20);
    expect(row(f, f.codexWt).gone_at).toBeNull();
    expect(turns(f, f.codexWt)).toHaveLength(4);
  });

  test("older turns go first and the newest operator line stays", () => {
    const ts = capTurns([
      ...Array.from({ length: 4 }, (_, i) => ({ role: "assistant" as const, text: `old ${i}` + "o".repeat(3990), at: i })),
      { role: "user", text: "do the thing", at: 4, from: "operator" },
      ...Array.from({ length: 6 }, (_, i) => ({ role: "assistant" as const, text: `${i}`.repeat(4000), at: 5 + i })),
    ]);
    expect(ts.some((t) => t.text.startsWith("old 0"))).toBe(false);
    expect(ts.find((t) => t.from === "operator")?.text).toBe("do the thing");
    expect(ts.at(-1)?.text).toBe("5".repeat(4000));
    expect(Buffer.byteLength(JSON.stringify(ts))).toBeLessThanOrEqual(MAX_BYTES);
  });

  test("when the operator line and what follows are still too big, the replies after it are cut, never the line", () => {
    const ts = capTurns([
      { role: "assistant", text: "before", at: 0 },
      { role: "user", text: "do the thing", at: 1, from: "operator" },
      ...Array.from({ length: 12 }, (_, i) => ({ role: "assistant" as const, text: `${i}`.repeat(4000), at: 2 + i })),
    ]);
    expect(ts[0]).toMatchObject({ text: "do the thing", from: "operator" });
    expect(ts).toHaveLength(13);
    expect(ts.slice(1).some((t) => t.text.length <= 1500 && t.text.endsWith("… (cut — full text in the terminal)"))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(ts))).toBeLessThanOrEqual(MAX_BYTES);
  });

  test("twenty short messages after the operator line keep the newest 20; the line drops only then", () => {
    const after = (n: number): Turn[] => [{ role: "user", text: "ask", at: 0, from: "operator" }, ...Array.from({ length: n }, (_, i) => ({ role: "assistant" as const, text: `r${i}`, at: i + 1 }))];
    expect(capTurns(after(19)).map((t) => t.text)[0]).toBe("ask");
    const t20 = capTurns(after(20));
    expect(t20).toHaveLength(20);
    expect(t20.some((t) => t.from === "operator")).toBe(false);
  });
});

test("chat-image-upload U2: a board line's images suffix becomes `images`, in the path, native and image-only forms", () => {
  const turns = claudeParse(readFileSync(join(FIX, "claude-images.jsonl"), "utf8"));
  expect(turns.map((t) => ({ text: t.text, from: t.from, images: t.images }))).toEqual([
    { text: "look", from: "operator", images: ["0123456789abcdef.png", "fedcba9876543210.jpg"] },
    { text: "look", from: "operator", images: [null] },
    { text: "", from: "operator", images: ["0123456789abcdef.png"] },
  ]);
});
