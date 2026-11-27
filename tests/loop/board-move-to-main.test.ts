// board-move-to-main.test.ts — side-loop-host U16 (issue #127): "Move to main" on a side member's board row. The
// board is built from the rig's loop.db and mounted; the button's request goes through the real route; the loop then
// waits for the Builder to be idle, asks its journal checkpoint, pushes its branch from the side host, closes it there
// and starts the unit's next attempt on main.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildBoard } from "../../bin/board/board-data.ts";
import { journalPath } from "../../bin/loop/pause/pause.ts";
import { latest } from "../../bin/loop/pause/stop-checkpoint.ts";
import type { Row } from "../../bin/loop/core/store.ts";
import { mount } from "./board-mount.ts";
import { agentGone, builderOnSide, cleanup, closes, HOST, member, rig, unit, type Rig } from "./side-rig.ts";

const ROOT = join(import.meta.dir, "..", "..");
afterEach(cleanup);

const boardMember = (r: Rig) => {
  const squad = (buildBoard("fx", "", r.s.root) as any).squads.find((q: any) => q.topic === r.sq);
  return squad.members.find((m: any) => m.label === "builder-u1" && m.host === HOST) ?? squad.members.find((m: any) => m.label === "builder-u1");
};

// The board server on the rig's state: post a body, get {status, error}.
async function server(r: Rig) {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port; probe.stop(true);
  const url = `http://127.0.0.1:${port}`;
  const p = Bun.spawn([process.execPath, join(ROOT, "bin/board/board-server.ts"), "127.0.0.1", String(port),
    join(ROOT, "web/board.html"), join(ROOT, "bin/board/board-data.ts"), "fx"], { env: { ...process.env, DS_STATE_ROOT: r.s.root }, stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url + "/healthz")).ok) break; } catch { /* not up yet */ } await Bun.sleep(20); }
  const post = async (body: unknown) => {
    const res = await fetch(url + "/api/member-move", { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, error: ((await res.json()) as any).error as string | undefined };
  };
  return { post, stop: async () => { p.kill(); await p.exited; } };
}

// Mount the board, open the squad and the Builder's ⋯ menu, and press "Move to main"; returns what it posted.
async function press(r: Rig) {
  const page = await mount(buildBoard("fx", "", r.s.root), false);
  const w = page.window, doc = w.document, posts: { url: string; body: any }[] = [], get = w.fetch;
  w.fetch = async (url: string, o: any) => {
    if (o?.method !== "POST") return get(url, o);
    posts.push({ url: String(url), body: JSON.parse(o.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  w.confirm = () => true;
  const click = async (el: any) => { expect(el).toBeTruthy(); el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await new Promise((res) => setTimeout(res, 40)); };
  const row = [...doc.querySelectorAll(".row.squad")].find((e: any) => e.textContent.includes(r.sq));
  await click(row);
  const crew = [...doc.querySelectorAll(".crew .m")].find((e: any) => e.querySelector(".nm")?.getAttribute("title") === "builder-u1") as any;
  await click(crew?.querySelector(".ovr button[aria-haspopup]"));
  const button = doc.querySelector('[data-act="move-to-main"]') as any;
  const label = button?.textContent;
  await click(button);
  expect(page.errors).toEqual([]);
  return { label, posts };
}

// Run ticks until `done`; the side's agent is gone once its terminal was closed (no side observer in this rig).
async function until(r: Rig, wt: string, done: () => boolean) {
  const before = closes(r.side);
  for (let i = 0; i < 20 && !done(); i++) {
    await r.tick();
    if (closes(r.side) > before) agentGone(r, wt);
  }
  expect(done()).toBe(true);
}
// Its turn ended: no side observer in this rig, so the start prompt's delivery is closed here too.
const idle = (r: Rig, wt: string) => {
  r.s.db.run("UPDATE deliveries SET state = 'verified' WHERE member = ? AND state = 'accepted'", [wt]);
  r.s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", observed_at: r.now() });
};
const request = (r: Rig) => r.s.db.query("SELECT * FROM requests WHERE kind = 'member-move' ORDER BY id DESC").get() as Row;
const result = (r: Rig) => JSON.parse(String(request(r).result ?? "null"));
const checkpoint = (r: Rig, m: Row) => {
  const file = journalPath(r.s, { scope: "member", project: "fx", squad: r.sq, role: "builder", suffix: "u1" });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `- 2027-01-15T08:00:00Z [keep] checkpoint ${latest(r.s, Number(m.id))!.generation}: done A; next step B — before a planned restart\n`);
  return file;
};

test("the row's Move to main: checkpoint once idle, push, close, and the unit starts again on main", async () => {
  const r = await rig();
  const { m, branch, sha } = await builderOnSide(r);
  const wt = String(m.wt);
  expect(boardMember(r)).toMatchObject({ host: HOST, wt });
  const pressed = await press(r);
  expect(pressed.label).toBe("Move to main");
  expect(pressed.posts).toEqual([{ url: "api/member-move", body: { project: "fx", topic: r.sq, wt } }]);

  const web = await server(r);
  try {
    expect((await web.post({ project: "fx", topic: r.sq })).status).toBe(400);
    expect((await web.post(pressed.posts[0].body)).status).toBeLessThan(300);
    expect(await web.post(pressed.posts[0].body)).toEqual({ status: 409, error: "already requested — waiting for the loop" });
  } finally { await web.stop(); }
  expect(boardMember(r).move).toEqual({ pending: true });

  // It is working: nothing is asked, nothing moves.
  await r.tick(3);
  expect(latest(r.s, Number(m.id))).toBeNull();
  expect(r.jobs.filter((j) => j.job === "push")).toEqual([]);

  // Idle: its journal checkpoint is asked, and the move waits for the line.
  idle(r, wt);
  await r.tick(2);
  expect(latest(r.s, Number(m.id))).toMatchObject({ why: "move", state: "asking" });
  expect(r.jobs.filter((j) => j.job === "push")).toEqual([]);
  const journal = checkpoint(r, m);
  const closedBefore = closes(r.side);
  await until(r, wt, () => request(r).done_at != null);

  expect(result(r)).toMatchObject({ ok: true, host: HOST, branch, sha, attempt: 2 });
  expect(r.jobs.filter((j) => j.job === "push")).toMatchObject([{ branch, path: m.wt_path }]);
  expect(closes(r.side)).toBeGreaterThan(closedBefore);
  expect(member(r.s, Number(m.id))).toMatchObject({ status: "gone", want: "gone", fenced_at: null });
  expect(unit(r)).toMatchObject({ attempt: 2, retry_from: branch, retry_sha: sha, retry_host: null });
  expect(readFileSync(journal, "utf8")).toContain(`[keep] the operator moved this member from host ${HOST} to main; this unit moved to attempt 2`);
  const next = () => r.s.db.query("SELECT * FROM members WHERE squad = ? AND suffix = 'u1' AND id != ? ORDER BY id DESC").get(r.sq, m.id as number) as Row;
  await until(r, wt, () => !!next()?.wt);
  expect(String(next().wt)).not.toStartWith(`${HOST}::`);
  expect(JSON.parse(String(next().want_payload))).toMatchObject({ main_only: true, unit: "u1" });
  expect(r.s.get("hosts", { name: HOST })!.fenced_at).toBeNull();
}, 60_000);   // real git, a board server and a mounted page: slow on a loaded host

test("uncommitted files stop the move: the member runs on and its row says why", async () => {
  const r = await rig();
  const { m } = await builderOnSide(r);
  const wt = String(m.wt);
  r.answers.probe = "2\t0\n.scratch/x.txt\nsrc/kept.ts\n";
  const web = await server(r);
  try { expect((await web.post({ project: "fx", topic: r.sq, wt })).status).toBeLessThan(300); } finally { await web.stop(); }
  idle(r, wt);
  await r.tick(2);
  checkpoint(r, m);
  const closedBefore = closes(r.side);
  await until(r, wt, () => request(r).done_at != null);
  expect(result(r)).toEqual({ ok: false, error: `uncommitted files would stay on ${HOST}: src/kept.ts; commit them, then move again` });
  expect(closes(r.side)).toBe(closedBefore);
  expect(r.jobs.filter((j) => j.job === "push")).toEqual([]);
  expect(member(r.s, Number(m.id))).toMatchObject({ want: "running", status: "running", wt });
  expect(boardMember(r).move).toEqual({ error: result(r).error });
}, 60_000);   // real git, a board server and a mounted page: slow on a loaded host

test("a failed push keeps the member where it is, and the push is tried again", async () => {
  const r = await rig();
  const { m } = await builderOnSide(r);
  const wt = String(m.wt);
  r.answers.push = 1;
  const web = await server(r);
  try { expect((await web.post({ project: "fx", topic: r.sq, wt })).status).toBeLessThan(300); } finally { await web.stop(); }
  idle(r, wt);
  await r.tick(2);
  checkpoint(r, m);
  const closedBefore = closes(r.side);
  await r.tick(3);
  expect(closes(r.side)).toBe(closedBefore);
  expect(member(r.s, Number(m.id))).toMatchObject({ want: "running", status: "running" });
  r.answers.push = 0;
  await until(r, wt, () => request(r).done_at != null);
  expect(result(r).ok).toBe(true);
  expect(r.jobs.filter((j) => j.job === "push").length).toBeGreaterThan(1);
}, 60_000);   // real git, a board server and a mounted page: slow on a loaded host
