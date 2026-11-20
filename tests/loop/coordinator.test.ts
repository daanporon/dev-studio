// coordinator.test.ts — U72: the loop keeps its own pane bound. The terminal observer records role
// terminals only, never the loop's `ds-loop <squad>` panes, so a pane it never listed must not read
// as gone; only an observer-set gone_at does. Fake Orca, a bare store.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outside, sender } from "../../bin/loop/messages/coordinator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";

const P = "demo", SQ = "topic", RUN = "run_1", LEAD = "wt-lead";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function rig() {
  const d = mkdtempSync(join(tmpdir(), "zzcoord-")); temps.push(d);
  const s = open(d); stores.push(s);
  s.db.run("INSERT INTO squads (project, topic, run_id, lead_wt, observed_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)", [P, SQ, RUN, LEAD]);
  // an observed terminal of another worker, so the observer "has run" for the project
  s.db.run("INSERT INTO observed_terminals (project, handle, observed_at) VALUES (?, 'term_other', 100)", [P]);
  return { s, orca: new FakeBackend() };
}
const events = (s: Store) => (s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'coordinator'").get() as { n: number }).n;

test("a bound loop pane the observer never lists is reused on ten ticks with no find, no run-use, no event", async () => {
  const { s, orca } = rig();
  const h = await sender(s, orca, P, SQ, 200);
  const base = { creates: orca.of("terminal-create").length, adopts: orca.of("adopt").length, finds: orca.of("terminal-find").length, ev: events(s) };
  for (let i = 1; i <= 10; i++) {
    s.db.run("UPDATE observed_terminals SET observed_at = ?", [200 + i]);
    expect(await sender(s, orca, P, SQ, 200 + i)).toBe(h);
  }
  expect(orca.of("terminal-create").length).toBe(base.creates);
  expect(orca.of("adopt").length).toBe(base.adopts);
  expect(orca.of("terminal-find").length).toBe(base.finds);
  expect(events(s)).toBe(base.ev);
});

test("a handle the observer marked gone is replaced and logs one event", async () => {
  const { s, orca } = rig();
  const h = await sender(s, orca, P, SQ, 200);
  s.db.run("INSERT INTO observed_terminals (project, handle, observed_at, gone_at) VALUES (?, ?, 300, 300)", [P, h]);
  orca.gone(h);
  const before = events(s);
  const h2 = await sender(s, orca, P, SQ, 301);
  expect(h2).not.toBe(h);
  expect(events(s)).toBe(before + 1);
});

test("a failed call from the stored handle then a fresh retry binds a new pane, one event naming was", async () => {
  const { s, orca } = rig();
  const h = await sender(s, orca, P, SQ, 200);
  orca.gone(h); // the pane really closed; the observer never noticed
  const before = events(s);
  const h2 = await sender(s, orca, P, SQ, 210, true);
  expect(h2).not.toBe(h);
  expect(events(s)).toBe(before + 1);
  const ev = s.db.query("SELECT payload FROM events WHERE kind = 'coordinator' ORDER BY rowid DESC LIMIT 1").get() as { payload: string };
  expect(JSON.parse(ev.payload).was).toBe(h);
});

test("a re-bind to the same handle updates bound_at and logs nothing", async () => {
  const { s, orca } = rig();
  const h = await sender(s, orca, P, SQ, 200);
  const before = events(s);
  expect(await sender(s, orca, P, SQ, 250, true)).toBe(h);
  expect(events(s)).toBe(before);
  expect(s.get("coordinators", { project: P, squad: SQ })?.bound_at).toBe(250);
});

test("outside() reuses an unobserved pane and logs once", async () => {
  const { s, orca } = rig();
  s.db.run("INSERT INTO projects (label, studio_wt, observed_at) VALUES (?, 'wt-studio', 1)", [P]);
  const h = await outside(s, orca, P, 200);
  const before = events(s);
  for (let i = 0; i < 5; i++) expect(await outside(s, orca, P, 210 + i)).toBe(h);
  expect(await outside(s, orca, P, 300, true)).toBe(h);
  expect(events(s)).toBe(before);
});

test("a stored outside pane terminal-find no longer finds gets a new terminal and binding (U93)", async () => {
  const { s, orca } = rig();
  s.db.run("INSERT INTO projects (label, studio_wt, observed_at) VALUES (?, 'wt-studio', 1)", [P]);
  // Orca no longer has the pane: the fake starts empty, so the stored pane resolves to nothing.
  s.upsert("coordinators", { project: P, squad: "" },
    { handle: "term_gone", pane_key: "tab9:leaf9", wt: "wt-studio", run_id: "", created_at: 100, bound_at: 100 });
  const before = events(s);
  const h = await outside(s, orca, P, 200);
  expect(h).not.toBe("term_gone");
  expect(orca.terminals.has(h)).toBe(true);
  expect(s.get("coordinators", { project: P, squad: "" })).toMatchObject({ handle: h, run_id: "" });
  expect((s.get("coordinators", { project: P, squad: "" })?.pane_key as string | null)).not.toBe("tab9:leaf9");
  expect(events(s)).toBe(before + 1);
});

test("a stored outside pane found under a new handle is bound to that handle (U93)", async () => {
  const { s, orca } = rig();
  s.db.run("INSERT INTO projects (label, studio_wt, observed_at) VALUES (?, 'wt-studio', 1)", [P]);
  const c = await orca.run("terminal-create", ["wt-studio", "ds-loop restart"]);
  const [live, pane] = c.out.trim().split("\t");
  s.upsert("coordinators", { project: P, squad: "" },
    { handle: "term_old", pane_key: pane, wt: "wt-studio", run_id: "", created_at: 100, bound_at: 100 });
  const before = events(s);
  expect(await outside(s, orca, P, 200)).toBe(live);
  expect(s.get("coordinators", { project: P, squad: "" })).toMatchObject({ handle: live, pane_key: pane });
  expect(events(s)).toBe(before + 1);
  expect(orca.of("terminal-create")).toHaveLength(1);
});

test("outside(fresh) with the failed handle still resolving makes a new pane instead (U93)", async () => {
  const { s, orca } = rig();
  s.db.run("INSERT INTO projects (label, studio_wt, observed_at) VALUES (?, 'wt-studio', 1)", [P]);
  const c = await orca.run("terminal-create", ["wt-studio", "ds-loop restart"]);
  const [live, pane] = c.out.trim().split("\t");
  s.upsert("coordinators", { project: P, squad: "" },
    { handle: live, pane_key: pane, wt: "wt-studio", run_id: "", created_at: 100, bound_at: 100 });
  const before = events(s);
  const h = await outside(s, orca, P, 200, true, live);
  expect(h).not.toBe(live);
  expect(orca.terminals.has(h)).toBe(true);
  expect((s.get("coordinators", { project: P, squad: "" })?.pane_key as string | null)).not.toBe(pane);
  expect(orca.of("terminal-close")).toHaveLength(0);
  expect(events(s)).toBe(before + 1);
});

test("a failed terminal-find keeps the stored handle instead of leaking a tab (U93)", async () => {
  const { s, orca } = rig();
  s.db.run("INSERT INTO projects (label, studio_wt, observed_at) VALUES (?, 'wt-studio', 1)", [P]);
  orca.fail("terminal-find", { code: 1, out: "", err: "adapter down" });
  s.upsert("coordinators", { project: P, squad: "" },
    { handle: "term_old", pane_key: "tab9:leaf9", wt: "wt-studio", run_id: "", created_at: 100, bound_at: 100 });
  const before = events(s);
  expect(await outside(s, orca, P, 200)).toBe("term_old");
  expect(orca.of("terminal-create")).toHaveLength(0);
  expect(events(s)).toBe(before);
});

test("a failed terminal-find on a fresh restart throws so the loop retries (U93)", async () => {
  const { s, orca } = rig();
  s.db.run("INSERT INTO projects (label, studio_wt, observed_at) VALUES (?, 'wt-studio', 1)", [P]);
  orca.fail("terminal-find", { code: 1, out: "", err: "adapter down" });
  s.upsert("coordinators", { project: P, squad: "" },
    { handle: "term_old", pane_key: "tab9:leaf9", wt: "wt-studio", run_id: "", created_at: 100, bound_at: 100 });
  await expect(outside(s, orca, P, 200, true)).rejects.toThrow("terminal-find");
  expect(orca.of("terminal-create")).toHaveLength(0);
});

test("U264: a Run the Studio's old tab held is bound from a fresh pane once a move marks that tab gone", async () => {
  const { s, orca } = rig();
  orca.terminals.set("term_s", { pane: "tabS:leafS", wt: "wt-studio" });
  s.db.run("INSERT INTO observed_terminals (project, handle, wt, observed_at) VALUES (?, 'term_s', 'wt-studio', 100)", [P]);
  s.db.run("INSERT INTO coordinators (project, squad, run_id, handle, pane_key, wt, created_at, bound_at) VALUES (?, ?, ?, 'term_s', 'tabS:leafS', 'wt-studio', 100, 100)", [P, SQ, RUN]);
  expect(await sender(s, orca, P, SQ, 200)).toBe("term_s");
  // fulfil/studio.ts's write after the close: the tab reads gone at once, before any observer tick.
  s.db.run("UPDATE observed_terminals SET gone_at = 300 WHERE project = ? AND handle = 'term_s'", [P]);
  orca.gone("term_s");
  const before = events(s);
  const h = await sender(s, orca, P, SQ, 301);
  expect(h).not.toBe("term_s");
  expect(events(s)).toBe(before + 1);
});
