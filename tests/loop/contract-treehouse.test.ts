// contract-treehouse.test.ts — orca-backend-alternatives U16e: a squad on a contract backend with
// `worktree_provider treehouse` runs its members in leased slots of treehouse's warm pool, and every way a
// member ends gives the lease back without losing the slot: a close returns it (the folder stays in the
// pool, the branch is kept), a cancel returns it forced, a crash restart adopts the same lease (one slot,
// one lease), and a leftover pass returns a retired member's slot. The host tidy's scan lists no pool
// slot, leased or returned. Hermetic: a copy of the fixture state, a temp repo with a bare remote, a temp
// HOME and pool root, the pinned treehouse release (fetchTreehouse, sha256 checked); the cases are skipped
// with the reason printed when it can't be had (DS_TREEHOUSE_FETCH=0, or DS_TREEHOUSE_BIN for a local one).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { fakeContract, type FakeContract } from "../../bin/loop/fakes/contract.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { git } from "../../bin/loop/io/worktrees.ts";
import { fetchTreehouse, holderOf, slots } from "../../bin/loop/io/providers/treehouse.ts";
import { scanCleanup } from "../../bin/loop/observers/cleanup.ts";
import { fakeProc, UID } from "./cleanup-fixture.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000, LONG = 180_000;
const SQ = "ontmux";
const ENV = ["DS_LOOP_RETRY_S", "DS_WORKTREE_ROOT", "DS_CLAUDE_SYSTEM_JSON_DIR", "HOME", "XDG_CONFIG_HOME", "TREEHOUSE_ROOT",
  "DS_TREEHOUSE_BIN", "TREEHOUSE_NO_UPDATE_CHECK"] as const;

const dir = mkdtempSync(join(tmpdir(), "zztreehouse-"));
const stores: Store[] = [];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const restore = () => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
afterEach(() => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } } restore(); });
afterAll(() => { restore(); rmSync(dir, { recursive: true, force: true }); });

const G = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
async function sh(at: string, ...args: string[]): Promise<string> {
  const g = await git([...G, "-C", at, ...args]);
  if (g.code !== 0) throw new Error(`git ${args.join(" ")}: ${g.err}`);
  return g.out.trim();
}

const got = await fetchTreehouse(join(dir, "bin"));
if ("skip" in got) {
  console.log(`contract-treehouse: the treehouse cases are skipped: ${got.skip}`);
  describe("a squad off Orca on treehouse worktrees", () => { test.skip(`leases, returns, restart, tidy (skipped: ${got.skip})`, () => {}); });
} else {
  const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
  const reconcilers = await load<Reconciler>(DIRS.reconcilers);
  const system: Picker = async () => ({ agent: "claude", model: "opus", effort: null, account: "system" });

  let n = 0;
  type Rig = Awaited<ReturnType<typeof rig>>;
  const rig = async () => {
    const d = join(dir, `r${++n}`), state = join(d, "state"), repo = join(d, "repo"), bare = join(d, "remote.git"), home = join(d, "home");
    cpSync(FIXTURE, state, { recursive: true });
    for (const x of [repo, bare, join(home, ".config")]) mkdirSync(x, { recursive: true });
    await sh(bare, "init", "-q", "--bare");
    await sh(repo, "init", "-q", "-b", "main");
    await sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
    await sh(repo, "remote", "add", "origin", bare);
    await sh(repo, "push", "-q", "origin", "main");
    writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ numStartups: 3 })}\n`);
    Object.assign(process.env, { DS_LOOP_RETRY_S: "1", DS_WORKTREE_ROOT: join(d, "wts"), DS_CLAUDE_SYSTEM_JSON_DIR: home,
      HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TREEHOUSE_ROOT: join(d, "pools"), DS_TREEHOUSE_BIN: got.bin,
      // No update check: treehouse runs it in the background, and its file can land after afterAll removed the dir.
      TREEHOUSE_NO_UPDATE_CHECK: "1" });
    const s = open(state); stores.push(s);
    importJson(s);
    for (const [role, value] of [["lead", "claude sonnet always"], ["thinker", "claude opus ondemand"], ["builder", "claude opus ondemand"]] as const)
      s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
    let at = T;
    const contract: FakeContract = fakeContract({}, { name: "tmux", now: () => at });
    const orca = new FakeOrca();
    const act = new LoopActuator({ orca, pick: system, fulfillers: fulfillers.filter((f) => f.kinds),
      backends: () => ({ backend: contract, caps: contract.caps }) });
    const queue: Action[] = [], emit: Reconciler = { name: "emit", run: () => queue.map((a) => ({ ...a })) };
    const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers, emit] }, act, { projects: () => ["fx"] });
    loop.boot(T);
    const tick = async (k = 1) => { for (let i = 0; i < k; i++) { at += 5; await loop.tick(at); await act.drain(); } };
    s.want("squad", `fx/${SQ}`, "running", { payload: { repo: `path:${repo}`, type: "feature" },
      fill: { repo: `path:${repo}`, type: "feature", backend: "tmux", worktree_provider: "treehouse" }, by: "test" });
    return { s, orca, contract, tick, queue, now: () => at, d, repo, pools: join(d, "pools") };
  };

  const pathOf = (m: Row) => String(m.wt).replace(/^local::/, "");
  const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;
  const live = (f: FakeContract, cwd: string) => [...f.terms.values()].filter((t) => t.t.cwd === cwd);
  const tree = (s: Store, path: string) => s.get("worktrees", { host: "local", path });
  // These rows stand in for the contract observer (U12): the decider reads a squad off Orca from the walk alone.
  const running = (r: Rig, m: Row, state = "idle") => r.s.upsert("observed_workers", { project: "fx", wt: String(m.wt) }, { state, presence: "running", walk: "running", account_at: r.now(), gone_at: null, observed_at: r.now() });
  const ended = (r: Rig, m: Row) => r.s.upsert("observed_workers", { project: "fx", wt: String(m.wt) }, { state: "idle", presence: "none", gone_at: r.now(), observed_at: r.now() });
  const orcaFor = (r: Rig) => r.orca.calls.filter((c) => [SQ, r.pools].some((v) => JSON.stringify(c.args).includes(v)) || c.via?.env?.DS_START_MEMBER?.includes(`/${SQ}/`));
  const slotAt = async (r: Rig, path: string) => (await slots(r.repo)).find((x) => x.path === path);
  const leased = async (r: Rig) => (await slots(r.repo)).filter((x) => x.lease_id);

  async function startBuilder(r: Rig): Promise<{ b: Row; path: string; branch: string; lease: string }> {
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
    const row = tree(r.s, path)!, branch = String(row.branch), lease = String(row.lease);
    // The Builder's work: one commit on its branch, pushed but not merged into main.
    writeFileSync(join(path, "work.txt"), "work\n");
    await sh(path, "add", "work.txt");
    await sh(path, "commit", "-q", "-m", "work");
    await sh(path, "push", "-q", "origin", branch);
    return { b, path, branch, lease };
  }
  // The lease went back through the provider, by path, with no Orca call: the slot is still in the pool,
  // on no lease, its row gone, the branch kept.
  async function returned(r: Rig, path: string, branch: string) {
    expect(live(r.contract, path)).toEqual([]);
    expect(tree(r.s, path)).toMatchObject({ provider: "treehouse", gone_at: expect.any(Number) });
    expect(existsSync(path)).toBe(true);
    const sl = await slotAt(r, path);
    expect(sl?.lease_id ?? "").toBe("");
    expect(await sh(r.repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)).toMatch(/^[0-9a-f]{40}$/);
    expect(r.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'worktree_removed' AND payload LIKE ?").get(`%${path}%`)).toEqual({ n: 1 });
    expect(orcaFor(r)).toEqual([]);
  }

  describe("a squad off Orca on treehouse worktrees (U16e)", () => {
    test("the Lead and a Builder run in leased pool slots, each held by its own name", async () => {
      const r = await rig();
      const { b, path, lease } = await startBuilder(r);
      const l = r.s.db.query("SELECT * FROM members WHERE squad = ? AND role = 'lead'").get(SQ) as Row, lp = pathOf(l);
      for (const p of [lp, path]) {
        expect(p.startsWith(r.pools + "/")).toBe(true);
        const row = tree(r.s, p)!;
        expect(row).toMatchObject({ provider: "treehouse", project: "fx", squad: SQ, gone_at: null });
        expect(await slotAt(r, p)).toMatchObject({ lease_id: row.lease, lease_holder: holderOf({ project: "fx", name: String(row.name) }) });
      }
      expect(tree(r.s, path)).toMatchObject({ role: "builder", parent_path: lp, lease });
      expect(await leased(r)).toHaveLength(2);
      expect(String(b.wt)).toBe(`local::${path}`);
      expect(orcaFor(r)).toEqual([]);
    }, LONG);

    test("close: a Builder wished gone is stopped and its lease returned; the slot stays in the pool", async () => {
      const r = await rig();
      const { b, path, branch } = await startBuilder(r);
      r.s.want("member", String(b.id), "gone", { by: "test" });
      for (let i = 0; i < 5 && live(r.contract, path).length; i++) await r.tick();
      ended(r, b);
      for (let i = 0; i < 10 && tree(r.s, path)?.gone_at == null; i++) await r.tick();
      await returned(r, path, branch);
      expect(member(r.s, Number(b.id)).status).toBe("gone");
      expect(await leased(r)).toHaveLength(1);   // the Lead's
    }, LONG);

    test("cancel: a cancelled Builder's dirty slot is returned, forced", async () => {
      const r = await rig();
      const { b, path, branch } = await startBuilder(r);
      writeFileSync(join(path, "draft.txt"), "dropped with the unit\n");
      running(r, b, "working");
      r.s.upsert("units", { project: "fx", squad: SQ, slug: "u1" }, { status: "cancelled", builder_wt: String(b.wt), observed_at: r.now(), updated_at: r.now() });
      for (let i = 0; i < 5 && live(r.contract, path).length; i++) await r.tick();
      ended(r, b);
      for (let i = 0; i < 10 && member(r.s, Number(b.id)).status !== "gone"; i++) await r.tick();
      await returned(r, path, branch);
      expect(member(r.s, Number(b.id))).toMatchObject({ status: "gone", want_result: "done: cancelled Builder removed" });
    }, LONG);

    test("a crash restart adopts its own lease: same slot, same lease, one leased slot for the member", async () => {
      const r = await rig();
      const { b, path, lease } = await startBuilder(r);
      const first = live(r.contract, path)[0].t;
      // The agent died, its shell stays: the decider restarts it.
      r.s.upsert("observed_workers", { project: "fx", wt: String(b.wt) }, { state: "idle", walk: "none", presence: "none", account_at: r.now() + 1, observed_at: r.now() });
      for (let i = 0; i < 6 && live(r.contract, path)[0]?.t.id === first.id; i++) await r.tick();
      const after = live(r.contract, path);
      expect(after).toHaveLength(1);
      expect(after[0].t.id).not.toBe(first.id);
      expect(member(r.s, Number(b.id)).wt).toBe(`local::${path}`);
      expect(tree(r.s, path)).toMatchObject({ lease, gone_at: null });
      expect((await leased(r)).filter((x) => x.lease_holder === holderOf({ project: "fx", name: String(tree(r.s, path)!.name) }))).toHaveLength(1);
      expect(await leased(r)).toHaveLength(2);
      expect(r.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'worktree_created' AND payload LIKE ?").get(`%${path}%`)).toEqual({ n: 1 });
    }, LONG);

    test("a leftover pass closes a stray terminal and returns the slot's lease", async () => {
      const r = await rig();
      const { b, path, branch } = await startBuilder(r);
      r.s.upsert("members", { id: b.id }, { status: "gone", want: null });
      ended(r, b);
      r.queue.push({ project: "fx", squad: SQ, subject: String(b.wt), kind: "worktree.remove", episode: "leftover:1",
        payload: { topic: SQ, wt: String(b.wt), path, unit: "u1" } } as Action);
      for (let i = 0; i < 5 && tree(r.s, path)?.gone_at == null; i++) await r.tick();
      await returned(r, path, branch);
    }, LONG);

    test("the host tidy's scan lists no pool slot, leased or returned, though git lists each one", async () => {
      const r = await rig();
      const { b, path } = await startBuilder(r);
      r.s.want("member", String(b.id), "gone", { by: "test" });
      for (let i = 0; i < 5 && live(r.contract, path).length; i++) await r.tick();
      ended(r, b);
      for (let i = 0; i < 10 && tree(r.s, path)?.gone_at == null; i++) await r.tick();
      r.s.upsert("projects", { label: "fx" }, { home_repo: `path:${r.repo}` });
      const gitTrees = (await sh(r.repo, "worktree", "list", "--porcelain")).split("\n").filter((x) => x.startsWith("worktree ")).map((x) => x.slice(9));
      const pooled = gitTrees.filter((p) => p.startsWith(r.pools + "/"));
      expect(pooled.length).toBeGreaterThanOrEqual(2);   // the Lead's leased slot and the Builder's returned one
      const tmp = join(r.d, "claude-tmp"); mkdirSync(tmp);
      const scan = await scanCleanup(r.s, r.now(), { proc: fakeProc([]), uid: UID, tmpRoot: tmp, projects: () => ["fx"],
        ps: async () => [{ worktreeId: "demo::/nowhere", path: "/nowhere" }] });
      expect(scan.psError).toBeNull();
      expect(scan.rows.filter((x) => String(x.path ?? "").startsWith(r.pools + "/"))).toEqual([]);
    }, LONG);
  });
}
