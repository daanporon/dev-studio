// side-fence.test.ts — side-loop-host U14 (issue #127, KTD11/KTD13): the side loop pushes each Builder branch that
// is ahead of its remote; once its link has been down for the grace it pushes and then closes its own members'
// terminals, with no checkpoint request, inside main's 60 s margin; a restarted side loop keeps the original
// down-since time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer, Backend, Op, Request } from "../../bin/backend/contract.ts";
import { accept, ensureHostKey, requestJoin } from "../../bin/link/host-keys.ts";
import { startLinkServer } from "../../bin/link/server.ts";
import { startSideLink } from "../../bin/link/side.ts";
import { fencedAt, linkDown, noteHeard, noteLink } from "../../bin/link/side-state.ts";
import { writeSideConfig } from "../../bin/lib/loop-unit.ts";
import { makeSideActuator, SIDE_PUSH_RETRY_S } from "../../bin/loop/core/side-actuator.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import sideFenceR, { fenceDue, graceS, MAIN_MARGIN_S, sideFence } from "../../bin/loop/reconcilers/side-fence.ts";
import sidePushR, { sidePush } from "../../bin/loop/reconcilers/side-push.ts";
import { pushAhead, sideMembers, type SideMember } from "../../bin/loop/squad/side-work.ts";

const T = 1_800_000_000;
const tmps: string[] = [];
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "ds-side-fence-"))); tmps.push(d); return d; };
const saved: Record<string, string | undefined> = {};
const pinned = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "DS_LIMIT_HOST_GRACE_MIN", "DS_LINK_DEAD_MS", "DS_LINK_PING_MS", "DS_SIDE_FENCE_PUSH_MS", "DS_LIMIT_LINK_LISTEN"];
beforeAll(() => {
  for (const k of pinned) saved[k] = process.env[k];
  const g = join(tmp(), "gitconfig");
  writeFileSync(g, "[user]\n\tname = t\n\temail = t@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = g;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const k of pinned.slice(2)) delete process.env[k];
});
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  for (const k of pinned) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

function sh(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** A bare remote and a clone on branch `branch`, pushed once; returns the clone's path. */
function repo(dir: string, branch = "feat"): { path: string; remote: string } {
  const remote = join(dir, "remote.git"), path = join(dir, "wt");
  sh(dir, "init", "-q", "--bare", remote);
  sh(dir, "clone", "-q", remote, path);
  writeFileSync(join(path, "a"), "1");
  sh(path, "add", "a"); sh(path, "commit", "-qm", "base"); sh(path, "push", "-q", "origin", "HEAD:refs/heads/main");
  sh(path, "checkout", "-qb", branch);
  return { path, remote };
}
const commit = (path: string, msg: string) => { writeFileSync(join(path, msg), msg); sh(path, "add", msg); sh(path, "commit", "-qm", msg); return sh(path, "rev-parse", "HEAD"); };

function sideStore(dir: string): Store {
  const root = join(dir, "state");
  mkdirSync(root, { recursive: true });
  const store = open(root);
  store.upsert("projects", { label: "realp" }, { doc: "{}", observed_at: T });
  store.upsert("squads", { project: "realp", topic: "t" }, { status: "running", backend: "tmux", doc: "{}", updated_at: T, observed_at: T });
  return store;
}
function member(store: Store, role: string, path: string, branch: string | null = "feat"): void {
  store.db.run("INSERT INTO members (project, squad, role, suffix, wt, status, host, updated_at, observed_at) VALUES ('realp', 't', ?, '', ?, 'running', 'local', ?, ?)",
    [role, `local::${path}`, T, T]);
  if (branch) store.upsert("worktrees", { host: "local", path }, { project: "realp", squad: "t", role, branch, provider: "tmux", created_at: T });
}
const ctx = (store: Store, now: number, project = "realp") => ({ store, project, tick: 1, now, fired: [], poked: new Set<string>(), role: "side" as const });
const events = (store: Store, kind: string) => (store.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload));

/** A side backend that records each op; terminals by folder. */
function fakeBackend(log: string[], terms: { id: string; cwd: string }[]): Backend {
  return {
    async call<O extends Op>(op: O, req: Request<O>): Promise<Answer<O>> {
      log.push(`${op}${op === "terminal.close" ? ` ${(req as { id: string }).id}` : ""}`);
      if (op === "terminal.list") return { ok: true, terminals: terms.map((t, i) => ({ id: t.id, cwd: t.cwd, label: "x", created_at: i, alive: true })) } as unknown as Answer<O>;
      if (op === "terminal.close") return { ok: true, closed: true } as Answer<O>;
      return { ok: false, error: { code: "unsupported", message: op } } as unknown as Answer<O>;
    },
  };
}

describe("side push", () => {
  test("a Builder branch ahead of its remote is pushed once per head; nothing ahead raises nothing", async () => {
    const dir = tmp(), { path, remote } = repo(dir), store = sideStore(dir);
    try {
      member(store, "builder", path);
      expect(await sidePush(ctx(store, T))).toEqual([]);   // a fresh branch with nothing new: left alone

      const sha = commit(path, "one");
      const acts = await sidePush(ctx(store, T));
      expect(acts.map((a) => [a.kind, a.episode, a.subject])).toEqual([["side.push", sha, `side-push:${path}`]]);
      await makeSideActuator().act(acts[0], ctx(store, T));
      expect(sh(dir, "--git-dir", remote, "rev-parse", "refs/heads/feat")).toBe(sha);
      expect(events(store, "side_pushed")).toEqual([{ branch: "feat", sha }]);
      expect(await sidePush(ctx(store, T + 10))).toEqual([]);

      const sha2 = commit(path, "two");
      expect((await sidePush(ctx(store, T + 20))).map((a) => a.episode)).toEqual([sha2]);
    } finally { store.close(); }
  }, 30_000);

  test("only Builders, only on the side, and never forced", async () => {
    const dir = tmp(), { path, remote } = repo(dir), store = sideStore(dir);
    try {
      member(store, "tester", path);
      commit(path, "one");
      expect(await sidePush(ctx(store, T))).toEqual([]);
      store.db.run("UPDATE members SET role = 'builder'");
      expect(await sidePush({ ...ctx(store, T), role: undefined } as never)).toEqual([]);   // a main loop pushes nothing

      // The remote moved on without this commit: the push is refused, not forced, and tried again later.
      const other = join(dir, "other");
      sh(dir, "clone", "-q", remote, other);
      sh(other, "checkout", "-qb", "feat"); commit(other, "theirs"); sh(other, "push", "-q", "origin", "feat");
      sh(path, "fetch", "-q");
      const mine = commit(path, "mine");
      const [a] = await sidePush(ctx(store, T));
      expect(a.episode).toBe(mine);
      await makeSideActuator().act(a, ctx(store, T));
      expect(sh(dir, "--git-dir", remote, "rev-parse", "refs/heads/feat")).not.toBe(mine);
      expect(events(store, "side_push_failed").map((p) => p.branch)).toEqual(["feat"]);
      expect(store.db.query("SELECT state, next_at FROM episodes WHERE kind = 'action:side.push'").all()).toEqual([]);   // no claim outside a tick
    } finally { store.close(); }
  }, 30_000);

  test("in a tick, a failed push is tried again after the retry wait", async () => {
    const dir = tmp(), { path } = repo(dir), store = sideStore(dir);
    try {
      member(store, "builder", path);
      commit(path, "one");
      let tries = 0;
      const act = makeSideActuator({ push: async () => { tries++; return { ok: false, branch: "feat", error: "no route" }; } });
      const loop = new Loop(store, { observers: [], reconcilers: [sidePushR] }, act, { role: "side", projects: () => ["realp"] });
      loop.boot(T);
      await loop.tick(T);
      await loop.tick(T + 10);
      expect(tries).toBe(1);
      expect(store.db.query("SELECT state, next_at FROM episodes WHERE kind = 'action:side.push'").get()).toEqual({ state: "pending", next_at: T + SIDE_PUSH_RETRY_S });
      await loop.tick(T + SIDE_PUSH_RETRY_S);
      expect(tries).toBe(2);
    } finally { store.close(); }
  }, 30_000);
});

describe("side link clock", () => {
  test("down since the last time heard up; a restarted side loop keeps the original down-since", () => {
    const dir = tmp(), store = sideStore(dir), A = 1111, B = 2222;
    try {
      noteLink(store, "connecting", T, A);
      expect(linkDown(store, A)).toBeNull();               // never up on this host: no clock
      noteLink(store, "up", T, A);
      noteHeard(store, T + 100, A);
      expect(linkDown(store, A)).toBeNull();
      // Noticed 30 s of silence after main was last heard at T+110: the clock starts no later than that.
      noteLink(store, "down", T + 140, A);
      expect(linkDown(store, A)).toBe(T + 110);
      noteLink(store, "connecting", T + 141, A);
      expect(linkDown(store, A)).toBe(T + 110);

      // A new side process (another pid) keeps the clock while it dials.
      noteLink(store, "connecting", T + 600, B);
      noteLink(store, "refused", T + 700, B);
      expect(linkDown(store, B)).toBe(T + 110);
      noteLink(store, "up", T + 800, B);
      expect(linkDown(store, B)).toBeNull();
    } finally { store.close(); }
  });

  test("an up left by a process that died reads as down since its last tick", () => {
    const dir = tmp(), store = sideStore(dir), A = 1111, B = 2222;
    try {
      noteLink(store, "up", T, A);
      noteHeard(store, T + 50, A);
      noteHeard(store, T + 60, B);                         // another process does not move A's clock
      expect(linkDown(store, B)).toBe(T + 50);
      noteLink(store, "connecting", T + 900, B);
      expect(linkDown(store, B)).toBe(T + 50);
    } finally { store.close(); }
  });

  test("the side clock never starts after main's (the host's last pong)", () => {
    const dir = tmp(), store = sideStore(dir), pid = process.pid;
    try {
      noteLink(store, "up", T, pid);
      noteHeard(store, T + 5, pid);                        // last side tick while up
      const lastPong = T + 18;                             // main's unreachable clock starts here (server.ts)
      noteLink(store, "down", lastPong + 30, pid);         // the side notices after DS_LINK_DEAD_MS of silence
      expect(linkDown(store)!).toBeLessThanOrEqual(lastPong);
    } finally { store.close(); }
  });
});

describe("the side link writes the clock", () => {
  test("startSideLink records up, then down when main goes away", async () => {
    process.env.DS_LINK_PING_MS = "150"; process.env.DS_LINK_DEAD_MS = "600";
    const mroot = join(tmp(), "main"), sroot = join(tmp(), "side");
    mkdirSync(mroot); mkdirSync(sroot);
    const main = open(mroot), sideS = open(sroot);
    const srv = await startLinkServer({ root: mroot, store: main, binds: "127.0.0.1", port: 0 });
    let link: ReturnType<typeof startSideLink> = null;
    const until = async (what: string, ok: () => boolean) => {
      for (let t = 0; t < 5000; t += 25) { if (ok()) return; await Bun.sleep(25); }
      throw new Error(`timed out waiting for ${what}`);
    };
    const state = () => (sideS.get("side_link", { id: 1 })?.state as string | undefined) ?? null;
    try {
      const k = ensureHostKey(sroot);
      expect(requestJoin(main, { name: "side-a", public_key: k.publicKey }).ok).toBe(true);
      expect(accept(main, "side-a").ok).toBe(true);
      writeSideConfig(sroot, { main: `ws://127.0.0.1:${srv.port}`, name: "side-a" });
      link = startSideLink(sideS, sroot, () => {});
      await until("the link up in side_link", () => state() === "up");
      expect(linkDown(sideS)).toBeNull();
      await srv.stop();
      await until("the link down in side_link", () => state() === "down");
      expect(linkDown(sideS)).not.toBeNull();
    } finally {
      link?.stop();
      await srv.stop().catch(() => {});
      main.close(); sideS.close();
      delete process.env.DS_LINK_PING_MS; delete process.env.DS_LINK_DEAD_MS;
    }
  }, 30_000);
});

describe("side fence", () => {
  test("at the grace: push each Builder branch, then close every member's terminals, no checkpoint; once", async () => {
    const dir = tmp(), store = sideStore(dir), pid = process.pid;
    const b1 = join(dir, "b1"), b2 = join(dir, "b2"), t1 = join(dir, "t1");
    for (const p of [b1, b2, t1]) mkdirSync(p);
    try {
      member(store, "builder", b1); member(store, "builder", b2); member(store, "tester", t1, null);
      const log: string[] = [];
      const push = async (m: SideMember) => { log.push(`push ${m.path}`); await Bun.sleep(200); return { ok: true as const, branch: "feat", sha: "a".repeat(40) }; };
      const backend = fakeBackend(log, [{ id: "%1", cwd: b1 }, { id: "%2", cwd: b2 }, { id: "%3", cwd: t1 }, { id: "%9", cwd: join(dir, "elsewhere") }]);
      const act = makeSideActuator({ push, backend: () => backend });
      const loop = new Loop(store, { observers: [], reconcilers: [sideFenceR, sidePushR] }, act, { role: "side", projects: () => ["realp"] });
      loop.boot(T);

      noteLink(store, "up", T, pid);
      await loop.tick(T + 10);                             // up: the tick moves heard_at on
      noteLink(store, "down", T + 45, pid);
      const since = linkDown(store)!;
      expect(since).toBe(T + 15);
      expect(graceS(store)).toBe(15 * 60);

      expect((await loop.tick(since + graceS(store) - 1)).acted.filter((a) => a.kind === "side.fence")).toEqual([]);
      const started = performance.now();
      const r = await loop.tick(since + graceS(store));
      const tookS = (performance.now() - started) / 1000;
      expect(r.acted.map((a) => a.kind)).toEqual(["side.fence"]);
      // Pushes first (in parallel), then the closes; only this host's members' terminals; nothing typed into them.
      expect(log.slice(0, 2).sort()).toEqual([`push ${b1}`, `push ${b2}`]);
      expect(log.slice(2).filter((l) => l.startsWith("terminal.close")).sort()).toEqual(["terminal.close %1", "terminal.close %2", "terminal.close %3"]);
      expect(log.some((l) => l.startsWith("terminal.send"))).toBe(false);
      expect(tookS).toBeLessThan(MAIN_MARGIN_S);
      expect(tookS).toBeLessThan(0.39);                    // two 200 ms pushes ran side by side
      // No checkpoint: no request, no message row, no pause.
      expect(store.db.query("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 0 });
      expect(store.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
      expect(fencedAt(store)).toBe(since + graceS(store));
      expect(events(store, "side_fenced")).toEqual([{ down_since: since, pushed: ["feat@aaaaaaaaaaaa", "feat@aaaaaaaaaaaa"], push_failed: [], closed: 3, close_failed: [] }]);

      // Fenced once: later ticks raise neither a fence nor a push.
      log.length = 0;
      const again = await loop.tick(since + graceS(store) + 30);
      expect(again.acted).toEqual([]);
      expect(log).toEqual([]);
    } finally { store.close(); }
  }, 30_000);

  test("a restarted side loop fences at the original grace, not a fresh one", async () => {
    const dir = tmp(), store = sideStore(dir), OLD = 1111;
    try {
      noteLink(store, "up", T, OLD);
      noteLink(store, "down", T + 30, OLD);                // went down at T (heard at T), the old process then died
      const since = linkDown(store)!;
      // The new process starts 10 minutes later and dials again.
      noteLink(store, "connecting", since + 600);
      expect(fenceDue(store, since + 600)).toBeNull();
      expect(fenceDue(store, since + graceS(store))).toBe(since);
      expect(sideFence(ctx(store, since + graceS(store), "")).map((a) => a.episode)).toEqual([String(since)]);
    } finally { store.close(); }
  });

  test("a failed push does not stop the close; the push waits while the fence is due; up again clears it", async () => {
    const dir = tmp(), { path } = repo(dir), store = sideStore(dir), pid = process.pid;
    try {
      process.env.DS_LIMIT_HOST_GRACE_MIN = "1";
      member(store, "builder", path);
      commit(path, "one");
      noteLink(store, "up", T, pid);
      noteLink(store, "down", T, pid);
      const since = linkDown(store)!, at = since + 60;
      expect(await sidePush(ctx(store, at))).toEqual([]);     // the fence pushes now
      const log: string[] = [];
      const act = makeSideActuator({ push: async () => ({ ok: false, branch: "feat", error: "main unreachable" }), backend: () => fakeBackend(log, [{ id: "%1", cwd: path }]) });
      await act.act(sideFence(ctx(store, at, ""))[0], ctx(store, at, ""));
      expect(log).toEqual(["terminal.list", "terminal.close %1"]);
      expect(events(store, "side_fenced")[0]).toMatchObject({ push_failed: ["feat: main unreachable"], closed: 1 });
      noteLink(store, "up", at + 5, pid);
      expect(fencedAt(store)).toBeNull();
      expect(fenceDue(store, at + 3600)).toBeNull();
      expect(sideMembers(store, "realp").map((m) => m.role)).toEqual(["builder"]);
      expect((await pushAhead(sideMembers(store, "realp")[0]))?.ok).toBe(true);   // the real push, once main is back
    } finally { delete process.env.DS_LIMIT_HOST_GRACE_MIN; store.close(); }
  }, 30_000);
});
