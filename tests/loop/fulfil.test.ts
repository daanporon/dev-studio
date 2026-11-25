// fulfil.test.ts — the squad, role, message and finish fulfillers. A message script on a migrated
// root writes a request whose payload is its replay; the loop runs that argv again as a child
// (DS_LOOP_CHILD=1, as the terminal that asked, in its cwd). Member and squad wishes are plain
// wishes the decider acts on in Bun (U159: the wish replay is gone). The children here are one
// fake script, so every test is hermetic: a copy of tests/fixtures/loop/state and no Orca.
import { beforeAll, afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { giveUpQueued } from "../../bin/loop/messages/replay.ts";
import { now, open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

// U150: a transient refusal is tried again every 15 minutes (DS_LOOP_RETRY_S); these tests step
// a retry one tick at a time. The spacing itself is tested in actuator.test.ts ("refusals").
beforeAll(() => { process.env.DS_LOOP_RETRY_S = "1"; });
afterAll(() => { delete process.env.DS_LOOP_RETRY_S; });

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;

const temps: string[] = [], stores: Store[] = [];
let tries: string | undefined;
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (tries === undefined) delete process.env.DS_LOOP_SEND_TRIES; else process.env.DS_LOOP_SEND_TRIES = tries;
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzfulfil-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}

// The child: logs how it was run, then does what its first argument says.
//   ok           prints "did <args>"
//   fail         "boom" on stderr, exit 1 (retried)
//   wait <epoch> "WAIT <epoch>", exit 3 (nothing free until then)
function child(s: Store): string {
  const f = join(s.root, "child.sh");
  writeFileSync(f, `#!/usr/bin/env bash
printf 'child=%s from=%s keep=%s root=%s cwd=%s orcafrom=%s args=%s\\n' "\${DS_LOOP_CHILD:-}" "\${ORCA_TERMINAL_HANDLE:-}" "\${DS_LOOP_KEEP_TERMINAL:-}" "\${DS_STATE_ROOT:-}" "$PWD" "\${DS_ORCA_FROM:-}" "$*" >> "$DS_STATE_ROOT/child.log"
case "$1" in
  ok) echo "did $*" ;;
  fail) echo "boom" >&2; exit 1 ;;
  wait) echo "WAIT $2: no account free"; exit 3 ;;
esac
`);
  chmodSync(f, 0o755);
  return f;
}
const runs = (s: Store) => (existsSync(join(s.root, "child.log")) ? readFileSync(join(s.root, "child.log"), "utf8").trim().split("\n") : []);
const replay = (s: Store, kind: string, key: string, ...args: string[]) => ({ kind, key, argv: [child(s), ...args], cwd: s.root, from: "term_asker" });

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
function rig(s: Store) {
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { const r = await loop.tick(at); await act.drain(); return r; };
  return { orca, act, loop, tick };
}
const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
const claim = (s: Store, subject: string, kind: string) => s.get("episodes", { project: "fx", subject, kind: `action:${kind}` });
const alerts = (s: Store) => {
  const f = join(s.root, "fx", "alerts.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((a) => a.title === "Lifecycle failed") : [];
};
const squad = (s: Store, topic: string) => s.db.query("SELECT * FROM squads WHERE project = 'fx' AND topic = ?").get(topic) as Row;
const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row;

describe("squad wishes (U158)", () => {
  test("a plain wish is acted on in Bun: suspended, with a pause intent and no child run", async () => {
    const s = imported(), a = rig(s);
    s.want("squad", "fx/demo", "suspended", { payload: { note: "by hand" } });
    await a.tick(T);
    const r = squad(s, "demo");
    expect(r.status).toBe("suspended");
    expect(String(r.want_result)).toContain("suspended");
    expect(runs(s)).toEqual([]);
    expect(s.db.query("SELECT 1 FROM pause_intents WHERE scope = 'squad' AND squad = 'demo' AND cleared_at IS NULL").get()).not.toBeNull();
  });

  test("a wish that still carries a script replay is not run: it fails once, asking again is the fix", async () => {
    const s = imported(), a = rig(s);
    s.want("squad", "fx/demo", "suspended", { payload: replay(s, "suspend-squad", "suspend-squad:fx/demo", "ok", "fx", "demo") });
    await a.tick(T);
    expect(runs(s)).toEqual([]);
    expect(String(squad(s, "demo").want_result)).toStartWith("failed:");
  });

  // U30: one rule for which backend a project's squads use, here through the wish (`ds want squad … --fill`).
  const wishOn = (s: Store, a: ReturnType<typeof rig>, topic: string, backend: string | null) => {
    s.want("squad", `fx/${topic}`, "running", { payload: { repo: "path:/fake", type: "feature" }, fill: { repo: "path:/fake", type: "feature", ...(backend ? { backend } : {}) }, by: "test" });
    return a.tick(T);
  };
  const refusedFor = (s: Store, topic: string) => String(squad(s, topic).want_result ?? "");
  test("U30: a squad wish naming another backend than the project's default_backend is refused with an event and a card, never started", async () => {
    const s = imported(), a = rig(s);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "default_backend" }, { value: "tmux", observed_at: T });
    // U54: no Studio here, so the project's default_backend alone rules (a Studio's own rule is squad-backend.test.ts).
    s.upsert("projects", { label: "fx" }, { studio_wt: null, observed_at: T });
    for (const b of ["orca", "herdr"]) {
      await wishOn(s, a, `t-${b}`, b);
      expect(refusedFor(s, `t-${b}`)).toContain(`failed: backend ${b} is refused: this project's squads start on tmux (its default_backend)`);
      expect(squad(s, `t-${b}`).doc).toBeNull();
      expect(squad(s, `t-${b}`).run_id).toBeNull();
    }
    expect(events(s, "wish_given_up").map((e) => e.error).filter((e) => String(e).includes("default_backend")).length).toBe(2);
    expect(alerts(s).length).toBe(2);
    // The project's own backend passes the rule (it starts; the Orca fake has no tmux here, so the result is not a refusal).
    await wishOn(s, a, "t-tmux", "tmux");
    expect(refusedFor(s, "t-tmux")).not.toContain("is refused");
  });

  test("U30: on an Orca project a wish naming orca (or none) is not refused, any other backend is", async () => {
    const s = imported(), a = rig(s);
    await wishOn(s, a, "t-lite", "orca-lite");
    // U54: the project's Studio runs on Orca, so the refusal names it and the move.
    expect(refusedFor(s, "t-lite")).toContain("backend orca-lite is refused: this project's Studio runs on orca");
    expect(refusedFor(s, "t-lite")).toContain("ds up fx --backend orca-lite");
    await wishOn(s, a, "t-orca", "orca");
    await wishOn(s, a, "t-none", null);
    for (const t of ["t-orca", "t-none"]) expect(refusedFor(s, t)).not.toContain("is refused");
  });

  test("closing a squad that is gone already archives it at once, without a child", async () => {
    const s = imported(), a = rig(s);
    s.want("squad", "fx/ghost", "gone");
    await a.tick(T);
    expect(runs(s)).toEqual([]);
    expect(squad(s, "ghost").status).toBe("closed");
    expect(String(squad(s, "ghost").want_result)).toContain("archived");
  });
});

// U159: the wish replay is gone. A wish still carrying a pre-U159 script replay is never run
// as a child again: no `role:` action is claimed for it, and the decider reads its want as a
// plain wish (a start for a dead Builder is pinned in decide.test.ts). The request replays below
// still run.
describe("stale script replays (U159)", () => {
  test("a member wish still carrying a script replay is never run as a child", async () => {
    const s = imported(), a = rig(s);
    const { row } = s.want("member", "fx/demo/builder/u7", "running", { payload: replay(s, "add-role", "add-role:fx/demo/builder-u7", "ok") });
    await a.tick(T);
    await a.tick(T + 1);
    expect(runs(s)).toEqual([]);
    expect(claim(s, "role:add-role:fx/demo/builder-u7", "role")).toBeNull();
    expect(member(s, Number(row.id))).toMatchObject({ want: "running", want_result: null });
  });

  test("a wish still waiting when the loop left for a rollback does not run after the re-switch; asked again it is a plain wish, never a child run", async () => {
    const s = imported(), a = rig(s);
    const { row } = s.want("member", "fx/demo/builder/u7", "running", { payload: replay(s, "add-role", "add-role:fx/demo/builder-u7", "wait", String(T + 600)) });
    await a.tick(T);
    expect(claim(s, "role:add-role:fx/demo/builder-u7", "role")).toBeNull();
    const open = () => (s.db.query("SELECT count(*) AS n FROM requests WHERE key LIKE 'file:%' AND done_at IS NULL").get() as { n: number }).n;
    const fromFiles = open();
    expect(fromFiles).toBeGreaterThan(0);
    expect(giveUpQueued(s, now() + 1).map((q) => q.what)).toEqual(["add-role"]);
    expect(open()).toBe(fromFiles);
    const b = rig(s);   // the loop the re-switch starts
    await b.tick(T + 600);
    expect(runs(s)).toEqual([]);
    expect(claim(s, "role:add-role:fx/demo/builder-u7", "role")).toBeNull();
    expect(String(member(s, Number(row.id)).want_result)).toStartWith("failed: queued before a rollback");
    expect(giveUpQueued(s, now() + 1)).toEqual([]);
    s.want("member", "fx/demo/builder/u7", "running", { payload: replay(s, "add-role", "add-role:fx/demo/builder-u7", "ok"), rearm: true });
    await b.tick(T + 601);
    expect(runs(s)).toEqual([]);
    expect(claim(s, "role:add-role:fx/demo/builder-u7", "role")).toBeNull();
  });

  test("reassert-roles is a request the role fulfiller runs", async () => {
    const s = imported(), a = rig(s);
    const { row } = s.request("reassert-roles", replay(s, "reassert-roles", "reassert-roles:fx:k", "ok", "fx"), { key: "reassert-roles:fx:k", project: "fx" });
    await a.tick(T);
    const r = s.db.query("SELECT * FROM requests WHERE id = ?").get(Number(row.id)) as Row;
    expect(r.done_at).toBe(T);
    expect(JSON.parse(String(r.result))).toEqual({ ok: true, out: "did ok fx" });
  });
});

describe("message and finish requests", () => {
  test("a send runs its replay once and the request is done with the output", async () => {
    const s = imported(), a = rig(s);
    const { row } = s.request("send-role", replay(s, "send-role", "send-role:fx:k", "ok", "demo", "lead"), { key: "send-role:fx:k", project: "fx", squad: "demo" });
    await a.loop.tick(T);
    expect(claim(s, `req:${row.id}`, "send-role")!.state).toBe("running");
    await a.act.drain();
    const r = s.db.query("SELECT * FROM requests WHERE id = ?").get(Number(row.id)) as Row;
    expect(r.done_at).toBe(T);
    expect(JSON.parse(String(r.result))).toEqual({ ok: true, out: "did ok demo lead" });
    expect(runs(s)).toEqual([`child=1 from=term_asker keep= root=${s.root} cwd=${s.root} orcafrom= args=ok demo lead`]);
  });

  test("a failing finish keeps its request open with the error and a toast, then fails it with an alert", async () => {
    tries = process.env.DS_LOOP_SEND_TRIES;
    process.env.DS_LOOP_SEND_TRIES = "2";
    const s = imported(), a = rig(s);
    const { row } = s.request("finish-unit", replay(s, "finish-unit", "finish-unit:fx/demo/u1@abc", "fail"), { key: "finish-unit:fx/demo/u1@abc", project: "fx", squad: "demo" });
    const get = () => s.db.query("SELECT * FROM requests WHERE id = ?").get(Number(row.id)) as Row;
    await a.tick(T);
    expect(get().done_at).toBeNull();
    expect(JSON.parse(String(get().result))).toEqual({ ok: false, error: "child.sh exit 1: boom", retrying: true });
    expect(events(s, "toast").map((e) => e.text)).toEqual(["child.sh exit 1: boom"]);
    await a.tick(T + 1);
    expect(get().done_at).toBe(T + 1);
    expect(JSON.parse(String(get().result))).toEqual({ ok: false, error: "child.sh exit 1: boom" });
    expect(alerts(s).map((x) => x.question)).toEqual(["The loop could not run finish-unit: child.sh exit 1: boom"]);
    expect(runs(s)).toHaveLength(2);
    // Given up, the same key asks again.
    expect(s.request("finish-unit", replay(s, "finish-unit", "finish-unit:fx/demo/u1@abc", "ok"), { key: "finish-unit:fx/demo/u1@abc", project: "fx", squad: "demo" }).created).toBe(true);
  });

  describe("U11: a finish-unit for a unit already finished", () => {
    const key = "finish-unit:fx/demo/u1@abc";
    function setup(status: string, cwd: string | null, pr?: string, prState?: string) {
      const s = imported(), a = rig(s);
      s.db.run("DELETE FROM units WHERE project = 'fx' AND squad = 'demo' AND slug = 'u1'");
      s.db.run("INSERT INTO units (project, squad, slug, status, pr, observed_at, updated_at) VALUES ('fx', 'demo', 'u1', ?, ?, ?, ?)", [status, pr ?? null, T, T]);
      if (prState) s.db.run("INSERT INTO observed_prs (project, ref, pr, state, observed_at) VALUES ('fx', 'r', 7, ?, ?)", [prState, T]);
      const rp = replay(s, "finish-unit", key, "fail");
      if (cwd !== null) rp.cwd = cwd;
      const { row } = s.request("finish-unit", rp, { key, project: "fx", squad: "demo" });
      return { s, a, id: Number(row.id) };
    }
    async function check(x: ReturnType<typeof setup>) {
      await x.a.tick(T);
      const r = x.s.db.query("SELECT * FROM requests WHERE id = ?").get(x.id) as Row;
      expect(r.done_at).toBe(T);
      expect(JSON.parse(String(r.result))).toEqual({ ok: true, skipped: "already finished" });
      expect(runs(x.s)).toHaveLength(0);
      expect(x.s.db.query("SELECT count(*) AS n FROM refusals").get()).toEqual({ n: 0 });
      expect(alerts(x.s)).toHaveLength(0);
    }
    test("a done unit with a missing cwd ends done, skipped", async () => { await check(setup("done", "/nonexistent/u11-wt")); });
    test("a done unit with an existing cwd is skipped too", async () => { await check(setup("done", null)); });
    test("a gone cwd with a merged PR is skipped", async () => { await check(setup("dispatched", "/nonexistent/u11-wt", "#7", "MERGED")); });
    test("a unit still dispatched runs the script as before", async () => {
      const x = setup("dispatched", null);
      await x.a.tick(T);
      expect(runs(x.s)).toHaveLength(1);
      expect((x.s.db.query("SELECT done_at FROM requests WHERE id = ?").get(x.id) as Row).done_at).toBeNull();
    });
  });

  test("a send without --project alerts its squad's project when given up and its sender can't be told (U75: else it is poked)", async () => {
    tries = process.env.DS_LOOP_SEND_TRIES;
    process.env.DS_LOOP_SEND_TRIES = "1";
    const s = imported(), a = rig(s);
    s.db.run("INSERT INTO observed_terminals (project, handle, observed_at) VALUES ('fx', 'term_asker', 100)");
    a.orca.fail("poke-terminal", { code: 1, out: "", err: "terminal send failed" });
    s.request("send-peer", replay(s, "send-peer", "send-peer::k", "fail"), { key: "send-peer::k", squad: "demo" });
    await a.tick(T);
    const f = join(s.root, "fx", "alerts.json");
    expect((JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((x) => x.title === "Message not delivered")).toHaveLength(1);
  });
  test("a standing role's send-peer goes out --from its squad's sender pane, still as the asker (U64)", async () => {
    const s = imported(), a = rig(s);
    const th = s.db.query("SELECT wt FROM members WHERE role = 'thinker'").get() as Row;
    s.db.run("INSERT INTO observed_terminals (project, handle, wt, observed_at) VALUES ('fx', 'term_asker', ?, ?)", [th.wt, T]);
    s.request("send-peer", replay(s, "send-peer", "send-peer:fx:k", "ok", "peer"), { key: "send-peer:fx:k", project: "fx", squad: "other" });
    await a.tick(T);
    expect(runs(s)[0]).toMatch(/from=term_asker .*orcafrom=term_1 args=ok peer/);
    // An asker the loop can't place in a squad sends as itself.
    s.request("send-peer", { ...replay(s, "send-peer", "send-peer:fx:k2", "ok", "solo"), from: "term_x" }, { key: "send-peer:fx:k2", project: "fx", squad: "other" });
    await a.tick(T + 1);
    expect(runs(s)[1]).toMatch(/from=term_x .*orcafrom= args=ok solo/);
  });
});
