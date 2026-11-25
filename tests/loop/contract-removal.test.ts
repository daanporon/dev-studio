// contract-removal.test.ts — orca-backend-alternatives U11c: every removal path of a squad not on `orca`
// goes through the contract's `terminal.close` and the squad's recorded worktree provider, by path: a
// close (fulfil/close.ts), a cancel (fulfil/cancel.ts), a leftover pass (fulfil/worktree.ts) and a host
// tidy (fulfil/cleanup-act.ts). The worktree goes, its pushed but unmerged branch stays, and nothing is
// asked of Orca. A squad on `orca` keeps terminal-close-worktree and worktree-rm. Hermetic: a copy of the
// fixture state, a temp repo with a bare remote, DS_WORKTREE_ROOT under the temp dir, a fake BACKEND.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Exec, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { fakeContract, type FakeContract } from "../../bin/loop/fakes/contract.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { git } from "../../bin/loop/io/worktrees.ts";
import { cleanupAct, CLEANUP_ACT } from "../../bin/loop/fulfil/cleanup-act.ts";
import { fakeProc, UID } from "./cleanup-fixture.ts";
import { pause } from "../../bin/loop/pause/pause.ts";
import { contractRemoveTree } from "../../bin/loop/squad/removal.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000, H = 3600;
const SQ = "ontmux";
const ENV = ["DS_LOOP_RETRY_S", "DS_WORKTREE_ROOT", "DS_CLAUDE_SYSTEM_JSON_DIR", "BACKEND", "FAKE_LOG"] as const;

const temps: string[] = [], stores: Store[] = [];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const reconcilers = await load<Reconciler>(DIRS.reconcilers);
const system: Picker = async () => ({ agent: "claude", model: "opus", effort: null, account: "system" });
const G = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
async function sh(dir: string, ...args: string[]): Promise<string> {
  const g = await git([...G, "-C", dir, ...args]);
  if (g.code !== 0) throw new Error(`git ${args.join(" ")}: ${g.err}`);
  return g.out.trim();
}

type Rig = Awaited<ReturnType<typeof rig>>;
async function rig() {
  const d = mkdtempSync(join(tmpdir(), "zzremoval-")); temps.push(d);
  const state = join(d, "state"), repo = join(d, "repo"), bare = join(d, "remote.git"), home = join(d, "home");
  cpSync(FIXTURE, state, { recursive: true });
  for (const x of [repo, bare, home]) mkdirSync(x);
  await sh(bare, "init", "-q", "--bare");
  await sh(repo, "init", "-q", "-b", "main");
  await sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
  await sh(repo, "remote", "add", "origin", bare);
  await sh(repo, "push", "-q", "origin", "main");
  writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ numStartups: 3 })}\n`);
  // Any shell-out to the backend adapter lands in this log (the Orca path's tools would reach it).
  const fake = join(d, "fake-backend"), log = join(d, "backend.log");
  writeFileSync(fake, `#!/usr/bin/env bash\necho "$*" >> "$FAKE_LOG"\necho '{}'\n`); chmodSync(fake, 0o755);
  Object.assign(process.env, { DS_LOOP_RETRY_S: "1", DS_WORKTREE_ROOT: join(d, "wts"), DS_CLAUDE_SYSTEM_JSON_DIR: home, BACKEND: fake, FAKE_LOG: log });
  const s = open(state); stores.push(s);
  importJson(s);
  for (const [role, value] of [["lead", "claude sonnet always"], ["thinker", "claude opus ondemand"], ["builder", "claude opus ondemand"]] as const)
    s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
  let at = T;
  const orca = new FakeOrca(), contract: FakeContract = fakeContract({}, { name: "tmux", now: () => at });
  const act = new LoopActuator({ orca, pick: system, fulfillers: fulfillers.filter((f) => f.kinds),
    backends: () => ({ backend: contract, caps: contract.caps }) });
  // Emitted every tick, as the lifecycle reconciler re-emits a leftover until it is gone.
  const queue: Action[] = [], emit: Reconciler = { name: "emit", run: () => queue.map((a) => ({ ...a })) };
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers, emit] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
  s.upsert("config", { project: "fx", file: "limits.conf", key: "default_backend" }, { value: "tmux", observed_at: T });   // U30: the project's backend
  s.want("squad", `fx/${SQ}`, "running", { payload: { repo: `path:${repo}`, type: "feature" },
    fill: { repo: `path:${repo}`, type: "feature", backend: "tmux", worktree_provider: "git" }, by: "test" });
  const x = (): Exec => ({ store: s, project: "fx", tick: 0, now: at, fired: [], poked: new Set<string>(), act } as unknown as Exec);
  return { s, orca, contract, act, tick, queue, x, now: () => at, d, repo, log };
}

const pathOf = (m: Row) => String(m.wt).replace(/^local::/, "");
const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;
const live = (f: FakeContract, cwd: string) => [...f.terms.values()].filter((t) => t.t.cwd === cwd);
const tree = (s: Store, path: string) => s.get("worktrees", { host: "local", path });
// These rows stand in for the contract observer (U12): the decider reads a squad off Orca from the walk alone.
const running = (r: Rig, m: Row, state = "idle") => r.s.upsert("observed_workers", { project: "fx", wt: String(m.wt) }, { state, presence: "running", walk: "running", account_at: r.now(), gone_at: null, observed_at: r.now() });
const ended = (r: Rig, m: Row) => r.s.upsert("observed_workers", { project: "fx", wt: String(m.wt) }, { state: "idle", presence: "none", gone_at: r.now(), observed_at: r.now() });
// No Orca call of any kind names this squad or its folders (the fixture's own `demo` squad is on Orca).
const orcaFor = (r: Rig) => r.orca.calls.filter((c) => [SQ, join(r.d, "wts")].some((v) => JSON.stringify(c.args).includes(v)) || c.via?.env?.DS_START_MEMBER?.includes(`/${SQ}/`));
const backendLog = (r: Rig) => existsSync(r.log) ? readFileSync(r.log, "utf8").split("\n").filter((l) => l.includes(join(r.d, "wts"))) : [];
const closes = (r: Rig, path: string) => r.s.db.query("SELECT * FROM orca_calls WHERE op = 'terminal.close' AND payload LIKE ?").all(`%${path}%`) as Row[];
const branchKept = async (r: Rig, branch: string) => expect(await sh(r.repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)).toMatch(/^[0-9a-f]{40}$/);

async function startBuilder(r: Rig): Promise<{ b: Row; path: string; branch: string }> {
  for (let i = 0; i < 10 && !(r.s.db.query("SELECT 1 FROM members WHERE squad = ? AND role = 'lead' AND wt LIKE 'local::%'").get(SQ)); i++) await r.tick();
  running(r, r.s.db.query("SELECT * FROM members WHERE squad = ? AND role = 'lead'").get(SQ) as Row);
  r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, observed_at, updated_at) VALUES ('fx', ?, 'builder', 'u1', 'claude', 'opus', 'system', ?, ?)", [SQ, T, T]);
  const id = Number((r.s.db.query("SELECT id FROM members WHERE squad = ? AND suffix = 'u1'").get(SQ) as Row).id);
  r.s.want("member", String(id), "running", { payload: { prompt: "build u1" } });
  for (let i = 0; i < 10 && !String(member(r.s, id).wt ?? "").startsWith("local::"); i++) await r.tick();
  const b = member(r.s, id), path = pathOf(b);
  expect(String(b.wt)).toStartWith("local::");
  running(r, b);
  expect(live(r.contract, path)).toHaveLength(1);
  // The Builder's work: one commit on its branch, pushed but not merged into main.
  const branch = String(tree(r.s, path)!.branch);
  writeFileSync(join(path, "work.txt"), "work\n");
  await sh(path, "add", "work.txt");
  await sh(path, "commit", "-q", "-m", "work");
  await sh(path, "push", "-q", "origin", branch);
  return { b, path, branch };
}
// Removed through its provider, by path, with no Orca call; the folder gone, the branch kept.
async function removedByProvider(r: Rig, path: string, branch: string) {
  expect(live(r.contract, path)).toEqual([]);
  expect(closes(r, path).length).toBeGreaterThan(0);
  expect(tree(r.s, path)).toMatchObject({ provider: "git", gone_at: expect.any(Number) });
  expect(existsSync(path)).toBe(false);
  await branchKept(r, branch);
  expect(r.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'worktree_removed' AND payload LIKE ?").get(`%${path}%`)).toEqual({ n: 1 });
  expect(orcaFor(r)).toEqual([]);
  expect(backendLog(r)).toEqual([]);
}

describe("a squad on a contract backend removes through its provider (U11c)", () => {
  test("close: a Builder wished gone is stopped, then its worktree removed by path", async () => {
    const r = await rig();
    const { b, path, branch } = await startBuilder(r);
    r.s.want("member", String(b.id), "gone", { by: "test" });
    for (let i = 0; i < 5 && live(r.contract, path).length; i++) await r.tick();
    expect(live(r.contract, path)).toEqual([]);
    ended(r, b);
    for (let i = 0; i < 10 && tree(r.s, path)?.gone_at == null; i++) await r.tick();
    await removedByProvider(r, path, branch);
    expect(member(r.s, Number(b.id)).status).toBe("gone");
  });

  test("close: a dirty worktree is kept as a leftover, untouched", async () => {
    const r = await rig();
    const { b, path } = await startBuilder(r);
    writeFileSync(join(path, "draft.txt"), "not committed\n");
    r.s.want("member", String(b.id), "gone", { by: "test" });
    for (let i = 0; i < 5 && live(r.contract, path).length; i++) await r.tick();
    ended(r, b);
    for (let i = 0; i < 10 && member(r.s, Number(b.id)).status !== "gone"; i++) await r.tick();
    expect(existsSync(join(path, "draft.txt"))).toBe(true);
    expect(tree(r.s, path)?.gone_at ?? null).toBeNull();
    const doc = JSON.parse(String(r.s.get("squads", { project: "fx", topic: SQ })!.doc));
    expect((doc.leftovers ?? []).map((l: Row) => l.path)).toContain(path);
    expect(orcaFor(r)).toEqual([]);
  });

  test("cancel: a cancelled Builder's terminals close, then its dirty worktree is removed, forced", async () => {
    const r = await rig();
    const { b, path, branch } = await startBuilder(r);
    writeFileSync(join(path, "draft.txt"), "dropped with the unit\n");
    running(r, b, "working");
    r.s.upsert("units", { project: "fx", squad: SQ, slug: "u1" }, { status: "cancelled", builder_wt: String(b.wt), observed_at: r.now(), updated_at: r.now() });
    for (let i = 0; i < 5 && live(r.contract, path).length; i++) await r.tick();
    expect(live(r.contract, path)).toEqual([]);
    ended(r, b);
    for (let i = 0; i < 10 && member(r.s, Number(b.id)).status !== "gone"; i++) await r.tick();
    await removedByProvider(r, path, branch);
    expect(member(r.s, Number(b.id))).toMatchObject({ status: "gone", want_result: "done: cancelled Builder removed" });
  });

  test("cancel: a Builder the observer has not seen live still has its terminals closed before the removal", async () => {
    const r = await rig();
    const { b, path, branch } = await startBuilder(r);
    expect(live(r.contract, path).length).toBeGreaterThan(0);
    r.s.upsert("units", { project: "fx", squad: SQ, slug: "u1" }, { status: "cancelled", builder_wt: String(b.wt), observed_at: r.now(), updated_at: r.now() });
    for (let i = 0; i < 10 && tree(r.s, path)?.gone_at == null; i++) await r.tick();
    expect(live(r.contract, path)).toEqual([]);
    await removedByProvider(r, path, branch);
  });

  test("a leftover pass closes a stray terminal and removes the worktree by path", async () => {
    const r = await rig();
    const { b, path, branch } = await startBuilder(r);
    // The member is retired but its terminal and worktree are not: the leftover reconciler's case.
    r.s.upsert("members", { id: b.id }, { status: "gone", want: null });
    ended(r, b);
    r.queue.push({ project: "fx", squad: SQ, subject: String(b.wt), kind: "worktree.remove", episode: "leftover:1",
      payload: { topic: SQ, wt: String(b.wt), path, unit: "u1" } } as Action);
    for (let i = 0; i < 5 && tree(r.s, path)?.gone_at == null; i++) await r.tick();
    await removedByProvider(r, path, branch);
  });

  test("a paused squad's removal waits: the provider is not called, the tree stays", async () => {
    const r = await rig();
    const { b, path } = await startBuilder(r);
    r.s.upsert("members", { id: b.id }, { status: "gone", want: null });
    ended(r, b);
    const a = { project: "fx", squad: SQ, member: String(b.wt), subject: String(b.wt), kind: "worktree.remove", episode: "leftover:1",
      payload: { topic: SQ, wt: String(b.wt), path } } as Action;
    pause(r.s, { scope: "squad", project: "fx", squad: SQ }, { by: "test" }, r.now());
    const rm = await contractRemoveTree(a, r.x(), { project: "fx", squad: SQ, wt: String(b.wt), path });
    expect(rm).toMatchObject({ code: 75, err: "activity: paused" });
    expect(existsSync(path)).toBe(true);
    expect(tree(r.s, path)?.gone_at ?? null).toBeNull();
  });

  test("a leftover pass whose terminal.close fails keeps the worktree", async () => {
    const r = await rig();
    const { b, path } = await startBuilder(r);
    r.s.upsert("members", { id: b.id }, { status: "gone", want: null });
    ended(r, b);
    const call = r.contract.call.bind(r.contract);
    r.contract.call = (async (op: string, req: unknown) => op === "terminal.close" ? { ok: false, error: { code: "internal", message: "stuck" } } : call(op as never, req as never)) as typeof r.contract.call;
    r.queue.push({ project: "fx", squad: SQ, subject: String(b.wt), kind: "worktree.remove", episode: "leftover:1",
      payload: { topic: SQ, wt: String(b.wt), path, unit: "u1" } } as Action);
    await r.tick(3);
    const done = r.s.db.query("SELECT result FROM episodes WHERE kind = 'action:worktree.remove' AND subject = ?").get(String(b.wt)) as Row | null;
    expect(String(done?.result ?? "")).toContain("terminals not closed");
    expect(existsSync(path)).toBe(true);
    expect(tree(r.s, path)?.gone_at ?? null).toBeNull();
    expect(live(r.contract, path)).toHaveLength(1);
  });

  test("a host tidy reads no Orca list, closes a stray terminal and removes the worktree by path", async () => {
    const r = await rig();
    const { b, path, branch } = await startBuilder(r);
    r.s.upsert("members", { id: b.id }, { status: "gone", want: "gone" });
    ended(r, b);
    r.s.upsert("config", { project: "fx", file: "limits.conf", key: "host_tidy" }, { value: "apply", observed_at: T });
    r.s.db.query(`INSERT INTO observed_cleanup (project, class, key, path, size_kb, mtime, first_seen, orphaned_since, verdict, facts, observed_at)
      VALUES ('fx', 'd', ?, ?, 10, NULL, ?, ?, 'removable', '{}', ?)`).run(path, path, r.now() - 30 * H, r.now() - 30 * H, r.now() - 60);
    const ps = r.orca.calls.ps;
    const a: Action = { project: "fx", subject: `${CLEANUP_ACT}:d:${path}`, kind: CLEANUP_ACT, episode: "1", payload: { class: "d", key: path, path } };
    const out = await cleanupAct({ proc: fakeProc([]), uid: UID }).exec(a, r.x());
    const res = "background" in out ? await out.background : out;
    expect(res).toMatchObject({ done: true });
    expect(String((res as Row).result)).toStartWith("removed");
    expect(r.orca.calls.ps).toBe(ps);
    await removedByProvider(r, path, branch);
  });
});

describe("a squad on Orca keeps today's removal (U11c)", () => {
  // A demo-squad Builder on an Orca worktree id over a real git worktree of the temp repo.
  async function orcaBuilder(r: Rig, suffix: string): Promise<{ id: number; wt: string; path: string }> {
    const path = join(r.d, `orca-${suffix}`), branch = `orca-${suffix}`;
    await sh(r.repo, "worktree", "add", "-q", "-b", branch, path);
    await sh(path, "push", "-q", "origin", branch);
    const wt = `wt-${suffix}::${path}`;
    r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, wt, status, want, observed_at, updated_at) VALUES ('fx', 'demo', 'builder', ?, 'claude', 'opus', 'system', ?, 'running', 'gone', ?, ?)", [suffix, wt, T, T]);
    const id = Number((r.s.db.query("SELECT id FROM members WHERE wt = ?").get(wt) as Row).id);
    r.s.upsert("observed_worktrees", { project: "fx", wt }, { path, branch, observed_at: r.now() });
    r.s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", presence: "none", gone_at: r.now(), observed_at: r.now() });
    return { id, wt, path };
  }
  const contractCalls = (r: Rig, path: string) => r.contract.calls.filter((c) => JSON.stringify(c.req).includes(path));

  test("close and a leftover pass call terminal-close-worktree and worktree-rm by id, never the contract", async () => {
    const r = await rig();
    const c = await orcaBuilder(r, "c"), l = await orcaBuilder(r, "l");
    r.s.upsert("members", { id: l.id }, { status: "gone", want: null });
    r.queue.push({ project: "fx", squad: "demo", subject: l.wt, kind: "worktree.remove", episode: "leftover:1",
      payload: { topic: "demo", wt: l.wt, path: l.path, unit: "u1" } } as Action);
    for (let i = 0; i < 6 && (r.orca.of("worktree-rm").filter((x) => [`id:${c.wt}`, `id:${l.wt}`].includes(x.args[0])).length < 2); i++) await r.tick();
    for (const wt of [c.wt, l.wt]) {
      expect(r.orca.of("terminal-close-worktree").some((x) => x.args[0] === `id:${wt}`)).toBe(true);
      expect(r.orca.of("worktree-rm").some((x) => x.args[0] === `id:${wt}`)).toBe(true);
    }
    for (const p of [c.path, l.path]) { expect(closes(r, p)).toEqual([]); expect(contractCalls(r, p)).toEqual([]); }
  });
});
