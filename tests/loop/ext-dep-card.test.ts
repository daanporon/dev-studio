// ext-dep-card.test.ts — U46: one Studio card per planned unit whose ext dep names no unit
// (extDepCards in bin/loop/reconcilers/ready.ts); it closes when the ref resolves or is dropped.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { alertId } from "../../bin/loop/core/actuator.ts";
import { extDepCards } from "../../bin/loop/reconcilers/ready.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const SUBJECT = "extdep.missing|demo/u11-card";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function setup(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzext-dep-card-")); temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d); stores.push(s); importJson(s, d, () => {});
  // The fixture's own unit with a dangling ref is not under test here.
  s.db.run("UPDATE units SET ext_deps = '[]' WHERE project = 'fx'");
  s.db.run("INSERT INTO units (project, squad, slug, status, deps, ext_deps, observed_at, updated_at) VALUES ('fx', 'demo', 'u11-card', 'planned', '[]', ?, 1, 1)", [JSON.stringify(["nope/u1-x"])]);
  return s;
}
// What the actuator records when it sends an action.
const settle = (s: Store, subject: string, kind: string, episode: string) =>
  s.upsert("episodes", { project: "fx", subject, kind: `action:${kind}` }, { episode_key: episode, started_at: 1, state: "sent", source: "loop", observed_at: 1 });

describe("extDepCards", () => {
  test("a missing ref raises one card naming the unit and the ref, and not again once sent", () => {
    const s = setup();
    const a = extDepCards(s, "fx");
    expect(a.length).toBe(1);
    expect(a[0].kind).toBe("alert");
    expect(a[0].subject).toBe(SUBJECT);
    expect(String((a[0].payload as { text: string }).text)).toContain("u11-card");
    expect(String((a[0].payload as { text: string }).text)).toContain("nope/u1-x");
    settle(s, SUBJECT, "alert", a[0].episode);
    expect(extDepCards(s, "fx")).toEqual([]);
  });
  test("dropping the ref clears the card; a peer unit that appears clears it too", () => {
    const s = setup();
    const ep = extDepCards(s, "fx", 5)[0].episode;
    settle(s, SUBJECT, "alert", ep);
    s.db.run("UPDATE units SET ext_deps = '[]' WHERE slug = 'u11-card'");
    const c = extDepCards(s, "fx");
    expect(c.map((x) => x.kind)).toEqual(["alert-clear"]);
    expect((c[0].payload as { id: string }).id).toBe(alertId(SUBJECT, ep));
    settle(s, SUBJECT, "alert-clear", c[0].episode);
    expect(extDepCards(s, "fx")).toEqual([]);

    s.db.run("UPDATE units SET ext_deps = ? WHERE slug = 'u11-card'", [JSON.stringify(["nope/u1-x"])]);
    const again = extDepCards(s, "fx");
    expect(again.map((x) => x.kind)).toEqual(["alert"]);   // a new episode after the clear
    expect(extDepCards(s, "fx", 99)[0].episode).not.toBe(ep);
  });
  test("a ref that resolves to a live unit raises nothing", () => {
    const s = setup();
    s.db.run("INSERT INTO units (project, squad, slug, status, deps, ext_deps, observed_at, updated_at) VALUES ('fx', 'nope', 'u1-x', 'planned', '[]', '[]', 1, 1)");
    expect(extDepCards(s, "fx")).toEqual([]);
  });
});
