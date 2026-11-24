// fulfil-actions.test.ts — U20: every action kind a reconciler emits has a fulfiller, and each one
// does the work. Each kind goes through the real actuator on a hermetic root with fake Orca, and the
// test asserts the effect on disk or in Orca, not the emission. Worktrees are real git repos in temp
// dirs; bin/ is linked into the temp root because the lifecycle scripts find state/ beside bin/.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const REPO = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const ENV = ["DS_CLOSE_ROLE", "BACKEND", "FAKE_LOG"];

const temps: string[] = [], stores: Store[] = [];
const saved = new Map(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "zzactions-")); temps.push(d); return d; }

type Leftover = { wt: string; path: string; branch?: string; unit?: string };

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);

// A migrated root holding squad t1: a Lead, and Builder u1 whose unit is done.
function rig(leftovers: Leftover[] = []) {
  const t = tmp(), S = join(t, "state");
  for (const f of ["bin", "conventions", "roles", "AGENTS.md"]) symlinkSync(join(REPO, f), join(t, f));
  mkdirSync(join(S, "fx", "squads"), { recursive: true });
  writeFileSync(join(S, "fx", "dispatcher.json"), '{"home_repo":"fx"}');
  writeFileSync(join(S, "fx", "squads", "t1.json"), JSON.stringify({
    topic: "t1", repo: "fx", type: "feature", status: "running", run_id: "run1", lead_wt: "wtl", worktrees: ["wtl", "wtb"],
    members: [{ role: "lead", wt: "wtl" }, { role: "builder", suffix: "u1", wt: "wtb" }],
    units: [{ slug: "u1", status: "done", tier: "hard", builder_wt: "wtb", pr: "7" }], leftovers,
  }));
  const s = open(S);
  stores.push(s);
  importJson(s);
  writeFileSync(join(S, ".loop-migrated"), "");
  const fake = join(t, "fakeb");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_LOG"\ncase "$1" in current) echo wt-elsewhere ;; ps) echo '{"result":{"worktrees":[]}}' ;; *) echo '{}' ;; esac\n`);
  chmodSync(fake, 0o755);
  Object.assign(process.env, { DS_CLOSE_ROLE: join(t, "bin", "close-role.sh"), BACKEND: fake, FAKE_LOG: join(t, "backend.log") });

  const orca = new FakeOrca(), queue: Action[] = [];
  const emit: Reconciler = { name: "emit", run: () => queue.splice(0) };
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [...fulfillers, emit] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const tick = async () => { at += 1; await loop.tick(at); await act.drain(); };
  const send = async (a: Action) => { queue.push(a); await tick(); };
  const backend = () => (existsSync(join(t, "backend.log")) ? readFileSync(join(t, "backend.log"), "utf8") : "");
  return { s, orca, act, send, tick, backend };
}

const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
const claim = (s: Store, subject: string, kind: string) => s.get("episodes", { project: "fx", subject, kind: `action:${kind}` });
const alertsFile = (s: Store) => join(s.root, "fx", "alerts.json");
const alerts = (s: Store) => (existsSync(alertsFile(s)) ? (JSON.parse(readFileSync(alertsFile(s), "utf8")).alerts as Row[]) : []);
const doneResult = (s: Store, kind: string) => events(s, "action_done").filter((e) => e.kind === kind).map((e) => e.result);
const builder = (s: Store) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = 't1' AND wt = 'wtb' ORDER BY id DESC").get() as Row;

const closeAct = (id: number, phase: string, episode = `close:${phase}:gone:1`): Action => ({ project: "fx", squad: "t1", member: "wtb", subject: `member:${id}`, kind: "member.close", episode,
  payload: { id, phase, why: "archived" } });

describe("member stop (U153)", () => {
  test("a stop action closes the agent (worker-stop, release, close terminals) and keeps the member", async () => {
    const r = rig();
    const b = builder(r.s);
    r.s.upsert("members", { id: b.id }, { want: "running", status: "running" });
    r.s.db.run("UPDATE units SET status = 'dispatched' WHERE project = 'fx' AND squad = 't1' AND slug = 'u1'");
    r.s.upsert("coordinators", { project: "fx", squad: "t1" }, { handle: "term_loop", run_id: "run1", created_at: T, bound_at: T });
    r.s.upsert("picks", { member: b.id }, { project: "fx", squad: "t1", role: "builder", agent: "claude", model: "opus", slot: 1, picked_at: T });
    r.orca.agent("wtb", "term_b");
    r.s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { presence: "running", state: "idle", observed_at: T });
    await r.send({ project: "fx", squad: "t1", member: "wtb", subject: `member:${b.id}`, kind: "member", episode: "stop:restart:1", payload: { id: Number(b.id), stop: true, why: "restart" } });
    expect(r.orca.of("worker-stop").length).toBe(1);
    expect(r.orca.of("worker-release").length).toBe(1);
    expect(r.orca.of("terminal-close-worktree").length).toBe(1);
    expect(r.orca.agents.filter((a) => a.wt === "wtb")).toEqual([]);
    expect(builder(r.s).want).toBe("running");   // the start row restarts it fresh next tick
  });
});

describe("a stop stops its own member (U200)", () => {
  function two() {
    const r = rig(), b = builder(r.s);
    r.s.db.run("UPDATE units SET status = 'dispatched' WHERE project = 'fx' AND squad = 't1' AND slug = 'u1'");
    r.s.upsert("coordinators", { project: "fx", squad: "t1" }, { handle: "term_loop", run_id: "run1", created_at: T, bound_at: T });
    r.s.upsert("members", { id: b.id }, { want: "running", status: "running" });
    r.s.upsert("members", { project: "fx", squad: "t1", wt: "wtc" }, { role: "builder", suffix: "u2", agent: "claude", model: "opus", want: "running", status: "running", observed_at: T, updated_at: T });
    const c = r.s.db.query("SELECT * FROM members WHERE project = 'fx' AND wt = 'wtc'").get() as Row;
    for (const [m, wt, h] of [[b, "wtb", "term_b"], [c, "wtc", "term_c"]] as [Row, string, string][]) {
      r.s.upsert("picks", { member: m.id }, { project: "fx", squad: "t1", role: "builder", agent: "claude", model: "opus", slot: 1, picked_at: T });
      r.orca.agent(wt, h);
      r.s.upsert("observed_workers", { project: "fx", wt }, { presence: "running", state: "idle", observed_at: T });
    }
    const stop = (m: Row): Action => ({ project: "fx", squad: "t1", member: String(m.wt), subject: `member:${m.id}`, kind: "member", episode: "stop:restart:1", payload: { id: Number(m.id), stop: true, why: "restart" } });
    return { r, b, c, stop };
  }

  test("two members stopped under one episode each run their own calls, and a done row of one never answers the other", async () => {
    const { r, b, c, stop } = two();
    await r.send(stop(b));
    r.s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { presence: "none", state: "idle", observed_at: T });
    await r.tick();
    await r.send(stop(c));
    for (const op of ["worker-stop", "worker-release", "terminal-close-worktree"]) expect(r.orca.of(op).length).toBe(2);
    expect(r.orca.of("worker-stop").map((x) => x.args[1]).sort()).toEqual(["wtb", "wtc"]);
    const rows = r.s.db.query("SELECT member, key FROM orca_calls WHERE key LIKE 'stop:%' AND op = 'worker-stop'").all() as Row[];
    expect(rows.map((x) => x.member).sort()).toEqual(["wtb", "wtc"]);
    expect(new Set(rows.map((x) => x.key)).size).toBe(2);
  });

  test("a stop whose calls went out but whose worker still reads running waits; once it reads gone it is done", async () => {
    const { r, b, stop } = two();
    await r.send(stop(b));
    expect(r.orca.of("worker-stop").length).toBe(1);
    expect(r.s.get("members", { id: b.id })?.want_result ?? null).toBeNull();
    expect(events(r.s, "member_stopped")).toEqual([]);
    r.s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { presence: "none", state: "idle", observed_at: T });
    for (let i = 0; i < 5 && events(r.s, "member_stopped").length === 0; i++) await r.tick();
    expect(events(r.s, "member_stopped").length).toBe(1);
    expect(r.orca.of("worker-stop").length).toBe(1);   // the retry did not stop it again
  });
});

describe("member.close (U155)", () => {
  test("stop closes the agent and keeps the worktree, branch and PR; a stopped member is not removed", async () => {
    const r = rig(), b = builder(r.s);
    r.s.upsert("members", { id: b.id }, { want: "stopped", status: "running" });
    r.s.db.run("UPDATE units SET status = 'dispatched' WHERE project = 'fx' AND squad = 't1' AND slug = 'u1'");
    r.s.upsert("coordinators", { project: "fx", squad: "t1" }, { handle: "term_loop", run_id: "run1", created_at: T, bound_at: T });
    r.orca.agent("wtb", "term_b");
    r.s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { presence: "running", state: "idle", observed_at: T });
    await r.send({ ...closeAct(Number(b.id), "stop"), payload: { id: Number(b.id), phase: "stop", why: "stopped" } });
    expect(r.orca.of("worker-stop").length).toBe(1);
    expect(r.orca.of("worktree-rm")).toEqual([]);
    expect(r.orca.of("pr-close")).toEqual([]);
    expect(r.backend()).toBe("");
    expect(builder(r.s)).toMatchObject({ want: "stopped", want_result: "done: stopped" });
    expect(builder(r.s).status).not.toBe("gone");
  });

  test("remove of a clean pushed worktree prunes the roster and never touches the PR", async () => {
    const wt = repo(), r = rig(), b = builder(r.s);
    r.s.upsert("members", { id: b.id }, { want: "gone", status: "running" });
    r.s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { presence: "none", state: "idle", observed_at: T });
    r.s.upsert("observed_worktrees", { project: "fx", wt: "wtb" }, { path: wt, branch: "work", observed_at: T });
    await r.send(closeAct(Number(b.id), "remove"));
    expect(r.orca.of("worktree-rm").map((c) => c.args)).toEqual([["id:wtb"]]);
    expect(r.orca.of("worker-release").map((c) => c.args)).toEqual([["run1", "wtb"]]);   // its dispatch is released
    expect(r.orca.of("pr-close")).toEqual([]);
    expect(builder(r.s)).toMatchObject({ status: "gone", want: "gone" });
    expect(String(builder(r.s).want_result)).toStartWith("done:");
  });

  test("a dirty worktree is recorded as a leftover and not removed", async () => {
    const wt = repo(), r = rig(), b = builder(r.s);
    writeFileSync(join(wt, "dirty.txt"), "work");
    r.s.upsert("members", { id: b.id }, { want: "gone", status: "running" });
    r.s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { presence: "none", state: "idle", observed_at: T });
    r.s.upsert("observed_worktrees", { project: "fx", wt: "wtb" }, { path: wt, branch: "work", observed_at: T });
    await r.send(closeAct(Number(b.id), "remove"));
    expect(r.orca.of("worktree-rm")).toEqual([]);
    expect(existsSync(join(wt, "dirty.txt"))).toBe(true);
    expect(builder(r.s).status).toBe("gone");
    const doc = JSON.parse(String(r.s.get("squads", { project: "fx", topic: "t1" })!.doc));
    expect(doc.leftovers).toHaveLength(1);
    expect(doc.leftovers[0]).toMatchObject({ wt: "wtb", path: wt, reason: expect.stringMatching(/^kept: [0-9]+ uncommitted, [0-9]+ unpushed$/) });
  });

  test("U203: a done unit's Builder working only through a background task is closed, not dropped as stale", async () => {
    const r = rig(), b = builder(r.s);
    r.s.db.run("UPDATE units SET status = 'done' WHERE project = 'fx' AND squad = 't1' AND slug = 'u1'");
    r.s.upsert("members", { id: b.id }, { want: "running", status: "running" });
    r.s.upsert("coordinators", { project: "fx", squad: "t1" }, { handle: "term_loop", run_id: "run1", created_at: T, bound_at: T });
    r.orca.agent("wtb", "term_b");
    r.s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { presence: "running", state: "working", observed_at: T });
    const path = join(r.s.root, "t.jsonl");
    const line = (c: Row[]) => JSON.stringify({ message: { content: c } });
    writeFileSync(path, [line([{ type: "tool_use", id: "a", name: "Bash", input: { run_in_background: true } }]), line([{ type: "tool_result", tool_use_id: "a", content: "running in background with ID: bg1" }]), line([{ type: "text", text: "done" }])].join("\n") + "\n");
    r.s.upsert("observed_transcripts", { path }, { project: "fx", wt: "wtb", mtime: T, size: 1, observed_at: T });
    await r.send({ ...closeAct(Number(b.id), "stop"), payload: { id: Number(b.id), phase: "stop", why: "archived" } });
    expect(r.orca.of("worker-stop").length).toBe(1);
  });

  test("is dropped as stale when the member is gone", async () => {
    const r = rig(), b = builder(r.s);
    r.s.upsert("coordinators", { project: "fx", squad: "t1" }, { handle: "term_loop", run_id: "run1", created_at: T, bound_at: T });
    r.s.db.run("UPDATE members SET status = 'gone' WHERE wt = 'wtb'");
    await r.send(closeAct(Number(b.id), "stop"));
    expect(claim(r.s, `member:${b.id}`, "member.close")!.state).toBe("dropped");
  });
});

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args]);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}
// A real worktree, clean and pushed to a bare remote; `.env` is gitignored.
function repo(): string {
  const d = tmp(), bare = join(d, "remote.git"), wt = join(d, "wt");
  mkdirSync(bare); mkdirSync(wt);
  git(bare, "init", "-q", "--bare");
  git(wt, "init", "-q", "-b", "work");
  writeFileSync(join(wt, ".gitignore"), ".env\nnode_modules/\nCLAUDE.local.md\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "one");
  git(wt, "remote", "add", "origin", bare);
  git(wt, "push", "-q", "origin", "work");
  return wt;
}
const remove = (path: string, merged = false, episode = "leftover:wtx@1"): Action => ({ project: "fx", squad: "t1", subject: "wtx", kind: "worktree.remove", episode,
  payload: { label: "fx", topic: "t1", wt: "wtx", path, branch: "work", unit: "u9", merged } });
const leftovers = (s: Store) => (JSON.parse(String(s.get("squads", { project: "fx", topic: "t1" })!.doc)).leftovers ?? []) as Row[];
const left = (path: string): Leftover[] => [{ wt: "wtx", path, branch: "work", unit: "u9" }];

describe("worktree.remove", () => {
  const removed = (r: ReturnType<typeof rig>) => {
    expect(r.orca.of("terminal-close-worktree").map((c) => c.args)).toEqual([["id:wtx"]]);
    expect(r.orca.of("worktree-rm").map((c) => c.args)).toEqual([["id:wtx", "force"]]);
    expect(leftovers(r.s)).toEqual([]);
  };
  const kept = (r: ReturnType<typeof rig>, why: string) => {
    expect(r.orca.of("worktree-rm")).toEqual([]);
    expect(leftovers(r.s)).toHaveLength(1);
    expect(doneResult(r.s, "worktree.remove").at(-1)).toBe(why);
  };

  test("removed when clean and pushed", async () => {
    const wt = repo(), r = rig(left(wt));
    await r.send(remove(wt));
    removed(r);
    expect(doneResult(r.s, "worktree.remove")).toEqual(["removed: all on main"]);
  });

  test("removed when its unpushed commit changes nothing", async () => {
    const wt = repo(), r = rig(left(wt));
    git(wt, "commit", "-qm", "two", "--allow-empty");
    await r.send(remove(wt));
    removed(r);
    expect(doneResult(r.s, "worktree.remove")).toEqual(["removed: all on main"]);
  });

  test("removed when its only ignored files are rebuildable or dev-studio's own", async () => {
    const wt = repo(), r = rig(left(wt));
    mkdirSync(join(wt, "node_modules", "x"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "x", "i.js"), "");
    writeFileSync(join(wt, "CLAUDE.local.md"), "");
    await r.send(remove(wt));
    removed(r);
  });

  test("left when dirty", async () => {
    const wt = repo(), r = rig(left(wt));
    writeFileSync(join(wt, "new.txt"), "work");
    await r.send(remove(wt, true));
    kept(r, "left: 0 commits, 1 file not on main");
  });

  test("left when unpushed, even with its PR merged", async () => {
    const wt = repo(), r = rig(left(wt));
    writeFileSync(join(wt, "a.txt"), "work");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-qm", "two");
    await r.send(remove(wt, true));
    kept(r, "left: 1 commit, 1 file not on main");
  });

  test("left when holding .env", async () => {
    const wt = repo(), r = rig(left(wt));
    writeFileSync(join(wt, ".env"), "SECRET=1");
    await r.send(remove(wt));
    kept(r, "left: ignored files");
    expect(existsSync(join(wt, ".env"))).toBe(true);
  });

  test("left when the probe fails, with one note per cause", async () => {
    const notGit = tmp(), r = rig(left(notGit));
    await r.send(remove(notGit));
    kept(r, "left: probe-failed");
    await r.send(remove(notGit, false, "leftover:wtx@2"));
    expect(events(r.s, "leftover_note").map((e) => e.cause)).toEqual(["probe-failed"]);
  });

  test("left when rm is refused, one note per cause, and the next episode tries again", async () => {
    const wt = repo(), r = rig(left(wt));
    r.orca.fail("worktree-rm", { code: 1, out: "", err: "refused" });
    r.orca.fail("worktree-rm", { code: 1, out: "", err: "refused" });
    await r.send(remove(wt));
    expect(leftovers(r.s)).toHaveLength(1);
    expect(doneResult(r.s, "worktree.remove")).toEqual(["left: rm-refused"]);
    await r.send(remove(wt, false, "leftover:wtx@2"));
    expect(events(r.s, "leftover_note").map((e) => e.cause)).toEqual(["rm-refused"]);
    await r.send(remove(wt, false, "leftover:wtx@3"));
    expect(leftovers(r.s)).toEqual([]);
    expect(r.s.get("episodes", { project: "fx", subject: "wtx", kind: "leftover-note" })).toBeNull();
  });

  test("a changed cause notes again", async () => {
    const wt = repo(), r = rig(left(wt));
    r.orca.fail("worktree-rm", { code: 1, out: "", err: "refused" });
    await r.send(remove(wt));
    rmSync(join(wt, ".git"), { recursive: true });
    await r.send(remove(wt, false, "leftover:wtx@2"));
    expect(events(r.s, "leftover_note").map((e) => e.cause)).toEqual(["rm-refused", "probe-failed"]);
  });
});

describe("request.file", () => {
  test("writes the sweep's path and text", async () => {
    const r = rig();
    await r.send({ project: "fx", squad: "t1", member: "lead", subject: "t1.builder-u1", kind: "request.file", episode: "broken|1",
      payload: { target: "t1", path: `requests/t1/t1.builder-u1-${T}.txt`, text: "restart builder-u1 of t1 (dead since 10:00)\n" } });
    const f = join(r.s.root, "fx", "requests", "t1", `t1.builder-u1-${T}.txt`);
    expect(readFileSync(f, "utf8")).toBe("restart builder-u1 of t1 (dead since 10:00)\n");
    expect(claim(r.s, "t1.builder-u1", "request.file")!.state).toBe("done");
  });
});

describe("alert-clear", () => {
  test("resolves only its prefix", async () => {
    const r = rig();
    writeFileSync(alertsFile(r.s), JSON.stringify({ alerts: [{ id: "sweep-studio.limit-1" }, { id: "sweep-studio.limit-2" }, { id: "sweep-other-1" }, { id: "loop-studio.limit-1" }] }));
    await r.send({ project: "fx", squad: null, subject: "studio.limit", kind: "alert-clear", episode: "cleared@1", payload: { target: "project", prefix: "sweep-studio.limit-" } });
    expect(alerts(r.s).map((a) => a.id)).toEqual(["sweep-other-1", "loop-studio.limit-1"]);
  });

  test("an id resolves exactly that alert, not a longer id it prefixes (U56)", async () => {
    const r = rig();
    writeFileSync(alertsFile(r.s), JSON.stringify({ alerts: [{ id: "loop-a-1" }, { id: "loop-a-12" }] }));
    await r.send({ project: "fx", squad: null, subject: "drop:loop-a-1", kind: "alert-clear", episode: "drop@x", payload: { id: "loop-a-1" } });
    expect(alerts(r.s).map((a) => a.id)).toEqual(["loop-a-12"]);
  });

  test("no alerts file is done", async () => {
    const r = rig();
    await r.send({ project: "fx", squad: null, subject: "studio.limit", kind: "alert-clear", episode: "cleared@1", payload: { target: "project", prefix: "sweep-x-" } });
    expect(claim(r.s, "studio.limit", "alert-clear")!.state).toBe("done");
  });
});

describe("obsolete queued early actions", () => {
  for (const kind of ["request-switch", "alert"]) {
    test(`a saved early ${kind} is dropped before replay writes a file or card`, async () => {
      const r = rig(), subject = kind === "alert" ? "studio.early" : "t1.builder-u1";
      const a: Action = { project: "fx", squad: null, subject, kind, episode: "early|wtb|claude/a|-#1",
        payload: { target: "t1", key: subject, text: "Studio at 93%", what: "builder-u1 of t1 (early)", command: "restart-role.sh" } };
      r.s.upsert("episodes", { project: "fx", subject, kind: `action:${kind}` }, { episode_key: a.episode, state: "pending", next_at: T, action: JSON.stringify({ action: a, tries: 1 }), source: "loop", observed_at: T });
      await r.tick();
      expect(claim(r.s, subject, kind)!.state).toBe("dropped");
      expect(existsSync(join(r.s.root, "fx", "requests", "t1"))).toBe(false);
      expect(alerts(r.s)).toEqual([]);
    });
  }
});

describe("withdraw", () => {
  const key = "t1.builder-u1", ep = "limit|wtb|claude/a|-#1";
  const ask = (episode = ep): Action => ({ project: "fx", squad: "t1", member: "wtb", subject: key, kind: "request-switch", episode,
    payload: { target: "t1", key, what: "builder-u1 of t1 (limited)", command: "restart-role.sh", quiet: true } });
  const take = (episode = ep): Action => ({ project: "fx", squad: "t1", member: "wtb", subject: key, kind: "withdraw", episode, payload: { of: "request-switch", key, episode } });
  const requests = (s: Store) => { const d = join(s.root, "fx", "requests", "t1"); return existsSync(d) ? readdirSync(d) : []; };

  test("deletes the file its request-switch wrote", async () => {
    const r = rig();
    await r.send(ask());
    expect(requests(r.s)).toHaveLength(1);
    await r.send(take());
    expect(requests(r.s)).toEqual([]);
    expect(claim(r.s, key, "withdraw")!.state).toBe("done");
  });

  test("is done when the file is already gone", async () => {
    const r = rig();
    await r.send(ask());
    rmSync(join(r.s.root, "fx", "requests", "t1"), { recursive: true });
    await r.send(take());
    expect(claim(r.s, key, "withdraw")!.state).toBe("done");
    expect(events(r.s, "action_failed")).toEqual([]);
  });

  test("is done when no request was made", async () => {
    const r = rig();
    await r.send(take());
    expect(doneResult(r.s, "withdraw")).toEqual(["no file"]);
  });

  test("leaves a later episode's request alone", async () => {
    const r = rig();
    await r.send(ask("limit|wtb|claude/a|-#2"));
    await r.send(take());
    expect(requests(r.s)).toHaveLength(1);
  });

  test("ends a request not written yet, so it never is", async () => {
    const r = rig();
    r.s.upsert("episodes", { project: "fx", subject: key, kind: "action:request-switch" }, { squad: "t1", episode_key: ep, state: "pending", next_at: T + 100, action: JSON.stringify({ action: ask(), tries: 1 }), count: 1, source: "loop", observed_at: T });
    await r.send(take());
    expect(claim(r.s, key, "request-switch")!.state).toBe("dropped");
    await r.tick();
    expect(requests(r.s)).toEqual([]);
  });

  test("deletes a request the sweep wrote, and forgets its marker so the next quiet point asks again", async () => {
    const r = rig(), d = join(r.s.root, "fx", "requests", "t1"), f = join(d, `${key}-${T}.txt`);
    mkdirSync(d, { recursive: true });
    writeFileSync(f, "switch: restart\n");
    r.s.upsert("episodes", { project: "fx", subject: key, kind: "switch" }, { squad: "t1", episode_key: "limit|wtb|claude/a|-", state: `request ${f}`, source: "sweep", observed_at: T });
    await r.send(take());
    expect(existsSync(f)).toBe(false);
    expect(r.s.get("episodes", { project: "fx", subject: key, kind: "switch" })).toBeNull();
  });
});

describe("a kind with no fulfiller", () => {
  const unknown = (episode: string, subject = "s1"): Action => ({ project: "fx", squad: "t1", subject, kind: "no.such.kind", episode, payload: {} });

  test("raises the Studio alert once, as well as the event each time", async () => {
    const r = rig();
    await r.send(unknown("e1"));
    await r.send(unknown("e2"));
    await r.send(unknown("e3", "s2"));
    expect(events(r.s, "action_unhandled")).toHaveLength(3);
    const raised = alerts(r.s);
    expect(raised).toHaveLength(1);
    expect(String(raised[0].question)).toContain("no.such.kind");
  });

  test("settles its claim, so a restart doesn't put it back", async () => {
    const r = rig();
    await r.send(unknown("e1"));
    expect(claim(r.s, "s1", "no.such.kind")).toMatchObject({ state: "failed", action: null });
  });

  test("a host action's alert goes to a project", async () => {
    const r = rig();
    await r.send({ project: "", squad: null, subject: "s1", kind: "no.host.kind", episode: "e1", payload: {} });
    expect(alerts(r.s).map((a) => String(a.question))[0]).toContain("no.host.kind");
  });
});

describe("the scan: every emitted kind has a fulfiller", () => {
  const SOURCES = [join(REPO, "bin", "loop", "pause", "wake.ts"), join(REPO, "bin", "loop", "core", "decide.ts"), ...["reconcilers", "fulfil"].flatMap((d) => {
    const dir = join(REPO, "bin", "loop", d);
    return readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));
  })];
  // An action literal has `kind: "x", episode`; an episodes key (`kind: "poke" }`) never does. The
  // services reconciler names its kinds through act("x", …).
  const emitted = new Set(SOURCES.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bkind: "([^"]+)",\s*episode\b|\bact\("([^"]+)",/g)].map((m) => m[1] ?? m[2])));

  test("the scan sees the kinds of this unit, so it can't rot into scanning nothing", () => {
    for (const k of ["member.close", "worktree.remove", "request.file", "alert-clear", "member", "alert", "poke", "board_start"]) expect(emitted).toContain(k);
  });

  test("no emitted kind lacks a fulfiller", () => {
    const loaded = new Set(fulfillers.flatMap((f) => f.kinds ?? []));
    expect([...emitted].filter((k) => !loaded.has(k))).toEqual([]);
  });
});
