// expose-stop.test.ts — exposed-cleanup U2: a done or closing squad ends every entry; an entry that ends
// with its squad or owner queues its stop command (never on down alone or a manual unexpose); the
// reconciler groups queued stops (one run per owner and command, skips what is still exposed or already
// stopped), settles a stop the loop lost, and raises one alert per failed group; the fulfiller claims a
// group once and runs it in the owner's worktree, else the state folder; a removal waits for the stops.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reconciler from "../../bin/loop/reconcilers/exposed.ts";
import fulfiller from "../../bin/loop/fulfil/expose-stop.ts";
import { endExposed, removalHold, stopGroups, stopsPending } from "../../bin/loop/squad/exposed.ts";
import type { Action, TickCtx } from "../../bin/loop/core/plugins.ts";
import type { Exec, Result } from "../../bin/loop/core/actuator.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

const roots: string[] = [];
const saved = process.env.DS_TIDY_WAIT_MS;
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
  if (saved === undefined) delete process.env.DS_TIDY_WAIT_MS; else process.env.DS_TIDY_WAIT_MS = saved;
});

function fixture() {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "expose-stop-")); roots.push(root);
  const s = open(join(root, "state"));
  const wt = (name: string) => { const p = join(root, name); mkdirSync(p); return `r::${p}`; };
  const w = { lead: wt("lead"), builder: wt("builder"), tester: wt("tester") };
  s.upsert("squads", { project: "p", topic: "t" }, { status: "running", lead_wt: w.lead, observed_at: 1, updated_at: 1 });
  for (const [role, id] of [["builder", w.builder], ["tester", w.tester]])
    s.upsert("members", { project: "p", squad: "t", wt: id }, { role, status: "running", observed_at: 1, updated_at: 1 });
  let n = 0;
  const entry = (owner_wt: string, scope: "member" | "squad", stop: string | null, more: Row = {}) => {
    const name = String(more.name ?? `e${++n}`);
    s.upsert("exposed", { project: "p", squad: "t", owner_wt, name, gone_at: null },
      { role: "tester", url: "http://localhost:1", scope, stop_cmd: stop, updated_at: 1, ...more });
    return Number((s.db.query("SELECT id FROM exposed WHERE name = ? ORDER BY id DESC").get(name) as Row).id);
  };
  const row = (id: number) => s.db.query("SELECT * FROM exposed WHERE id = ?").get(id) as Row;
  const result = (id: number) => JSON.parse(String(row(id).stop_result)) as Row;
  const run = (now: number) => reconciler.run({ store: s, project: "p", tick: 1, now, fired: [], poked: new Set() } as TickCtx) as Action[];
  const exec = async (a: Action, now = 2_000): Promise<Result> => {
    const r = await fulfiller.exec(a, { store: s, project: "p", now } as unknown as Exec);
    return "background" in r ? await r.background : r;
  };
  const setLimit = (key: string, value: string) => s.upsert("config", { project: "p", file: "limits.conf", key }, { value, observed_at: 1 });
  return { root, s, w, entry, row, result, run, exec, setLimit };
}
const pathOf = (wt: string) => wt.slice(wt.indexOf("::") + 2);
const stops = (as: Action[]) => as.filter((a) => a.kind === "expose.stop");
const alerts = (as: Action[]) => as.filter((a) => a.kind === "alert");
const events = (s: Store, kind: string) => s.db.query("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[];

test("a done squad ends every entry (squad-done), member and squad scope, and queues their stops", () => {
  const f = fixture();
  const a = f.entry(f.w.tester, "squad", "echo down"), b = f.entry(f.w.builder, "member", null);
  f.s.db.run("UPDATE squads SET status = 'done'");
  f.run(1_000);
  expect(f.row(a)).toMatchObject({ gone_why: "squad-done", stop_state: "queued" });
  expect(f.row(b)).toMatchObject({ gone_why: "squad-done", stop_state: null });
  expect(Number(f.row(a).stop_at)).toBeGreaterThan(0);
});

test("a squad wished gone ends its entries as squad-closed", () => {
  const f = fixture();
  const a = f.entry(f.w.tester, "squad", "echo down");
  f.s.db.run("UPDATE squads SET want = 'gone'");
  f.run(1_000);
  expect(f.row(a)).toMatchObject({ gone_why: "squad-closed", stop_state: "queued" });
});

test("down and a manual unexpose never queue a stop; a down row's late stop queues once its squad ends", () => {
  const f = fixture();
  const down = f.entry(f.w.tester, "squad", "echo down"), manual = f.entry(f.w.tester, "squad", "echo down2");
  f.s.upsert("observed_exposed", { exposed_id: down }, { status: "down", reach: "down", probed_at: 1, down_since: 10 });
  f.run(10 + 15 * 60);
  expect(f.row(down)).toMatchObject({ gone_why: "down", stop_state: null });
  endExposed(f.s, f.row(manual), "unexposed", "tester");
  expect(f.row(manual).stop_state).toBeNull();
  f.s.db.run("UPDATE squads SET status = 'closed'");
  f.run(2_000);
  expect(f.row(down).stop_state).toBe("queued");
  expect(f.row(manual).stop_state).toBeNull();
});

test("two entries with one owner and one command are one stop run; the result lands on both rows", async () => {
  const f = fixture();
  const a = f.entry(f.w.tester, "squad", "echo stopped > stopped.txt"), b = f.entry(f.w.tester, "squad", "echo stopped > stopped.txt");
  f.s.db.run("UPDATE squads SET status = 'done'");
  const [act] = stops(f.run(1_000));
  expect(stops(f.run(1_001))).toHaveLength(1);
  expect(act).toMatchObject({ subject: `expose-stop:${a}`, episode: `expose-stop:${a}`, squad: "t", payload: { ids: [a, b], cmd: "echo stopped > stopped.txt", cwd: pathOf(f.w.tester) } });
  expect(act).not.toHaveProperty("member");
  expect(await f.exec(act)).toMatchObject({ done: true });
  expect(readFileSync(join(pathOf(f.w.tester), "stopped.txt"), "utf8")).toBe("stopped\n");
  for (const id of [a, b]) {
    expect(f.row(id).stop_state).toBe("done");
    expect(f.result(id)).toMatchObject({ ids: [a, b], code: 0, timed_out: false, cwd: pathOf(f.w.tester), cwd_fallback: false });
  }
  const [ev] = events(f.s, "expose_stop");
  expect(JSON.parse(String(ev.payload))).toMatchObject({ ids: [a, b], state: "done", code: 0 });
  // A replay (the same action after a restart) runs nothing: the rows are no longer queued.
  rmSync(join(pathOf(f.w.tester), "stopped.txt"));
  expect(await f.exec(act)).toMatchObject({ done: true, result: "nothing queued" });
  expect(existsSync(join(pathOf(f.w.tester), "stopped.txt"))).toBe(false);
  expect(stops(f.run(1_002))).toHaveLength(0);
});

test("a stop whose stack another open entry still exposes is skipped, naming it", () => {
  const f = fixture();
  const gone = f.entry(f.w.tester, "member", "docker compose down", { name: "api" });
  f.entry(f.w.tester, "squad", "docker compose down", { name: "console" });
  endExposed(f.s, f.row(gone), "owner-gone", "loop");
  expect(stops(f.run(1_000))).toHaveLength(0);
  expect(f.row(gone).stop_state).toBe("skipped");
  expect(f.result(gone).skipped).toContain("'console'");
});

test("a stop whose group already stopped after the row was registered is skipped", () => {
  const f = fixture();
  const old = f.entry(f.w.tester, "squad", "echo x", { name: "a", created_at: 100 });
  f.s.db.run("UPDATE exposed SET gone_at = 150, gone_why = 'squad-done', stop_state = 'done', stop_at = 200, stop_result = '{}' WHERE id = ?", [old]);
  const later = f.entry(f.w.tester, "squad", "echo x", { name: "b", created_at: 120 });
  endExposed(f.s, f.row(later), "owner-gone", "loop");
  expect(stopGroups(f.s, "p").run).toHaveLength(0);
  f.run(1_000);
  expect(f.row(later).stop_state).toBe("skipped");
  expect(f.result(later).skipped).toContain(`entry ${old}`);
});

test("the owner's worktree gone: the stop runs in the project's state folder (cwd_fallback)", async () => {
  const f = fixture();
  const a = f.entry(f.w.tester, "squad", "pwd");
  rmSync(pathOf(f.w.tester), { recursive: true });
  f.s.db.run("UPDATE squads SET status = 'done'");
  const [act] = stops(f.run(1_000));
  await f.exec(act);
  expect(f.result(a)).toMatchObject({ code: 0, cwd: join(f.s.root, "p"), cwd_fallback: true });
  expect(String(f.result(a).tail)).toContain(join(f.s.root, "p"));
});

test("a failed stop settles failed with its exit code and raises one Studio alert naming entry, command, code, squad", async () => {
  const f = fixture();
  const a = f.entry(f.w.tester, "squad", "echo nope; exit 3", { name: "stack" });
  f.s.db.run("UPDATE squads SET status = 'done'");
  await f.exec(stops(f.run(1_000))[0]);
  expect(f.row(a).stop_state).toBe("failed");
  expect(f.result(a)).toMatchObject({ code: 3, timed_out: false });
  expect(String(f.result(a).tail)).toContain("nope");
  const al = alerts(f.run(1_001));
  expect(al).toHaveLength(1);
  expect(al[0]).toMatchObject({ squad: null, subject: `expose-stop:${a}`, episode: `expose-stop:${a}` });
  const text = String((al[0].payload as Row).text);
  for (const s of ["'stack'", "echo nope; exit 3", "exit code 3", "squad t"]) expect(text).toContain(s);
  // Already alerted for this episode: no second card.
  f.s.upsert("episodes", { project: "p", subject: `expose-stop:${a}`, kind: "alerted" }, { state: JSON.stringify([`expose-stop:${a}`]), source: "loop", observed_at: 1 });
  expect(alerts(f.run(1_002))).toHaveLength(0);
});

// A late stop on a stack the probe saw down (U1 of loop-notes-review): no card unless something still listens.
async function downThenFailed(f: ReturnType<typeof fixture>, more: Row = {}, owner = "squad" as "squad" | "member") {
  const id = f.entry(f.w.tester, owner, "exit 1", { url: "http://localhost:4321", ...more });
  f.s.upsert("observed_exposed", { exposed_id: id }, { status: "down", reach: "down", probed_at: 1, down_since: 10 });
  f.run(10 + 15 * 60);
  expect(f.row(id).gone_why).toBe("down");
  f.s.db.run("UPDATE squads SET status = 'closed'");
  await f.exec(stops(f.run(2_000))[0]);
  expect(f.row(id).stop_state).toBe("failed");
  return id;
}

test("a failed late stop of a down group with nothing listening raises no card, and stays recorded", async () => {
  const f = fixture();
  const id = await downThenFailed(f);
  expect(alerts(f.run(2_001))).toHaveLength(0);
  expect(f.row(id).stop_state).toBe("failed");
  expect(events(f.s, "expose_stop").length).toBeGreaterThan(0);
});

test("the same down group with its port in a live observed_procs listen row raises one card", async () => {
  const f = fixture();
  await downThenFailed(f, { ports: "[5555]" });
  f.s.upsert("observed_procs", { project: "p", wt: f.w.tester }, { observed_at: 1, listen: JSON.stringify([{ port: 5555, since: 1, comm: "x", addr: "any", src: "proc" }]) });
  expect(alerts(f.run(2_001))).toHaveLength(1);
});

test("an owner-gone group with a failed stop still raises one card", async () => {
  const f = fixture();
  const id = f.entry(f.w.tester, "member", "exit 1");
  f.s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [f.w.tester]);
  f.run(1_000);
  expect(f.row(id).gone_why).toBe("owner-gone");
  await f.exec(stops(f.run(1_001))[0]);
  expect(f.row(id).stop_state).toBe("failed");
  expect(alerts(f.run(1_002))).toHaveLength(1);
});

test("a mixed group (one down, one owner-gone) raises one card", async () => {
  const f = fixture();
  const a = f.entry(f.w.tester, "squad", "exit 1", { url: "http://localhost:4321" }), b = f.entry(f.w.tester, "squad", "exit 1", { url: "http://localhost:4322" });
  f.s.db.run("UPDATE exposed SET gone_at = 5, gone_why = 'down', stop_state = 'failed', stop_result = ? WHERE id = ?", [JSON.stringify({ ids: [a, b], code: 1 }), a]);
  f.s.db.run("UPDATE exposed SET gone_at = 5, gone_why = 'owner-gone', stop_state = 'failed', stop_result = ? WHERE id = ?", [JSON.stringify({ ids: [a, b], code: 1 }), b]);
  expect(alerts(f.run(2_001))).toHaveLength(1);
});

test("the alert shows a secret in the stop command redacted", async () => {
  const f = fixture();
  f.entry(f.w.tester, "squad", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' http://localhost:1/stop; exit 1");
  f.s.db.run("UPDATE squads SET status = 'done'");
  await f.exec(stops(f.run(1_000))[0]);
  const text = String((alerts(f.run(1_001))[0].payload as Row).text);
  expect(text).toContain("[redacted]");
  expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
});

test("a hanging stop is stopped at expose_stop_s and settles timeout", async () => {
  const f = fixture();
  f.setLimit("expose_stop_s", "1");
  process.env.DS_TIDY_WAIT_MS = "100";
  const a = f.entry(f.w.tester, "squad", "sleep 30");
  f.s.db.run("UPDATE squads SET status = 'done'");
  const t0 = Date.now();
  await f.exec(stops(f.run(1_000))[0]);
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(f.row(a).stop_state).toBe("timeout");
  expect(f.result(a)).toMatchObject({ timed_out: true, code: null });
  expect(String((alerts(f.run(1_001))[0].payload as Row).text)).toContain("timed out");
});

test("a stop left running past expose_stop_s + 60 s is lost, never run again, and alerts once per group", () => {
  const f = fixture();
  const a = f.entry(f.w.tester, "squad", "echo x"), b = f.entry(f.w.tester, "squad", "echo x");
  f.s.db.run(`UPDATE exposed SET gone_at = 900, gone_why = 'squad-done', stop_state = 'running', stop_at = 1000, stop_result = '{"ids":[${a},${b}]}'`);
  f.s.db.run("UPDATE squads SET status = 'done'");
  expect(f.run(1000 + 150).filter((x) => x.kind !== "alert")).toHaveLength(0);
  expect(f.row(a).stop_state).toBe("running");
  const out = f.run(1000 + 151);
  expect(stops(out)).toHaveLength(0);
  expect([f.row(a).stop_state, f.row(b).stop_state]).toEqual(["lost", "lost"]);
  expect(f.result(b).ids).toEqual([a, b]);
  expect(events(f.s, "expose_stop")).toHaveLength(1);
  expect(alerts(out)).toHaveLength(1);
  expect(String((alerts(out)[0].payload as Row).text)).toContain("lost");
});

test("removalHold ends the worktree's member entries, waits for their stops, and a squad entry only when the squad ends", () => {
  const f = fixture();
  const mine = f.entry(f.w.tester, "member", "echo m", { name: "mine" }), shared = f.entry(f.w.tester, "squad", "echo s", { name: "shared" });
  expect(removalHold(f.s, "p", f.w.tester, "owner-gone", 1_000)).toBe("stop commands: mine");
  expect(f.row(mine)).toMatchObject({ gone_why: "owner-gone", stop_state: "queued" });
  expect(f.row(shared).gone_at).toBeNull();
  f.s.db.run("UPDATE exposed SET stop_state = 'done' WHERE id = ?", [mine]);
  expect(removalHold(f.s, "p", f.w.tester, "owner-gone", 1_001)).toBeNull();
  f.s.db.run("UPDATE squads SET want = 'gone'");
  expect(removalHold(f.s, "p", f.w.tester, "owner-gone", 1_002)).toBe("stop commands: shared");
  expect(f.row(shared).gone_why).toBe("squad-closed");
});

test("a suspended member's entries end worktree-removed; a down row's late stop queues on removal", () => {
  const f = fixture();
  const a = f.entry(f.w.tester, "member", "echo a"), d = f.entry(f.w.tester, "member", "echo d");
  f.s.db.run("UPDATE exposed SET gone_at = 5, gone_why = 'down' WHERE id = ?", [d]);
  removalHold(f.s, "p", f.w.tester, "worktree-removed", 1_000);
  expect(f.row(a)).toMatchObject({ gone_why: "worktree-removed", stop_state: "queued" });
  expect(f.row(d)).toMatchObject({ gone_why: "down", stop_state: "queued" });
});

test("a close waits at most expose_stop_s + 180 s for a stop, then goes on with one expose_stop_wait_over event", () => {
  const f = fixture();
  const a = f.entry(f.w.tester, "member", "echo a");
  endExposed(f.s, f.row(a), "owner-gone", "loop");
  const at = Number(f.row(a).stop_at);
  expect(stopsPending(f.s, { project: "p", wt: f.w.tester }, at + 270, 90)).toEqual([f.row(a).name]);
  expect(stopsPending(f.s, { project: "p", wt: f.w.tester }, at + 271, 90)).toEqual([]);
  expect(stopsPending(f.s, { project: "p", squad: "t" }, at + 400, 90)).toEqual([]);
  expect(events(f.s, "expose_stop_wait_over")).toHaveLength(1);
});

// side-loop-host u8b: the stop of an entry a side member owns runs on that host as the `expose.stop` host job, never
// on main; held while the host is unreachable, settled lost once the host or the owner is fenced.
function sideFixture(host: Row = {}) {
  const f = fixture();
  const owner = "hb::/home/u/wt/builder";
  f.s.upsert("hosts", { name: "hb" }, { status: "accepted", public_key: "ssh-ed25519 AAAAtest", fingerprint: "SHA256:test", requested_at: 1, accepted_at: 1, last_seen_at: 1, ...host });
  f.s.upsert("members", { project: "p", squad: "t", wt: owner }, { role: "builder", host: "hb", status: "running", observed_at: 1, updated_at: 1 });
  const sent: Row[] = [];
  const answer: Row = { code: 0, ms: 12, timed_out: false, cwd: "/home/u/wt/builder", cwd_fallback: false, tail: "stopped" };
  let reply: () => unknown = () => answer;
  const act = { hostJobs: () => ({ send: async (h: string, body: Row) => { sent.push({ h, ...body }); return reply(); } }) };
  const exec = async (a: Action, now = 2_000): Promise<Result> => {
    const r = await fulfiller.exec(a, { store: f.s, project: "p", now, act } as unknown as Exec);
    return "background" in r ? await r.background : r;
  };
  return { ...f, owner, sent, exec, setReply: (r: () => unknown) => { reply = r; } };
}

test("a side owner's stop is a host job on its host: the action names the host and main runs nothing", async () => {
  const f = sideFixture();
  const id = f.entry(f.owner, "member", "make down");
  f.s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [f.owner]);
  const [a] = stops(f.run(1_000));
  expect(a.payload).toMatchObject({ ids: [id], cmd: "make down", cwd: "/home/u/wt/builder", host: "hb" });
  expect(await f.exec(a)).toMatchObject({ done: true, result: "stop done (exit 0) on hb" });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ h: "hb", job: "expose.stop", project: "p", squad: "t", cmd: "make down", cwd: "/home/u/wt/builder", low: id, timeout_s: 90 });
  expect(f.row(id).stop_state).toBe("done");
  expect(f.result(id)).toMatchObject({ ids: [id], code: 0, host: "hb", tail: "stopped" });
  expect(existsSync(join(f.root, "state", "p", "loop", "cleanup", `expose-stop-${id}.log`))).toBe(false);
});

test("a side owner's stop is held while its host is unreachable, then runs once the link is back", async () => {
  const f = sideFixture({ unreachable_since: 500 });
  const id = f.entry(f.owner, "member", "make down");
  f.s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [f.owner]);
  expect(stops(f.run(1_000))).toHaveLength(0);
  expect(f.row(id).stop_state).toBe("queued");
  // An action already in flight when the link dropped claims nothing and waits.
  expect(await f.exec({ project: "p", squad: "t", kind: "expose.stop", subject: "x", payload: { ids: [id], cmd: "make down", host: "hb" } } as Action))
    .toEqual({ wait: "host hb is unreachable" });
  expect(f.row(id).stop_state).toBe("queued");
  expect(f.sent).toHaveLength(0);
  f.s.db.run("UPDATE hosts SET unreachable_since = NULL");
  expect(stops(f.run(1_100))).toHaveLength(1);
});

test("a side owner's stop settles lost once its host or the owner is fenced, or the host is removed; the alert says why", () => {
  for (const [sql, why] of [["UPDATE hosts SET fenced_at = 900, unreachable_since = 500", "host hb was fenced"],
    ["UPDATE members SET fenced_at = 900", "host hb was fenced"], ["UPDATE hosts SET status = 'removed'", "host hb is no longer an accepted host"]]) {
    const f = sideFixture();
    const id = f.entry(f.owner, "member", "make down");
    f.s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [f.owner]);
    f.s.db.run(sql);
    const out = f.run(1_000);
    expect(stops(out)).toHaveLength(0);
    expect(f.row(id).stop_state).toBe("lost");
    expect(f.result(id)).toMatchObject({ ids: [id], why, host: "hb" });
    expect(events(f.s, "expose_stop").at(-1)?.payload).toContain(why);
    expect(JSON.stringify(alerts(f.run(1_100)))).toContain(`was lost (${why}`);
  }
});

test("a side stop whose link breaks mid-run settles lost, never retried on main", async () => {
  const f = sideFixture();
  const id = f.entry(f.owner, "member", "make down");
  f.s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [f.owner]);
  const [a] = stops(f.run(1_000));
  f.setReply(() => { throw new Error("link closed"); });
  expect(await f.exec(a)).toMatchObject({ done: true });
  expect(f.row(id).stop_state).toBe("lost");
  expect(String(f.result(id).why)).toContain("link closed");
});

test("goneWhy: a side owner's worktree is removed by main's worktrees row, never by looking for the folder on main", () => {
  const f = sideFixture();
  const id = f.entry(f.owner, "member", null);
  f.run(1_000);
  expect(f.row(id).gone_at).toBeNull();   // the path does not exist on main, and that alone ends nothing
  f.s.upsert("worktrees", { host: "hb", path: "/home/u/wt/builder" }, { project: "p", provider: "tmux", created_at: 1, gone_at: 900 });
  f.run(1_100);
  expect(f.row(id).gone_why).toBe("worktree-removed");
});
