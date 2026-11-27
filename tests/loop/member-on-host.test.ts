// member-on-host.test.ts — side-loop-host U10: a member whose row names a side host runs there. The loop clones
// the project on that host through a host job when it has no clone, makes the worktree there (worktree.add), makes
// the terminal there over the link (the remote adapter, here a fake) with DS_MEMBER, DS_GEN and DS_WT, records the
// member as `<host>::<path>`, and stops, archives and removes it there. A side member of a squad on Orca is the
// same: no Orca call is about it and the Orca observer never reads or marks it gone. The side's `contract` channel
// adds DS_MAIN_URL and trusts the folder for the side's login; `ds request --host` (add-role --host) forces a host.
// Hermetic: a copy of the fixture state, fakes for the side's backend and its host jobs, no link.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { fakeContract, type FakeContract } from "../../bin/loop/fakes/contract.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { contractObserver } from "../../bin/loop/observers/contract.ts";
import { orcaObserver } from "../../bin/loop/observers/orca.ts";
import { git } from "../../bin/loop/io/worktrees.ts";
import { offOrca, wtHost } from "../../bin/loop/squad/backend.ts";
import { sideCreate } from "../../bin/link/channels/contract.ts";
import { mainUrlFor } from "../../bin/link/relay.ts";
import { runHere, type HostJob, type Send } from "../../bin/link/host-jobs.ts";
import { launchDir } from "../../bin/loop/squad/launch-file.ts";
import { studioOn } from "./studio-on.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const HOST = "side-a";
const SIDE_REPO = "/side/dev-studio-repos/fx", SIDE_WTS = "/side/wts";
const ENV = ["DS_LOOP_RETRY_S", "DS_WORKTREE_ROOT", "DS_CLAUDE_SYSTEM_JSON_DIR", "DS_TOKEN_CACHE", "DS_STATE_ROOT", "DS_LIMIT_LINK_LISTEN"] as const;

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

type Rig = Awaited<ReturnType<typeof rig>>;
// `backend`: the squad's backend on main (tmux, or orca: the side runs tmux for it).
async function rig(backend: "tmux" | "orca", o: { cloned?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "zzonhost-")); temps.push(d);
  const state = join(d, "state"), repo = join(d, "repo"), home = join(d, "home");
  cpSync(FIXTURE, state, { recursive: true });
  for (const x of [repo, home]) mkdirSync(x);
  for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"],
    ["remote", "add", "origin", "https://example.com/fx.git"]]) {
    const g = await git(["-C", repo, ...a]);
    if (g.code !== 0) throw new Error(g.err);
  }
  writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ numStartups: 3 })}\n`);
  process.env.DS_LOOP_RETRY_S = "1";
  process.env.DS_WORKTREE_ROOT = join(d, "wts");
  process.env.DS_CLAUDE_SYSTEM_JSON_DIR = home;
  process.env.DS_TOKEN_CACHE = "0";
  process.env.DS_LIMIT_LINK_LISTEN = "off";   // the hosts row would otherwise start a real link server
  const s = open(state); stores.push(s);
  importJson(s);
  for (const [role, value] of [["lead", "claude sonnet always"], ["builder", "claude opus ondemand"]] as const)
    s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
  s.db.run("INSERT INTO hosts (name, status, public_key, fingerprint, seats, requested_at, accepted_at) VALUES (?, 'accepted', 'a2V5', 'aaaa', 2, ?, ?)", [HOST, T, T]);
  const orca = new FakeOrca();
  const local = fakeContract({}, { name: "tmux", now: () => at }), side = fakeContract({}, { name: "tmux", now: () => at });
  const remotes: string[] = [];
  // The side's host jobs: a clone (adopted when `cloned` is false), a worktree made under SIDE_WTS, a clean probe,
  // nothing to rescue, a removal.
  const jobs: HostJob[] = [];
  const send: Send = async (host, body) => {
    expect(host).toBe(HOST);
    jobs.push(body);
    if (body.job === "clone") return { path: SIDE_REPO, cloned: o.cloned ?? true };
    if (body.job === "worktree.add") return { path: `${SIDE_WTS}/${body.spec.name}`, repo: body.spec.repo, branch: body.spec.branch, adopted: false };
    if (body.job === "probe") return { code: 0, out: "", err: "" };
    if (body.job === "rescue") return { listed: true, capped: 0, files: [], kept_dest: null, kept: [] };
    if (body.job === "worktree.remove") return { removed: true, already: false, branch: "kept" };
    if (body.job === "launch.write") return runHere(body, { root: join(d, "side-state") });   // the side's own code and state root
    throw new Error(`no fake for ${body.job}`);
  };
  const act = new LoopActuator({ orca, pick: system, fulfillers: fulfillers.filter((f) => f.kinds), jobs: send,
    backends: () => ({ backend: local, caps: local.caps }),
    remote: (host, name) => { remotes.push(`${name}@${host}`); return side; } });
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
  s.upsert("projects", { label: "fx" }, { doc: JSON.stringify({ ...JSON.parse(String(s.get("projects", { label: "fx" })?.doc ?? "{}")), studio_backend: "tmux" }), observed_at: T });
  studioOn(s, "fx", "tmux", T);
  const sq = `on${backend}`;
  s.want("squad", `fx/${sq}`, "running", { payload: { repo: `path:${repo}`, type: "feature" },
    fill: { repo: `path:${repo}`, type: "feature", backend, worktree_provider: "git" }, by: "test" });
  return { s, orca, local, side, act, tick, now: () => at, d, repo, home, jobs, remotes, sq };
}

const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;
const creates = (f: FakeContract) => f.calls.filter((c) => c.op === "terminal.create").map((c) => c.req as { cwd: string; label: string; env: Record<string, string> });
function builder(r: Rig, suffix: string): number {
  r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, host, observed_at, updated_at) VALUES ('fx', ?, 'builder', ?, 'claude', 'opus', 'system', ?, ?, ?)",
    [r.sq, suffix, HOST, T, T]);
  const id = Number((r.s.db.query("SELECT id FROM members WHERE squad = ? AND suffix = ?").get(r.sq, suffix) as Row).id);
  r.s.want("member", String(id), "running", { payload: { prompt: `build ${suffix}` } });
  return id;
}
async function startOnSide(r: Rig, suffix = "u1"): Promise<Row> {
  const id = builder(r, suffix);
  for (let i = 0; i < 10 && !String(member(r.s, id).wt ?? "").startsWith(`${HOST}::`); i++) await r.tick();
  const m = member(r.s, id);
  expect(String(m.wt)).toStartWith(`${HOST}::`);
  // The side's contract observer's row, as the link replicates it (link/replica.ts): the member reads running.
  r.s.upsert("observed_workers", { project: "fx", wt: String(m.wt) }, { state: "idle", walk: "running", presence: "running", observed_at: r.now(), host: HOST });
  return m;
}
const orcaAbout = (r: Rig, needle: string) => r.orca.calls.filter((c) => JSON.stringify(c.args).includes(needle) || JSON.stringify(c.via?.env ?? {}).includes(needle));

for (const backend of ["tmux", "orca"] as const) {
  describe(`a builder on side host ${HOST} (squad on ${backend})`, () => {
    test("starts there: a clone, a worktree and a terminal on that host, a <host>::<path> id, no Orca call", async () => {
      const r = await rig(backend);
      const m = await startOnSide(r);
      const path = `${SIDE_WTS}/${String(m.wt).split("/").at(-1)}`;
      expect(String(m.wt)).toBe(`${HOST}::${path}`);
      expect(r.jobs.map((j) => j.job).slice(0, 2)).toEqual(["clone", "worktree.add"]);
      expect(r.jobs[0]).toMatchObject({ job: "clone", project: "fx", url: "https://example.com/fx.git" });
      expect(r.jobs[1]).toMatchObject({ job: "worktree.add", provider: "git", spec: { repo: SIDE_REPO, base: "HEAD", parent: null, squad: r.sq, role: "builder" } });
      // Main records the side's worktree under that host.
      expect(r.s.get("worktrees", { host: HOST, path })).toMatchObject({ project: "fx", squad: r.sq, provider: "git", repo: SIDE_REPO });
      expect(r.s.get("worktrees", { host: "local", path })).toBeNull();
      // The terminal is the side's (tmux there, even for a squad on Orca), never main's.
      expect(r.remotes.every((x) => x === `tmux@${HOST}`)).toBe(true);
      const made = creates(r.side);
      expect(made.length).toBe(1);
      expect(made[0]!.cwd).toBe(path);
      expect(made[0]!.env).toMatchObject({ DS_MEMBER: `fx/${r.sq}/builder-u1`, DS_WT: path, DS_BACKEND: "tmux" });
      expect(made[0]!.env.DS_GEN).toBeTruthy();
      expect(creates(r.local).some((c) => c.cwd === path)).toBe(false);
      // Main's own login is left alone: the side trusts the folder for its login (sideCreate below).
      expect(JSON.parse(readFileSync(join(r.home, ".claude.json"), "utf8")).projects?.[path]).toBeUndefined();
      expect(orcaAbout(r, path)).toEqual([]);
      expect(orcaAbout(r, `/${r.sq}/builder/`)).toEqual([]);
      expect(wtHost(r.s, String(m.wt))).toBe(HOST);
      // The launch file is the side's: written under its state root by a host job, and that is the path typed there.
      const sideLaunch = launchDir(join(r.d, "side-state"), "fx", path);
      expect(r.jobs.filter((j) => j.job === "launch.write").length).toBe(1);
      const typed = r.side.calls.find((c) => c.op === "terminal.send")?.req as { text: string };
      expect(typed.text).toStartWith(`exec bash '${sideLaunch}/`);
      expect(readdirSync(sideLaunch).length).toBe(1);
      expect(existsSync(launchDir(r.s.root, "fx", path))).toBe(false);
    });

    test("stops there: the side's terminal is closed, main's are untouched", async () => {
      const r = await rig(backend);
      const m = await startOnSide(r);
      const path = String(m.wt).slice(HOST.length + 2);
      r.s.want("member", String(m.id), "stopped", { by: "test" });
      for (let i = 0; i < 6 && [...r.side.terms.values()].some((x) => x.t.cwd === path); i++) await r.tick();
      expect([...r.side.terms.values()].some((x) => x.t.cwd === path)).toBe(false);
      expect(r.side.calls.some((c) => c.op === "terminal.close")).toBe(true);
      expect(r.local.calls.some((c) => c.op === "terminal.close")).toBe(false);
      expect(orcaAbout(r, path)).toEqual([]);
    });

    test("is closed and removed there: probe, rescue and removal are host jobs", async () => {
      const r = await rig(backend);
      const m = await startOnSide(r);
      const path = String(m.wt).slice(HOST.length + 2);
      r.s.want("member", String(m.id), "gone", { by: "test" });
      for (let i = 0; i < 6 && [...r.side.terms.values()].some((x) => x.t.cwd === path); i++) await r.tick();
      // The side's observer saw its agent end (replicated up the link).
      r.s.upsert("observed_workers", { project: "fx", wt: String(m.wt) }, { state: "idle", presence: "none", gone_at: r.now(), observed_at: r.now(), host: HOST });
      for (let i = 0; i < 12 && r.s.get("worktrees", { host: HOST, path })?.gone_at == null; i++) await r.tick();
      const names = r.jobs.map((j) => j.job);
      expect(names).toContain("probe");
      expect(names).toContain("worktree.remove");
      expect(r.jobs.find((j) => j.job === "worktree.remove")).toMatchObject({ path });
      expect(r.s.get("worktrees", { host: HOST, path })?.gone_at).not.toBeNull();
      expect([...r.side.terms.values()].some((x) => x.t.cwd === path)).toBe(false);
      expect(member(r.s, Number(m.id)).status).toBe("gone");
      expect(orcaAbout(r, path)).toEqual([]);
    });
  });
}

describe("side members and Orca", () => {
  test("offOrca counts a side member of a squad on Orca; its folder is not an Orca path", async () => {
    const r = await rig("orca");
    const m = await startOnSide(r);
    const off = offOrca(r.s, "fx");
    expect(off.wts.has(String(m.wt))).toBe(true);
    expect(off.paths.has(String(m.wt).slice(HOST.length + 2))).toBe(false);
  });

  test("the Orca observer never reads it or marks it gone, even when Orca's directory names it", async () => {
    const r = await rig("orca");
    const m = await startOnSide(r);
    const wt = String(m.wt), path = wt.slice(HOST.length + 2);
    const ps = () => [], dir = () => [{ squad: r.sq, role: "builder", suffix: "u1", wt, live: false }];
    const loop = new Loop(r.s, { observers: [orcaObserver(r.orca.observer(ps, dir))], reconcilers: [] }, { act() {} }, { projects: () => ["fx"] });
    loop.boot(r.now());
    await loop.tick(r.now() + 5);
    expect(r.s.db.query("SELECT gone_at, host FROM observed_workers WHERE project = 'fx' AND wt = ?").get(wt)).toMatchObject({ gone_at: null, host: HOST });
    expect(orcaAbout(r, path)).toEqual([]);
  });

  test("the side reads it on its own backend: its contract observer covers a squad on Orca there, not on main", async () => {
    for (const role of ["side", "main"] as const) {
      const d = mkdtempSync(join(tmpdir(), "zzsideobs-")); temps.push(d);
      const s = open(join(d, "state")); stores.push(s);
      const wt = join(d, "wt"); mkdirSync(wt);
      // The side's down copy (link/replica.ts): the squad row as main has it, the member as host local.
      s.upsert("squads", { project: "fx", topic: "sq" }, { status: "running", backend: "orca", doc: "{}", updated_at: T, observed_at: T });
      s.db.run("INSERT INTO members (project, squad, role, suffix, wt, gen, status, host, updated_at, observed_at) VALUES ('fx', 'sq', 'builder', 'u1', ?, 'g1', 'running', 'local', ?, ?)", [`local::${wt}`, T, T]);
      const tmux = fakeContract({}, { name: "tmux", now: () => T });
      await tmux.call("terminal.create", { cwd: wt, label: "builder-u1", env: { DS_GEN: "g1" } });
      const asked: string[] = [];
      const backends = (name: string) => { asked.push(name); return { backend: tmux, caps: tmux.caps }; };
      const walk = async () => [{ cwd: wt, agent: "claude", account: "system", kind: "main", model: "opus", pid: 4000, start: T }];
      const loop = new Loop(s, { observers: [contractObserver({ backends, walk: walk as never })], reconcilers: [] }, { act() {} }, { projects: () => ["fx"], ...(role === "side" ? { role } : {}) });
      loop.boot(T);
      await loop.tick(T + 5);
      const row = s.db.query("SELECT walk FROM observed_workers WHERE project = 'fx' AND wt = ?").get(`local::${wt}`) as Row | null;
      if (role === "side") { expect(asked).toEqual(["tmux"]); expect(row?.walk).toBe("running"); }
      else { expect(asked).toEqual([]); expect(row).toBeNull(); }
    }
  });

  test("a host the project has no clone of is cloned once; an existing clone is adopted", async () => {
    const r = await rig("tmux", { cloned: false });
    await startOnSide(r, "u1");
    await startOnSide(r, "u2");
    expect(r.jobs.filter((j) => j.job === "clone").length).toBe(2);   // each start asks; the side adopts its clone
    expect(r.jobs.filter((j) => j.job === "worktree.add").every((j) => j.job === "worktree.add" && j.spec.repo === SIDE_REPO)).toBe(true);
  });
});

describe("the side's contract channel (sideCreate)", () => {
  test("a member's terminal.create gets DS_MAIN_URL and its folder trusted for the side's login", () => {
    const d = mkdtempSync(join(tmpdir(), "zzsidecreate-")); temps.push(d);
    writeFileSync(join(d, ".claude.json"), `${JSON.stringify({ numStartups: 1 })}\n`);
    const env = { DS_CLAUDE_SYSTEM_JSON_DIR: d };
    const got = sideCreate({ op: "terminal.create", req: { cwd: "/side/wts/u1", label: "builder-u1", env: { DS_MEMBER: "fx/sq/builder/u1", DS_MAIN_URL: "unix:/elsewhere" } } }, "/side/state", env);
    expect((got.req as { env: Record<string, string> }).env).toEqual({ DS_MEMBER: "fx/sq/builder/u1", DS_MAIN_URL: mainUrlFor("/side/state") });
    expect(JSON.parse(readFileSync(join(d, ".claude.json"), "utf8")).projects["/side/wts/u1"].hasTrustDialogAccepted).toBe(true);
  });

  test("another op, or a terminal that is no member's, is not trusted; other ops pass as is", () => {
    const d = mkdtempSync(join(tmpdir(), "zzsidecreate-")); temps.push(d);
    writeFileSync(join(d, ".claude.json"), `${JSON.stringify({ numStartups: 1 })}\n`);
    const env = { DS_CLAUDE_SYSTEM_JSON_DIR: d };
    const list = { op: "terminal.list", req: {} };
    expect(sideCreate(list, "/side/state", env)).toBe(list);
    const plain = sideCreate({ op: "terminal.create", req: { cwd: "/side/x", label: "x" } }, "/side/state", env);
    expect((plain.req as { env: Record<string, string> }).env.DS_MAIN_URL).toBe(mainUrlFor("/side/state"));
    expect(JSON.parse(readFileSync(join(d, ".claude.json"), "utf8")).projects).toBeUndefined();
  });
});

describe("ds request --host (add-role --host)", () => {
  test("forces the member's host; an unknown host is refused", async () => {
    const r = await rig("tmux");
    process.env.DS_STATE_ROOT = r.s.root;
    const { run } = await import("../../bin/commands/request.ts");
    const quiet = { log: console.log, error: console.error };
    console.log = () => {}; console.error = () => {};
    let ok: number, bad: number;
    try {
      ok = await run(["tester", "--suffix", "t1", "--squad", `fx/${r.sq}`, "--host", HOST, "--by", "test"]);
      bad = await run(["tester", "--suffix", "t2", "--squad", `fx/${r.sq}`, "--host", "nowhere", "--by", "test"]);
    } finally { console.log = quiet.log; console.error = quiet.error; }
    expect(ok).toBe(0);
    expect(bad).toBe(1);
    const rows = r.s.db.query("SELECT suffix, host FROM members WHERE squad = ? AND role = 'tester' ORDER BY id").all(r.sq) as Row[];
    expect(rows).toEqual([{ suffix: "t1", host: HOST }]);
  });
});
