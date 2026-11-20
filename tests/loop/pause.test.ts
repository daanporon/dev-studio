import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishRequest, LoopActuator, requestActions, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import member from "../../bin/loop/fulfil/member.ts";
import decider from "../../bin/loop/core/decide.ts";
import pending from "../../bin/loop/fulfil/pending.ts";
import poke from "../../bin/loop/fulfil/poke.ts";
import { squadDoc } from "../../bin/loop/db/export-json.ts";
import { DIRS, load, type Action, type TickCtx } from "../../bin/loop/core/plugins.ts";
import { actionVersion, effective, resume } from "../../bin/loop/pause/pause.ts";
import { run as lifecycle } from "../../bin/loop/reconcilers/lifecycle.ts";
import { liveness } from "../../bin/loop/reconcilers/liveness.ts";
import { run as phases } from "../../bin/loop/reconcilers/phases.ts";
import { pickerStale, reapPickers } from "../../bin/loop/reconcilers/alerts.ts";
import { relay } from "../../bin/loop/messages/relay.ts";
import { shell } from "../../bin/loop/io/orca.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { wake } from "../../bin/loop/pause/wake.ts";

const roots: string[] = [], stores: Store[] = [];
const T = 1_800_000_000;
const savedNow = process.env.DS_NOW;
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedNow === undefined) delete process.env.DS_NOW; else process.env.DS_NOW = savedNow;
});
function fixture() {
  process.env.DS_NOW = String(T);
  const root = mkdtempSync(join(tmpdir(), "loop-pause-")); roots.push(root);
  const s = open(root); stores.push(s);
  s.upsert("projects", { label: "p" }, { observed_at: T });
  for (const squad of ["one", "two"]) {
    s.upsert("squads", { project: "p", topic: squad }, { status: "running", run_id: `run_${squad}`, lead_wt: `wt-${squad}-lead`, repo: "path:/fake",
      doc: JSON.stringify({ topic: squad, members: [], units: [], worktrees: [] }), observed_at: T, updated_at: T });
    for (const [role, suffix] of [["lead", ""], ["builder", "task"]]) {
      s.upsert("members", { project: "p", squad, role, suffix }, { wt: `wt-${squad}-${role}`, status: "running", agent: "claude", model: "opus", account: "a", observed_at: T, updated_at: T });
      s.upsert("observed_workers", { project: "p", wt: `wt-${squad}-${role}` }, { state: "idle", since: T - 5000, observed_at: T });
    }
  }
  s.upsert("members", { project: "p", squad: "studio", role: "studio", suffix: "" }, { wt: "wt-studio", status: "running", observed_at: T, updated_at: T });
  const ctx = (at = T): TickCtx => ({ store: s, project: "p", tick: 1, now: at, fired: [], poked: new Set() });
  return { s, root, ctx };
}
const role = { project: "p", squad: "one", role: "builder", suffix: "task" };
const repo = join(import.meta.dir, "../..");
function pauseTrigger(root: string, scope: "member" | "project" = "member") {
  const file = join(root, "pause-trigger.ts");
  writeFileSync(file, `import { open } from ${JSON.stringify(join(repo, "bin/loop/core/store.ts"))};\nconst s = open(process.env.PAUSE_TEST_STATE ?? process.env.DS_STATE_ROOT!); s.pause({scope:${JSON.stringify(scope)},project:"p",squad:"one",role:"builder",suffix:"task"}); s.close();\n`);
  return file;
}

describe("durable pause intent", () => {
  test("a squad or project resume clears manual pauses and keeps a dependency wait (U151)", () => {
    const { s } = fixture();
    s.upsert("units", { project: "p", squad: "two", slug: "prerequisite" }, { status: "dispatched", observed_at: T, updated_at: T });
    s.pause({ scope: "member", ...role }, { source: "dependency", prerequisites: [{ kind: "unit", project: "p", squad: "two", slug: "prerequisite" }] });
    s.pause({ scope: "member", project: "p", squad: "one", role: "lead", suffix: "" });
    s.pause({ scope: "squad", project: "p", squad: "one" });
    const open = () => (s.db.query("SELECT scope, role, source FROM pause_intents WHERE cleared_at IS NULL ORDER BY generation, scope, role").all() as any[]).map((r) => `${r.source}:${r.scope}:${r.role ?? ""}`);
    s.resume({ scope: "squad", project: "p", squad: "one" });
    expect(open()).toEqual(["dependency:member:builder"]);
    s.pause({ scope: "project", project: "p" });
    s.resume({ scope: "project", project: "p" });
    expect(open()).toEqual(["dependency:member:builder"]);
    expect(effective(s, s.get("members", { project: "p", squad: "one", role: "builder", suffix: "task" })!).state).toBe("paused");
    // Resuming the member by name still clears its dependency wait.
    s.resume({ scope: "member", ...role });
    expect(open()).toEqual([]);
  });

  test("effective state: squad archived or suspended, then a pause on the member or above, then its own wish", () => {
    const { s } = fixture();
    const m = () => s.get("members", { project: "p", squad: "one", role: "builder", suffix: "task" })!;
    expect(effective(s, m())).toEqual({ state: null, own: null, why: "own" });
    s.want("member", "p/one/builder/task", "stopped");
    expect(effective(s, m()).state).toBe("stopped");
    s.pause({ scope: "project", project: "p" });
    expect(effective(s, m())).toEqual({ state: "paused", own: "stopped", why: "pause" });
    s.want("squad", "p/one", "suspended");
    expect(effective(s, m())).toEqual({ state: "suspended", own: "stopped", why: "squad" });
    s.want("squad", "p/one", "gone");
    expect(effective(s, m()).state).toBe("archived");
    s.want("member", "p/one/builder/task", "archived");
    expect(effective(s, m())).toEqual({ state: "archived", own: "archived", why: "own" });
    // The Studio has no squad and no inherited pause.
    expect(effective(s, s.get("members", { project: "p", squad: "studio", role: "studio", suffix: "" })!).state).toBe(null);
  });

  test("upgraded rows are active; scope inheritance excludes the Studio", () => {
    const { s, ctx } = fixture();
    expect(wake(ctx(), "wt-one-builder", "go", "test", "1").status).toBe("sent");
    s.pause({ scope: "project", project: "p" });
    expect(wake(ctx(), "wt-one-builder", "go", "test", "2").status).toBe("skipped:paused");
    expect(wake(ctx(), "wt-two-lead", "go", "test", "2").status).toBe("skipped:paused");
    expect(s.db.query("SELECT COUNT(*) AS n FROM pause_members WHERE role = 'studio'").get()).toEqual({ n: 0 });
  });

  test("role and squad pauses survive reopening, preserve lifecycle and export", () => {
    const { s, root, ctx } = fixture();
    const first = s.pause({ scope: "member", ...role });
    expect(s.pause({ scope: "member", ...role })).toMatchObject({ changed: false, generation: first.generation });
    expect(wake(ctx(), "wt-one-lead", "go", "test", "1").status).toBe("sent");
    expect(wake(ctx(), "wt-one-builder", "go", "test", "1").status).toBe("skipped:paused");
    s.pause({ scope: "squad", project: "p", squad: "one" });
    const doc = squadDoc(s, "p", "one")!;
    expect(doc.pause).toHaveProperty("state", "pausing");
    expect((doc.members as any[]).find((m) => m.role === "builder").pause.generation).toBe(first.generation);
    s.close();
    const reopened = open(root); stores.push(reopened);
    expect(wake({ ...ctx(), store: reopened }, "wt-one-lead", "go", "test", "2").status).toBe("skipped:paused");
    expect(reopened.get("squads", { project: "p", topic: "one" })?.status).toBe("running");
    expect(reopened.db.query("SELECT COUNT(*) AS n FROM members").get()).toEqual({ n: 5 });
  });

  test("resume cascades, preserves checkpoints and rejects a paused parent", () => {
    const { s, ctx } = fixture();
    s.pause({ scope: "member", ...role });
    s.db.run("UPDATE pause_members SET checkpoint = 'journal/checkpoint' WHERE role = 'builder'");
    s.pause({ scope: "squad", project: "p", squad: "one" });
    expect(() => s.resume({ scope: "member", ...role })).toThrow("squad");
    s.resume({ scope: "squad", project: "p", squad: "one" });
    expect(wake(ctx(), "wt-one-builder", "go", "test", "1").status).toBe("sent");
    expect(s.db.query("SELECT checkpoint FROM pause_members WHERE role = 'builder'").get()).toEqual({ checkpoint: "journal/checkpoint" });
    s.pause({ scope: "member", ...role });
    s.pause({ scope: "project", project: "p" });
    s.upsert("squads", { project: "p", topic: "two" }, { status: "suspended", want: "suspended" });
    s.resume({ scope: "project", project: "p" });
    expect(wake(ctx(), "wt-one-builder", "go", "test", "2").status).toBe("sent");
    expect(s.get("squads", { project: "p", topic: "two" })).toMatchObject({ status: "suspended", want: "suspended" });
  });

  test("manual and dependency sources coexist and invalid identities are refused", () => {
    const { s } = fixture();
    s.upsert("units", { project: "p", squad: "two", slug: "prerequisite" }, { status: "dispatched", observed_at: T, updated_at: T });
    s.pause({ scope: "member", ...role }, { source: "dependency", prerequisites: [{ kind: "unit", project: "p", squad: "two", slug: "prerequisite" }] });
    s.pause({ scope: "member", ...role });
    expect(s.db.query("SELECT source FROM pause_intents WHERE cleared_at IS NULL ORDER BY source").all()).toEqual([{ source: "dependency" }, { source: "manual" }]);
    expect(() => s.pause({ scope: "member", ...role, suffix: "wrong" })).toThrow("member");
    expect(() => s.pause({ scope: "squad", project: "p", squad: "missing" })).toThrow("squad");
    expect(() => s.pause({ scope: "member", ...role }, { source: "dependency", prerequisites: [] })).toThrow("prerequisite");
  });
});

describe("pause fences across loop turns", () => {
  test.each(["project", "squad", "member"] as const)("%s pause holds queued starts, pokes and retirement across reboot", async (scope) => {
    const { s, root } = fixture(), orca = new FakeBackend();
    const file = join(root, "unfinished.txt"); writeFileSync(file, "unfinished");
    const m = s.get("members", role)!;
    s.want("member", String(m.id), "running", { payload: { prompt: "start" } });
    const req = s.request("poke", { text: "repair" }, { project: "p", squad: "one", member: "wt-one-builder" }).row;
    let retired = 0;
    const retire: Fulfiller = { name: "retire-proof", kinds: ["member.retire"], run: () => [], exec: () => { retired++; rmSync(file); return { done: true }; } };
    const actions: Action[] = [{ project: "p", squad: "one", member: "wt-one-builder", subject: "retire", kind: "member.retire", episode: "1" }];
    const act = new LoopActuator({ orca, pick: async () => ({ agent: "claude", model: "opus", effort: null, account: "a" }), fulfillers: [member, poke, retire] });
    const plugins = { observers: [], reconcilers: [decider, member, poke, pending, { name: "retire-proof", run: () => actions }] };
    s.pause({ scope, ...role });
    let loop = new Loop(s, plugins, act, { projects: () => ["p"] }); loop.boot(T);
    for (let i = 0; i < 100; i++) { if (i === 50) { await act.boot(s, T + i); loop = new Loop(s, plugins, act, { projects: () => ["p"] }); loop.boot(T + i); } await loop.tick(T + i); }
    await act.drain();
    expect(orca.of("worker-start")).toHaveLength(0);
    expect(orca.of("poke")).toHaveLength(0);
    expect(retired).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("unfinished");
    expect(s.get("requests", { id: req.id })?.done_at).toBeNull();
    expect(s.get("members", { id: m.id })?.want_result).toBeNull();
  });

  test.each(["wt-one-builder", null])("an in-flight start retains its returned worktree (%s) without sending the brief again", async (wt) => {
    const { s } = fixture(), orca = new FakeBackend();
    const m = s.get("members", role)!;
    s.upsert("members", { id: m.id }, { wt });
    if (wt) s.upsert("observed_workers", { project: "p", wt }, { presence: "none" });   // the walk reads no agent: the decider starts it
    s.want("member", String(m.id), "running", { payload: { prompt: "build" } });
    orca.onCall = (c) => { if (c.op === "worker-start" || c.op === "role-start") s.pause({ scope: "member", ...role }); };
    const act = new LoopActuator({ orca, pick: async () => ({ agent: "claude", model: "opus", effort: null, account: "a" }), fulfillers: [member] });
    const loop = new Loop(s, { observers: [], reconcilers: [decider, member] }, act, { projects: () => ["p"] }); loop.boot(T);
    await loop.tick(T); await act.drain(); await loop.tick(T + 1);
    expect(orca.started).toHaveLength(1);
    expect(s.get("members", { id: m.id })?.wt).toBe(orca.started[0].wt);
    expect(s.db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
    expect(s.db.query("SELECT state FROM pause_members WHERE role = 'builder'").get()).toEqual({ state: "pausing" });
  });

  test("paused Lead mail stays durable with unchanged delivery retry budget", async () => {
    const { s } = fixture(), orca = new FakeBackend();
    const message = orca.ask("run_one", "term_builder", "Which approach?");
    orca.bound.set("run_one", "term_control");
    s.pause({ scope: "member", project: "p", squad: "one", role: "lead" });
    const act = new LoopActuator({ orca, fulfillers: [] });
    for (let i = 0; i < 100; i++) await relay(act, s, { project: "p", squad: "one", run: "run_one", handle: "term_control", lead: "wt-one-lead", at: T + i * 600 });
    expect(s.get("relayed", { msg_id: message })).toMatchObject({ forwarded_at: null, tries: 0, error: null });
    expect(orca.of("send-run-worker")).toHaveLength(0);
    expect(orca.of("dispatch")).toHaveLength(0);
    expect(s.db.query("SELECT COUNT(*) AS n FROM episodes WHERE kind = 'relay-stuck'").get()).toEqual({ n: 0 });
  });

  test("all existing mutation kinds respect a paused role before executing", async () => {
    const { s, ctx } = fixture(), orca = new FakeBackend();
    const fulfillers = (await load<Fulfiller>(DIRS.fulfil)).filter((f) => f.kinds);
    const act = new LoopActuator({ orca, fulfillers });
    const m = s.get("members", role)!;
    s.pause({ scope: "member", ...role });
    // U159: the `role` wish-replay kind is gone (member wishes are plain wishes now); the role
    // fulfiller's surviving kind, reassert-roles, is a project-scope fan-out, fenced by a pause on
    // its own scope, not by a member pause — so it is not in this member-pause list.
    for (const kind of ["member", "member.close", "poke", "keys", "rebind", "unbind", "request-restart", "worktree.remove", "duplicate", "stray", "finish-unit"]) {
      const a: Action = { project: "p", squad: "one", member: "wt-one-builder", subject: kind, kind, episode: "before-pause",
        payload: { id: m.id, wt: "wt-one-builder", args: ["p", "one", "builder", "task"] } };
      expect(await act.act(a, ctx())).toMatchObject({ wait: "paused" });
    }
    expect(orca.calls).toEqual([]);
  });

  test("resume invalidates old restart actions while queued mail reaches the resumed role", async () => {
    const { s, ctx } = fixture(), orca = new FakeBackend();
    let restarted = 0;
    const restart: Fulfiller = { name: "restart-proof", kinds: ["run-switch"], run: () => [], exec: () => { restarted++; return { done: true }; } };
    const act = new LoopActuator({ orca, fulfillers: [restart, poke] });
    const a: Action = { project: "p", squad: "one", member: "wt-one-builder", subject: "restart", kind: "run-switch", episode: "old" };
    a.pauseVersion = actionVersion(s, a);
    const q = s.request("poke", { text: "Queued instruction" }, { project: "p", squad: "one", member: "wt-one-builder" }).row;
    s.pause({ scope: "member", ...role });
    expect(await act.act(a, ctx())).toMatchObject({ wait: "paused" });
    s.resume({ scope: "member", ...role });
    expect(await act.act(a, ctx())).toMatchObject({ dropped: "generation changed" });
    expect(restarted).toBe(0);
    for (const action of await poke.run(ctx()) ?? []) await act.act(action, ctx());
    await act.drain();
    expect(orca.of("poke")).toHaveLength(1);
    expect(s.get("requests", { id: q.id })?.done_at).toBe(T);
  });

  test("a reply to a parked dispatch waits for its exact recipient", async () => {
    const { s, ctx } = fixture();
    s.upsert("observed_workers", { project: "p", wt: "wt-one-builder" }, { dispatch_id: "ctx_builder" });
    s.upsert("relayed", { msg_id: "question" }, { project: "p", squad: "one", run_id: "run_one", from_handle: "dispatch:ctx_builder", seen_at: T });
    let sent = 0;
    const reply: Fulfiller = { name: "reply-proof", kinds: ["reply"], run: () => [], exec: () => { sent++; return { done: true }; } };
    const act = new LoopActuator({ fulfillers: [reply] });
    const a: Action = { project: "p", squad: "one", subject: "question", kind: "reply", episode: "1", payload: { id: "question" } };
    s.pause({ scope: "member", ...role });
    expect(await act.act(a, ctx())).toMatchObject({ wait: "paused" });
    expect(sent).toBe(0);
    s.resume({ scope: "member", ...role });
    expect(await act.act(a, ctx())).toMatchObject({ done: true });
    expect(sent).toBe(1);
  });

  test("pause during request outcome lookup prevents replay of the mutation", async () => {
    const { s } = fixture(), orca = new FakeBackend();
    s.upsert("orca_calls", { retry_id: "retry_start" }, { key: "start", project: "p", squad: "one", member: "wt-one-builder", sender: "term_control", op: "worker-start", payload: "[]", state: "pending", at: T });
    orca.onCall = (c) => { if (c.op === "request-show") s.pause({ scope: "member", ...role }); };
    const act = new LoopActuator({ orca, fulfillers: [] });
    expect(await act.call(s, "worker-start", [], { key: "start", project: "p", squad: "one", member: "wt-one-builder", sender: "term_control", at: T })).toMatchObject({ code: 75, err: "activity: paused" });
    expect(orca.of("worker-start")).toHaveLength(0);
  });

  test.each(["wish", "request"] as const)("fresh reconciliation resumes a queued %s after the old action is invalidated", async (kind) => {
    const { s } = fixture();
    let ran = 0;
    const m = s.get("members", role)!;
    if (kind === "wish") s.want("member", String(m.id), "running", { payload: { prompt: "build" } });
    else s.db.run("INSERT INTO requests (project, squad, member, kind, payload, created_at) VALUES ('p', 'one', 'wt-one-builder', 'run-switch', ?, 1)", [JSON.stringify({ args: ["p", "one", "builder", "task"] })]);   // a retired kind: a pre-U43 row
    // U159: wishes are plain wishes acted in Bun — no script replay. The proof fulfiller stands in
    // for the decider's start: what matters here is the pause fence across reconciliation.
    const wishAction = (): Action => ({ project: "p", squad: "one", member: "wt-one-builder", subject: "wish-proof", kind: "wish-proof", episode: "1", payload: {} });
    const f: Fulfiller = kind === "wish" ? { name: "wish-proof", kinds: ["wish-proof"], run: () => [wishAction()], exec: () => { ran++; return { done: true }; } }
      : { name: "request-proof", kinds: ["run-switch"], run: (ctx) => requestActions(ctx, ["run-switch"]), exec: (a, x) => { ran++; finishRequest(s, a, { ok: true }, x.now); return { done: true }; } };
    const act = new LoopActuator({ fulfillers: [f] });
    const loop = new Loop(s, { observers: [], reconcilers: [pending, f] }, act, { projects: () => ["p"] });
    loop.boot(T); s.pause({ scope: "member", ...role });
    await loop.tick(T);
    s.resume({ scope: "member", ...role });
    for (let at = T + 1; at < T + 5; at++) await loop.tick(at);
    expect(ran).toBe(1);
  });

  test("native backend calls fence mutations after their shell process starts", async () => {
    const { s, root, ctx } = fixture();
    const trigger = pauseTrigger(root), shim = join(root, "orca"), log = join(root, "native-writes"), backend = join(root, "backend.sh");
    writeFileSync(shim, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PAUSE_TEST_LOG"\nprintf \'{"ok":true}\\n\'\n'); chmodSync(shim, 0o755);
    writeFileSync(backend, `#!/bin/sh\nbun '${trigger}'\nexec '${join(repo, "bin/backend/orca.sh")}' "$@"\n`); chmodSync(backend, 0o755);
    const savedCli = process.env.DS_ORCA_CLI_BIN_DIR;
    const savedPath = process.env.PATH, savedLog = process.env.PAUSE_TEST_LOG, savedState = process.env.PAUSE_TEST_STATE;
    process.env.DS_ORCA_CLI_BIN_DIR = root;
    process.env.PATH = `${root}:${savedPath}`; process.env.PAUSE_TEST_LOG = log; process.env.PAUSE_TEST_STATE = root;
    try {
      const f: Fulfiller = { name: "native-proof", kinds: ["native-proof"], run: () => [], exec: async (a, x) => {
        const o = await x.act.call(s, "terminal-close", ["term_fake"], { key: "native", project: "p", squad: "one", member: a.member!, sender: "term_control", at: T });
        return o.code === 0 ? { done: true } : { retry: o.err };
      } };
      const act = new LoopActuator({ orca: shell(backend), fulfillers: [f] });
      expect(await act.act({ project: "p", squad: "one", member: "wt-one-builder", subject: "native", kind: "native-proof", episode: "1" }, ctx())).toMatchObject({ wait: "paused" });
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("terminal close");
    } finally {
      if (savedCli === undefined) delete process.env.DS_ORCA_CLI_BIN_DIR; else process.env.DS_ORCA_CLI_BIN_DIR = savedCli;
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      if (savedLog === undefined) delete process.env.PAUSE_TEST_LOG; else process.env.PAUSE_TEST_LOG = savedLog;
      if (savedState === undefined) delete process.env.PAUSE_TEST_STATE; else process.env.PAUSE_TEST_STATE = savedState;
    }
  });

  test("a paused member's close (U155) waits: the roster and files are retained", async () => {
    const { s, ctx } = fixture(), orca = new FakeBackend();
    const fulfillers = (await load<Fulfiller>(DIRS.fulfil)).filter((f) => f.kinds);
    const act = new LoopActuator({ orca, fulfillers });
    const m = s.get("members", role)!;
    s.pause({ scope: "member", ...role });
    s.upsert("members", { id: m.id }, { want: "gone" });   // archived while paused: the close must wait
    const a: Action = { project: "p", squad: "one", member: "wt-one-builder", subject: `member:${m.id}`, kind: "member.close", episode: "close:stop:archived:1", payload: { id: Number(m.id), phase: "stop", why: "archived" } };
    expect(await act.act(a, ctx())).toMatchObject({ wait: "paused" });
    expect(orca.calls).toEqual([]);
    expect(s.get("members", { id: m.id })?.status).not.toBe("gone");
  });

  test("remote merge is observed during pause without retiring the retained Builder", () => {
    const { s, ctx } = fixture();
    s.upsert("units", { project: "p", squad: "one", slug: "task" }, { status: "dispatched", pr: "42", builder_wt: "wt-one-builder", observed_at: T, updated_at: T });
    s.upsert("observed_prs", { project: "p", ref: "one/task" }, { pr: 42, state: "MERGED", observed_at: T });
    s.pause({ scope: "member", ...role });
    expect(lifecycle(ctx()).filter((a) => a.kind === "member.close")).toEqual([]);
    expect(s.get("units", { project: "p", squad: "one", slug: "task" })?.status).toBe("done");
    expect(s.get("members", role)?.want).not.toBe("gone");
    s.resume({ scope: "member", ...role });
    lifecycle(ctx());
    expect(s.get("members", role)?.want).toBe("gone");   // U155: the archive wish, written once unpaused
  });

  test("intentional absence produces no crash recovery or phase switch", () => {
    const { s, ctx } = fixture();
    s.upsert("units", { project: "p", squad: "one", slug: "task" }, { status: "dispatched", pr: "42", builder_wt: "wt-one-builder", observed_at: T, updated_at: T });
    s.upsert("observed_prs", { project: "p", ref: "one/task" }, { pr: 42, state: "OPEN", observed_at: T });
    s.pause({ scope: "squad", project: "p", squad: "one" });
    s.db.run("UPDATE observed_workers SET state = 'gone' WHERE wt LIKE 'wt-one-%'");
    expect(liveness(ctx()).filter((a) => a.squad === "one")).toEqual([]);
    phases(ctx());
    expect(s.get("members", role)?.phase).toBeNull();
    expect(s.get("members", role)?.want).toBeNull();
  });

  test("child scripts recheck the pause generation at the backend mutation boundary", () => {
    const { s, root } = fixture(), act = new LoopActuator({ fulfillers: [] });
    const a: Action = { project: "p", squad: "one", member: "wt-one-builder", subject: "restart", kind: "run-switch", episode: "old" };
    const shim = join(root, "orca"), log = join(root, "backend-writes");
    writeFileSync(shim, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$PAUSE_TEST_LOG"\nprintf \'{"ok":true}\\n\'\n'); chmodSync(shim, 0o755);
    const env = { ...process.env, ...act.childActivity(s, a), DS_ORCA_CLI_BIN_DIR: root, PATH: `${root}:${process.env.PATH}`, PAUSE_TEST_LOG: log };
    const run = () => Bun.spawnSync(["bash", join(import.meta.dir, "../../bin/backend/orca.sh"), "terminal-close", "term_fake"], { env, stdout: "pipe", stderr: "pipe" });
    expect(run().exitCode).toBe(0);
    s.pause({ scope: "member", ...role });
    expect(run().stderr.toString()).toContain("activity: paused");
    s.resume({ scope: "member", ...role });
    expect(run().stderr.toString()).toContain("generation changed");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("a paused recipient keeps its picker question, while unrelated work and backend errors continue", async () => {
    const { s, ctx } = fixture(), orca = new FakeBackend();
    const q = { id: "pick", asker: "builder-task", source: "picker", card_wt: "wt-one-builder", since: new Date((T - 1000) * 1000).toISOString() };
    s.upsert("observed_pickers", { project: "p", squad: "one", id: "pick" }, { doc: JSON.stringify(q), observed_at: T });
    s.pause({ scope: "member", ...role });
    s.db.run("DELETE FROM observed_workers WHERE wt = 'wt-one-builder'");
    expect(pickerStale(s, "p", "one", q, T)).toBeNull();
    reapPickers(ctx());
    expect(s.db.query("SELECT COUNT(*) AS n FROM requests WHERE kind = 'picker'").get()).toEqual({ n: 0 });
    expect(wake(ctx(), "wt-two-builder", "go", "test", "active").status).toBe("sent");
    let errors = 0;
    const alerts: Fulfiller = { name: "alert-proof", kinds: ["alert"], run: () => [], exec: () => { errors++; return { done: true }; } };
    const act = new LoopActuator({ orca, fulfillers: [alerts] });
    const a: Action = { project: "p", squad: "one", member: "wt-one-builder", subject: "backend-error", kind: "alert", episode: "1", payload: { title: "Backend read failed" } };
    expect(await act.act(a, ctx())).toMatchObject({ done: true });
    expect(errors).toBe(1);
    expect(await act.act({ ...a, subject: "gone", payload: { title: "Agent broken", card: "agent_broken" } }, ctx())).toMatchObject({ wait: "paused" });
    // U232: matched on the stable card, never the (now squad-prefixed) title.
    for (const card of ["poke_unanswered", "poke_not_taken"])
      expect(await act.act({ ...a, subject: `gone-${card}`, payload: { title: `one · lead: ${card}`, card } }, ctx())).toMatchObject({ wait: "paused" });
  });

  test("a paused Lead's Run mail waits; on resume it is written as the Lead's row with its stuck clock moved by the pause", async () => {
    const { s } = fixture(), orca = new FakeBackend();
    orca.bound.set("run_one", "term_control");
    orca.agent("wt-one-lead", "term_lead", "claude");
    const message = orca.ask("run_one", "term_builder", "Which approach?");
    s.upsert("relayed", { msg_id: message }, { project: "p", squad: "one", run_id: "run_one", type: "question", from_handle: "term_builder", body: "Which approach?", seen_at: T });
    s.pause({ scope: "member", project: "p", squad: "one", role: "lead" });
    const act = new LoopActuator({ orca, fulfillers: [] });
    const pass = (at: number) => relay(act, s, { project: "p", squad: "one", run: "run_one", handle: "term_control", lead: "wt-one-lead", at });
    const rows = () => s.db.query("SELECT * FROM messages WHERE project = 'p' AND squad = 'one' AND to_role = 'lead'").all() as Row[];
    await pass(T + 100);
    expect(s.get("relayed", { msg_id: message })).toMatchObject({ forwarded_at: null, paused_at: T });   // frozen when the pause began
    expect(rows()).toEqual([]);
    resume(s, { scope: "member", project: "p", squad: "one", role: "lead" }, T + 10_100);
    await pass(T + 10_101);
    expect(s.get("relayed", { msg_id: message })).toMatchObject({ forwarded_at: T + 10_101, seen_at: T + 10_100, paused_at: null });
    expect(rows()).toEqual([expect.objectContaining({ key: `relay:${message}`, needs_reply: 1 })]);
    expect(orca.of("send-run-worker")).toHaveLength(0);
  });
});
