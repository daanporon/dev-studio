// host-unreachable.test.ts — side-loop-host U13 (issue #127, KTD11): when a host's link drops, its members read
// `unknown` on main, are not restarted, closed or counted dead, and nothing new is placed there; on reconnect before
// the grace they read live again with no action taken; after a main restart the unreachable clock starts at the
// later of the last pong and the link server's start.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { fakeContract, type FakeContract } from "../../bin/loop/fakes/contract.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider, { compare, reality, type Facts } from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { git } from "../../bin/loop/io/worktrees.ts";
import { runHere, type HostJob, type Send } from "../../bin/link/host-jobs.ts";
import { accept, ensureHostKey, requestJoin, pinMainKey } from "../../bin/link/host-keys.ts";
import { LinkClient } from "../../bin/link/client.ts";
import { startLinkServer, type LinkServer } from "../../bin/link/server.ts";
import { hostLink, hostUnreachable } from "../../bin/loop/squad/host-reach.ts";
import { studioOn } from "./studio-on.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const HOST = "side-a";
const SIDE_REPO = "/side/dev-studio-repos/fx", SIDE_WTS = "/side/wts";
const ENV: Record<string, string | undefined> = { DS_LOOP_RETRY_S: "1", DS_TOKEN_CACHE: "0", DS_LIMIT_LINK_LISTEN: "off", DS_LINK_PING_MS: "150", DS_LINK_DEAD_MS: "600",
  DS_LINK_BIND_ANY: undefined, DS_WORKTREE_ROOT: undefined, DS_CLAUDE_SYSTEM_JSON_DIR: undefined, DS_STATE_ROOT: undefined, DS_NOW: undefined };
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const temps: string[] = [], stores: Store[] = [], servers: LinkServer[] = [], clients: LinkClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const s of servers.splice(0)) await s.stop();
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  for (let t = 0; t < ms; t += 25) { if (ok()) return; await Bun.sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}

describe("main's view of a host's link (squad/host-reach.ts)", () => {
  test("online while the link is up; unreachable once it drops, since the last pong; online again on reconnect", async () => {
    const root = temp("zzreach-"), store = open(root); stores.push(store);
    const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0 }); servers.push(srv);
    const sroot = temp("zzreach-side-"), k = ensureHostKey(sroot);
    expect(requestJoin(store, { name: HOST, public_key: k.publicKey }).ok).toBe(true);
    // Accepted but never linked: unreachable (nothing is placed on a host main never heard).
    expect(accept(store, HOST).ok).toBe(true);
    expect(hostLink(store, HOST).state).toBe("unreachable");
    pinMainKey(sroot, srv.mainKey.publicKey);
    const c = new LinkClient({ main: `ws://127.0.0.1:${srv.port}`, root: sroot, name: HOST }); clients.push(c);
    await c.start();
    await until("online", () => hostLink(store, HOST).state === "online");
    expect(hostUnreachable(store, HOST)).toBe(false);
    expect(hostUnreachable(store, "local")).toBe(false);
    c.stop();
    await until("unreachable", () => hostLink(store, HOST).state === "unreachable");
    const row = store.get("hosts", { name: HOST })!;
    expect(hostLink(store, HOST).since).toBe(Number(row.unreachable_since));
    expect(Number(row.unreachable_since)).toBe(Number(row.last_seen_at));
    const again = new LinkClient({ main: `ws://127.0.0.1:${srv.port}`, root: sroot, name: HOST }); clients.push(again);
    await again.start();
    await until("online again", () => hostLink(store, HOST).state === "online");
    expect(store.get("hosts", { name: HOST })!.unreachable_since).toBeNull();
  });

  test("after a main restart the clock starts at the later of the last pong and the link server's start", async () => {
    const root = temp("zzreach-"), store = open(root); stores.push(store);
    const now = Math.floor(Date.now() / 1000);
    const ins = (name: string, status: string, seen: number | null, since: number | null) =>
      store.db.run("INSERT INTO hosts (name, status, public_key, fingerprint, seats, requested_at, accepted_at, last_seen_at, unreachable_since) VALUES (?, ?, 'a2V5', 'aaaa', 2, ?, ?, ?, ?)",
        [name, status, now - 3600, now - 3600, seen, since]);
    ins("was-up", "accepted", now - 40, null);           // linked when main went down: no clock yet
    ins("was-down", "accepted", now - 900, now - 900);   // already unreachable for 15 min before main went down
    ins("waiting", "pending", null, null);
    const before = Math.floor(Date.now() / 1000);
    const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0 }); servers.push(srv);
    for (const name of ["was-up", "was-down"]) {
      const h = hostLink(store, name);
      expect(h.state).toBe("unreachable");
      // Main's downtime used up none of the grace: the clock is the server's start, later than the last pong.
      expect(h.since!).toBeGreaterThanOrEqual(before);
      expect(h.since!).toBeGreaterThan(Number(store.get("hosts", { name })!.last_seen_at));
    }
    expect(store.get("hosts", { name: "waiting" })!.unreachable_since).toBeNull();
  });
});

describe("the decider on an unreachable host", () => {
  const facts = (f: Partial<Facts>): Facts => ({ view: "running", lock: false, hold: false, reality: "unknown", unknownS: 3600, recheckS: 300, resume: null, switchDue: false,
    givenUp: false, capped: false, rebroke: false, room: true, ...f }) as Facts;
  test("an unknown member on a down host gets no card; elsewhere the card still comes", () => {
    expect(compare(facts({ hostDown: true }))).toBeNull();
    expect(compare(facts({}))).toEqual({ act: "card", why: "unknown" });
  });
});

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const reconcilers = await load<Reconciler>(DIRS.reconcilers);
// U19: acct-a, the account with a login on the side host (rig).
const picker: Picker = async () => ({ agent: "claude", model: "opus", effort: null, account: "acct-a" });

// A squad on tmux on main with one accepted side host whose link is up (last seen, no clock), as in member-on-host.test.ts.
async function rig() {
  const d = temp("zzunreach-");
  const state = join(d, "state"), repo = join(d, "repo"), home = join(d, "home");
  cpSync(FIXTURE, state, { recursive: true });
  for (const x of [repo, home]) mkdirSync(x);
  for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"],
    ["remote", "add", "origin", "https://example.com/fx.git"]]) {
    const g = await git(["-C", repo, ...a]);
    if (g.code !== 0) throw new Error(g.err);
  }
  writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ numStartups: 3 })}\n`);
  process.env.DS_WORKTREE_ROOT = join(d, "wts");
  process.env.DS_CLAUDE_SYSTEM_JSON_DIR = home;
  const s = open(state); stores.push(s);
  importJson(s);
  for (const [role, value] of [["lead", "claude sonnet always"], ["builder", "claude opus ondemand"]] as const)
    s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
  s.db.run("INSERT INTO hosts (name, status, public_key, fingerprint, seats, requested_at, accepted_at, last_seen_at) VALUES (?, 'accepted', 'a2V5', 'aaaa', 2, ?, ?, ?)", [HOST, T, T, T]);
  // U19: acct-a has a login on the side host (its own ~/.claude); the launch reads account_folders from this state root.
  process.env.DS_STATE_ROOT = state;
  s.db.run("INSERT INTO account_folders (agent, account, host, dir, observed_at) VALUES ('claude', 'acct-a', ?, '/side/home/.claude', ?)", [HOST, T]);
  const orca = new FakeOrca();
  let at = T;
  const local = fakeContract({}, { name: "tmux", now: () => at }), side = fakeContract({}, { name: "tmux", now: () => at });
  const jobs: HostJob[] = [];
  const send: Send = async (_host, body) => {
    jobs.push(body);
    if (body.job === "clone") return { path: SIDE_REPO, cloned: true };
    if (body.job === "worktree.add") return { path: `${SIDE_WTS}/${body.spec.name}`, repo: body.spec.repo, branch: body.spec.branch, adopted: false };
    if (body.job === "probe") return { code: 0, out: "", err: "" };
    if (body.job === "rescue") return { listed: true, capped: 0, files: [], kept_dest: null, kept: [] };
    if (body.job === "worktree.remove") return { removed: true, already: false, branch: "kept" };
    if (body.job === "launch.write") return runHere(body, { root: join(d, "side-state") });
    throw new Error(`no fake for ${body.job}`);
  };
  const act = new LoopActuator({ orca, pick: picker, fulfillers: fulfillers.filter((f) => f.kinds), jobs: send,
    backends: () => ({ backend: local, caps: local.caps }), remote: () => side });
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  // `step`: seconds per tick. While the link is up the host's last pong follows the clock (the link server's ping pass).
  const tick = async (n = 1, step = 5) => {
    for (let i = 0; i < n; i++) {
      at += step;
      s.db.run("UPDATE hosts SET last_seen_at = ? WHERE name = ? AND unreachable_since IS NULL", [at, HOST]);
      await loop.tick(at); await act.drain();
    }
  };
  s.upsert("projects", { label: "fx" }, { doc: JSON.stringify({ ...JSON.parse(String(s.get("projects", { label: "fx" })?.doc ?? "{}")), studio_backend: "tmux" }), observed_at: T });
  studioOn(s, "fx", "tmux", T);
  const sq = "sidesq";
  s.want("squad", `fx/${sq}`, "running", { payload: { repo: `path:${repo}`, type: "feature" },
    fill: { repo: `path:${repo}`, type: "feature", backend: "tmux", worktree_provider: "git" }, by: "test" });
  return { s, side, jobs, tick, now: () => at, sq };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;
function builder(r: Rig, suffix: string): number {
  r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, host, observed_at, updated_at) VALUES ('fx', ?, 'builder', ?, 'claude', 'opus', 'acct-a', ?, ?, ?)",
    [r.sq, suffix, HOST, T, T]);
  const id = Number((r.s.db.query("SELECT id FROM members WHERE squad = ? AND suffix = ?").get(r.sq, suffix) as Row).id);
  r.s.want("member", String(id), "running", { payload: { prompt: `build ${suffix}` } });
  return id;
}
const ops = (f: FakeContract, op: string) => f.calls.filter((c) => c.op === op).length;
const alerts = (s: Store, id: number) => s.db.query("SELECT COUNT(*) AS n FROM episodes WHERE kind = 'action:alert' AND subject = ?").get(`member:${id}`) as { n: number };

describe("a builder on an unreachable side host", () => {
  test("reads unknown and is not restarted, closed, carded or started anew; reads running again on reconnect with no action", async () => {
    const r = await rig();
    const id = builder(r, "u1");
    for (let i = 0; i < 10 && !String(member(r.s, id).wt ?? "").startsWith(`${HOST}::`); i++) await r.tick();
    const wt = String(member(r.s, id).wt);
    expect(wt).toStartWith(`${HOST}::`);
    // The side's walk, replicated up the link: running.
    r.s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", walk: "running", presence: "running", observed_at: r.now(), host: HOST });
    r.s.upsert("units", { project: "fx", squad: r.sq, slug: "u1" }, { status: "dispatched", builder_wt: wt, observed_at: r.now(), updated_at: r.now() });
    await r.tick(2);
    expect(reality(r.s, member(r.s, id), r.now())).toBe("running");
    const creates = ops(r.side, "terminal.create"), closes = ops(r.side, "terminal.close");

    // The link drops: the server marks the host down at its last pong. The last uploaded rows go stale: an agent
    // the side's walk last read as gone would otherwise read dead and start again.
    r.s.db.run("UPDATE hosts SET unreachable_since = last_seen_at WHERE name = ?", [HOST]);
    r.s.upsert("observed_workers", { project: "fx", wt }, { walk: "none", presence: "none", gone_at: r.now(), observed_at: r.now() });
    expect(reality(r.s, member(r.s, id), r.now())).toBe("unknown");
    // A second Builder wished onto that host meanwhile is not started there.
    const id2 = builder(r, "u2");
    // Past RECHECK_MIN (5 min), HUNG_MIN and the spawn grace, but inside the host grace.
    await r.tick(12, 60);
    expect(reality(r.s, member(r.s, id), r.now())).toBe("unknown");
    expect(ops(r.side, "terminal.create")).toBe(creates);
    expect(ops(r.side, "terminal.close")).toBe(closes);
    expect(member(r.s, id2).wt ?? null).toBeNull();
    expect(r.jobs.filter((j) => j.job === "worktree.add").length).toBe(1);
    expect(alerts(r.s, id).n).toBe(0);
    expect(r.s.db.query("SELECT COUNT(*) AS n FROM episodes WHERE subject = ? AND kind IN ('req', 'poke', 'alerted')").get(`${r.sq}.builder-u1`)).toEqual({ n: 0 });

    // Reconnect before the grace: the hello clears the clock and the side's rows flow again.
    r.s.db.run("UPDATE hosts SET unreachable_since = NULL, last_seen_at = ? WHERE name = ?", [r.now(), HOST]);
    r.s.upsert("observed_workers", { project: "fx", wt }, { walk: "running", presence: "running", gone_at: null, account_at: r.now(), observed_at: r.now() });
    expect(reality(r.s, member(r.s, id), r.now())).toBe("running");
    r.s.want("member", String(id2), "stopped", { by: "test" });   // keep the second wish from starting now that it may
    await r.tick(3);
    expect(reality(r.s, member(r.s, id), r.now())).toBe("running");
    expect(ops(r.side, "terminal.create")).toBe(creates);
    expect(ops(r.side, "terminal.close")).toBe(closes);
    expect(alerts(r.s, id).n).toBe(0);
  }, 30_000);
});
