// archive-stuck-worktrees U1: a worktree removal close.ts dropped as stale (Orca still listed the stopped
// agent's dispatch as live, so presence read running) is tried again under a new episode with backoff and
// no cap, one Archive slow card from the third stale drop on, until the squad archives.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import decider from "../../bin/loop/core/decide.ts";
import { removeRetry, removeWaitS } from "../../bin/loop/squad/close-drift.ts";
import { alertGone } from "../../bin/loop/reconcilers/alerts.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

const T = 1_800_000_000;
const ENV = ["DS_CLOSE_ROLE", "BACKEND", "FAKE_LOG", "DS_CLAUDE_TMP_ROOT", "DS_TIDY_WAIT_MS"];
const saved = new Map(ENV.map((k) => [k, process.env[k]]));
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const REPO = join(import.meta.dir, "..", "..");
function gitIn(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args]);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

describe("removeRetry: the backoff and the card", () => {
  test("no drop: the base episode; a stale drop waits, then retry<n> at 6, 12, 24, 30, 30 min; a card from the third drop", () => {
    const root = mkdtempSync(join(tmpdir(), "rr-")); roots.push(root);
    const s = open(root); stores.push(s);
    s.upsert("projects", { label: "p" }, { observed_at: 1 });
    s.upsert("members", { project: "p", squad: "one", role: "lead", suffix: "" }, { wt: "r::/x/lead", status: "running", want: "running", want_at: T - 1000, observed_at: 1, updated_at: 1 });
    const m = s.get("members", { project: "p", squad: "one", role: "lead", suffix: "" })!;
    const base = `close:remove:archived:${T - 1000}`, key = { project: "p", subject: `member:${m.id}`, kind: "action:member.close" };
    expect(removeRetry(s, m, base, T)).toEqual({ episode: base, tries: 0 });
    expect([1, 2, 3, 4, 5].map((n) => removeWaitS(s, "p", n - 1) / 60)).toEqual([6, 12, 24, 30, 30]);
    // A try under way keeps its key.
    s.upsert("episodes", key, { episode_key: base, state: "acted", started_at: T, source: "loop", observed_at: T });
    expect(removeRetry(s, m, base, T)).toEqual({ episode: base, tries: 0 });
    // Another wish's episode: the base.
    s.upsert("episodes", key, { episode_key: "close:remove:archived:1", state: "dropped", result: "stale", ended_at: T });
    expect(removeRetry(s, m, base, T + 9999)).toEqual({ episode: base, tries: 0 });
    let at = T;
    for (let n = 0; n < 5; n++) {
      const ep = n ? `${base}:retry${n}` : base, wait = removeWaitS(s, "p", n);
      s.upsert("episodes", key, { episode_key: ep, state: "dropped", result: "stale: presence running", ended_at: at });
      const w = removeRetry(s, m, base, at + wait - 1);
      expect(w).toMatchObject({ episode: ep, wait: true, tries: n + 1, next_at: at + wait, reason: "presence running" });
      expect(!!w.card).toBe(n + 1 >= 3);
      at += wait;
      expect(removeRetry(s, m, base, at)).toMatchObject({ episode: `${base}:retry${n + 1}`, tries: n + 1 });
      expect(removeRetry(s, m, base, at).wait).toBeUndefined();
    }
    // A drop for another reason (episode ended) is not retried: the claim keeps holding it.
    s.upsert("episodes", key, { episode_key: `${base}:retry5`, state: "dropped", result: "episode ended", ended_at: at });
    expect(removeRetry(s, m, base, at + 99999)).toEqual({ episode: `${base}:retry5`, tries: 5 });
  });
});

// The loop end to end on the fake Orca: the decider, the close fulfiller and the squad's archive.
function rig() {
  const t = mkdtempSync(join(tmpdir(), "rr-loop-")); roots.push(t);
  const S = join(t, "state"), wt = join(t, "wt"), bare = join(t, "remote.git");
  for (const f of ["bin", "conventions", "roles", "AGENTS.md"]) symlinkSync(join(REPO, f), join(t, f));
  mkdirSync(join(S, "fx", "squads"), { recursive: true }); mkdirSync(bare); mkdirSync(wt);
  gitIn(bare, "init", "-q", "--bare"); gitIn(wt, "init", "-q", "-b", "work");
  writeFileSync(join(wt, ".gitignore"), "CLAUDE.local.md\n"); gitIn(wt, "add", "."); gitIn(wt, "commit", "-qm", "one");
  gitIn(wt, "remote", "add", "origin", bare); gitIn(wt, "push", "-q", "origin", "work");
  writeFileSync(join(S, "fx", "dispatcher.json"), '{"home_repo":"fx"}');
  writeFileSync(join(S, "fx", "squads", "t1.json"), JSON.stringify({ topic: "t1", repo: "fx", type: "feature", status: "done", run_id: "run1", lead_wt: "wtl",
    worktrees: ["wtl"], members: [{ role: "lead", wt: "wtl" }], units: [] }));
  const s = open(S); stores.push(s); importJson(s); writeFileSync(join(S, ".loop-migrated"), "");
  const fake = join(t, "fakeb");
  writeFileSync(fake, "#!/usr/bin/env bash\ncase \"$1\" in current) echo wt-elsewhere ;; ps) echo '{\"result\":{\"worktrees\":[]}}' ;; *) echo '{}' ;; esac\n");
  Bun.spawnSync(["chmod", "755", fake]);
  Object.assign(process.env, { DS_CLOSE_ROLE: join(t, "bin", "close-role.sh"), BACKEND: fake, FAKE_LOG: join(t, "backend.log"), DS_CLAUDE_TMP_ROOT: join(t, "claude-tmp"), DS_TIDY_WAIT_MS: "300" });
  s.upsert("config", { project: "fx", file: "limits.conf", key: "archive_debrief_min" }, { value: "0", observed_at: T });
  const lead = s.db.query("SELECT * FROM members WHERE project = 'fx' AND wt = 'wtl' ORDER BY id DESC").get() as Row;
  const wantAt = T - 600;
  s.upsert("squads", { project: "fx", topic: "t1" }, { want: "gone", want_at: wantAt, want_result: null });
  s.upsert("members", { id: lead.id }, { status: "running", want_at: wantAt });
  // The loop stopped the Lead (member_stopped), the walk since finds no agent, yet Orca still lists its dispatch.
  s.event("member_stopped", { project: "fx", squad: "t1", member: "wtl", payload: { id: Number(lead.id), sent_at: T - 300 } });
  s.upsert("observed_workers", { project: "fx", wt: "wtl" }, { presence: "running", walk: "none", state: "idle", account_at: T - 60, observed_at: T });
  s.upsert("observed_worktrees", { project: "fx", wt: "wtl" }, { path: wt, branch: "work", observed_at: T });
  const orca = new FakeBackend();
  const fulfillers = loaded.filter((f) => f.kinds);
  const act = new LoopActuator({ orca, fulfillers });
  const loop = new Loop(s, { observers: [], reconcilers: [decider as Reconciler, ...loaded] }, act, { projects: () => ["fx"] }); loop.boot(T);
  const tick = async (at: number) => { s.upsert("observed_workers", { project: "fx", wt: "wtl" }, { observed_at: at, account_at: at }); await loop.tick(at); await act.drain(); };
  const squad = () => s.db.query("SELECT status, want_result FROM squads WHERE project = 'fx' AND topic = 't1' ORDER BY id DESC").get() as Row;
  const cards = () => { const f = join(S, "fx", "alerts.json"); return existsSync(f) ? ((JSON.parse(readFileSync(f, "utf8")) as { alerts: Row[] }).alerts ?? []).filter((c) => c.kind === "archive_slow") : []; };
  const episode = () => s.get("episodes", { project: "fx", subject: `member:${lead.id}`, kind: "action:member.close" });
  return { s, wt, orca, tick, squad, cards, episode };
}
const loaded = await load<Fulfiller & Reconciler>(DIRS.fulfil);

describe("a stale-dropped removal is retried until the squad archives", () => {
  test("dropped stale while presence reads running; once it reads none the retry removes the tree and the squad closes", async () => {
    const r = rig();
    await r.tick(T);
    const base = String(r.episode()!.episode_key);
    expect(base).toMatch(/^close:remove:archived:[0-9]+$/);
    expect(r.episode()).toMatchObject({ episode_key: base, state: "dropped", result: "stale: presence running" });
    expect(r.orca.of("worktree-rm")).toEqual([]);
    // Orca settles the dispatch: presence reads none. Inside the wait nothing runs.
    r.s.upsert("observed_workers", { project: "fx", wt: "wtl" }, { presence: "none" });
    await r.tick(T + 300);
    expect(r.episode()!.episode_key).toBe(base);
    await r.tick(T + 361);
    expect(r.episode()).toMatchObject({ episode_key: `${base}:retry1`, state: "done" });
    expect(r.orca.of("worktree-rm")).toHaveLength(1);
    await r.tick(T + 400);
    await r.tick(T + 440);
    expect(r.squad().status).toBe("closed");
    expect(r.cards()).toEqual([]);
  });

  test("five stale drops: a retry at each backoff time, exactly one card; then the retry archives and the card clears", async () => {
    const r = rig();
    let at = T;
    await r.tick(at);
    const base = String(r.episode()!.episode_key);
    const ends: number[] = [Number(r.episode()!.ended_at)];
    for (let n = 1; n <= 4; n++) {
      const wait = removeWaitS(r.s, "fx", n - 1);
      await r.tick(at + wait - 5);
      expect(r.episode()!.episode_key).toBe(n === 1 ? base : `${base}:retry${n - 1}`);
      at += wait;
      await r.tick(at);
      expect(r.episode()).toMatchObject({ episode_key: `${base}:retry${n}`, state: "dropped", result: "stale: presence running" });
      ends.push(Number(r.episode()!.ended_at));
    }
    // Five stale drops so far (the base and four retries), 6, 12, 24 and 30 min apart.
    expect(ends.slice(1).map((e, i) => (e - ends[i]) / 60)).toEqual([6, 12, 24, 30]);
    expect(r.cards()).toHaveLength(1);
    expect(r.orca.of("worktree-rm")).toEqual([]);
    const card = r.cards()[0];
    expect(card).toMatchObject({ title: "t1 · lead: Archive slow: t1", squad: "t1", member: "wtl", options: ["Seen"] });
    expect(String(card.question)).toContain(r.wt);
    expect(String(card.question)).toContain("presence running");
    const alert = { kind: "archive_slow", member: "wtl", squad: "t1" };
    expect(alertGone(r.s, "fx", alert)).toBe(false);
    // The fifth retry comes 30 min after the fourth; presence now reads none, so it removes the tree.
    r.s.upsert("observed_workers", { project: "fx", wt: "wtl" }, { presence: "none" });
    at += removeWaitS(r.s, "fx", 4);
    expect(removeWaitS(r.s, "fx", 4)).toBe(30 * 60);
    await r.tick(at);
    expect(r.episode()).toMatchObject({ episode_key: `${base}:retry5`, state: "done" });
    expect(r.orca.of("worktree-rm")).toHaveLength(1);
    await r.tick(at + 40); await r.tick(at + 80);
    expect(r.squad().status).toBe("closed");
    expect(r.cards()).toHaveLength(1);
    expect(alertGone(r.s, "fx", alert)).toBeTruthy();
    expect(existsSync(join(r.s.root, "fx", "squads", "t1.json"))).toBe(false);
  });

  test("Archive slow clears once the squad is no longer wanted gone", () => {
    const r = rig();
    const alert = { kind: "archive_slow", member: "wtl", squad: "t1" };
    expect(alertGone(r.s, "fx", alert)).toBe(false);
    r.s.upsert("squads", { project: "fx", topic: "t1" }, { want: "running" });
    expect(alertGone(r.s, "fx", alert)).toBe("its squad is no longer closing");
  });
});
