// contract-squad.test.ts — orca-backend-alternatives U11: a squad whose backend is not `orca` is run
// through the contract (bin/backend/contract.ts) on its fake (bin/loop/fakes/contract.ts): the loop
// starts its Lead and a Builder in worktrees its provider (git, a temp repo) makes, types the Claude
// launch line, delivers a poke, restarts and stops a member, all as orca_calls rows (op = the contract
// verb) the member lock reads, and makes no Orca call for it. Hermetic: a copy of the fixture state, a
// temp HOME whose .claude.json the folder trust is written to, DS_WORKTREE_ROOT under the temp dir.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, memberOf, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { lock } from "../../bin/loop/squad/member-state.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { fakeContract, type FakeContract } from "../../bin/loop/fakes/contract.ts";
import type { Capabilities, Op } from "../../bin/backend/contract.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { git } from "../../bin/loop/io/worktrees.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const SQ = "ontmux";
const ENV = ["DS_LOOP_RETRY_S", "DS_WORKTREE_ROOT", "DS_CLAUDE_SYSTEM_JSON_DIR"] as const;

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
  const s = open(state); stores.push(s);
  importJson(s);
  for (const [role, value] of [["lead", "claude sonnet always"], ["thinker", "claude opus ondemand"], ["builder", "claude opus ondemand"]] as const)
    s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
  const orca = new FakeOrca(), fake = fakeContract(caps, { name: "tmux", now: () => at });
  // The folder trust as it stood when each terminal was made: it must be written before the first start.
  const trustAtCreate: Record<string, boolean> = {};
  const call = fake.call.bind(fake);
  fake.call = (async (op: Op, req: unknown) => {
    if (op === "terminal.create") {
      const cwd = (req as { cwd: string }).cwd;
      trustAtCreate[cwd] = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects?.[cwd]?.hasTrustDialogAccepted === true;
    }
    return call(op, req as never);
  }) as FakeContract["call"];
  const made: string[] = [];
  const act = new LoopActuator({ orca, pick: system, fulfillers: fulfillers.filter((f) => f.kinds),
    backends: (name) => { made.push(name); return { backend: fake, caps: fake.caps }; } });
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers, ...(o.extra ?? [])] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
  s.want("squad", `fx/${SQ}`, "running", { payload: { repo: `path:${repo}`, type: "feature" },
    fill: { repo: `path:${repo}`, type: "feature", backend: "tmux", worktree_provider: "git" }, by: "test" });
  return { s, orca, fake, act, loop, tick, now: () => at, d, repo, home, trustAtCreate, made };
}

const members = (s: Store) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = ? AND COALESCE(status, '') != 'gone' ORDER BY id").all(SQ) as Row[];
const lead = (s: Store) => members(s).find((m) => m.role === "lead")!;
const pathOf = (m: Row) => String(m.wt).replace(/^local::/, "");
const creates = (f: FakeContract) => f.calls.filter((c) => c.op === "terminal.create").map((c) => c.req as { cwd: string; label: string; group?: string; parent?: string; env: Record<string, string> });
const sends = (f: FakeContract) => f.calls.filter((c) => c.op === "terminal.send").map((c) => c.req as { id: string; text: string; submit?: boolean });
const live = (f: FakeContract, cwd: string) => [...f.terms.values()].filter((x) => x.t.cwd === cwd);
// No Orca call of any kind is about this squad (the fixture's own `demo` squad is on Orca).
const orcaFor = (r: Rig) => r.orca.calls.filter((c) => [SQ, join(r.d, "wts"), r.repo].some((x) => JSON.stringify(c.args).includes(x)) || c.via?.env?.DS_START_MEMBER?.includes(`/${SQ}/`));
// The observer U12 adds: a started member reads running, so the decider leaves it be.
const running = (r: Rig, m: Row) => r.s.upsert("observed_workers", { project: "fx", wt: String(m.wt) }, { state: "idle", presence: "running", observed_at: r.now() });
function builder(r: Rig, suffix: string): number {
  r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, observed_at, updated_at) VALUES ('fx', ?, 'builder', ?, 'claude', 'opus', 'system', ?, ?)", [SQ, suffix, T, T]);
  const id = Number((r.s.db.query("SELECT id FROM members WHERE squad = ? AND suffix = ?").get(SQ, suffix) as Row).id);
  r.s.want("member", String(id), "running", { payload: { prompt: `build ${suffix}` } });
  return id;
}
const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;
async function startLead(r: Rig): Promise<Row> {
  for (let i = 0; i < 10 && !String(lead(r.s)?.wt ?? "").startsWith("local::"); i++) await r.tick();
  const l = lead(r.s);
  expect(String(l.wt)).toStartWith("local::");
  running(r, l);
  return l;
}
async function startBuilder(r: Rig, suffix = "u1"): Promise<Row> {
  const id = builder(r, suffix);
  for (let i = 0; i < 10 && !String(member(r.s, id).wt ?? "").startsWith("local::"); i++) await r.tick();
  const b = member(r.s, id);
  expect(String(b.wt)).toStartWith("local::");
  running(r, b);
  return b;
}

describe("a squad on a contract backend (U11)", () => {
  for (const parents of ["native", "groups", "none"] as const) {
    test(`parents ${parents}: the Lead and a Builder start in provider worktrees, nested as the backend can, with no Orca call`, async () => {
      const r = await rig({ parents });
      const l = await startLead(r), b = await startBuilder(r);
      const lp = pathOf(l), bp = pathOf(b);
      expect(lp).toStartWith(join(r.d, "wts"));
      expect(bp).toStartWith(join(r.d, "wts"));
      // The provider made and recorded both worktrees, the Builder's under the Lead's.
      expect(r.s.get("worktrees", { host: "local", path: bp })?.parent_path ?? null).toBe(lp);
      const [cl, cb] = [creates(r.fake).find((c) => c.cwd === lp)!, creates(r.fake).find((c) => c.cwd === bp)!];
      expect(cl.label).toBe("lead");
      expect(cb.label).toBe("builder-u1");
      if (parents === "native") { expect(cb.parent).toBe(lp); expect(cb.group).toBeUndefined(); }
      if (parents === "groups") { expect(cb.group).toBe(SQ); expect(cb.parent).toBeUndefined(); }
      if (parents === "none") { expect(cb.group).toBeUndefined(); expect(cb.parent).toBeUndefined(); }
      // The terminal's env carries the member's identity, the backend and the start's generation: the
      // orca_calls row's retry id, the op its contract verb.
      const row = r.s.db.query("SELECT * FROM orca_calls WHERE op = 'terminal.create' AND payload LIKE ? ORDER BY id DESC").get(`%${bp}%`) as Row;
      expect(row.state).toBe("completed");
      expect(cb.env).toMatchObject({ DS_BACKEND: "tmux", DS_WT: bp, DS_GEN: String(row.retry_id) });
      expect(cb.env.DS_MEMBER).toContain(`${SQ}/builder-u1`);
      // The launch line is typed once in its terminal: the system login, the model, the brief.
      const t = live(r.fake, bp);
      expect(t).toHaveLength(1);
      const typed = sends(r.fake).filter((x) => x.id === t[0].t.id);
      expect(typed).toHaveLength(1);
      expect(typed[0].submit).toBe(true);
      expect(typed[0].text).toStartWith("env -u CLAUDE_CONFIG_DIR ");
      expect(typed[0].text).toContain("claude --dangerously-skip-permissions --model opus");
      expect(typed[0].text).toContain("build\\ u1");
      // The folder was trusted in the account's .claude.json before the terminal was made; other keys kept.
      expect(r.trustAtCreate[lp]).toBe(true);
      expect(r.trustAtCreate[bp]).toBe(true);
      expect(JSON.parse(readFileSync(join(r.home, ".claude.json"), "utf8")).numStartups).toBe(3);
      // No Run, no task, no coordinator, no Orca call for this squad; the fake was asked for by name.
      expect(r.s.db.query("SELECT run_id FROM squads WHERE project = 'fx' AND topic = ?").get(SQ)).toEqual({ run_id: null });
      expect(orcaFor(r)).toEqual([]);
      expect(new Set(r.made)).toEqual(new Set(["tmux"]));
    });
  }

  test("a start whose answer was lost is matched on its generation: one terminal, the line typed once", async () => {
    const r = await rig();
    const l = await startLead(r);
    const call = r.fake.call.bind(r.fake);
    let lost = 0;
    r.fake.call = (async (op: Op, req: unknown) => {
      const a = await call(op, req as never);
      if (op === "terminal.create" && lost++ === 0) throw new Error("socket closed");   // made, the answer lost
      return a;
    }) as FakeContract["call"];
    const id = builder(r, "u2");
    await r.tick(4);
    const b = member(r.s, id);
    expect(String(b.wt)).toStartWith("local::");
    const bp = pathOf(b), rows = r.s.db.query("SELECT * FROM orca_calls WHERE op = 'terminal.create' AND payload LIKE ?").all(`%${bp}%`) as Row[];
    expect(rows).toHaveLength(1);                 // one row, its id kept across the retry
    expect(rows[0].state).toBe("completed");
    expect(creates(r.fake).filter((c) => c.cwd === bp)).toHaveLength(1);
    const t = live(r.fake, bp);
    expect(t).toHaveLength(1);
    expect(t[0].t.gen).toBe(String(rows[0].retry_id));
    expect(sends(r.fake).filter((x) => x.id === t[0].t.id && x.text.includes("claude --"))).toHaveLength(1);
    expect(live(r.fake, pathOf(l))).toHaveLength(1);
  });

  test("a second start of one member filed in the same tick makes no second terminal", async () => {
    let twice: Action[] = [];
    const again: Reconciler = { name: "again", run: () => { const a = twice; twice = []; return a; } };
    const r = await rig({}, { extra: [again] });
    await startLead(r);
    const id = builder(r, "u3");
    // The decider files the start; this files a second start of the same member in the same tick.
    twice = [{ project: "fx", squad: SQ, member: null, subject: `member:${id}`, kind: "member", episode: "start:dup", payload: { id } }];
    await r.tick(3);
    const b = member(r.s, id);
    expect(creates(r.fake).filter((c) => c.cwd === pathOf(b))).toHaveLength(1);
    expect(live(r.fake, pathOf(b))).toHaveLength(1);
  });

  test("two starts of one member at once make one terminal: the second is busy, the member lock holds meanwhile", async () => {
    const r = await rig();
    await startLead(r);
    const b = await startBuilder(r, "u5"), bp = pathOf(b), first = live(r.fake, bp)[0].t.id;
    let release!: () => void, held = false;
    const gate = new Promise<void>((res) => { release = res; }), call = r.fake.call.bind(r.fake);
    r.fake.call = (async (op: Op, req: unknown) => { if (op === "terminal.create") { held = true; await gate; } return call(op, req as never); }) as FakeContract["call"];
    const m = memberOf(r.s, { id: Number(b.id) })!;
    const start = () => r.act.driver(r.act.seat(r.s, "fx", SQ, "start:twice", String(b.wt), r.now(), `fx/${SQ}/builder-u5`), "claude").start(m, "opus", "system", "again");
    const one = start();
    while (!held) await Bun.sleep(1);
    expect(lock(r.s, member(r.s, Number(b.id)))).toBe(true);     // terminal.create is a lock op
    expect(await start()).toMatchObject({ ok: false, busy: true });
    release();
    expect(await one).toMatchObject({ ok: true, wt: b.wt });
    const t = live(r.fake, bp);
    expect(t).toHaveLength(1);
    expect(t[0].t.id).not.toBe(first);                            // the old agent's terminal was closed first
    expect(lock(r.s, member(r.s, Number(b.id)))).toBe(false);
  });

  for (const turn of ["native", "none"] as const) {
    test(`a poke is delivered to the member's terminal (turn_confirm ${turn})`, async () => {
      const r = await rig({ turn_confirm: turn });
      const l = await startLead(r);
      const req = Number(r.s.request("poke", { text: "check your inbox" }, { project: "fx", squad: SQ, member: String(l.wt) }).row.id);
      await r.tick(2);
      const t = live(r.fake, pathOf(l))[0];
      expect(sends(r.fake).filter((x) => x.id === t.t.id).map((x) => x.text)).toContain("check your inbox");
      const done = JSON.parse(String((r.s.db.query("SELECT * FROM requests WHERE id = ?").get(req) as Row).result ?? "{}"));
      expect(done.delivered).toBe(turn === "native" ? "started" : "accepted");
      expect(orcaFor(r)).toEqual([]);
    });
  }

  test("a restart closes the old terminal first; a stop closes the member's terminals", async () => {
    const r = await rig();
    await startLead(r);
    const b = await startBuilder(r, "u4"), bp = pathOf(b);
    const first = live(r.fake, bp)[0].t;
    // The agent crashed, its shell stays: the observer reads it gone, the decider restarts it.
    r.s.upsert("observed_workers", { project: "fx", wt: String(b.wt) }, { state: "idle", presence: "none", account_at: r.now() + 1, observed_at: r.now() });
    await r.tick(3);
    const after = live(r.fake, bp);
    expect(after).toHaveLength(1);
    expect(after[0].t.id).not.toBe(first.id);
    expect(r.fake.calls.some((c) => c.op === "terminal.close" && (c.req as { id: string }).id === first.id)).toBe(true);
    running(r, member(r.s, Number(b.id)));
    r.s.want("member", String(b.id), "stopped", { by: "test" });
    await r.tick(3);
    expect(live(r.fake, bp)).toEqual([]);
    const close = r.s.db.query("SELECT * FROM orca_calls WHERE op = 'terminal.close' AND member = ?").get(String(b.wt)) as Row | null;
    expect(close?.state).toBe("completed");
    expect(orcaFor(r)).toEqual([]);
  });
});
