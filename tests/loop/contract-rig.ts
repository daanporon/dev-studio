// contract-rig.ts — the loop over a squad on the contract fake (bin/loop/fakes/contract.ts), for
// contract-observe.test.ts (U12) and contract-guards.test.ts (U12b). A project holds the fixture's Orca
// squad `demo` and a squad on the fake named for tmux; the Orca observer runs beside the contract one, on
// the fake Orca. The host's process walk is the test's: an agent runs in each fake terminal its launch
// line was typed into, until the test kills it (`kill`) or closes the terminal (`fake.exit`).
// Hermetic: a copy of the fixture state, a temp HOME, DS_WORKTREE_ROOT under the temp dir.
import { expect } from "bun:test";
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
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { git } from "../../bin/loop/io/worktrees.ts";
import { contractObserver } from "../../bin/loop/observers/contract.ts";
import { orcaObserver, wtPath, type LiveAccount } from "../../bin/loop/observers/orca.ts";

export const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
export const T = 1_800_000_000;
export const SQ = "ontmux";
export const LONG = 60_000;   // each case runs tens of loop ticks
const ENV = ["DS_LOOP_RETRY_S", "DS_WORKTREE_ROOT", "DS_CLAUDE_SYSTEM_JSON_DIR", "DS_LOOP_LIVE_ACCOUNT_S", "DS_TOKEN_CACHE"] as const;

const temps: string[] = [], stores: Store[] = [];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
// Each test file registers this with its own afterEach: bun loads this module once for every file of a
// run, so a hook registered here would run only for the file that imported it first.
export function cleanRigs(): void {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
}

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const reconcilers = await load<Reconciler>(DIRS.reconcilers);
const system: Picker = async () => ({ agent: "claude", model: "opus", effort: null, account: "system" });

export type Rig = Awaited<ReturnType<typeof rig>>;
export async function rig(caps: Partial<Capabilities> = {}, o: { extra?: Reconciler[] } = {}) {
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
  process.env.DS_TOKEN_CACHE = "0";              // the tokens reconciler's background scan must not make state/loop after the rig is removed
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
  const tick = async (n = 1, step = 5) => { for (let i = 0; i < n; i++) { at += step; await loop.tick(at); await act.drain(); } };
  s.want("squad", `fx/${SQ}`, "running", { payload: { repo: `path:${repo}`, type: "feature" },
    fill: { repo: `path:${repo}`, type: "feature", backend: "tmux", worktree_provider: "git" }, by: "test" });
  return { s, orca, fake, act, loop, tick, now: () => at, d, repo, killed, acted, walks: () => walks, orcaReads: () => reads };
}

export const members = (s: Store) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = ? AND COALESCE(status, '') != 'gone' ORDER BY id").all(SQ) as Row[];
export const lead = (s: Store) => members(s).find((m) => m.role === "lead")!;
export const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;
export const pathOf = (m: Row) => String(m.wt).replace(/^local::/, "");
export const creates = (f: FakeContract, cwd: string) => f.calls.filter((c) => c.op === "terminal.create" && (c.req as { cwd: string }).cwd === cwd);
export const sends = (f: FakeContract, id: string) => f.calls.filter((c) => c.op === "terminal.send" && (c.req as { id: string }).id === id).map((c) => (c.req as { text: string }).text);
export const live = (f: FakeContract, cwd: string) => [...f.terms.values()].filter((x) => x.t.cwd === cwd);
export const worker = (s: Store, m: Row) => s.get("observed_workers", { project: "fx", wt: String(m.wt) });

export function add(r: Rig, role: string, suffix: string): number {
  r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, observed_at, updated_at) VALUES ('fx', ?, ?, ?, 'claude', 'opus', 'system', ?, ?)", [SQ, role, suffix, T, T]);
  const id = Number((r.s.db.query("SELECT id FROM members WHERE squad = ? AND role = ? AND suffix = ?").get(SQ, role, suffix) as Row).id);
  r.s.want("member", String(id), "running", { payload: { prompt: `${role} ${suffix}` } });
  return id;
}
// Ticks until the member has a terminal and the walk sees its agent.
export async function started(r: Rig, id: () => number | undefined): Promise<Row> {
  for (let i = 0; i < 12; i++) {
    const n = id(), m = n ? member(r.s, n) : null;
    if (m && String(m.wt ?? "").startsWith("local::") && worker(r.s, m)?.walk === "running") return m;
    await r.tick();
  }
  throw new Error("the member never started");
}
export const startLead = (r: Rig) => started(r, () => Number(lead(r.s)?.id) || undefined);
export async function startMember(r: Rig, role: string, suffix: string): Promise<Row> {
  const id = add(r, role, suffix);
  return started(r, () => id);
}
export function unit(r: Rig, b: Row, slug: string, status: string, pr: number | null = null) {
  r.s.db.run("INSERT INTO units (project, squad, slug, status, builder_wt, pr, deps, ext_deps, observed_at, updated_at) VALUES ('fx', ?, ?, ?, ?, ?, '[]', '[]', ?, ?)",
    [SQ, slug, status, String(b.wt), pr == null ? null : String(pr), T, T]);
}
let keys = 0;
export function finish(r: Rig, m: Row, outcome: "ok" | "failed" | "no-pr" | "verdict", at = r.now(), body = `${outcome} body`) {
  const fresh = member(r.s, Number(m.id));
  expect(fresh.gen).toBeTruthy();
  const name = `fx/${SQ}/${fresh.role}${fresh.suffix ? `-${fresh.suffix}` : ""}`;
  r.s.db.run("INSERT INTO finishes (key, project, squad, member, wt, unit, gen, outcome, body, at) VALUES (?, 'fx', ?, ?, ?, ?, ?, ?, ?, ?)",
    [`k${++keys}`, SQ, name, pathOf(fresh), String(fresh.suffix ?? ""), String(fresh.gen), outcome, body, at]);
}
export const term = (r: Rig, m: Row) => live(r.fake, pathOf(m))[0]!;
