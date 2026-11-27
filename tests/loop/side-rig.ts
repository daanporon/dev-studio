// side-rig.ts — a loop with one accepted side host (`side-a`) and a Builder running there, for the U16 tests: a copy
// of the fixture state, a bare repo as origin, fakes for both hosts' backends and for the host jobs.
import { expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { fakeContract } from "../../bin/loop/fakes/contract.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { git } from "../../bin/loop/io/worktrees.ts";
import { runHere, type HostJob, type Send } from "../../bin/link/host-jobs.ts";
import { studioOn } from "./studio-on.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
export const T = 1_800_000_000;
export const HOST = "side-a";
const SIDE_REPO = "/side/dev-studio-repos/fx", SIDE_WTS = "/side/wts";
const ENV = ["DS_LOOP_RETRY_S", "DS_WORKTREE_ROOT", "DS_CLAUDE_SYSTEM_JSON_DIR", "DS_TOKEN_CACHE", "DS_STATE_ROOT", "DS_LIMIT_LINK_LISTEN"] as const;

const temps: string[] = [], stores: Store[] = [];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
/** For the test's afterEach: close the stores, remove the temp folders, restore the env. */
export function cleanup(): void {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
}
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const reconcilers = await load<Reconciler>(DIRS.reconcilers);
// acct-a is the account with a login on the side host (U19, rig).
const picker: Picker = async () => ({ agent: "claude", model: "opus", effort: null, account: "acct-a" });
/** What the fake side answers a `probe` and a `push` with; a test changes them. */
export type Answers = { probe: string; push: number };

async function run(args: string[]): Promise<string> {
  const g = await git(args);
  if (g.code !== 0) throw new Error(`git ${args.join(" ")}: ${g.err}`);
  return g.out.trim();
}

export type Rig = Awaited<ReturnType<typeof rig>>;
// A squad on tmux whose repo's origin is a local bare repo, so ls-remote and fetch work.
export async function rig() {
  for (const k of ENV) delete process.env[k];
  const d = temp("zzside-");
  const state = join(d, "state"), repo = join(d, "repo"), bare = join(d, "origin.git"), home = join(d, "home");
  cpSync(FIXTURE, state, { recursive: true });
  for (const x of [repo, home]) mkdirSync(x);
  await run(["init", "-q", "--bare", bare]);
  for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"],
    ["remote", "add", "origin", bare], ["push", "-q", "origin", "main"]]) await run(["-C", repo, ...a]);
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
  let at = T;
  s.db.run("INSERT INTO hosts (name, status, public_key, fingerprint, seats, requested_at, accepted_at, last_seen_at) VALUES (?, 'accepted', 'a2V5', 'aaaa', 2, ?, ?, ?)", [HOST, T, T, T]);
  // acct-a has a login on the side host (the launch reads account_folders from this state root) and one on main,
  // where a requeued Builder starts.
  process.env.DS_STATE_ROOT = state;
  s.db.run("INSERT INTO account_folders (agent, account, host, dir, observed_at) VALUES ('claude', 'acct-a', ?, '/side/home/.claude', ?)", [HOST, T]);
  mkdirSync(join(d, "acct-a"));
  s.db.run("UPDATE accounts SET config_dir = ? WHERE agent = 'claude' AND account = 'acct-a'", [join(d, "acct-a")]);
  const orca = new FakeOrca();
  const local = fakeContract({}, { name: "tmux", now: () => at }), side = fakeContract({}, { name: "tmux", now: () => at });
  const jobs: HostJob[] = [];
  const answers: Answers = { probe: "0\t0\n", push: 0 };
  const send: Send = async (host, body) => {
    expect(host).toBe(HOST);
    jobs.push(body);
    if (body.job === "clone") return { path: SIDE_REPO, cloned: true };
    if (body.job === "worktree.add") return { path: `${SIDE_WTS}/${body.spec.name}`, repo: body.spec.repo, branch: body.spec.branch, adopted: false };
    if (body.job === "probe") return { code: 0, out: answers.probe, err: "" };
    if (body.job === "push") return { code: answers.push, out: "", err: answers.push ? "rejected" : "" };
    if (body.job === "launch.write") return runHere(body, { root: join(d, "side-state") });
    throw new Error(`no fake for ${body.job}`);
  };
  const act = new LoopActuator({ orca, pick: picker, fulfillers: fulfillers.filter((f) => f.kinds), jobs: send,
    backends: () => ({ backend: local, caps: local.caps }), remote: () => side });
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
  s.upsert("projects", { label: "fx" }, { doc: JSON.stringify({ ...JSON.parse(String(s.get("projects", { label: "fx" })?.doc ?? "{}")), studio_backend: "tmux" }), observed_at: T });
  studioOn(s, "fx", "tmux", T);
  const sq = "ontmux";
  s.want("squad", `fx/${sq}`, "running", { payload: { repo: `path:${repo}`, type: "feature" },
    fill: { repo: `path:${repo}`, type: "feature", backend: "tmux", worktree_provider: "git" }, by: "test" });
  s.db.run("INSERT INTO units (project, squad, slug, status, pr, tier, observed_at, updated_at) VALUES ('fx', ?, 'u1', 'dispatched', '7', 'hard', ?, ?)", [sq, T, T]);
  return { s, local, side, tick, now: () => at, d, repo, bare, jobs, answers, sq };
}

export const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;
export const unit = (r: Rig) => r.s.db.query("SELECT * FROM units WHERE squad = ? AND slug = 'u1'").get(r.sq) as Row;
// The side's terminal closes (contract close lists the folder's terminals, then closes each by id).
export const closes = (f: FakeContract) => f.calls.filter((c) => c.op === "terminal.close").length;

// A builder on the side host, running there, with its branch pushed to origin at one commit of its own.
export async function builderOnSide(r: Rig): Promise<{ m: Row; branch: string; sha: string }> {
  r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, host, observed_at, updated_at) VALUES ('fx', ?, 'builder', 'u1', 'claude', 'opus', 'acct-a', ?, ?, ?)",
    [r.sq, HOST, T, T]);
  const id = Number((r.s.db.query("SELECT id FROM members WHERE squad = ? AND suffix = 'u1'").get(r.sq) as Row).id);
  r.s.want("member", String(id), "running", { payload: { prompt: "build u1" } });
  for (let i = 0; i < 10 && !String(member(r.s, id).wt ?? "").startsWith(`${HOST}::`); i++) await r.tick();
  const m = member(r.s, id);
  expect(String(m.wt)).toStartWith(`${HOST}::`);
  r.s.upsert("observed_workers", { project: "fx", wt: String(m.wt) }, { state: "busy", walk: "running", presence: "running", observed_at: r.now(), host: HOST });
  const branch = String(r.s.get("worktrees", { host: HOST, path: String(m.wt_path) })!.branch);
  // What the side pushed before it fenced: one commit on the old branch.
  await run(["-C", r.repo, "checkout", "-q", "-b", branch]);
  await run(["-C", r.repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "work on u1"]);
  await run(["-C", r.repo, "push", "-q", "origin", branch]);
  const sha = await run(["-C", r.repo, "rev-parse", "HEAD"]);
  await run(["-C", r.repo, "checkout", "-q", "main"]);
  await run(["-C", r.repo, "branch", "-q", "-D", branch]);
  return { m, branch, sha };
}

/** What the side's observer reports once the agent in `wt` is gone. */
export const agentGone = (r: Rig, wt: string) =>
  r.s.upsert("observed_workers", { project: "fx", wt }, { presence: "none", walk: "none", state: null, account_at: r.now(), observed_at: r.now() });
