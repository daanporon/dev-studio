// contract-observe.test.ts — orca-backend-alternatives U12: the loop decides for a squad off Orca from
// the contract observer (bin/loop/observers/contract.ts) and the finish rows (bin/loop/squad/finish-read.ts),
// never from Orca. A project holds the fixture's Orca squad `demo` and a squad on the contract fake
// (bin/loop/fakes/contract.ts) named for tmux; the Orca observer runs beside the contract one, on the
// fake Orca. The host's process walk is the test's: an agent runs in each fake terminal its launch
// line was typed into, until the test kills it (`kill`) or closes the terminal (`fake.exit`).
// Hermetic: a copy of the fixture state, a temp HOME, DS_WORKTREE_ROOT under the temp dir.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { fakeContract, type FakeContract } from "../../bin/loop/fakes/contract.ts";
import type { Capabilities } from "../../bin/backend/contract.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Reconciler, type TickCtx } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { view } from "../../bin/loop/squad/member-state.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { git } from "../../bin/loop/io/worktrees.ts";
import { contractObserver, readState } from "../../bin/loop/observers/contract.ts";
import { orcaObserver, wtPath, type LiveAccount } from "../../bin/loop/observers/orca.ts";
import { wake, type Wake } from "../../bin/loop/pause/wake.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const SQ = "ontmux";
const LONG = 60_000;   // each case runs tens of loop ticks
const ENV = ["DS_LOOP_RETRY_S", "DS_WORKTREE_ROOT", "DS_CLAUDE_SYSTEM_JSON_DIR", "DS_LOOP_LIVE_ACCOUNT_S"] as const;

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
async function rig(caps: Partial<Capabilities> = {}, o: { extra?: Reconciler[] } = {}) {
  const d = mkdtempSync(join(tmpdir(), "zzcontract-")); temps.push(d);
  const state = join(d, "state"), repo = join(d, "repo"), home = join(d, "home");
  cpSync(FIXTURE, state, { recursive: true });
  for (const x of [repo, home]) mkdirSync(x);
  for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    const g = await git(["-C", repo, ...a]);
    if (g.code !== 0) throw new Error(g.err);
  }
  writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ numStartups: 3 })}\n`);
  process.env.DS_LOOP_RETRY_S = "1";
  process.env.DS_WORKTREE_ROOT = join(d, "wts");
  process.env.DS_CLAUDE_SYSTEM_JSON_DIR = home;
  process.env.DS_LOOP_LIVE_ACCOUNT_S = "1";      // the walk every tick (ticks are 5 s apart)
  const s = open(state); stores.push(s);
  importJson(s);
  for (const [role, value] of [["lead", "claude sonnet always"], ["thinker", "claude opus ondemand"], ["builder", "claude opus ondemand"], ["tester", "claude opus ondemand"]] as const)
    s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
  const orca = new FakeOrca(), fake = fakeContract(caps, { name: "tmux", now: () => at });
  // The Orca observer reads the fake Orca host, which lists the fixture squad's worktrees and never ours.
  const demo = (s.db.query("SELECT wt FROM members WHERE project = 'fx' AND squad = 'demo' AND wt IS NOT NULL").all() as { wt: string }[]).map((x) => x.wt);
  let reads = 0;
  const seen = orca.observer(() => { reads++; return demo.map((wt) => ({ worktreeId: wt, path: wtPath(wt) ?? undefined })); }, () => []);
  // The host's agents: one in each terminal the launch line went into, until killed.
  const killed = new Set<string>(), pids = new Map<string, number>();
  let walks = 0;
  const walk = async (): Promise<LiveAccount[]> => {
    walks++;
    return [...fake.terms.values()].filter((x) => !killed.has(x.t.id) && x.lines.some((l) => l.includes("claude --")))
      .map((x) => {
        if (!pids.has(x.t.id)) pids.set(x.t.id, 4000 + pids.size);
        return { cwd: x.t.cwd, agent: "claude", account: "system", kind: "main", model: "opus", pid: pids.get(x.t.id), start: x.t.created_at };
      });
  };
  const backends = () => ({ backend: fake, caps: fake.caps });
  const act = new LoopActuator({ orca, pick: system, fulfillers: fulfillers.filter((f) => f.kinds), backends });
  const acted: Action[] = [];
  const actOne = act.act.bind(act);
  act.act = (a: Action, ctx: TickCtx) => { acted.push(a); return actOne(a, ctx); };
  const loop = new Loop(s, { observers: [contractObserver({ backends, walk }), orcaObserver(seen)],
    reconcilers: [decider, ...reconcilers, ...fulfillers, ...(o.extra ?? [])] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
  s.want("squad", `fx/${SQ}`, "running", { payload: { repo: `path:${repo}`, type: "feature" },
    fill: { repo: `path:${repo}`, type: "feature", backend: "tmux", worktree_provider: "git" }, by: "test" });
  return { s, orca, fake, act, loop, tick, now: () => at, d, repo, killed, acted, walks: () => walks, orcaReads: () => reads };
}

const members = (s: Store) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = ? AND COALESCE(status, '') != 'gone' ORDER BY id").all(SQ) as Row[];
const lead = (s: Store) => members(s).find((m) => m.role === "lead")!;
const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;
const pathOf = (m: Row) => String(m.wt).replace(/^local::/, "");
const creates = (f: FakeContract, cwd: string) => f.calls.filter((c) => c.op === "terminal.create" && (c.req as { cwd: string }).cwd === cwd);
const sends = (f: FakeContract, id: string) => f.calls.filter((c) => c.op === "terminal.send" && (c.req as { id: string }).id === id).map((c) => (c.req as { text: string }).text);
const live = (f: FakeContract, cwd: string) => [...f.terms.values()].filter((x) => x.t.cwd === cwd);
const worker = (s: Store, m: Row) => s.get("observed_workers", { project: "fx", wt: String(m.wt) });

function add(r: Rig, role: string, suffix: string): number {
  r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, observed_at, updated_at) VALUES ('fx', ?, ?, ?, 'claude', 'opus', 'system', ?, ?)", [SQ, role, suffix, T, T]);
  const id = Number((r.s.db.query("SELECT id FROM members WHERE squad = ? AND role = ? AND suffix = ?").get(SQ, role, suffix) as Row).id);
  r.s.want("member", String(id), "running", { payload: { prompt: `${role} ${suffix}` } });
  return id;
}
// Ticks until the member has a terminal and the walk sees its agent.
async function started(r: Rig, id: () => number | undefined): Promise<Row> {
  for (let i = 0; i < 12; i++) {
    const n = id(), m = n ? member(r.s, n) : null;
    if (m && String(m.wt ?? "").startsWith("local::") && worker(r.s, m)?.walk === "running") return m;
    await r.tick();
  }
  throw new Error("the member never started");
}
const startLead = (r: Rig) => started(r, () => Number(lead(r.s)?.id) || undefined);
async function startMember(r: Rig, role: string, suffix: string): Promise<Row> {
  const id = add(r, role, suffix);
  return started(r, () => id);
}
function unit(r: Rig, b: Row, slug: string, status: string, pr: number | null = null) {
  r.s.db.run("INSERT INTO units (project, squad, slug, status, builder_wt, pr, deps, ext_deps, observed_at, updated_at) VALUES ('fx', ?, ?, ?, ?, ?, '[]', '[]', ?, ?)",
    [SQ, slug, status, String(b.wt), pr == null ? null : String(pr), T, T]);
}
let keys = 0;
function finish(r: Rig, m: Row, outcome: "ok" | "failed" | "no-pr" | "verdict", at = r.now(), body = `${outcome} body`) {
  const fresh = member(r.s, Number(m.id));
  expect(fresh.gen).toBeTruthy();
  const name = `fx/${SQ}/${fresh.role}${fresh.suffix ? `-${fresh.suffix}` : ""}`;
  r.s.db.run("INSERT INTO finishes (key, project, squad, member, wt, unit, gen, outcome, body, at) VALUES (?, 'fx', ?, ?, ?, ?, ?, ?, ?, ?)",
    [`k${++keys}`, SQ, name, pathOf(fresh), String(fresh.suffix ?? ""), String(fresh.gen), outcome, body, at]);
}
const term = (r: Rig, m: Row) => live(r.fake, pathOf(m))[0]!;

describe("readState: what the loop reads for a terminal on a backend with no native state", () => {
  const base = { native: null, out: null, transcript: null, tail: "❯ ", walk: "running", now: 100, quiet: 10 };
  test("no agent process reads idle whatever the backend says; else a native answer wins", () => {
    expect(readState({ ...base, walk: "none", out: 99, native: "working" })).toBe("idle");
    expect(readState({ ...base, native: "waiting" })).toBe("waiting");
    expect(readState({ ...base, walk: "unknown", native: "working" })).toBe("working");
  });
  test("output or the transcript within chat_quiet_s, or esc to interrupt, reads working", () => {
    expect(readState({ ...base, out: 95 })).toBe("working");
    expect(readState({ ...base, transcript: 95 })).toBe("working");
    expect(readState({ ...base, tail: "✻ Thinking… (esc to interrupt)\n❯ " })).toBe("working");
  });
  test("quiet with an empty prompt and a live agent reads idle; a draft or no prompt is unknown", () => {
    expect(readState({ ...base, out: 80 })).toBe("idle");
    expect(readState({ ...base, tail: "❯ half a line" })).toBe("unknown");
    expect(readState({ ...base, tail: "$ " })).toBe("unknown");
    expect(readState({ ...base, walk: "unknown" })).toBe("unknown");
  });
});

describe("the loop decides for a squad off Orca (U12)", () => {
  test("a crashed member with no finish row is restarted", async () => {
    const r = await rig();
    await startLead(r);
    const b = await startMember(r, "builder", "u1"), bp = pathOf(b);
    unit(r, b, "u1", "dispatched");
    r.fake.exit(term(r, b).t.id);                 // the terminal and its agent are gone
    await r.tick();
    expect(worker(r.s, b)).toMatchObject({ presence: "none" });
    expect(worker(r.s, b)?.gone_at).not.toBeNull();
    for (let i = 0; i < 6 && live(r.fake, bp).length === 0; i++) await r.tick();
    expect(creates(r.fake, bp)).toHaveLength(2);
    expect(live(r.fake, bp)).toHaveLength(1);
  }, LONG);

  test("killing the agent while its shell stays reads crashed: the decider restarts it in a new terminal", async () => {
    const r = await rig();
    const l = await startLead(r), lp = pathOf(l), first = term(r, l).t.id;
    r.killed.add(first);                          // claude died; the tmux window and its shell are still there
    await r.tick();
    expect(worker(r.s, l)).toMatchObject({ walk: "none", presence: "none", state: "idle" });
    expect(JSON.parse(String(r.s.get("observed_worktrees", { project: "fx", wt: String(l.wt) })?.doc))).toMatchObject({ agents: 0 });
    for (let i = 0; i < 6 && creates(r.fake, lp).length < 2; i++) await r.tick();
    expect(creates(r.fake, lp)).toHaveLength(2);
    const t = live(r.fake, lp);
    expect(t).toHaveLength(1);                    // the old shell's terminal was closed first
    expect(t[0].t.id).not.toBe(first);
  }, LONG);

  test("a Builder that crashes after its finish row while its unit is open is restarted", async () => {
    const r = await rig();
    await startLead(r);
    const b = await startMember(r, "builder", "u2"), bp = pathOf(b);
    unit(r, b, "u2", "dispatched");
    finish(r, b, "ok");
    r.fake.exit(term(r, b).t.id);
    for (let i = 0; i < 8 && creates(r.fake, bp).length < 2; i++) await r.tick();
    expect(creates(r.fake, bp)).toHaveLength(2);
  }, LONG);

  test("a finished Builder is retired once its unit is done", async () => {
    const r = await rig();
    await startLead(r);
    const b = await startMember(r, "builder", "u3"), bp = pathOf(b);
    unit(r, b, "u3", "done", 31);
    r.s.upsert("observed_prs", { project: "fx", ref: `${SQ}/u3` }, { pr: 31, state: "MERGED", observed_at: r.now() });
    // Its output still moves (a tmux pane reads working): the finish row says its work ended.
    term(r, b).last = r.now() + 5;
    await r.tick(2);
    expect(member(r.s, Number(b.id)).want).not.toBe("gone");
    finish(r, b, "ok");
    for (let i = 0; i < 8 && live(r.fake, bp).length > 0; i++) { term(r, b) && (term(r, b).last = r.now() + 5); await r.tick(); }
    expect(member(r.s, Number(b.id)).want).toBe("gone");
    expect(live(r.fake, bp)).toHaveLength(0);
    expect(creates(r.fake, bp)).toHaveLength(1);
  }, LONG);

  test("a Tester that finished and exited is not started again and is retired", async () => {
    const r = await rig();
    await startLead(r);
    const t = await startMember(r, "tester", "t1"), tp = pathOf(t);
    finish(r, t, "verdict");
    expect(view(r.s, member(r.s, Number(t.id)))).toBe("stopped");
    r.killed.add(term(r, t).t.id);                // its agent exits; the shell stays
    await r.tick(8);
    expect(creates(r.fake, tp)).toHaveLength(1);
    expect(member(r.s, Number(t.id)).want).toBe("gone");
    const ev = r.s.db.query("SELECT * FROM events WHERE kind = 'tester_pass_done' AND project = 'fx' AND squad = ?").all(SQ) as Row[];
    expect(ev).toHaveLength(1);
    expect(ev[0].member).toBe(String(t.wt));
  }, LONG);

  test("the Lead hears once of each failed and no-PR finish", async () => {
    const r = await rig();
    await startLead(r);
    const a = await startMember(r, "builder", "u4"), b = await startMember(r, "builder", "u5");
    unit(r, a, "u4", "dispatched");
    unit(r, b, "u5", "dispatched");
    finish(r, a, "failed", r.now() - 200, "tests red\nsee the log");
    finish(r, b, "no-pr", r.now() - 200, "nothing to change");
    await r.tick(4);
    const reqs = (slug: string) => r.acted.filter((x) => x.kind === "request.file" && String(x.episode).startsWith(`failed|${slug}|gen:`));
    expect(reqs("u4")).toHaveLength(1);
    expect(reqs("u5")).toHaveLength(1);
    const [fa, fb] = [String((reqs("u4")[0].payload as Row).text), String((reqs("u5")[0].payload as Row).text)];
    expect((reqs("u4")[0].payload as Row).target).toBe(SQ);
    expect(fa).toStartWith("failed report:");
    expect(fa).toContain("ds finish");
    expect(fa).toContain("tests red / see the log");
    expect(fb).toStartWith("report with no PR:");
  }, LONG);

  test("wake() pokes an idle member on a backend with no native state", async () => {
    let ask = "", got: Wake | null = null;
    const waker: Reconciler = { name: "waker", run: (ctx) => {
      if (!ask) return [];
      got = wake(ctx, ask, "check your inbox, from the test", "test", "w1");
      ask = "";
      return got.actions;
    } };
    const r = await rig({ state: "none" }, { extra: [waker] });
    const l = await startLead(r);
    // Claude draws its prompt: the output moved, so it reads working until chat_quiet_s (10 s) passes.
    const t = term(r, l);
    t.lines.push("╭────╮", "│ ❯  │", "╰────╯");
    t.last = r.now();
    await r.tick();
    expect(worker(r.s, l)?.state).toBe("working");
    await r.tick(2);
    expect(worker(r.s, l)?.state).toBe("idle");
    expect(r.fake.calls.some((c) => c.op === "agent.state")).toBe(false);
    ask = String(l.wt);
    await r.tick(2);
    expect(got!.status).toBe("sent");
    expect(sends(r.fake, term(r, l).t.id)).toContain("check your inbox, from the test");
  }, LONG);

  test("a mixed project over ten ticks: the Orca observer marks no member off Orca gone, and nothing restarts it", async () => {
    const r = await rig();
    const l = await startLead(r), b = await startMember(r, "builder", "u6");
    unit(r, b, "u6", "dispatched");
    const ps = r.orcaReads();
    await r.tick(10);
    expect(r.orcaReads()).toBeGreaterThan(ps);       // the Orca observer did run
    for (const m of [l, b]) {
      expect(creates(r.fake, pathOf(m))).toHaveLength(1);
      expect(worker(r.s, m)?.gone_at ?? null).toBeNull();
      expect(r.s.get("observed_worktrees", { project: "fx", wt: String(m.wt) })?.gone_at ?? null).toBeNull();
      const terms = r.s.db.query("SELECT gone_at FROM observed_terminals WHERE project = 'fx' AND wt = ?").all(String(m.wt)) as Row[];
      expect(terms.length).toBe(1);
      expect(terms[0].gone_at).toBeNull();
    }
    expect(r.walks()).toBeGreaterThanOrEqual(10);
  }, LONG);
});
