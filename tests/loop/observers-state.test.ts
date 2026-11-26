// observers-state.test.ts — U4: the state-file observer on a copy of tests/fixtures/loop/state:
// rows and observed_at, the mtime gate (an unchanged file is not re-read), what it never reads
// (squad JSON, marker files), pickers, transcripts, Lavish, and the accounts refresh.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { importMarkers } from "../../bin/loop/db/import-markers.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { mangle } from "../../bin/loop/observers/orca.ts";
import { stateObserver, type StateOpts } from "../../bin/loop/observers/state.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const LEAD_PATH = "/home/user/orca/workspaces/demo/ds-dev-studio-lead-demo";
const THINKER = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-thinker-demo";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(d); return d; }
function imported(): Store {
  const d = tmp();
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}
// An observer with its outside paths in a temp dir; `refreshed` records the accounts refreshes.
function observer(extra: StateOpts = {}) {
  const d = tmp(), refreshed: number[] = [];
  const opts = { tokenDir: join(d, "projects"), lavishDir: join(d, "lavish"), lavishLog: join(d, "lavish.log"),
    refreshAccounts: (_root: string, maxAge: number) => { refreshed.push(maxAge); }, ...extra };
  return { o: stateObserver(opts), refreshed, ...opts };
}
const tick = (s: Store, o: ReturnType<typeof stateObserver>, at: number) =>
  o.run({ store: s, project: "", tick: at, now: at, fired: [], poked: new Set() } as TickCtx);
const rows = (s: Store, table: string) => s.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
// Bump a file's mtime so the gate sees it move.
const touch = (p: string, at: number) => utimesSync(p, at, at);

describe("state observer", () => {
  test("legacy PR health never deletes or confirms GitHub-owned observations", () => {
    const s = imported(), { o } = observer();
    const key = { project: "fx", ref: "o/r#7" };
    const historicalRows = rows(s, "observed_prs").filter((r) => r.repo == null);
    s.upsert("observed_prs", key, { repo: "o/r", pr: 7, detail: "full", state: "OPEN", verdict: "blocked", problem: "conflicting", since: T - 60, observed_at: T - 60 });
    tick(s, o, T);
    expect(s.get("observed_prs", key)).toMatchObject({ since: T - 60, observed_at: T - 60, detail: "full" });
    tick(s, o, T + 5);
    expect(s.get("observed_prs", key)?.observed_at).toBe(T - 60);
    const f = join(s.root, "fx", "sweep", "pr-health.json");
    writeFileSync(f, JSON.stringify({ at: T + 10, units: {} }));
    tick(s, o, T + 10);
    expect(s.get("observed_prs", key)).toMatchObject({ since: T - 60, observed_at: T - 60 });
    expect(rows(s, "observed_prs").filter((r) => r.repo == null)).toEqual(historicalRows);
    rmSync(f);
    tick(s, o, T + 15);
    expect(s.get("observed_prs", key)?.since).toBe(T - 60);
  });

  test("the state files into observed rows, each with observed_at = the tick", () => {
    const s = imported(), { o } = observer();
    tick(s, o, T);
    const lim = rows(s, "observed_limited");
    expect(lim.map((r) => [r.wt, r.line, r.wait_until])).toEqual([
      [THINKER, "weekly limit · resets Oct 31", 1793473200],
      ["0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-lead-demo", "session limit", null]]);
    expect(rows(s, "observed_compacted")).toEqual([]); // old compaction files are never observed
    for (const t of ["observed_limited", "observed_alerts", "observed_spend", "observed_tokens", "observed_accounts"]) {
      const r = rows(s, t);
      expect(r.length, t).toBeGreaterThan(0);
      expect(r.every((x) => x.observed_at === T), t).toBe(true);
    }
    expect(s.get("projects", { label: "fx" })?.observed_at).toBe(T);
  });

  test("an unchanged file is not re-read, only confirmed; a changed one is re-read", () => {
    const s = imported(), { o } = observer();
    tick(s, o, T);
    s.db.run("UPDATE observed_alerts SET doc = 'edited in the db' WHERE id = 'a1'");
    tick(s, o, T + 5);
    expect([s.get("observed_alerts", { project: "fx", id: "a1" })?.doc, s.get("observed_alerts", { project: "fx", id: "a1" })?.observed_at]).toEqual(["edited in the db", T + 5]);

    const f = join(s.root, "fx", "alerts.json");
    writeFileSync(f, JSON.stringify({ alerts: [{ id: "a2", text: "new" }] }));
    touch(f, T);
    tick(s, o, T + 10);
    expect(rows(s, "observed_alerts").map((r) => [r.id, r.observed_at])).toEqual([["a2", T + 10]]);
  });

  test("a request file that is gone is done; a new one becomes a request", () => {
    const s = imported(), { o } = observer();
    tick(s, o, T);
    rmSync(join(s.root, "fx", "requests", "demo", "restart-lead-1793100100.txt"));
    writeFileSync(join(s.root, "fx", "requests", "demo", "poke-lead-1793100300.txt"), "poke lead\n");
    tick(s, o, T + 5);
    const r = rows(s, "requests").map((x) => [x.key, x.kind, x.done_at]);
    expect(r).toContainEqual(["file:fx/demo/restart-lead-1793100100.txt", "restart", T + 5]);
    expect(r).toContainEqual(["file:fx/demo/poke-lead-1793100300.txt", "poke", null]);
  });

  test("never the squad JSON: a squad file that disagrees with the db leaves the units rows as they are", () => {
    const s = imported(), { o } = observer();
    // demo.json has u1 done; the db has moved on (written since the file).
    s.db.run("UPDATE units SET status = 'planned' WHERE project = 'fx' AND squad = 'demo' AND slug = 'u1-spike-loop-as-coordinator'");
    const before = rows(s, "units");
    touch(join(s.root, "fx", "squads", "demo.json"), T);
    tick(s, o, T);
    tick(s, o, T + 5);
    expect(rows(s, "units")).toEqual(before);
    expect(s.get("units", { project: "fx", squad: "demo", slug: "u1-spike-loop-as-coordinator" })?.status).toBe("planned");
  });

  test("never the marker files: one written after the switch is ignored", () => {
    const s = imported(), { o } = observer();
    importMarkers(s);
    const before = rows(s, "observed_markers");
    writeFileSync(join(s.root, "fx", "sweep", "demo.thinker.poke"), "1800000000\n");
    tick(s, o, T);
    expect(rows(s, "observed_markers")).toEqual(before);
  });

  test("a Lead's beat file is a marker row with its mtime; a beat that left drops its row, the sweep's stay", () => {
    const s = imported(), { o } = observer();
    importMarkers(s);
    const sweep = rows(s, "observed_markers");
    const beat = join(s.root, "fx", "squads", "demo.beat");
    writeFileSync(beat, ""); touch(beat, T - 30);
    tick(s, o, T);
    const r = s.get("observed_markers", { project: "fx", path: "fx/squads/demo.beat" });
    expect([r?.mtime, r?.observed_at]).toEqual([T - 30, T]);
    rmSync(beat);
    tick(s, o, T + 5);
    expect(rows(s, "observed_markers")).toEqual(sweep);
  });

  test("pickers: closed by a tombstone or by a tool_result in the transcript", () => {
    const s = imported(), { o } = observer(), d = tmp();
    const tr = join(d, "t.jsonl");
    writeFileSync(tr, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_aaa" }] } })}\n`);
    const doc = JSON.parse(s.get("squads", { project: "fx", topic: "demo" })!.doc as string);
    doc.waiting_on_you = [
      { source: "picker", id: "picker-aaa", tool_use_id: "toolu_aaa", transcript_path: tr },
      { source: "picker", id: "picker-bbb", tool_use_id: "toolu_bbb", transcript_path: tr },
      { source: "lead", id: "q1" }];
    s.upsert("squads", { project: "fx", topic: "demo" }, { doc: JSON.stringify(doc) });
    mkdirSync(join(s.root, "fx", "picker-done"));
    writeFileSync(join(s.root, "fx", "picker-done", "picker-bbb"), "");
    tick(s, o, T);
    const closed = () => Object.fromEntries(rows(s, "observed_pickers").map((r) => [r.id, JSON.parse(r.doc as string).closed]));
    expect(closed()).toEqual({ "picker-aaa": false, "picker-bbb": true });

    writeFileSync(tr, `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_aaa" }] } })}\n`, { flag: "a" });
    tick(s, o, T + 5);
    expect(closed()).toEqual({ "picker-aaa": true, "picker-bbb": true });
  });

  test("transcripts: each member's newest one, with the model of its last reply", () => {
    const s = imported(), x = observer();
    const dir = join(x.tokenDir, mangle(LEAD_PATH));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.jsonl"), `${JSON.stringify({ type: "assistant", message: { model: "claude-haiku-5-5" } })}\n`);
    touch(join(dir, "old.jsonl"), 1_700_000_000);
    writeFileSync(join(dir, "new.jsonl"), [{ type: "assistant", message: { model: "claude-sonnet-5-5" } }, { type: "user", message: {} }]
      .map((l) => JSON.stringify(l)).join("\n"));
    tick(s, x.o, T);
    const r = rows(s, "observed_transcripts");
    expect(r.map((t) => [t.path, t.project, t.last_model, t.observed_at])).toEqual([[join(dir, "new.jsonl"), "fx", "claude-sonnet-5-5", T]]);
  });

  test("U105 transcripts: last_effort follows the newest perTurnEffort and stays empty without the field", () => {
    const s = imported(), x = observer();
    const dir = join(x.tokenDir, mangle(LEAD_PATH));
    mkdirSync(dir, { recursive: true });
    const a = (eff?: string) => JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5" }, ...(eff ? { perTurnEffort: eff } : {}) });
    writeFileSync(join(dir, "t.jsonl"), `${a("low")}\n${a("high")}\n`);
    tick(s, x.o, T);
    expect(rows(s, "observed_transcripts").map((t) => t.last_effort)).toEqual(["high"]);
    writeFileSync(join(dir, "t.jsonl"), `${a("low")}\n${a("high")}\n${a("medium")}\n`);
    tick(s, x.o, T + 5);
    expect(rows(s, "observed_transcripts").map((t) => t.last_effort)).toEqual(["medium"]);
    writeFileSync(join(dir, "t.jsonl"), `${a()}\n`);
    tick(s, x.o, T + 10);
    expect(rows(s, "observed_transcripts").map((t) => t.last_effort)).toEqual([null]);
  });

  test("transcripts: a newer sdk-cli review file does not displace the member's own cli one", () => {
    const s = imported(), x = observer();
    const dir = join(x.tokenDir, mangle(LEAD_PATH));
    mkdirSync(dir, { recursive: true });
    const cli = (model: string) => JSON.stringify({ type: "assistant", message: { model }, entrypoint: "cli" });
    const sdk = (model: string) => JSON.stringify({ type: "assistant", message: { model }, entrypoint: "sdk-cli" });
    writeFileSync(join(dir, "own.jsonl"), `${cli("claude-sonnet-5-5")}\n`);
    touch(join(dir, "own.jsonl"), 1_700_000_000);
    writeFileSync(join(dir, "review.jsonl"), `${sdk("claude-opus-5-5")}\n`);
    touch(join(dir, "review.jsonl"), 1_700_000_100);
    tick(s, x.o, T);
    // One row per member: the member's cli file, not the newer review file.
    expect(rows(s, "observed_transcripts").map((t) => [t.path, t.last_model, t.entrypoint])).toEqual([
      [join(dir, "own.jsonl"), "claude-sonnet-5-5", "cli"]]);
    // A just-created reviewer file with no entrypoint lines yet does not displace it either.
    writeFileSync(join(dir, "fresh.jsonl"), "");
    touch(join(dir, "fresh.jsonl"), 1_700_000_200);
    tick(s, x.o, T + 1);
    expect(rows(s, "observed_transcripts").map((t) => [t.path, t.last_model, t.entrypoint])).toEqual([
      [join(dir, "own.jsonl"), "claude-sonnet-5-5", "cli"]]);
    // A transcript that did not move keeps its model and entrypoint unread: a same-size
    // rewrite with a different model and entrypoint changes nothing.
    const sameSize = readFileSync(join(dir, "own.jsonl"), "utf8")
      .replace("claude-sonnet-5-5", "claude-sonnet-5-4").replace('"entrypoint":"cli"', '"entrypoint":"sdk"');
    expect(sameSize.length).toBe(readFileSync(join(dir, "own.jsonl"), "utf8").length);
    writeFileSync(join(dir, "own.jsonl"), sameSize);
    touch(join(dir, "own.jsonl"), 1_700_000_000);
    tick(s, x.o, T + 5);
    expect(rows(s, "observed_transcripts").map((t) => [t.last_model, t.entrypoint])).toEqual([["claude-sonnet-5-5", "cli"]]);
  });

  test("transcripts: when every file is headless the newest sdk-cli file is still stored", () => {
    const s = imported(), x = observer();
    const dir = join(x.tokenDir, mangle(LEAD_PATH));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review.jsonl"), `${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" }, entrypoint: "sdk-cli" })}\n`);
    tick(s, x.o, T);
    expect(rows(s, "observed_transcripts").map((t) => [t.path, t.last_model, t.entrypoint])).toEqual([
      [join(dir, "review.jsonl"), "claude-opus-5-5", "sdk-cli"]]);
  });

  test("Lavish pages go to the project whose worktree holds them; the start log's tail is kept", () => {
    const s = imported(), x = observer();
    mkdirSync(x.lavishDir, { recursive: true });
    writeFileSync(join(x.lavishDir, "state.json"), JSON.stringify({ sessions: {
      a: { file: `${LEAD_PATH}/.lavish/plan.html`, url: "http://h/session/a", status: "open" },
      b: { file: "/elsewhere/x.html", url: "http://h/session/b", status: "closed" } } }));
    writeFileSync(x.lavishLog, "started\nlistening on 4387\n");
    tick(s, x.o, T);
    expect(rows(s, "observed_sessions").map((r) => [r.project, r.file, r.status])).toEqual([
      ["fx", `${LEAD_PATH}/.lavish/plan.html`, "open"], ["", "/elsewhere/x.html", "closed"], ["", x.lavishLog, "log"]]);
    expect(JSON.parse(rows(s, "observed_sessions")[2].doc as string).tail).toContain("listening on 4387");
  });

  test("Lavish pages under pages/<topic>/ and squads/<topic>-board/ get the project; notes/ stays unowned", () => {
    const s = imported(), x = observer();
    mkdirSync(x.lavishDir, { recursive: true });
    const f = (rel: string) => `${s.root}/${rel}`;
    writeFileSync(join(x.lavishDir, "state.json"), JSON.stringify({ sessions: {
      a: { file: f("fx/pages/t/a.html"), status: "open" }, b: { file: f("fx/squads/t-board/b.html"), status: "open" },
      c: { file: `${LEAD_PATH}/.lavish/c.html`, status: "open" }, d: { file: f("fx/notes/d.html"), status: "open" },
      e: { file: f("fx/squads/plan.html"), status: "open" } } }));
    tick(s, x.o, T);
    expect(Object.fromEntries(rows(s, "observed_sessions").map((r) => [String(r.file).replace(`${s.root}/`, ""), r.project]))).toMatchObject({
      "fx/pages/t/a.html": "fx", "fx/squads/t-board/b.html": "fx", "fx/notes/d.html": "", "fx/squads/plan.html": "" });
    expect(rows(s, "observed_sessions").find((r) => String(r.file).endsWith("c.html"))?.project).toBe("fx");
  });

  test("a stale accounts.tsv asks for one refresh, not one per tick", () => {
    const s = imported(), x = observer();
    tick(s, x.o, T);
    tick(s, x.o, T + 5);
    expect(x.refreshed).toEqual([60]);
    tick(s, x.o, T + 60);
    expect(x.refreshed).toEqual([60, 60]);
    touch(join(s.root, "accounts.tsv"), T + 100);
    tick(s, x.o, T + 130);
    expect(x.refreshed.length).toBe(2);
  });
});

// Issue #125 (U1): the refresh's accounts-orca.tsv and account-folders.tsv into the accounts table.
describe("the account list", () => {
  const HDR = "agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\tskills\tplan\tresets\n";
  const line = (agent: string, account: string, label = account) => `${agent}\t${account}\t-\t-\t-\t-\t-\t1\t${label}\t-\t-\t-\t-\n`;
  function files(s: Store, at: number, f: { tsv?: string; orca?: string; folders?: string }) {
    for (const [name, text] of [["accounts.tsv", f.tsv], ["accounts-orca.tsv", f.orca], ["account-folders.tsv", f.folders]] as const) {
      if (text === undefined) continue;
      writeFileSync(join(s.root, name), text);
      touch(join(s.root, name), at);
    }
  }
  const acct = (s: Store, account: string, agent = "claude") => s.get("accounts", { agent, account });
  const orca = (state: string, ...l: string[]) => `orca: ${state}\n${l.map((x) => x + "\n").join("")}`;

  test("a profile Orca lists is an orca row it lists, even when accounts.tsv made the row first", () => {
    const s = imported(), x = observer();
    files(s, T, { tsv: HDR + line("claude", "prof-new", "n@example.test"), orca: orca("here", "prof-new\tn@example.test\t/x/prof-new/home\t0", "system\tsystem login\t-\t1") });
    tick(s, x.o, T);
    expect(acct(s, "prof-new")).toMatchObject({ source: "orca", orca_listed: 1, config_dir: "/x/prof-new/home", label: "n@example.test" });
    // The fixture's rows: in accounts.tsv before, not in Orca's list now.
    expect(acct(s, "acct-a")).toMatchObject({ orca_listed: 0 });
  });

  test("a sourceless row is claimed; a removed, ds or system row is never brought back or repointed", () => {
    const s = imported(), x = observer();
    s.upsert("accounts", { agent: "claude", account: "gone" }, { source: "orca", removed_at: T - 9, observed_at: 1 });
    s.upsert("accounts", { agent: "claude", account: "mine" }, { source: "ds", config_dir: "/ds/mine", observed_at: 1 });
    s.upsert("accounts", { agent: "claude", account: "loose" }, { observed_at: 1 });
    files(s, T, { orca: orca("here", "gone\tG\t/o/gone\t0", "mine\tM\t/o/mine\t0", "loose\tL\t/o/loose\t0") });
    tick(s, x.o, T);
    expect(acct(s, "gone")).toMatchObject({ removed_at: T - 9, config_dir: null });
    expect(acct(s, "mine")).toMatchObject({ source: "ds", config_dir: "/ds/mine" });
    expect(acct(s, "loose")).toMatchObject({ source: "orca", config_dir: "/o/loose" });
  });

  test("orca_listed: here sets this list, absent clears every flag, unreachable leaves them", () => {
    const s = imported(), x = observer();
    files(s, T, { orca: orca("here", "p1\tP\t/o/p1\t0") });
    tick(s, x.o, T);
    expect(acct(s, "p1")?.orca_listed).toBe(1);
    files(s, T + 1, { orca: orca("unreachable") });
    tick(s, x.o, T + 1);
    expect(acct(s, "p1")?.orca_listed).toBe(1);
    files(s, T + 2, { orca: orca("absent") });
    tick(s, x.o, T + 2);
    expect(acct(s, "p1")?.orca_listed).toBe(0);
    expect(acct(s, "p1")?.source).toBe("orca");
  });

  test("the default is seeded once from Orca's active account and never moved by a later import", () => {
    const s = imported(), x = observer();
    files(s, T, { orca: orca("here", "p1\tP1\t/o/p1\t1", "p2\tP2\t/o/p2\t0", "system\tS\t-\t0") });
    tick(s, x.o, T);
    expect(acct(s, "p1")?.is_default).toBe(1);
    files(s, T + 1, { orca: orca("here", "p1\tP1\t/o/p1\t0", "p2\tP2\t/o/p2\t1", "system\tS\t-\t0") });
    tick(s, x.o, T + 1);
    expect([acct(s, "p1")?.is_default, acct(s, "p2")?.is_default]).toEqual([1, 0]);
  });

  test("an active system login is the default, its row made as a system row", () => {
    const s = imported(), x = observer();
    files(s, T, { orca: orca("here", "p1\tP1\t/o/p1\t0", "system\tsystem login (me)\t-\t1") });
    tick(s, x.o, T);
    expect(acct(s, "system")).toMatchObject({ source: "system", is_default: 1 });
    expect(acct(s, "p1")?.is_default).toBe(0);
  });

  test("codex's and muse's default rows are system rows under their id; another row gets no source", () => {
    const s = imported(), x = observer();
    files(s, T, { tsv: HDR + line("claude", "system") + line("muse", "default") + line("codex", "default") + line("claude", "stray") });
    tick(s, x.o, T);
    for (const [agent, account] of [["claude", "system"], ["muse", "default"], ["codex", "default"]])
      expect(acct(s, account, agent), `${agent}:${account}`).toMatchObject({ agent, account, source: "system" });
    expect(acct(s, "stray")?.source).toBeNull();
  });

  test("the folder scan replaces observed_account_folders, copies login ids by folder and makes no row", () => {
    const s = imported(), x = observer();
    s.upsert("accounts", { agent: "claude", account: "p1" }, { source: "orca", config_dir: "/o/p1/home", observed_at: 1 });
    files(s, T, { folders: "claude\t/o/p1/home\tuuid-1\t1\nclaude\t/o/orphan/home\t-\t0\n" });
    tick(s, x.o, T);
    expect(rows(s, "observed_account_folders").map((r) => [r.dir, r.login_id, r.logged_in])).toEqual([["/o/p1/home", "uuid-1", 1], ["/o/orphan/home", null, 0]]);
    expect(acct(s, "p1")?.login_id).toBe("uuid-1");
    expect(acct(s, "orphan")).toBeNull();
    files(s, T + 1, { folders: "claude\t/o/p1/home\tuuid-1\t1\n" });
    tick(s, x.o, T + 1);
    expect(rows(s, "observed_account_folders").map((r) => r.dir)).toEqual(["/o/p1/home"]);
  });
});

describe("a note in squads/ is not a squad", () => {
  const note = { kind: "pause-experiment", result: "ok", at: "2026-11-07" };
  const squad = { task_id: "t1", run_id: "r1", type: "feature", autonomy: "checkpoint", status: "running", waiting_on_you: [], lfg_assumptions: [], members: [], units: [] };
  function root(files: Record<string, unknown>): { d: string; s: Store } {
    const d = tmp(), dir = join(d, "p", "squads");
    mkdirSync(dir, { recursive: true });
    for (const [n, v] of Object.entries(files)) writeFileSync(join(dir, n), JSON.stringify(v));
    const s = open(d); stores.push(s);
    return { d, s };
  }
  test("a JSON object with no squad fields gives no rows and one warning, once", () => {
    const { s } = root({ "studio-u88-pause-20261107.json": note });
    const warned: string[] = [];
    importJson(s, s.root, (m) => warned.push(m));
    expect(rows(s, "squads").length).toBe(0);
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain("studio-u88-pause-20261107.json: not a squad file (no status)");
    importJson(s, s.root, (m) => warned.push(m));
    expect(warned.length).toBe(1);
  });
  test("a new squad file still imports next to a note", () => {
    const { s } = root({ "feat.json": squad, "note.json": note });
    const warned: string[] = [];
    importJson(s, s.root, (m) => warned.push(m));
    expect(rows(s, "squads").map((r) => r.topic)).toEqual(["feat"]);
    expect(warned.length).toBe(1);
  });
});
