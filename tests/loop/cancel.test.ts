import { beforeAll, afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { docRows, importJson } from "../../bin/loop/db/import-json.ts";
import { load, DIRS, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Store, type Row } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import lifecycle from "../../bin/loop/reconcilers/lifecycle.ts";
import { targets } from "../../bin/loop/observers/github.ts";
import startMember from "../../bin/loop/fulfil/member.ts";
import { startEpisode } from "../../bin/loop/squad/member-state.ts";

// U150: a transient refusal is tried again every 15 minutes (DS_LOOP_RETRY_S); these tests step
// a retry one tick at a time. The spacing itself is tested in actuator.test.ts ("refusals").
beforeAll(() => { process.env.DS_LOOP_RETRY_S = "1"; });
afterAll(() => { delete process.env.DS_LOOP_RETRY_S; });

const roots: string[] = [], stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const git = (p: string, ...args: string[]) => {
  const o = Bun.spawnSync(["git", "-C", p, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args]);
  if (o.exitCode) throw new Error(o.stderr.toString()); return o.stdout.toString().trim();
};
const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
function fixture(state = "working", orphan = false) {
  const root = mkdtempSync(join(tmpdir(), "cancel-unit-")); roots.push(root);
  const repo = join(root, "repo"), path = join(root, "builder"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main"); git(repo, "commit", "-qm", "base", "--allow-empty");
  git(repo, "worktree", "add", "-qb", "cancel-work", path); git(path, "commit", "-qm", "work", "--allow-empty");
  writeFileSync(join(path, "dirty"), "uncommitted work");
  const stateRoot = join(root, "state"); mkdirSync(join(stateRoot, "p", "squads"), { recursive: true });
  const file = join(stateRoot, "p", "squads", "one.json"), wt = `repo::${path}`;
  writeFileSync(join(stateRoot, "p", "dispatcher.json"), '{"home_repo":"repo"}');
  writeFileSync(file, JSON.stringify({ topic: "one", repo: "repo", status: "running", members: orphan ? [] : [{ role: "builder", suffix: "work", wt }], units: [{ slug: "work", status: "dispatched", builder_wt: wt, pr: "7" }] }));
  const s = open(stateRoot); stores.push(s); importJson(s); writeFileSync(join(stateRoot, ".loop-migrated"), "");
  s.upsert("config", { project: "p", file: "github", key: "repo:repo" }, { value: "owner/repo", observed_at: 1 });
  s.upsert("observed_prs", { project: "p", ref: "owner/repo#7" }, { repo: "owner/repo", pr: 7, state: "OPEN", observed_at: 100 });
  const o = new FakeBackend(); o.agent(wt, "term_builder", "claude");
  let tree = true, at = 100, removeFailures = 0;
  const observe: Reconciler = { name: "fixture", run(ctx) {
    s.upsert("observed_worktrees", { project: "p", wt }, { path, branch: "cancel-work", doc: { agents: o.agents.filter(a => a.wt === wt).length }, observed_at: ctx.now, gone_at: tree ? null : ctx.now });
    s.upsert("observed_workers", { project: "p", wt }, { state, observed_at: ctx.now, gone_at: o.agents.some(a => a.wt === wt) ? null : ctx.now });
    s.upsert("observed_terminals", { project: "p", handle: "term_builder" }, { wt, observed_at: ctx.now, gone_at: o.agents.some(a => a.wt === wt) ? null : ctx.now });
  }};
  o.answer = (c) => {
    if (c.op === "worktree-rm") { if (removeFailures-- > 0) return { code: 1, out: "", err: "temporary removal failure" }; git(repo, "worktree", "remove", "--force", path); tree = false; return { code: 0, out: "", err: "" }; }
  };
  const act = new LoopActuator({ orca: o, fulfillers: fulfillers.filter(f => f.kinds) });
  const loop = new Loop(s, { observers: [observe], reconcilers: [lifecycle, ...fulfillers] }, act, { projects: () => ["p"] }); loop.boot(at);
  const tick = async () => { await loop.tick(++at); await act.drain(); };
  const command = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../bin/loop/squad/squad-state.ts"), file, ...args], { env: { ...process.env, DS_STATE_ROOT: stateRoot } });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    expect(p.exitCode).toBe(0);
  };
  const cancel = (...args: string[]) => command("cancel-unit", "work", ...args);
  return { s, o, root, file, path, repo, wt, tick, cancel, command, act, loop, failRemove: () => { removeFailures++; } };
}

test.each(["working", "idle"])("cancel keeps the gone wish and closes a %s Builder, dirty worktree and PR", async state => {
  const r = fixture(state); r.cancel("--why", "dropped");
  const m = r.s.db.query("SELECT * FROM members WHERE wt = ?").get(r.wt) as Row;
  expect(m.want).toBe("gone"); expect(m.doc).not.toBeNull();
  await r.tick(); expect(r.o.agents).toHaveLength(0);
  await r.tick(); expect(existsSync(r.path)).toBe(false);
  expect(git(r.repo, "show-ref", "--verify", "refs/heads/cancel-work")).toContain("refs/heads/cancel-work");
  expect(r.o.of("pr-close").length).toBeGreaterThan(0);
});

test("--check writes nothing", async () => {
  const r = fixture(), before = r.s.db.query("SELECT * FROM units").all(), ms = r.s.db.query("SELECT * FROM members").all();
  r.cancel("--check"); expect(r.s.db.query("SELECT * FROM units").all()).toEqual(before); expect(r.s.db.query("SELECT * FROM members").all()).toEqual(ms);
});

test("cancel during an in-flight start keeps the unit cancelled and stops the launched Builder", async () => {
  const r = fixture();
  const m = r.s.db.query("SELECT * FROM members WHERE wt = ?").get(r.wt) as Row;
  r.s.want("member", String(m.id), "running", { by: "test", payload: { request: true, unit: "work", why: "phase", agent: "claude", model: "sonnet", account: "test" } });
  let finishStart!: (result: { ok: true; wt: string }) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const driver = { start: () => { signalStarted(); return new Promise<{ ok: true; wt: string }>(done => { finishStart = done; }); } };
  const ctx = { store: r.s, project: "p", squad: "one", tick: 100, now: 100, fired: [], poked: new Set<string>(),
    act: { pick: () => ({ agent: "claude", model: "sonnet", effort: null, account: "test" }),
      openCall: () => null, seat: () => ({}), slot: () => () => {}, driver: () => driver } } as any;
  const fresh = r.s.get("members", { id: m.id })!;   // the decider's start (decide.ts)
  const action = { project: "p", squad: "one", member: r.wt, subject: `member:${m.id}`, kind: "member", episode: startEpisode(r.s, fresh), payload: { id: Number(m.id) } };
  const result: any = await startMember.exec!(action, ctx);
  await started;
  r.cancel();
  finishStart({ ok: true, wt: r.wt });
  await result.background;
  expect(r.s.get("units", { project: "p", squad: "one", slug: "work" })?.status).toBe("cancelled");
  expect(r.s.get("members", { id: m.id })).toMatchObject({ want: "gone", want_result: null, wt: r.wt });
  await r.tick();
  expect(r.o.agents).toHaveLength(0);
});

test("an off-roster cancelled Builder is stopped; matching reality emits no more actions; reappearance is stopped again", async () => {
  const r = fixture("working", true); r.cancel(); await r.tick(); expect(r.o.agents).toHaveLength(0); await r.tick();
  r.s.db.run("UPDATE observed_prs SET state = 'CLOSED'"); await r.tick();
  const calls = r.o.calls.length; await r.tick(); expect(r.o.calls.length).toBe(calls);
  r.o.agent(r.wt, "term_builder", "claude"); await r.tick(); expect(r.o.agents).toHaveLength(0);
});

test("the PR named by --into stays open; no PR needs no GitHub call", async () => {
  const r = fixture(); r.cancel("--into", "PR#7"); await r.tick(); expect(r.o.of("pr-close")).toHaveLength(0);
  r.s.db.run("UPDATE units SET pr = NULL"); await r.tick(); expect(r.o.of("pr-close")).toHaveLength(0);
});

test("GitHub close failure retries, closed PR remains watched and reopened PR closes again", async () => {
  const r = fixture(); r.o.fail("pr-close", { code: 1, out: "", err: "GitHub unavailable" }); r.cancel(); await r.tick();
  await r.tick(); await r.tick(); expect(r.o.of("pr-close").length).toBeGreaterThan(1);
  r.s.db.run("UPDATE observed_prs SET state = 'CLOSED'");
  expect(targets(r.s, 110, () => "owner/repo").tracked.get("owner/repo")).toContain(7);
  await r.tick(); const n = r.o.of("pr-close").length;
  r.s.db.run("UPDATE observed_prs SET state = 'OPEN', observed_at = 111"); await r.tick(); expect(r.o.of("pr-close").length).toBeGreaterThan(n);
});

test("cancel outranks pause; a queued poke, restart and unbind cannot reach it", async () => {
  const r = fixture();
  r.s.pause({ scope: "member", project: "p", squad: "one", role: "builder", suffix: "work" }, { by: "test" });
  r.cancel();
  const { wake } = await import("../../bin/loop/pause/wake.ts");
  const ctx = { store: r.s, project: "p", tick: 101, now: 101, fired: [], poked: new Set<string>() };
  expect(wake(ctx, r.wt, "wake", "pr-stale", "old").actions).toEqual([]);
  for (const kind of ["poke", "request-restart", "rebind", "unbind"]) {
    const action = { project: "p", squad: "one", member: r.wt, subject: r.wt, kind, episode: "old", payload: { wt: r.wt, text: "old" } };
    const result = await r.act.act(action, ctx);
    expect(result).toMatchObject({ dropped: "generation changed" });
  }
  await r.tick(); expect(r.o.agents).toHaveLength(0); await r.tick(); expect(existsSync(r.path)).toBe(false);
});

test("worktree removal failure survives loop boot and retries with branch and commits intact", async () => {
  const r = fixture(); const commit = git(r.repo, "rev-parse", "refs/heads/cancel-work"); r.cancel(); await r.tick();
  r.failRemove(); await r.tick();
  expect(existsSync(r.path)).toBe(true); expect(git(r.repo, "rev-parse", "refs/heads/cancel-work")).toBe(commit);
  await r.act.boot(r.s, 103); r.loop.boot(103);
  await r.tick(); await r.tick(); expect(existsSync(r.path)).toBe(false);
  expect(git(r.repo, "rev-parse", "refs/heads/cancel-work")).toBe(commit);
});

test("a worktree without any Orca observation is retained until reality can be read", async () => {
  const r = fixture(); r.cancel();
  const ctx = { store: r.s, project: "p", tick: 1, now: 1, fired: [], poked: new Set<string>() };
  expect(lifecycle.run(ctx).filter(a => a.kind !== "cancel.pr")).toEqual([]);
  expect((r.s.db.query("SELECT status FROM members WHERE wt = ?").get(r.wt) as Row).status).toBe("running");
  expect(existsSync(r.path)).toBe(true);
});

test("a surviving unit sharing the Builder and PR remains live, including historic cancellation", async () => {
  const r = fixture("idle");
  r.command("add-unit", "fix", r.wt); r.command("set-unit-status", "fix", "dispatched", r.wt); r.command("set-unit-pr", "fix", "7");
  r.cancel("--into", "fix");
  expect((r.s.db.query("SELECT want FROM members WHERE wt = ?").get(r.wt) as Row).want).not.toBe("gone");
  await r.tick(); await r.tick(); await r.tick();
  expect(r.o.agents).toHaveLength(1); expect(existsSync(r.path)).toBe(true); expect(r.o.of("pr-close")).toHaveLength(0);
  const { stopping } = await import("../../bin/loop/squad/cancel.ts"), { wake } = await import("../../bin/loop/pause/wake.ts");
  expect(stopping(r.s, "p", r.wt)).toBe(false);
  expect(wake({ store: r.s, project: "p", tick: 110, now: 110, fired: [], poked: new Set() }, r.wt, "wake", "test", "fix").status).toBe("sent");
});

test("queued cancellation is dropped when another unit takes the Builder and PR", async () => {
  const r = fixture(); r.cancel();
  await r.tick(); r.o.agent(r.wt, "term_builder", "claude");
  const ctx = { store: r.s, project: "p", tick: 110, now: 110, fired: [], poked: new Set<string>() };
  const actions = ["cancel.stop", "cancel.remove", "cancel.pr"].map(kind => ({ project: "p", squad: "one", member: r.wt, subject: `queued:${kind}`, kind, episode: "queued", payload: { unit: "work", wt: r.wt, path: r.path, repo: "owner/repo", pr: 7 } }));
  r.command("add-unit", "fix", r.wt); r.command("set-unit-pr", "fix", "7");
  const calls = r.o.calls.length;
  for (const a of actions) expect(await r.act.act(a, ctx)).toMatchObject({ dropped: "stale" });
  expect(r.o.calls.length).toBe(calls); await r.tick(); expect(r.o.agents).toHaveLength(1); expect(existsSync(r.path)).toBe(true);
});

test("a removed Builder reused by another unit loses the historic gone wish", async () => {
  const r = fixture(); r.cancel(); await r.tick(); await r.tick(); await r.tick();
  expect((r.s.db.query("SELECT want_result FROM members WHERE wt = ?").get(r.wt) as Row).want_result).toStartWith("done:");
  git(r.repo, "worktree", "add", r.path, "cancel-work"); r.o.agent(r.wt, "term_builder", "claude");
  r.command("add-unit", "fix", r.wt); r.command("add-member", "builder", "work", r.wt);
  await r.tick();
  expect((r.s.db.query("SELECT want FROM members WHERE wt = ?").get(r.wt) as Row).want).toBeNull();
  expect(r.o.agents).toHaveLength(1); expect(existsSync(r.path)).toBe(true);
});

test.each(["p", "other-project"])("shared Builder and repository PR are protected across squads in %s", async project => {
  const r = fixture();
  r.s.fact("unit_dispatched", docRows(project, "two", { repo: "different-selector", status: "running", units: [{ slug: "work", status: "dispatched", builder_wt: r.wt, pr: 7 }] }, 1));
  r.s.upsert("config", { project, file: "github", key: "repo:different-selector" }, { value: "owner/repo", observed_at: 1 });
  r.cancel(); await r.tick(); await r.tick();
  expect(r.o.agents).toHaveLength(1); expect(existsSync(r.path)).toBe(true); expect(r.o.of("pr-close")).toHaveLength(0);
});

test("the same PR number in another repository does not protect the cancelled PR", async () => {
  const r = fixture();
  r.s.fact("unit_dispatched", docRows("p", "two", { repo: "other", status: "running", units: [{ slug: "work", status: "dispatched", builder_wt: "another-wt", pr: 7 }] }, 1));
  r.s.upsert("config", { project: "p", file: "github", key: "repo:other" }, { value: "owner/other", observed_at: 1 });
  r.cancel(); await r.tick(); expect(r.o.of("pr-close")).toHaveLength(1);
});

test.each(["owner/repo", "owner/other"])("shared PR ownership uses the surviving unit's URL repository %s", async repo => {
  const r = fixture();
  r.s.fact("unit_dispatched", docRows("p", "two", { repo: "repo", status: "running", units: [{ slug: "work", status: "dispatched", pr: `https://github.com/${repo}/pull/7` }] }, 1));
  r.cancel(); await r.tick(); expect(r.o.of("pr-close")).toHaveLength(repo === "owner/repo" ? 0 : 1);
});

test("a cancelled PR URL overrides the squad repository for cleanup", async () => {
  const r = fixture();
  r.s.db.run("UPDATE units SET pr = 'https://github.com/owner/other/pull/7'");
  r.s.upsert("observed_prs", { project: "p", ref: "owner/other#7" }, { repo: "owner/other", pr: 7, state: "OPEN", observed_at: 100 });
  r.cancel(); await r.tick(); expect(r.o.of("pr-close")[0].args).toEqual(["owner/other", "7"]);
});

test.each(["rebase", "merge"])("cancel removes a conflicted %s and preserves its branch", async op => {
  const r = fixture(); rmSync(join(r.path, "dirty"));
  writeFileSync(join(r.repo, "conflict"), "base"); git(r.repo, "add", "conflict"); git(r.repo, "commit", "-qm", "main edit");
  writeFileSync(join(r.path, "conflict"), "work"); git(r.path, "add", "conflict"); git(r.path, "commit", "-qm", "builder edit");
  const sha = git(r.repo, "rev-parse", "cancel-work");
  expect(Bun.spawnSync(["git", "-C", r.path, "-c", "user.name=test", "-c", "user.email=test@example.com", op, "main"]).exitCode).not.toBe(0);
  r.cancel(); await r.tick(); await r.tick();
  expect(existsSync(r.path)).toBe(false); expect(git(r.repo, "rev-parse", "cancel-work")).toBe(sha);
});

test("persistent cleanup failure raises one board card and matching reality clears it", async () => {
  const r = fixture(), answer = r.o.answer; let failing = true;
  r.o.answer = c => c.op === "worktree-rm" && failing ? { code: 1, out: "", err: "permission denied" } : answer?.(c);
  r.cancel(); for (let i = 0; i < 15; i++) await r.tick();
  const alerts = JSON.parse(readFileSync(join(r.root, "state/p/alerts.json"), "utf8"));
  const cards = alerts.alerts.filter((a: Row) => a.kind === "cancel_failed" && a.step === "cancel.remove");
  expect(cards).toHaveLength(1); expect(cards[0].question).toContain("permission denied");
  const { alertGone, dropAlerts } = await import("../../bin/loop/reconcilers/alerts.ts");
  expect(alertGone(r.s, "p", cards[0], 120)).toBe(false);
  failing = false; for (let i = 0; i < 3; i++) await r.tick();
  expect(alertGone(r.s, "p", cards[0], 120)).toBeTruthy();
  r.s.upsert("observed_alerts", { project: "p", id: cards[0].id }, { doc: cards[0], observed_at: 120 });
  const ctx = { store: r.s, project: "p", tick: 120, now: 120, fired: [], poked: new Set<string>() };
  for (const a of dropAlerts(ctx)) await r.act.act(a, ctx);
  expect(JSON.parse(readFileSync(join(r.root, "state/p/alerts.json"), "utf8")).alerts.some((a: Row) => a.id === cards[0].id)).toBe(false);
});

test("persistent Builder stop failure raises a card and keeps its worktree", async () => {
  const r = fixture(), answer = r.o.answer;
  r.o.answer = c => c.op === "terminal-close-worktree" ? { code: 1, out: "", err: "terminal close failed" } : answer?.(c);
  r.cancel();
  for (let i = 0; i < 15; i++) await r.tick();
  const alerts = JSON.parse(readFileSync(join(r.root, "state/p/alerts.json"), "utf8"));
  const cards = alerts.alerts.filter((a: Row) => a.kind === "cancel_failed" && a.step === "cancel.stop");
  expect(cards).toHaveLength(1);
  expect(cards[0].question).toContain("terminal close failed");
  expect(r.o.agents).toHaveLength(1);
  expect(existsSync(r.path)).toBe(true);
});

test("reviving a cancelled unit clears its unfulfilled cancellation wish", async () => {
  const r = fixture(); r.cancel(); r.command("set-unit-status", "work", "planned");
  const m = r.s.db.query("SELECT * FROM members WHERE wt = ?").get(r.wt) as Row;
  expect(m.want).not.toBe("gone"); expect(m.want_payload).toBeNull();
  r.command("set-unit-status", "work", "dispatched"); await r.tick(); await r.tick();
  expect(r.o.agents).toHaveLength(1); expect(existsSync(r.path)).toBe(true);
});

test("U1: a cancel runs cleanup_on_close, then the forced removal whatever its exit code, then the Claude temp dir goes", async () => {
  const r = fixture(), log = join(r.root, "cleanup.log"), tmpRoot = join(r.root, "claude-tmp");
  const saved = process.env.DS_CLAUDE_TMP_ROOT;
  process.env.DS_CLAUDE_TMP_ROOT = tmpRoot;
  try {
    const { claudeTmpDir } = await import("../../bin/loop/io/tidy.ts");
    const temp = claudeTmpDir(r.path, tmpRoot); mkdirSync(temp, { recursive: true }); writeFileSync(join(temp, "out"), "x");
    r.s.upsert("config", { project: "p", file: "limits.conf", key: "cleanup_on_close" }, { value: `echo "$PWD" > ${log}; exit 1`, observed_at: 1 });
    r.cancel(); await r.tick(); await r.tick();
    expect(readFileSync(log, "utf8").trim()).toBe(r.path);
    expect(existsSync(r.path)).toBe(false);
    expect(existsSync(temp)).toBe(false);
    const kinds = (r.s.db.query("SELECT kind FROM events WHERE kind IN ('cleanup_on_close_ran','claude_tmp_removed') ORDER BY id").all() as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toEqual(["cleanup_on_close_ran", "claude_tmp_removed"]);
  } finally { if (saved === undefined) delete process.env.DS_CLAUDE_TMP_ROOT; else process.env.DS_CLAUDE_TMP_ROOT = saved; }
});
