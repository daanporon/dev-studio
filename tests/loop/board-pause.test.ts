import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBoard } from "../../bin/board/board-data.ts";
import { fixture } from "./pause-fixture.ts";

const servers: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => { for (const p of servers.splice(0)) { p.kill(); await p.exited; } });
async function rig() {
  const f = fixture();
  f.store.upsert("squads", { project: "p", topic: "one" }, { doc: { topic: "one", members: [], worktrees: ["wt_one"], units: [], waiting_on_you: [] } });
  f.store.upsert("members", f.target, { doc: { role: "builder", suffix: "task", wt: "wt_one" } });
  f.store.upsert("observed_workers", { project: "p", wt: "wt_one" }, { state: "working", observed_at: Math.floor(Date.now() / 1000) });
  const listener = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = listener.port; listener.stop(true);
  const url = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([process.execPath, join(import.meta.dir, "../../bin/board/board-server.ts"), "127.0.0.1", String(port),
    join(import.meta.dir, "../../web/board.html"), join(import.meta.dir, "../../bin/board/board-data.ts"), "p"],
    { env: { ...process.env, DS_STATE_ROOT: f.root }, stdout: "ignore", stderr: "pipe" });
  servers.push(server);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + "/healthz")).ok) break; } catch {}
    await Bun.sleep(20);
  }
  const post = async (path: string, body: unknown, origin = url) => {
    const r = await fetch(url + "/api/" + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    let result; try { result = JSON.parse(text); } catch { result = { error: text }; }
    return { status: r.status, body: result };
  };
  const target = { scope: "member", project: "p", topic: "one", wt: "wt_one" };
  const board = () => buildBoard("p", "", f.root) as any;
  return { ...f, post, targetBody: target, board };
}

test("board Pause checkpoints a dirty Builder; Resume only clears state until the loop returns", async () => {
  const f = await rig();
  const first = await f.post("pause", f.targetBody);
  expect(first.status).toBe(200);
  expect(first.body.pause).toMatchObject({ state: "pausing", changed: true });
  const duplicate = await f.post("pause", f.targetBody);
  expect(duplicate.body.pause).toMatchObject({ generation: first.body.pause.generation, changed: false });
  expect(f.board().squads[0].members[0]).toMatchObject({ suffix: "task", state: "pausing", pause: { reason: "awaiting journal checkpoint" } });
  expect(f.board().squads[0].live.working).toBe(0);
  await f.tick(); f.checkpoint(); await f.tick();
  expect(f.board().squads[0].members[0].pause).toMatchObject({ state: "paused", checkpoint: expect.any(String) });
  expect(readFileSync(join(f.path, "unfinished"), "utf8")).toBe("local changes");
  const calls = f.orca.calls.length;
  const resumed = await f.post("resume", f.targetBody);
  expect(resumed.status).toBe(200);
  expect(resumed.body.pause.state).toBe("resuming");
  expect(f.orca.calls.length).toBe(calls);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 0 });
  expect(f.board().squads[0].members[0].state).toBe("resuming");
  await f.tick(); await f.tick();
  expect(f.orca.started).toHaveLength(1);
  expect(f.orca.started[0].args.join(" ")).toContain("retained journal checkpoint first");
});

test("parent controls cascade, role resume explains its parent, suspended squads stay suspended", async () => {
  const f = await rig();
  f.store.upsert("squads", { project: "p", topic: "suspended" }, { status: "suspended", doc: {}, observed_at: 1, updated_at: 1 });
  expect((await f.post("pause", f.targetBody)).status).toBe(200);
  expect((await f.post("pause", { scope: "squad", project: "p", topic: "one" })).status).toBe(200);
  const blocked = await f.post("resume", f.targetBody);
  expect(blocked.status).toBe(409); expect(blocked.body.error).toContain("squad first");
  expect((await f.post("resume", { scope: "squad", project: "p", topic: "one" })).status).toBe(200);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM pause_intents WHERE cleared_at IS NULL").get()).toEqual({ n: 0 });
  expect((await f.post("pause", { scope: "project", project: "p" })).status).toBe(200);
  expect(f.board().projects[0].pause.state).toBe("pausing");
  expect((await f.post("resume", f.targetBody)).body.error).toContain("project first");
  expect((await f.post("resume", { scope: "project", project: "p" })).status).toBe(200);
  expect(f.store.get("squads", { project: "p", topic: "suspended" })?.status).toBe("suspended");
  expect((await f.post("pause", { scope: "squad", project: "p", topic: "suspended" })).status).toBe(409);
});

test("pause routes validate ownership and ordinary restart/poke cannot bypass pause", async () => {
  const f = await rig();
  expect((await f.post("pause", { ...f.targetBody, wt: "foreign" })).status).toBe(409);
  expect((await f.post("pause", { ...f.targetBody, role: "lead" })).status).toBe(409);
  expect((await f.post("pause", { ...f.targetBody, scope: "project" })).status).toBe(400);
  f.store.upsert("projects", { label: "other" }, { observed_at: 1 });
  expect((await f.post("pause", { scope: "project", project: "other" })).status).toBe(403);
  expect((await f.post("pause", f.targetBody, "http://evil.example")).status).toBe(403);
  expect((await f.post("pause", { scope: "squad", project: "p", topic: "one" })).status).toBe(200);
  expect((await f.post("restart", f.targetBody)).status).toBe(409);
  expect((await f.post("poke", { project: "p", topic: "one" })).status).toBe(409);
  expect((await f.post("request", { project: "p", topic: "one", action: "restart" })).status).toBe(409);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 0 });
});

test("recorded waits show tracked prerequisite links and holds, while explicit Resume preserves facts", async () => {
  const f = await rig();
  f.store.upsert("units", { project: "p", squad: "one", slug: "task" }, { hold: 1 });
  f.store.upsert("observed_prs", { project: "p", ref: "owner/repo#12" }, { repo: "owner/repo", pr: 12, state: "OPEN", observed_at: 1 });
  const refs = [{ kind: "pr", project: "p", ref: "owner/repo#12" }];
  expect((await f.post("pause", { ...f.targetBody, prerequisites: [{ kind: "pr", project: "p", ref: "unknown" }] })).status).toBe(409);
  expect((await f.post("pause", { ...f.targetBody, prerequisites: refs })).status).toBe(200);
  const m = f.board().squads[0].members[0];
  expect(m.pause.sources[0].remaining).toEqual(["prerequisite unresolved: owner/repo#12", "unit hold: task"]);
  expect(f.board().prerequisites).toContainEqual(expect.objectContaining({ kind: "pr", ref: "owner/repo#12", url: "https://github.com/owner/repo/pull/12" }));
  expect((await f.post("resume", f.targetBody)).status).toBe(200);
  expect(f.store.get("units", { project: "p", squad: "one", slug: "task" })?.hold).toBe(1);
  expect(f.store.get("observed_prs", { project: "p", ref: "owner/repo#12" })?.state).toBe("OPEN");
});

test("a registered role awaiting its first worktree stays on the board and can be paused", async () => {
  const f = await rig();
  f.store.upsert("members", { project: "p", squad: "one", role: "researcher", suffix: "extra" },
    { wt: null, doc: { role: "researcher", suffix: "extra" }, observed_at: 1, updated_at: 1 });
  expect(f.board().squads[0].members).toContainEqual(expect.objectContaining({ role: "researcher", suffix: "extra", wt: null }));
  const target = { scope: "member", project: "p", topic: "one", role: "researcher", suffix: "extra" };
  expect((await f.post("pause", target)).status).toBe(200);
  expect((await f.post("resume", target)).status).toBe(200);
  expect((await f.post("pause", { ...target, suffix: "not-registered" })).status).toBe(409);
});

test("a squad whose member is resuming still counts in the header; a paused squad does not", async () => {
  const f = await rig();
  f.store.upsert("squads", { project: "p", topic: "two" }, { doc: { topic: "two", members: [], worktrees: [], units: [], waiting_on_you: [] }, status: "running", observed_at: 1, updated_at: 1 });
  for (const sq of ["one", "two"]) f.store.upsert("units", { project: "p", squad: sq, slug: "u" }, { status: "planned", updated_at: 1, observed_at: 1 });
  await f.post("pause", f.targetBody); await f.tick(); f.checkpoint(); await f.tick();
  expect((await f.post("resume", f.targetBody)).status).toBe(200);
  const resuming = f.board();
  const one = resuming.squads.find((s: any) => s.topic === "one");
  expect(one.members[0].state).toBe("resuming");
  expect(one.pause.state).not.toMatch(/^(pausing|paused)$/);
  expect(resuming.header.squads_active).toBe(2);
  expect((await f.post("pause", { scope: "squad", project: "p", topic: "two" })).status).toBe(200);
  const b = f.board();
  expect(b.squads.find((s: any) => s.topic === "two").pause.state).toMatch(/^(pausing|paused)$/);
  expect(b.header.squads_active).toBe(1);
});
