// board-seats-brake.test.ts — board-shows-host-brake U2: the header's Builder seats come from the loop's own count
// (slot.ts seats()), not from the working Builders of the active squads, and the host brake shows as one host
// signal (header.brake, the BRAKE line, the `waiting for the host` Flow group). The data is built by buildBoard on a
// small loop.db; the page is mounted on the same boards.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { brakeText, buildBoard, buildersText, renderText } from "../../bin/board/board-data.ts";
import { mount } from "./board-mount.ts";

const REPO = join(import.meta.dir, "..", "..");
const NOW = Math.floor(Date.now() / 1000);
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function setup(limits: Record<string, string>) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardseats-")); roots.push(root);
  const conv = mkdtempSync(join(tmpdir(), "boardseats-conv-")); roots.push(conv);
  cpSync(join(REPO, "conventions"), conv, { recursive: true });
  for (const p of ["p", "other"]) mkdirSync(join(root, p, "squads"), { recursive: true });   // the loop's projects are the state root's folders
  const s = open(root);
  importConfig(s, root, conv);   // the shipped crit lines
  for (const p of ["p", "other"]) s.upsert("projects", { label: p }, { observed_at: NOW });
  const squad = (topic: string, set: Row = {}) =>
    s.upsert("squads", { project: "p", topic }, { status: "running", run_id: `run_${topic}`, repo: "path:/r/p", lead_wt: `wt_lead_${topic}`, observed_at: NOW, updated_at: NOW, doc: JSON.stringify({ task_id: topic, run_id: `run_${topic}`, repo: "path:/r/p", status: "running", approved_plans: [] }), ...set });
  for (const [k, v] of Object.entries(limits)) s.upsert("config", { project: "p", file: "limits.conf", key: k }, { value: v, observed_at: NOW });
  const unit = (squad: string, slug: string, status: string, set: Row = {}) =>
    s.upsert("units", { project: "p", squad, slug }, { status, builder_wt: "", tier: "standard", deps: "[]", observed_at: NOW, updated_at: NOW, doc: JSON.stringify({ slug, status }), ...set });
  // A Builder whose agent runs, as the observer reads it.
  const live = (squad: string, slug: string, state = "working") => {
    unit(squad, slug, "dispatched", { builder_wt: `wt_${slug}` });
    s.upsert("members", { project: "p", squad, role: "builder", suffix: slug }, { wt: `wt_${slug}`, agent: "claude", model: "opus", status: "running", started: "2026-01-01T00:00:00Z", observed_at: NOW, updated_at: NOW });
    s.upsert("observed_workers", { project: "p", wt: `wt_${slug}` }, { state, presence: "running", started_at: NOW - 600, observed_at: NOW });
  };
  const machine = (set: Row = {}) => s.upsert("observed_machine", { host: "h" }, { cores: 24, load1: 6, load5: 6, load15: 6, mem_total_kb: 64_000_000, mem_avail_kb: 32_000_000, swap_total_kb: 8_000_000,
    swap_free_kb: 8_000_000, psi_cpu_some: 1, psi_mem_some: 0, psi_mem_full: 0, psi_io_some: 0, psi_io_full: 0, disks: "[]", groups: "[]", observed_at: NOW, ...set });
  const brake = (project: string, value = "on") => s.upsert("config", { project, file: "limits.conf", key: "builder_host_brake" }, { value, observed_at: NOW });
  const resuming = (squad: string, slug: string) => s.db.run(`INSERT INTO pause_members (project, squad, role, suffix, generation, state, requested_at) VALUES ('p', ?, 'builder', ?, ?, 'resuming', ?)`, [squad, slug, `g-${slug}`, NOW]);
  return { s, resuming, squad, unit, live, machine, brake, board: () => buildBoard("p", "", root) as any };
}
const HOT = { load1: 36.8 };   // 24 cores at load 36.8 = 153%, over the 150% crit line

test("seats: six live Builders, three in a squad that is resuming and one idle, read 6/6 as the loop counts them", () => {
  const f = setup({ max_builders: "6" });
  f.squad("one"); f.squad("two");
  for (const [sq, slug, st] of [["one", "a1", "working"], ["one", "a2", "working"], ["one", "a3", "idle"], ["two", "b1", "working"], ["two", "b2", "working"], ["two", "b3", "working"]] as const)
    f.live(sq, slug, st);
  for (const slug of ["b1", "b2", "b3"]) f.resuming("two", slug);   // `two` has members resuming: it stays on the board
  const h = f.board().header;
  expect(h.builders_normal).toBe(6);
  expect(h.builders_total).toBe(6);
  expect(h.builders_left).toBe(0);
  expect(h.builders_seats.used).toBe(6);
  expect(h.builders_seats.by_why).toEqual({ working: 5, idle: 1, pausing: 0, restarting: 0, starting: 0, hold: 0 });
  expect(h.builders_seats.list.map((x: any) => `${x.squad}/${x.unit}:${x.why}`).sort()).toEqual(["one/a1:working", "one/a2:working", "one/a3:idle", "two/b1:working", "two/b2:working", "two/b3:working"]);
  expect(buildersText(h)).toBe("6/6 · normal 6/6 (5 working, 1 idle)");
  expect(renderText(f.board())).toContain("BUILDERS  6/6 · normal 6/6 (5 working, 1 idle)");
  expect(h.brake).toBeNull();
});

test("brake: on, load past crit, a free seat and a ready unit: holding 1, the group `waiting for the host`, the BRAKE line", () => {
  const f = setup({ max_builders: "2" });
  f.squad("one");
  f.live("one", "a1");
  f.unit("one", "a2", "planned");
  f.machine(HOT); f.brake("p");
  // The pick the loop wrote for the held start: it waits on the host, not on a slot.
  f.s.upsert("members", { project: "p", squad: "one", role: "builder", suffix: "a2" }, { wt: "", agent: "claude", model: "opus", status: "waiting", want: "running", want_at: NOW, observed_at: NOW, updated_at: NOW });
  const id = (f.s.get("members", { project: "p", squad: "one", role: "builder", suffix: "a2" }) as Row).id;
  f.s.upsert("picks", { member: id }, { project: "p", squad: "one", role: "builder", tier: "standard", reason: "WAIT host: load 153% ≥ crit 150%", slot: 0, picked_at: NOW });
  const b = f.board(), br = b.header.brake;
  expect(br).toMatchObject({ setting: "builder_host_brake", on: true, projects: ["p"], holding: true, held: 1, free: 1, hit: { metric: "load", value: 153.3, crit: 150, key: "machine_load_crit_pct" } });
  expect(b.flow.brake).toEqual(br);
  expect(b.flow.cards.find((c: any) => c.slug === "a2")).toMatchObject({ group: "waiting for the host", note: null });
  const text = renderText(b);
  expect(text).toContain("BRAKE  holding 1 start: load 153.3% ≥ crit 150% (machine_load_crit_pct) · set builder_host_brake off to start anyway");
  // No free seat: the host is over its line and the next seat will wait, but nothing is held now.
  const g = setup({ max_builders: "1" });
  g.squad("one"); g.live("one", "a1"); g.machine(HOT); g.brake("p");
  expect(g.board().header.brake).toMatchObject({ on: true, holding: false, held: 0, free: 0 });
  expect(brakeText(g.board().header.brake)).toContain("BRAKE  armed:");
  expect(brakeText(g.board().header.brake)).toContain("no free seat now");
});

test("brake: a stale sample shows nothing; off here but on for another project is a host note, never holding", () => {
  const stale = setup({ max_builders: "2" });
  stale.squad("one"); stale.unit("one", "a2", "planned"); stale.machine({ ...HOT, observed_at: NOW - 3600 }); stale.brake("p");
  expect(stale.board().header.brake).toBeNull();
  expect(renderText(stale.board())).not.toContain("BRAKE");

  const off = setup({ max_builders: "2" });
  off.squad("one"); off.unit("one", "a2", "planned"); off.machine(HOT); off.brake("other");
  const br = off.board().header.brake;
  expect(br).toMatchObject({ on: false, projects: ["other"], holding: false, held: 0 });
  expect(renderText(off.board())).toContain("BRAKE  host over crit: load 153.3% ≥ crit 150% (machine_load_crit_pct) · the brake is off here, on for other");
});

test("the mounted page: the Builders tile is red with ⛔ host brake, the queued banner names the line, and the card sits under `for the host`", async () => {
  const f = setup({ max_builders: "2" });
  f.squad("one"); f.live("one", "a1"); f.unit("one", "a2", "planned");
  f.machine(HOT); f.brake("p");
  f.s.upsert("members", { project: "p", squad: "one", role: "builder", suffix: "a2" }, { wt: "", agent: "claude", model: "opus", status: "waiting", want: "running", want_at: NOW, observed_at: NOW, updated_at: NOW });
  const id = (f.s.get("members", { project: "p", squad: "one", role: "builder", suffix: "a2" }) as Row).id;
  f.s.upsert("picks", { member: id }, { project: "p", squad: "one", role: "builder", tier: "standard", reason: "WAIT host: load 153% ≥ crit 150%", slot: 0, picked_at: NOW });
  const run = await mount(f.board()), doc = run.window.document;
  expect(run.errors).toEqual([]);
  const tile = [...doc.querySelectorAll(".tile")].find((x: any) => x.querySelector(".tl")?.textContent === "Builders") as any;
  expect(tile.className).toContain("crit");
  expect(tile.querySelector(".td").textContent).toContain("⛔ host brake");
  const banner = doc.querySelector("#flow-brake") as any;
  expect(banner.textContent).toContain("Host brake holding 1 start: load 153.3% ≥ crit 150% (machine_load_crit_pct) · builder_host_brake");
  expect(banner.querySelector("button")).not.toBeNull();
  expect(doc.querySelector('[data-group="waiting for the host"] .fgl')?.textContent).toBe("for the host");
});

test("the mounted page: the Builders tile tooltip names all six holders with why", async () => {
  const f = setup({ max_builders: "6" });
  f.squad("one"); f.squad("two");
  for (const [sq, slug, st] of [["one", "a1", "working"], ["one", "a2", "idle"], ["two", "b1", "working"], ["two", "b2", "working"], ["two", "b3", "working"], ["one", "a3", "working"]] as const) f.live(sq, slug, st);
  for (const slug of ["b1", "b2", "b3"]) f.resuming("two", slug);
  const run = await mount(f.board()), doc = run.window.document;
  expect(run.errors).toEqual([]);
  const tile = [...doc.querySelectorAll(".tile")].find((x: any) => x.querySelector(".tl")?.textContent === "Builders") as any;
  expect(tile.querySelector(".tv").textContent).toBe("6/6");
  const title = tile.getAttribute("title") ?? "";
  for (const h of ["one/a1 — working", "one/a2 — idle", "two/b1 — working", "two/b2 — working", "two/b3 — working", "one/a3 — working"]) expect(title).toContain(h);
});

// board-shows-host-brake U3: the Flow holds one card outside Queued for each Builder seat holder.
const outside = (b: any) => b.flow.cards.filter((c: any) => c.stage !== "queued");
const cardOf = (b: any, slug: string) => b.flow.cards.find((c: any) => c.slug === slug);

test("flow (a): a squad with one member resuming keeps its Building card and its header counts", () => {
  const f = setup({ max_builders: "6" });
  f.squad("two");
  f.live("two", "b1"); f.live("two", "b2", "idle");
  f.unit("two", "b3", "planned");
  f.resuming("two", "b3");   // b3's Builder waits for a seat: the member's state must not hide the squad
  const b = f.board();
  expect(b.header.builders_seats.used).toBe(2);
  expect(cardOf(b, "b1")?.stage).toBe("building");
  expect(cardOf(b, "b2")?.stage).toBe("building");
  expect(b.flow.counts.building).toBe(2);
});

test("flow (b): a squad paused at squad scope is still dropped from the Flow", () => {
  const f = setup({ max_builders: "6" });
  f.squad("two"); f.squad("three");
  f.live("two", "b1"); f.live("three", "c1");
  f.s.db.run(`INSERT INTO pause_intents (scope, project, squad, role, suffix, source, generation, requested_at) VALUES ('squad', 'p', 'two', '', '', 'manual', 'g1', ?)`, [NOW]);
  const b = f.board();
  expect(cardOf(b, "b1")).toBeUndefined();
  expect(cardOf(b, "c1")?.stage).toBe("building");
});

test("flow (c): a planned unit whose Builder is live and idle is a Building card, not Queued", () => {
  const f = setup({ max_builders: "6" });
  f.squad("one");
  f.live("one", "u27", "idle");
  f.unit("one", "u27", "planned", { builder_wt: "wt_u27" });   // the row went back to planned while the Builder runs
  const c = cardOf(f.board(), "u27");
  expect(c.stage).toBe("building");
  expect(c.group).toBe("coding");
});

test("flow (d): on a seat-heavy board the cards outside Queued equal the seats used", () => {
  const f = setup({ max_builders: "8" });
  f.squad("one"); f.squad("two");
  f.live("one", "a1"); f.live("one", "a2", "idle"); f.live("one", "a3");
  f.unit("one", "a3", "planned", { builder_wt: "wt_a3" });
  f.live("two", "b1"); f.live("two", "b2"); f.live("two", "b3", "idle");
  for (const slug of ["b1", "b2"]) f.resuming("two", slug);
  f.unit("one", "q1", "planned");   // a real queued unit, no Builder
  const b = f.board();
  expect(b.header.builders_seats.used).toBe(6);
  expect(outside(b).length).toBe(6);
  expect(cardOf(b, "q1")?.stage).toBe("queued");
});

test("flow (e): a resuming member with no seat is a Queued card at its queue position, never paused and never Building", () => {
  const f = setup({ max_builders: "6" });
  f.squad("two");
  f.unit("two", "r1", "planned", { builder_wt: "wt_r1" });
  f.s.upsert("members", { project: "p", squad: "two", role: "builder", suffix: "r1" }, { wt: "wt_r1", agent: "claude", model: "opus", status: "waiting", observed_at: NOW, updated_at: NOW });
  f.resuming("two", "r1");
  const b = f.board();
  const c = cardOf(b, "r1");
  expect(c.stage).toBe("queued");
  expect(c.group).toBe("waiting for a slot");
  expect(c.note).toBe("resumed · waiting for a seat");
  expect(c.paused).toBe(false);
  expect(c.queue_pos).toBe(1);
  expect(b.flow.counts.paused).toBe(0);
});
