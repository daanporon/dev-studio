// close-against-reality.test.ts — U231: a close or suspend wish is granted against the worktrees and
// agents that really exist: drift repair, gone-after-start reads none, a stale dispatch is no evidence,
// and a stop that reported done is checked.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { claudeTmpDir, procsUnder } from "../../bin/loop/io/tidy.ts";
import { bootTime, CLK_TCK, parseStat } from "../../bin/loop/io/proc.ts";
import { decide, reality } from "../../bin/loop/core/decide.ts";
import { stopRetry } from "../../bin/loop/squad/close-drift.ts";
import { dispatchRuns, presence } from "../../bin/loop/observers/orca.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const T = 1_800_000_000;
const ENV = ["DS_CLOSE_ROLE", "BACKEND", "FAKE_LOG", "DS_CLAUDE_TMP_ROOT", "DS_TIDY_WAIT_MS", "DS_LOOP_CLEANUP_CMD_S"];
const saved = new Map(ENV.map((k) => [k, process.env[k]]));
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  // A sleeper a cleanup command left: stop it only while it still runs inside this test's own dirs.
  for (const r of roots) for (const f of [join(r, "sleeper.pid"), join(r, "agent.pid")]) {
    const pid = existsSync(f) ? Number(readFileSync(f, "utf8").trim()) : 0;
    try { if (pid > 0 && procsUnder(r, { self: -1 }).procs.some((p) => p.pid === pid)) process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
function fixture(squad: Row = { status: "suspended", want: "suspended" }): Store {
  const root = mkdtempSync(join(tmpdir(), "u231-")); roots.push(root);
  const s = open(root); stores.push(s);
  s.upsert("projects", { label: "p" }, { observed_at: 1 });
  s.upsert("squads", { project: "p", topic: "one" }, { run_id: "run_one", repo: "path:/fake", observed_at: 1, updated_at: 1, ...squad });
  s.upsert("episodes", { project: "p", subject: "seed", kind: "wish_seed" }, { state: "done", started_at: T, observed_at: T, source: "loop" });
  return s;
}
function member(s: Store, role: string, wt: string, set: Row = {}): Row {
  s.upsert("members", { project: "p", squad: "one", role, suffix: "" }, { wt, status: "running", want: "running", observed_at: 1, updated_at: 1, ...set });
  return s.get("members", { project: "p", squad: "one", role, suffix: "" })!;
}
const ctx = (s: Store, now = T): TickCtx => ({ store: s, project: "", tick: 1, now, fired: [], poked: new Set() });
const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ?").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));

describe("reality: gone after the start", () => {
  test("gone after the start reads none; no row inside the grace is starting, after it unknown; a row older than the start is unknown", () => {
    const s = fixture({ status: "running" });
    const m = member(s, "lead", "r::/nowhere/a", { placed_at: T - 600 });
    s.upsert("observed_workers", { project: "p", wt: "r::/nowhere/a" }, { gone_at: T - 10, observed_at: T });
    expect(reality(s, m, T)).toBe("none");
    const b = member(s, "thinker", "r::/nowhere/b", { placed_at: T - 60 });
    expect(reality(s, b, T)).toBe("starting");
    expect(reality(s, member(s, "thinker", "r::/nowhere/b", { placed_at: T - 600 }), T)).toBe("unknown");
    s.upsert("observed_workers", { project: "p", wt: "r::/nowhere/b" }, { account_at: T - 900, observed_at: T });
    expect(reality(s, member(s, "thinker", "r::/nowhere/b", { placed_at: T - 600 }), T)).toBe("unknown");
    s.upsert("observed_workers", { project: "p", wt: "r::/nowhere/b" }, { gone_at: T - 900 });   // gone BEFORE the start
    expect(reality(s, member(s, "thinker", "r::/nowhere/b", { placed_at: T - 600 }), T)).toBe("unknown");
  });
});

describe("drift: a recorded worktree that is gone stops blocking", () => {
  test("a suspended squad's member with no folder and no worker: wt cleared once, with an event", () => {
    const s = fixture();
    const m = member(s, "lead", "r::/nowhere/lead", { placed_at: T - 7200 });
    s.upsert("observed_workers", { project: "p", wt: "r::/nowhere/lead" }, { gone_at: T - 3600, observed_at: T });
    s.upsert("squads", { project: "p", topic: "one" }, { lead_wt: "r::/nowhere/lead" });
    decide(ctx(s));
    const row = s.get("members", { id: m.id })!;
    expect([row.wt, row.status]).toEqual([null, "suspended"]);
    expect(events(s, "member_drift_cleared")).toEqual([{ id: m.id, path: "/nowhere/lead", status: "suspended" }]);
    decide(ctx(s, T + 60));
    expect(events(s, "member_drift_cleared").length).toBe(1);
  });
  test("an archived squad's member gets status gone", () => {
    const s = fixture({ status: "running", want: "gone" });
    const m = member(s, "thinker", "r::/nowhere/t");
    decide(ctx(s));
    expect(s.get("members", { id: m.id })).toMatchObject({ wt: null, status: "gone" });
  });
  test("the folder present: no clear, the remove phase runs as before", () => {
    const s = fixture();
    const dir = mkdtempSync(join(tmpdir(), "u231-wt-")); roots.push(dir);
    const m = member(s, "lead", `r::${dir}`, { placed_at: T - 7200 });
    s.upsert("observed_workers", { project: "p", wt: `r::${dir}` }, { presence: "none", walk: "none", account_at: T - 1, observed_at: T });
    const acts = decide(ctx(s));
    expect(s.get("members", { id: m.id })!.wt).toBe(`r::${dir}`);
    expect(acts.map((a) => [a.kind, (a.payload as Row).phase])).toEqual([["member.close", "remove"]]);
    expect(events(s, "member_drift_cleared")).toEqual([]);
  });
  test("a member with a live worker or terminal is never cleared", () => {
    const s = fixture();
    const m = member(s, "lead", "r::/nowhere/lead");
    s.upsert("observed_workers", { project: "p", wt: "r::/nowhere/lead" }, { presence: "running", walk: "running", account_at: T, observed_at: T });
    decide(ctx(s));
    expect(s.get("members", { id: m.id })!.wt).toBe("r::/nowhere/lead");
    const m2 = member(s, "thinker", "r::/nowhere/th");
    s.upsert("observed_workers", { project: "p", wt: "r::/nowhere/th" }, { gone_at: T - 5, observed_at: T });
    s.upsert("observed_terminals", { project: "p", handle: "term_1" }, { wt: "r::/nowhere/th", observed_at: T, gone_at: null });
    decide(ctx(s));
    expect(s.get("members", { id: m2.id })!.wt).toBe("r::/nowhere/th");
  });
});

describe("presence: a stale dispatch is no evidence", () => {
  test("not current + walk none -> none; current unsettled -> running; walk running always", () => {
    expect(presence("none", "dispatched", false)).toBe("none");
    expect(presence("none", "dispatched", true)).toBe("running");
    expect(presence("none", "dispatched")).toBe("running");
    expect(presence("running", "completed", false)).toBe("running");
    expect(presence("unknown", "dispatched", false)).toBe("unknown");
  });
  test("a squad wished gone with a member wt keeps getting dispatch reads; one without does not", () => {
    const s = fixture({ status: "running", want: "gone" });
    s.upsert("observed_workers", { project: "p", wt: "r::/x/lead" }, { observed_at: T });
    member(s, "lead", "r::/x/lead", { want: "gone", started: new Date((T - 7200) * 1000).toISOString() });
    expect(dispatchRuns(s, "p", T)).toEqual([{ run: "run_one", wts: ["r::/x/lead"] }]);
    s.db.run("UPDATE members SET wt = NULL, status = 'gone'");
    expect(dispatchRuns(s, "p", T)).toEqual([]);
  });
});

describe("a stop is checked, not assumed", () => {
  test("stop done + still running: wait, then a new episode, then a card after 3", () => {
    const s = fixture({ status: "gone" });
    const m = member(s, "lead", "r::/x/lead", { want_at: T - 1000 });
    const base = "close:stop:archived:" + (T - 1000);
    const closed = (at: number) => s.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, 'p', 'one', 'r::/x/lead', 'member_closed', ?)", [at, JSON.stringify({ id: m.id, phase: "stop" })]);
    expect(stopRetry(s, m, base, T)).toMatchObject({ episode: base, tries: 0 });
    closed(T);
    expect(stopRetry(s, m, base, T + 60)).toMatchObject({ wait: true });
    expect(stopRetry(s, m, base, T + 400)).toMatchObject({ episode: base + ":retry1" });
    closed(T + 400); closed(T + 800);
    expect(stopRetry(s, m, base, T + 1300)).toMatchObject({ card: true, tries: 3 });
  });
  test("decide: the stop under a new episode, and the card, for a member that still runs", () => {
    const s = fixture({ status: "gone" });
    const m = member(s, "lead", "r::/x/lead", { want_at: T - 1000 });
    s.upsert("observed_workers", { project: "p", wt: "r::/x/lead" }, { presence: "running", walk: "running", state: "idle", account_at: T, observed_at: T });
    const closed = (at: number) => s.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, 'p', 'one', 'r::/x/lead', 'member_closed', ?)", [at, JSON.stringify({ id: m.id, phase: "stop" })]);
    closed(T - 600);
    expect(decide(ctx(s)).map((a) => [a.kind, a.episode])).toEqual([["member.close", `close:stop:archived:${T - 1000}:retry1`]]);
    closed(T - 500); closed(T - 400);
    expect(decide(ctx(s)).map((a) => [a.kind, (a.payload as Row).title])).toEqual([["alert", "Agent did not stop"]]);
  });
});

// U1 (host-disk-cleanup): the close-time tidy. A member.close remove runs the project's cleanup_on_close,
// stops what is still running in the tree, probes again, removes it and then its Claude temp dir.
const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const REPO = join(import.meta.dir, "..", "..");
function gitIn(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args]);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}
function tidyRig(cmd: ((at: { t: string; log: string }) => string) | null) {
  const t = mkdtempSync(join(tmpdir(), "u1-close-")); roots.push(t);
  const S = join(t, "state"), wt = join(t, "wt"), bare = join(t, "remote.git"), tmpRoot = join(t, "claude-tmp");
  for (const f of ["bin", "conventions", "roles", "AGENTS.md"]) symlinkSync(join(REPO, f), join(t, f));
  mkdirSync(join(S, "fx", "squads"), { recursive: true }); mkdirSync(bare); mkdirSync(wt);
  gitIn(bare, "init", "-q", "--bare"); gitIn(wt, "init", "-q", "-b", "work");
  writeFileSync(join(wt, ".gitignore"), "CLAUDE.local.md\n"); gitIn(wt, "add", "."); gitIn(wt, "commit", "-qm", "one");
  gitIn(wt, "remote", "add", "origin", bare); gitIn(wt, "push", "-q", "origin", "work");
  writeFileSync(join(S, "fx", "dispatcher.json"), '{"home_repo":"fx"}');
  writeFileSync(join(S, "fx", "squads", "t1.json"), JSON.stringify({ topic: "t1", repo: "fx", type: "feature", status: "running", run_id: "run1", lead_wt: "wtl",
    worktrees: ["wtl", "wtb"], members: [{ role: "lead", wt: "wtl" }, { role: "builder", suffix: "u1", wt: "wtb" }], units: [{ slug: "u1", status: "done", tier: "hard", builder_wt: "wtb", pr: "7" }] }));
  const s = open(S); stores.push(s); importJson(s); writeFileSync(join(S, ".loop-migrated"), "");
  const fake = join(t, "fakeb");
  writeFileSync(fake, "#!/usr/bin/env bash\ncase \"$1\" in current) echo wt-elsewhere ;; ps) echo '{\"result\":{\"worktrees\":[]}}' ;; *) echo '{}' ;; esac\n"); chmodSync(fake, 0o755);
  Object.assign(process.env, { DS_CLOSE_ROLE: join(t, "bin", "close-role.sh"), BACKEND: fake, FAKE_LOG: join(t, "backend.log"),
    DS_CLAUDE_TMP_ROOT: tmpRoot, DS_TIDY_WAIT_MS: "300", DS_LOOP_CLEANUP_CMD_S: "20" });
  const temp = claudeTmpDir(wt, tmpRoot); mkdirSync(join(temp, "tasks"), { recursive: true }); writeFileSync(join(temp, "tasks", "out"), "x".repeat(4096));
  // The recorded steps: each backend op, with what the tree looked like when it was called.
  const log = join(t, "cleanup.log"), steps: string[] = [];
  if (cmd) s.upsert("config", { project: "fx", file: "limits.conf", key: "cleanup_on_close" }, { value: cmd({ t, log }), observed_at: T });
  const orca = new FakeBackend();
  orca.onCall = (c) => {
    if (c.op !== "terminal-close-worktree" && c.op !== "worktree-rm") return;
    const left = procsUnder(wt).procs.length;
    steps.push(`${c.op}${existsSync(log) ? " cleaned" : ""}${left ? ` procs:${left}` : ""}${existsSync(temp) ? " temp" : ""}`);
  };
  const queue: Action[] = [], emit: Reconciler = { name: "emit", run: () => queue.splice(0) };
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [...fulfillers, emit] }, act, { projects: () => ["fx"] }); loop.boot(T);
  let at = T;
  const send = async (a: Action) => { queue.push(a); at += 1; await loop.tick(at); await act.drain(); };
  const b = s.db.query("SELECT * FROM members WHERE project = 'fx' AND wt = 'wtb' ORDER BY id DESC").get() as Row;
  s.upsert("members", { id: b.id }, { want: "gone", status: "running" });
  s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { presence: "none", state: "idle", observed_at: T });
  s.upsert("observed_worktrees", { project: "fx", wt: "wtb" }, { path: wt, branch: "work", observed_at: T });
  const close = () => send({ project: "fx", squad: "t1", member: "wtb", subject: `member:${b.id}`, kind: "member.close", episode: "close:remove:gone:1", payload: { id: Number(b.id), phase: "remove", why: "archived" } });
  const remove = () => send({ project: "fx", squad: "t1", subject: "wtx", kind: "worktree.remove", episode: "leftover:wtx@1", payload: { label: "fx", topic: "t1", wt: "wtx", path: wt, branch: "work", unit: "u9" } });
  const kinds = () => (s.db.query("SELECT kind FROM events WHERE kind IN ('cleanup_on_close_ran','leftover_procs_stopped','claude_tmp_removed','claude_tmp_kept') ORDER BY id").all() as { kind: string }[]).map((e) => e.kind);
  const leftovers = () => (JSON.parse(String(s.get("squads", { project: "fx", topic: "t1" })!.doc)).leftovers ?? []) as Row[];
  return { s, t, wt, temp, log, steps, orca, send, close, remove, kinds, leftovers };
}

describe("close tidies the worktree (host-disk-cleanup U1)", () => {
  test("cleanup_on_close runs in the tree, its backgrounded sleeper is stopped before worktree-rm, then the temp dir goes", async () => {
    const r = tidyRig(({ t, log }) => `printf '%s %s %s\\n' "$DS_PROJECT" "$DS_WORKTREE" "$PWD" > ${log}; sleep 600 & echo $! > ${join(t, "sleeper.pid")}`);
    await r.close();
    expect(r.steps).toEqual(["terminal-close-worktree temp", "worktree-rm cleaned temp"]);
    expect(readFileSync(r.log, "utf8").trim()).toBe(`fx ${r.wt} ${r.wt}`);
    expect(r.kinds()).toEqual(["cleanup_on_close_ran", "leftover_procs_stopped", "claude_tmp_removed"]);
    expect(events(r.s, "cleanup_on_close_ran")[0]).toMatchObject({ path: r.wt, code: 0, timed_out: false });
    expect(events(r.s, "leftover_procs_stopped")[0]).toMatchObject({ path: r.wt, count: 1, pids: [Number(readFileSync(join(r.t, "sleeper.pid"), "utf8"))] });
    expect(events(r.s, "claude_tmp_removed")[0]).toMatchObject({ path: r.temp });
    expect(existsSync(r.temp)).toBe(false);
  });

  test("unset: nothing is spawned; the temp dir still goes", async () => {
    const r = tidyRig(null);
    await r.close();
    expect(r.steps).toEqual(["terminal-close-worktree temp", "worktree-rm temp"]);
    expect(r.kinds()).toEqual(["claude_tmp_removed"]);
    expect(existsSync(join(r.s.root, "fx", "loop", "cleanup"))).toBe(false);
  });

  test.each([["exit 1", "exit 1", { code: 1, timed_out: false }], ["a timeout", "sleep 30", { code: null, timed_out: true }]])(
    "a command that fails with %s writes one event and removal continues", async (_n, cmd, want) => {
      const r = tidyRig(() => cmd);
      if (want.timed_out) process.env.DS_LOOP_CLEANUP_CMD_S = "1";
      await r.close();
      expect(events(r.s, "cleanup_on_close_ran")).toHaveLength(1);
      expect(events(r.s, "cleanup_on_close_ran")[0]).toMatchObject(want);
      expect(r.orca.of("worktree-rm")).toHaveLength(1);
      expect(existsSync(r.temp)).toBe(false);
    });

  test("a command that leaves an untracked file: the second probe reads dirty, a leftover, no rm, the temp dir kept", async () => {
    const r = tidyRig(() => "echo junk > new-file.txt");
    await r.close();
    expect(r.orca.of("worktree-rm")).toEqual([]);
    expect(r.leftovers()).toHaveLength(1);
    expect(String(r.leftovers()[0].reason)).toMatch(/^kept: [0-9]+ uncommitted, [0-9]+ unpushed \(after cleanup_on_close\)$/);
    expect(existsSync(r.temp)).toBe(true);
    expect(r.kinds()).toEqual(["cleanup_on_close_ran"]);
  });

  test("dirty at the first probe: no command, no stop, no temp removal", async () => {
    const r = tidyRig(({ log }) => `echo ran > ${log}`);
    writeFileSync(join(r.wt, "work.txt"), "work");
    await r.close();
    expect(r.steps).toEqual([]);
    expect(r.kinds()).toEqual([]);
    expect(existsSync(r.log)).toBe(false);
    expect(existsSync(r.temp)).toBe(true);
    expect(r.leftovers()[0]).toMatchObject({ reason: expect.stringMatching(/^kept: [0-9]+ uncommitted, [0-9]+ unpushed$/) });
  });

  test("a process under a live agent is spared and named; the worktree goes, its temp dir stays", async () => {
    const r = tidyRig(null), agentPid = join(r.t, "agent.pid"), sleeperPid = join(r.t, "sleeper.pid");
    // An agent outside the loop's process tree (its launcher exits) running a child inside the worktree.
    Bun.spawnSync(["bash", "-c", `cd "$1" && bash -c '(cd "$1" && exec sleep 600) & echo $! > "$2"; echo $$ > "$3"; wait' x "$2" "$3" "$4" &`, "x", r.t, r.wt, sleeperPid, agentPid], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 50 && !(existsSync(agentPid) && existsSync(sleeperPid)); i++) await Bun.sleep(20);
    const agent = Number(readFileSync(agentPid, "utf8")), sleeper = Number(readFileSync(sleeperPid, "utf8"));
    const started = bootTime()! + Math.floor(parseStat(readFileSync(`/proc/${agent}/stat`, "utf8"))!.start / CLK_TCK);
    r.s.upsert("observed_workers", { project: "fx", wt: "wtl" }, { presence: "running", state: "working", pid: agent, started_at: started, observed_at: T });
    await r.close();
    expect(events(r.s, "leftover_procs_stopped")[0]).toMatchObject({ path: r.wt, count: 0, spared: [sleeper] });
    expect(r.orca.of("worktree-rm")).toHaveLength(1);
    expect(events(r.s, "claude_tmp_kept")[0]).toMatchObject({ path: r.temp, reason: `live agent pid ${sleeper}` });
    expect(existsSync(r.temp)).toBe(true);
    expect(existsSync(`/proc/${sleeper}`)).toBe(true);
  });

  test.each([[1, "refused"], [75, "fenced"]])("worktree-rm answering %i (%s) keeps the temp dir", async (code) => {
    const r = tidyRig(null);
    r.orca.fail("worktree-rm", { code, out: "", err: "no" });
    await r.close();
    expect(r.orca.of("worktree-rm")).toHaveLength(1);
    expect(existsSync(r.temp)).toBe(true);
    expect(r.kinds()).toEqual([]);
  });

  test("worktree.remove: the leftover sweep runs the same tidy, in the same order", async () => {
    const r = tidyRig(({ log }) => `echo ran > ${log}`);
    await r.remove();
    expect(r.steps).toEqual(["terminal-close-worktree temp", "worktree-rm cleaned temp"]);
    expect(r.kinds()).toEqual(["cleanup_on_close_ran", "claude_tmp_removed"]);
    expect(existsSync(r.temp)).toBe(false);
  });

  test("exposed-cleanup U2: a close waits for the member's stop command, which runs once in the tree, then removes it", async () => {
    const r = tidyRig(null), out = join(r.t, "stopped.txt");
    r.s.upsert("exposed", { project: "fx", squad: "t1", owner_wt: "wtb", name: "stack", gone_at: null },
      { role: "builder", url: "http://localhost:1", scope: "member", stop_cmd: `echo "$PWD" >> ${out}`, updated_at: T });
    await r.close();
    expect(r.steps).toEqual([]);
    const row = r.s.db.query("SELECT * FROM exposed WHERE name = 'stack'").get() as Row;
    expect(row).toMatchObject({ gone_why: "owner-gone", stop_state: "queued" });
    const stop = { project: "fx", squad: "t1", subject: `expose-stop:${row.id}`, kind: "expose.stop", episode: `expose-stop:${row.id}`, payload: { ids: [Number(row.id)], cmd: String(row.stop_cmd), cwd: r.wt } };
    await r.send(stop);
    await r.send(stop);
    expect(readFileSync(out, "utf8")).toBe(`${r.wt}\n`);
    expect((r.s.db.query("SELECT stop_state FROM exposed WHERE name = 'stack'").get() as Row).stop_state).toBe("done");
    await r.close();
    expect(r.steps).toEqual(["terminal-close-worktree temp", "worktree-rm temp"]);
  });

  test("exposed-cleanup U2: a paused squad's stop command still runs through the actuator, so its close is not held", async () => {
    const r = tidyRig(null), out = join(r.t, "stopped.txt");
    r.s.upsert("exposed", { project: "fx", squad: "t1", owner_wt: "wtb", name: "stack", gone_at: null },
      { role: "builder", url: "http://localhost:1", scope: "member", stop_cmd: `echo ran > ${out}`, updated_at: T });
    r.s.pause({ scope: "squad", project: "fx", squad: "t1" });
    await r.close();
    const row = r.s.db.query("SELECT * FROM exposed WHERE name = 'stack'").get() as Row;
    expect(row.stop_state).toBe("queued");
    await r.send({ project: "fx", squad: "t1", subject: `expose-stop:${row.id}`, kind: "expose.stop", episode: `expose-stop:${row.id}`, payload: { ids: [Number(row.id)], cmd: String(row.stop_cmd), cwd: r.wt } });
    expect(readFileSync(out, "utf8")).toBe("ran\n");
    expect((r.s.db.query("SELECT stop_state FROM exposed WHERE name = 'stack'").get() as Row).stop_state).toBe("done");
  });

  test("worktree.remove on a paused squad waits before any tidy step", async () => {
    const r = tidyRig(({ log }) => `echo ran > ${log}`);
    r.s.pause({ scope: "squad", project: "fx", squad: "t1" });
    await r.remove();
    expect(r.steps).toEqual([]);
    expect(existsSync(r.log)).toBe(false);
    expect(existsSync(r.temp)).toBe(true);
  });
});
