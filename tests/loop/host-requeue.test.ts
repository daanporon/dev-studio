// host-requeue.test.ts — side-loop-host U15 (issue #127, KTD11): main requeues the units of a host it lost.
// At the grace plus 60 s of a host's unreachable clock, each member there is ended and wished again with no host; a
// Builder's unit moves to attempt 2, its next Builder starts on another seat on `<branch>-r2` from the old branch's
// last pushed commit, and its journal gets a `[keep]` line naming the host, the branch and the commit. When the host
// comes back, the terminals of the moved members are closed there before the host is used again. An open PR from the
// old branch raises one Studio card. A host that says on reconnect that it fenced itself is fenced at once.
// Hermetic: a copy of the fixture state, a bare repo as origin, fakes for both hosts' backends and the host jobs.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { git } from "../../bin/loop/io/worktrees.ts";
import { runHere, type HostJob, type Send } from "../../bin/link/host-jobs.ts";
import { accept, ensureHostKey, requestJoin } from "../../bin/link/host-keys.ts";
import { LinkClient } from "../../bin/link/client.ts";
import { startLinkServer, type LinkServer } from "../../bin/link/server.ts";
import { fenceDueAt, hostFence } from "../../bin/loop/reconcilers/host-fence.ts";
import { studioOn } from "./studio-on.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const HOST = "side-a";
const SIDE_REPO = "/side/dev-studio-repos/fx", SIDE_WTS = "/side/wts";
const GRACE = 15 * 60;
const ENV = ["DS_LOOP_RETRY_S", "DS_WORKTREE_ROOT", "DS_CLAUDE_SYSTEM_JSON_DIR", "DS_TOKEN_CACHE", "DS_STATE_ROOT", "DS_LIMIT_LINK_LISTEN",
  "DS_LIMIT_HOST_GRACE_MIN", "DS_LINK_PING_MS", "DS_LINK_DEAD_MS", "DS_LINK_BIND_ANY"] as const;

const temps: string[] = [], stores: Store[] = [], servers: LinkServer[] = [], clients: LinkClient[] = [];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const s of servers.splice(0)) await s.stop();
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const reconcilers = await load<Reconciler>(DIRS.reconcilers);
const system: Picker = async () => ({ agent: "claude", model: "opus", effort: null, account: "system" });

async function run(args: string[]): Promise<string> {
  const g = await git(args);
  if (g.code !== 0) throw new Error(`git ${args.join(" ")}: ${g.err}`);
  return g.out.trim();
}

type Rig = Awaited<ReturnType<typeof rig>>;
// A squad on tmux whose repo's origin is a local bare repo, so ls-remote and fetch work.
async function rig() {
  for (const k of ENV) delete process.env[k];
  const d = temp("zzrequeue-");
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
  const orca = new FakeOrca();
  const local = fakeContract({}, { name: "tmux", now: () => at }), side = fakeContract({}, { name: "tmux", now: () => at });
  const jobs: HostJob[] = [];
  const send: Send = async (host, body) => {
    expect(host).toBe(HOST);
    jobs.push(body);
    if (body.job === "clone") return { path: SIDE_REPO, cloned: true };
    if (body.job === "worktree.add") return { path: `${SIDE_WTS}/${body.spec.name}`, repo: body.spec.repo, branch: body.spec.branch, adopted: false };
    if (body.job === "launch.write") return runHere(body, { root: join(d, "side-state") });
    throw new Error(`no fake for ${body.job}`);
  };
  const act = new LoopActuator({ orca, pick: system, fulfillers: fulfillers.filter((f) => f.kinds), jobs: send,
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
  return { s, local, side, tick, now: () => at, d, repo, bare, jobs, sq };
}

const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;
const unit = (r: Rig) => r.s.db.query("SELECT * FROM units WHERE squad = ? AND slug = 'u1'").get(r.sq) as Row;
// The side's terminal closes (contract close lists the folder's terminals, then closes each by id).
const closes = (f: FakeContract) => f.calls.filter((c) => c.op === "terminal.close").length;

// A builder on the side host, running there, with its branch pushed to origin at one commit of its own.
async function onSide(r: Rig): Promise<{ m: Row; branch: string; sha: string }> {
  r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, host, observed_at, updated_at) VALUES ('fx', ?, 'builder', 'u1', 'claude', 'opus', 'system', ?, ?, ?)",
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
const down = (r: Rig, since: number) => r.s.db.run("UPDATE hosts SET unreachable_since = ? WHERE name = ?", [since, HOST]);

describe("main fences a lost host at the grace plus 60 s", () => {
  test("its Builder is ended and requeued: attempt 2 on <branch>-r2 from the last pushed commit, on another seat, with a [keep] line", async () => {
    const r = await rig();
    const { m, branch, sha } = await onSide(r);
    // Down for the grace plus 50 s: not yet.
    down(r, r.now() - GRACE - 50);
    await r.tick();
    expect(member(r.s, Number(m.id)).status).not.toBe("gone");
    expect(r.s.get("hosts", { name: HOST })!.fenced_at).toBeNull();
    // Past the grace plus 60 s: fenced and requeued.
    down(r, r.now() - GRACE - 61);
    await r.tick();
    const old = member(r.s, Number(m.id));
    expect(old).toMatchObject({ status: "gone", want: "gone" });
    expect(old.fenced_at).not.toBeNull();
    expect(r.s.get("hosts", { name: HOST })!.fenced_at).not.toBeNull();
    expect(unit(r)).toMatchObject({ attempt: 2, retry_from: branch, retry_sha: sha, retry_host: HOST, retry_pr: "7" });
    const journal = readFileSync(join(r.s.root, "fx", "journals", `${r.sq}-builder-u1.md`), "utf8");
    expect(journal).toContain("[keep] host side-a was lost");
    expect(journal).toContain(branch);
    expect(journal).toContain(sha);
    const ev = r.s.db.query("SELECT payload FROM events WHERE kind = 'host_fenced'").get() as Row;
    expect(JSON.parse(String(ev.payload))).toMatchObject({ name: HOST, members: ["builder-u1"] });
    // The new Builder starts on main (the fenced host is refused) on <branch>-r2, at the old branch's pushed commit.
    let next: Row | null = null;
    for (let i = 0; i < 12; i++) {
      await r.tick();
      next = r.s.db.query("SELECT * FROM members WHERE squad = ? AND suffix = 'u1' AND id != ? ORDER BY id DESC").get(r.sq, Number(m.id)) as Row | null;
      if (next?.wt) break;
    }
    expect(next).not.toBeNull();
    expect(String(next!.host ?? "local")).not.toBe(HOST);
    const path = String(next!.wt_path ?? String(next!.wt).replace(/^[^:]+::/, ""));
    expect(await run(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"])).toBe(`${branch}-r2`);
    expect(await run(["-C", path, "rev-parse", "HEAD"])).toBe(sha);
    expect(r.jobs.filter((j) => j.job === "worktree.add").length).toBe(1);   // nothing more on the lost host
  }, 30_000);

  test("a second loss with nothing pushed keeps the base the attempt started from", async () => {
    const r = await rig();
    const { m, branch } = await onSide(r);
    await run(["-C", r.repo, "push", "-q", "origin", "--delete", branch]);   // this attempt pushed nothing
    r.s.db.run("UPDATE units SET attempt = 2, retry_from = 'old-x', retry_sha = 'abc123' WHERE squad = ? AND slug = 'u1'", [r.sq]);
    down(r, r.now() - GRACE - 61);
    await r.tick();
    expect(member(r.s, Number(m.id)).status).toBe("gone");
    expect(unit(r)).toMatchObject({ attempt: 3, retry_from: "old-x", retry_sha: "abc123" });
    const journal = readFileSync(join(r.s.root, "fx", "journals", `${r.sq}-builder-u1.md`), "utf8");
    expect(journal).toContain("started from old-x at abc123");
  }, 30_000);

  test("when the host comes back, the moved member's terminals are closed there first, then the host is free again", async () => {
    const r = await rig();
    const { m } = await onSide(r);
    down(r, r.now() - GRACE - 61);
    await r.tick();
    expect(member(r.s, Number(m.id)).status).toBe("gone");
    expect(closes(r.side)).toBe(0);
    // Still down: nothing is closed and the host stays fenced.
    await r.tick(2);
    expect(closes(r.side)).toBe(0);
    expect(r.s.get("hosts", { name: HOST })!.fenced_at).not.toBeNull();
    r.s.db.run("UPDATE hosts SET unreachable_since = NULL, last_seen_at = ? WHERE name = ?", [r.now(), HOST]);
    await r.tick();
    expect(closes(r.side)).toBe(1);
    expect(member(r.s, Number(m.id)).fence_closed_at).not.toBeNull();
    expect(r.s.get("hosts", { name: HOST })!.fenced_at).toBeNull();
    expect(r.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'host_returned'").get()).toEqual({ n: 1 });
  }, 30_000);

  test("an open PR from the old branch raises one Studio card", async () => {
    const r = await rig();
    await onSide(r);
    r.s.upsert("observed_prs", { project: "fx", ref: `${r.sq}/u1` }, { pr: 7, state: "OPEN", observed_at: r.now() });
    down(r, r.now() - GRACE - 61);
    await r.tick(4);
    const key = `host-requeue.${r.sq}.u1`;
    // The reconciler asks every tick with the same episode; the claim makes it one card.
    const card = hostFence({ store: r.s, project: "", tick: 0, now: r.now(), fired: [], poked: new Set() }).find((a) => a.kind === "alert");
    expect(card).toMatchObject({ project: "fx", squad: null, subject: key, episode: "u1#2" });
    expect(JSON.stringify(card!.payload)).toContain("PR #7");
    const done = r.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'action_done' AND json_extract(payload, '$.subject') = ?").get(key);
    expect(done).toEqual({ n: 1 });
    // A closed PR raises nothing.
    r.s.upsert("observed_prs", { project: "fx", ref: `${r.sq}/u1` }, { pr: 7, state: "CLOSED", observed_at: r.now() });
    expect(hostFence({ store: r.s, project: "", tick: 0, now: r.now(), fired: [], poked: new Set() }).filter((a) => a.kind === "alert")).toEqual([]);
  }, 30_000);
});

describe("after a main restart, or when the host fenced itself", () => {
  test("a host back before the grace, that did not fence, keeps its members", async () => {
    const r = await rig();
    const { m } = await onSide(r);
    down(r, r.now() - GRACE + 30);
    await r.tick();
    r.s.db.run("UPDATE hosts SET unreachable_since = NULL, last_seen_at = ? WHERE name = ?", [r.now(), HOST]);
    await r.tick(2);
    expect(member(r.s, Number(m.id)).status).not.toBe("gone");
    expect(unit(r).attempt).toBeNull();
  }, 30_000);

  test("after a main restart the clock counts from the link server's start, not from the old last pong", async () => {
    const root = temp("zzrequeue-boot-"), store = open(root); stores.push(store);
    const old = Math.floor(Date.now() / 1000) - 3 * 3600;
    store.db.run("INSERT INTO hosts (name, status, public_key, fingerprint, seats, requested_at, accepted_at, last_seen_at) VALUES (?, 'accepted', 'a2V5', 'aaaa', 2, ?, ?, ?)", [HOST, old, old, old]);
    const before = Math.floor(Date.now() / 1000);
    const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0 }); servers.push(srv);
    const due = fenceDueAt(store, store.get("hosts", { name: HOST })!);
    expect(due).not.toBeNull();
    expect(due!).toBeGreaterThanOrEqual(before + GRACE + 60);
  }, 30_000);

  test("a host that reports on reconnect that it fenced is fenced on main at once (link/server.ts)", async () => {
    process.env.DS_LINK_PING_MS = "150"; process.env.DS_LINK_DEAD_MS = "600";
    const root = temp("zzrequeue-link-"), store = open(root); stores.push(store);
    const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0 }); servers.push(srv);
    const sroot = temp("zzrequeue-side-"), k = ensureHostKey(sroot);
    expect(requestJoin(store, { name: HOST, public_key: k.publicKey }).ok).toBe(true);
    expect(accept(store, HOST).ok).toBe(true);
    const fencedAt = Math.floor(Date.now() / 1000) - 100;
    const c = new LinkClient({ main: `ws://127.0.0.1:${srv.port}`, root: sroot, name: HOST, fenced: () => fencedAt }); clients.push(c);
    await c.start();
    expect(Number(store.get("hosts", { name: HOST })!.fenced_at)).toBe(fencedAt);
    expect(store.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'host_reported_fence'").get()).toEqual({ n: 1 });
    // A host that did not fence sends nothing and is not fenced.
    store.db.run("UPDATE hosts SET fenced_at = NULL WHERE name = ?", [HOST]);
    c.stop();
    const again = new LinkClient({ main: `ws://127.0.0.1:${srv.port}`, root: sroot, name: HOST, fenced: () => null }); clients.push(again);
    for (let i = 0; i < 40; i++) { try { await again.start(); break; } catch { await Bun.sleep(50); } }
    expect(store.get("hosts", { name: HOST })!.fenced_at).toBeNull();
  }, 30_000);

  test("a reported fence requeues the host's members even while it is online", async () => {
    const r = await rig();
    const { m } = await onSide(r);
    r.s.db.run("UPDATE hosts SET fenced_at = ?, last_seen_at = ? WHERE name = ?", [r.now() - 100, r.now(), HOST]);
    await r.tick();
    expect(member(r.s, Number(m.id)).status).toBe("gone");
    expect(unit(r).attempt).toBe(2);
    // Then, online with nothing live: the moved member's terminals are closed and the host is free.
    await r.tick();
    expect(closes(r.side)).toBe(1);
    expect(r.s.get("hosts", { name: HOST })!.fenced_at).toBeNull();
  }, 30_000);
});
