// blocker-slot.test.ts — U221: a unit that blocks started work (a dep of a `dispatched` unit) gets the next
// free Builder slot after urgent and before every other candidate, never over the limit, and the slot wait
// line says "next: blocks <unit>". Direct slot() checks on a small store (the shape max-builders.test.ts uses).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { placeOf, slot } from "../../bin/loop/capacity/slot.ts";
import { slotted } from "../../bin/loop/reconcilers/ready.ts";

const T = 1_800_000_000;
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(max: number) {
  const root = mkdtempSync(join(tmpdir(), "blocker-slot-")); roots.push(root);
  const store = open(root); stores.push(store);
  store.upsert("projects", { label: "p" }, { observed_at: 1 });
  store.upsert("squads", { project: "p", topic: "one" }, { status: "running", run_id: "run_one", repo: "path:/fake", lead_wt: "wt_lead", observed_at: 1, updated_at: 1 });
  store.upsert("config", { project: "p", file: "limits.conf", key: "max_builders" }, { value: String(max), observed_at: T });
  const unit = (slug: string, status: string, o: { deps?: string[]; urgent?: boolean } = {}) =>
    store.upsert("units", { project: "p", squad: "one", slug },
      { status, builder_wt: "", tier: "hard", deps: JSON.stringify(o.deps ?? []),
        doc: JSON.stringify({ slug, status, ...(o.urgent ? { urgent: true } : {}) }), observed_at: 1, updated_at: 1 });
  const live = (slug: string) =>
    store.upsert("members", { project: "p", squad: "one", role: "builder", suffix: slug },
      { wt: `wt_${slug}`, status: "running", agent: "claude", model: "opus", observed_at: 1, updated_at: 1 });
  const waiting = (slug: string) =>
    store.upsert("members", { project: "p", squad: "one", role: "builder", suffix: slug },
      { wt: `wt_${slug}`, status: "waiting", want: "running", want_at: T, agent: "claude", model: "opus", observed_at: 1, updated_at: 1 });
  return { store, unit, live, waiting };
}
const ask = (f: ReturnType<typeof setup>, s: string) => slot(f.store, "p", { squad: "one", suffix: s }, T);

test("a blocking planned unit takes the one free slot ahead of an older non-blocking dispatched unit", () => {
  const f = setup(3);
  for (const s of ["u1", "u2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("u3", "dispatched"); f.waiting("u3");               // older, not blocking
  f.unit("u9", "dispatched", { deps: ["u10"] }); f.live("u9"); // a started unit waits on u10... (live: holds a slot)
  f.unit("u10", "planned");
  // u9 is live, so the project is full (3 of 3): the blocker waits and says why.
  const full = ask(f, "u10");
  expect(full.ok).toBe(false);
  if (!full.ok) { expect(full.why).toBe("WAIT slot: p at max_builders 3 (next: blocks u9)"); expect(full.live).toBe(3); }
});

test("with one slot free the blocker gets it and the older dispatched unit does not", () => {
  const f = setup(3);
  for (const s of ["u1", "u2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("u3", "dispatched"); f.waiting("u3");
  f.unit("u9", "dispatched", { deps: ["u10"] });             // paused: no live agent, no wish
  f.unit("u10", "planned");
  expect(ask(f, "u10").ok).toBe(true);
  expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0u10"]));   // the one free slot goes to the blocker
});

test("the older non-blocking unit waits when the blocker is ahead of it", () => {
  const f = setup(3);
  for (const s of ["u1", "u2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("u3", "dispatched"); f.waiting("u3");
  f.unit("u9", "dispatched", { deps: ["u10"] });
  f.unit("u10", "planned"); f.waiting("u10");
  expect(ask(f, "u10").ok).toBe(true);
  expect(ask(f, "u3").ok).toBe(false);
});

test("an urgent unit still comes first, and over the limit; the blocker does not go over", () => {
  const f = setup(2);
  for (const s of ["u1", "u2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("u9", "dispatched", { deps: ["u10"] });
  f.unit("u10", "planned");
  f.unit("u11", "planned", { urgent: true });
  expect(ask(f, "u11").ok).toBe(true);
  expect(ask(f, "u10").ok).toBe(false);
  expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0u11"]));
});

test("planned queue order: a blocker is ready before an older planned unit", () => {
  const f = setup(3);
  for (const s of ["u1", "u2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("u3", "planned");                                    // older id
  f.unit("u9", "dispatched", { deps: ["u10"] });
  f.unit("u10", "planned");
  expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0u10"]));
});

test("a done dependent no longer makes its dep a blocker", () => {
  const f = setup(3);
  for (const s of ["u1", "u2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("u3", "planned");
  f.unit("u9", "done", { deps: ["u10"] });
  f.unit("u10", "planned");
  expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0u3"]));
});

// The ACME case: at the limit with six live Builders, U109 and U105 wait on U110. Their pauses free two slots,
// and U110 starts on the first with no urgent flag; an older waiting unit gets the other.
test("six live Builders, two wait on a fix: both pause, the fix starts on a freed slot without urgent", () => {
  const f = setup(6);
  for (const s of ["u100", "u105", "u109", "u101", "u102", "u103"]) { f.unit(s, "dispatched", s === "u105" || s === "u109" ? { deps: ["u110"] } : {}); f.live(s); }
  f.unit("u110", "planned");
  expect(ask(f, "u110").ok).toBe(false);
  for (const s of ["u105", "u109"]) {
    f.store.pause({ scope: "member", project: "p", squad: "one", role: "builder", suffix: s, member: `wt_${s}` });
    f.store.db.query("DELETE FROM observed_workers WHERE wt = ?").run(`wt_${s}`);
  }
  expect(ask(f, "u110").ok).toBe(true);
  expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0u110"]));
});

test("U6 placeOf: urgent, then blocking, then focus (squad-priority U1), then dispatched, then the lower units.id", () => {
  const f = setup(9);
  f.unit("plain-old", "planned"); f.unit("plain-new", "planned");
  f.unit("blocker", "planned"); f.unit("child", "dispatched", { deps: ["blocker"] });
  f.unit("urgent", "planned", { urgent: true });
  const at = (s: string) => placeOf(f.store, "p", f.store.get("units", { project: "p", squad: "one", slug: s }));
  const cmp = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const order = ["plain-new", "plain-old", "blocker", "urgent", "child"].sort((x, y) => cmp(at(x), at(y)));
  expect(order).toEqual(["urgent", "blocker", "child", "plain-old", "plain-new"]);
  expect(at("plain-old")[4]).toBeLessThan(at("plain-new")[4]);
  expect(placeOf(f.store, "p", null)).toEqual([1, 1, 1, 1, Number.MAX_SAFE_INTEGER]);
  expect(placeOf(f.store, "p", null, true)[2]).toBe(0);
});
