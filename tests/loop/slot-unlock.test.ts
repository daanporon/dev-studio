// slot-unlock.test.ts — picker-prefers-unblocking-units U1: when Builder seats are full, the queued unit that open
// units wait on takes the next free seat before an older one nothing waits on. Urgent, blocks-started work, the
// focus key and resumes still rank above it; inside the focus squad the unit that unlocks the most goes first;
// outside it the unlock key never fills a lane's last seat; `unblock_first off` gives today's line exactly; and
// slot(), readyLine(), slotted(), seatable() and the board's Flow place read one line. Fixtures as slot-focus.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { queue, seatable, slot, unlocksOf } from "../../bin/loop/capacity/slot.ts";
import { readyLine, slotted } from "../../bin/loop/reconcilers/ready.ts";
import { buildBoard } from "../../bin/board/board-data.ts";

const REPO = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type UnitOpts = { light?: boolean; urgent?: boolean; deps?: string[]; ext?: string[]; hold?: boolean; superseded?: string };
// Squads `one` and `two`, live feature squads. Units are numbered in the order they are made, so the one made
// first is the older. `off`: unblock_first off.
function setup(max: number | null, light = 0, off = false) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "slot-unlock-")); roots.push(root);
  const store = open(root); stores.push(store);
  store.upsert("projects", { label: "p" }, { observed_at: 1 });
  const squad = (topic: string, status = "running") =>
    store.upsert("squads", { project: "p", topic }, { status, run_id: `run_${topic}`, repo: "path:/fake", lead_wt: `wt_lead_${topic}`, observed_at: 1, updated_at: 1 });
  squad("one"); squad("two");
  const conf = (key: string, value: string) => store.upsert("config", { project: "p", file: "limits.conf", key }, { value, observed_at: T });
  if (max != null) conf("max_builders", String(max));
  conf("max_light_builders", String(light));
  if (off) conf("unblock_first", "off");
  const unit = (sq: string, slug: string, status: string, o: UnitOpts = {}) =>
    store.upsert("units", { project: "p", squad: sq, slug },
      { status, builder_wt: "", tier: "standard", deps: JSON.stringify(o.deps ?? []), ext_deps: JSON.stringify(o.ext ?? []),
        hold: o.hold ? 1 : null, superseded_by: o.superseded ?? null, observed_at: 1, updated_at: 1,
        doc: JSON.stringify({ slug, status, ...(o.light ? { lane: "light" } : {}), ...(o.urgent ? { urgent: true } : {}) }) });
  const member = (sq: string, slug: string, waits: boolean) =>
    store.upsert("members", { project: "p", squad: sq, role: "builder", suffix: slug },
      { wt: `wt_${sq}_${slug}`, status: waits ? "waiting" : "running", ...(waits ? { want: "running", want_at: T } : {}),
        agent: "claude", model: "opus", observed_at: 1, updated_at: 1 });
  const live = (sq: string, slug: string, o: UnitOpts = {}) => { unit(sq, slug, "dispatched", o); member(sq, slug, false); };
  const waiting = (sq: string, slug: string, o: UnitOpts = {}) => { unit(sq, slug, "dispatched", o); member(sq, slug, true); };
  // `n` planned units of `sq` that wait on `slug` (not ready: their dep is not done).
  const kids = (sq: string, slug: string, n: number) => { for (let i = 1; i <= n; i++) unit(sq, `${slug}-k${i}`, "planned", { deps: [slug] }); };
  return { store, root, squad, unit, member, live, waiting, kids, conf, focus: (sq: string) => conf("focus_squad", sq) };
}
type F = ReturnType<typeof setup>;
const ask = (f: F, sq: string, slug: string) => slot(f.store, "p", { squad: sq, suffix: slug }, T);
const ok = (f: F, sq: string, slug: string) => ask(f, sq, slug).ok;
const planned = (f: F) => readyLine(f.store, "p", T).map((c) => ({ squad: c.topic, suffix: c.slug }));
const line = (f: F) => queue(f.store, "p", T, planned(f));
const order = (f: F) => line(f).map((p) => `${p.squad}/${p.suffix}`);
const count = (f: F, sq: string, slug: string) => unlocksOf(f.store, "p")(f.store.get("units", { project: "p", squad: sq, slug }));

// Each fixture on its own, so (8) re-runs it with unblock_first off.
const fixtures = {
  // (1) One seat free: an older leaf and a newer root with 3 planned dependents both wait.
  root: (off = false) => {
    const f = setup(3, 0, off);
    f.live("two", "x1"); f.live("two", "x2");
    f.waiting("two", "leaf");
    f.waiting("one", "root"); f.kids("one", "root", 3);
    return f;
  },
  // (3) Planned: an oldest leaf, a with 1 dependent, b and c with 2 each (c newer).
  counts: (off = false) => {
    const f = setup(4, 0, off);
    f.unit("one", "leaf", "planned");
    f.unit("one", "a", "planned"); f.kids("one", "a", 1);
    f.unit("one", "b", "planned"); f.kids("one", "b", 2);
    f.unit("one", "c", "planned"); f.kids("one", "c", 2);
    return f;
  },
  // (4) max_builders 3, two live seats on units with open dependents: no unlock room left.
  noRoom: (off = false) => {
    const f = setup(3, 0, off);
    f.live("two", "x1"); f.kids("two", "x1", 1);
    f.live("two", "x2"); f.kids("two", "x2", 1);
    f.waiting("one", "leaf");
    f.waiting("one", "root"); f.kids("one", "root", 2);
    return f;
  },
  // (5a) One seat in all: the lane's last seat goes oldest first.
  oneSeat: (off = false) => {
    const f = setup(1, 0, off);
    f.waiting("one", "leaf");
    f.waiting("one", "root"); f.kids("one", "root", 3);
    return f;
  },
  // (6) Five seats, nothing live: urgent, a blocker of started work, a dispatched resume, then the newest root.
  above: (off = false) => {
    const f = setup(5, 0, off);
    f.unit("one", "u", "planned", { urgent: true });
    f.unit("one", "b", "planned"); f.live("one", "d", { deps: ["b"] });
    f.waiting("one", "w");
    f.unit("one", "root", "planned"); f.kids("one", "root", 4);
    return f;
  },
  // (7a) The focus squad's leaf and an older root of another squad.
  focusLeaf: (off = false) => {
    const f = setup(3, 0, off);
    f.unit("two", "root", "planned"); f.kids("two", "root", 3);
    f.unit("one", "fleaf", "planned");
    f.focus("one");
    return f;
  },
  // (7b) The focus squad holds one seat (focus room 1): its newer root takes the room before its older leaf.
  focusRoot: (off = false) => {
    const f = setup(3, 0, off);
    f.live("one", "x1");
    f.unit("two", "o", "planned");
    f.unit("one", "fleaf", "planned");
    f.unit("one", "froot", "planned"); f.kids("one", "froot", 2);
    f.focus("one");
    return f;
  },
  // (7c) The focus squad's room is used up (it holds 2 of 3): the other squad's newer root beats its older leaf.
  focusFull: (off = false) => {
    const f = setup(3, 0, off);
    f.live("one", "a1"); f.live("one", "a2");
    f.waiting("two", "leaf");
    f.waiting("one", "f3");
    f.waiting("two", "root"); f.kids("two", "root", 2);
    f.focus("one");
    return f;
  },
};

describe("the next free seat", () => {
  test("(1) a newer root with 3 planned dependents beats an older leaf", () => {
    const f = fixtures.root();
    expect([ok(f, "one", "root"), ok(f, "two", "leaf")]).toEqual([true, false]);
    const w = ask(f, "two", "leaf");
    if (!w.ok) { expect(w.why).toBe("WAIT slot: p at max_builders 3"); expect(w.ahead).toBe(1); }
    const p = line(f).find((x) => x.suffix === "root")!;
    expect([p.unlock, p.unlocks]).toEqual([true, 3]);
    // At the limit the root says why it is next.
    f.live("two", "x3");
    const r = ask(f, "one", "root");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toBe("WAIT slot: p at max_builders 3 (next: unlocks 3)");
  });

  test("(2) counts go through the chain and ext_deps, and leave out what does not wait", () => {
    const f = setup(9);
    f.squad("three", "suspended");
    f.unit("one", "r", "planned");
    f.unit("one", "a", "planned", { deps: ["r"] });
    f.unit("one", "b", "planned", { deps: ["a"] });              // through the chain
    f.unit("one", "j", "dispatched", { deps: ["r"] });           // started work counts too
    f.unit("two", "h", "planned", { ext: ["one/r"] });           // another squad's ext_deps
    f.unit("one", "c", "planned", { deps: ["r"], hold: true });  // held: out, and the chain stops there
    f.unit("one", "c2", "planned", { deps: ["c"] });
    f.unit("one", "e", "done", { deps: ["r"] });
    f.unit("one", "g", "cancelled", { deps: ["r"] });
    f.unit("one", "s", "planned", { deps: ["r"], superseded: "s2" });
    f.unit("three", "i", "planned", { ext: ["one/r"] });         // a suspended squad
    f.unit("one", "both", "planned", { deps: ["a", "r"] });      // two ways in: counted once
    expect(count(f, "one", "r")).toBe(5);                        // a, b, j, h, both
    expect(count(f, "one", "a")).toBe(2);                        // b, both
    expect(count(f, "one", "b")).toBe(0);
    // A cycle ends, and counts each unit once.
    f.unit("one", "k", "planned", { deps: ["m"] });
    f.unit("one", "m", "planned", { deps: ["k"] });
    f.unit("one", "n", "planned", { deps: ["m"] });
    expect(count(f, "one", "k")).toBe(2);                        // m, n
    expect(count(f, "one", "m")).toBe(2);                        // k, n
  });

  test("(3) a bigger count goes first, a tie goes by id", () => {
    const f = fixtures.counts();
    expect(order(f)).toEqual(["one/b", "one/c", "one/a", "one/leaf"]);
    expect(line(f).map((p) => [p.unlock, p.unlocks])).toEqual([[true, 2], [true, 2], [true, 1], [false, 0]]);
  });

  test("(4) with max_builders 3 and 2 live seats on units with open dependents, the next seat goes by age", () => {
    const f = fixtures.noRoom();
    expect([ok(f, "one", "leaf"), ok(f, "one", "root")]).toEqual([true, false]);
    const r = ask(f, "one", "root");
    if (!r.ok) expect(r.why).toBe("WAIT slot: p at max_builders 3");
    expect(line(f).map((p) => [p.suffix, p.unlock, p.unlocks])).toEqual([["leaf", false, 0], ["root", false, 2]]);
  });

  test("(5) a one-seat lane ignores the key, and the light lane gets its own room", () => {
    const one = fixtures.oneSeat();
    expect([ok(one, "one", "leaf"), ok(one, "one", "root")]).toEqual([true, false]);
    // 2 normal + 2 light: room 1 in each lane. A live light seat on a unit with dependents takes the light room only.
    const f = setup(2, 2);
    f.unit("one", "nleaf", "planned"); f.unit("one", "lleaf", "planned", { light: true });
    f.unit("one", "nroot", "planned"); f.kids("one", "nroot", 1);
    f.unit("one", "lroot", "planned", { light: true }); f.kids("one", "lroot", 1);
    const at = (s: string) => order(f).indexOf(`one/${s}`);
    expect([at("nroot") < at("nleaf"), at("lroot") < at("lleaf")]).toEqual([true, true]);
    f.live("two", "lx", { light: true }); f.kids("two", "lx", 1);
    expect([at("nroot") < at("nleaf"), at("lroot") < at("lleaf")]).toEqual([true, false]);
  });

  test("(6) urgent, blocks-started work and a dispatched resume still rank above a bigger root", () => {
    const f = fixtures.above();
    expect(order(f)).toEqual(["one/u", "one/b", "one/w", "one/root"]);
    expect(line(f).find((p) => p.suffix === "root")!.unlocks).toBe(4);
  });

  test("(7) focus first; inside it the bigger root; outside it the root once focus has nothing to give", () => {
    const a = fixtures.focusLeaf();
    expect(order(a)).toEqual(["one/fleaf", "two/root"]);
    expect(line(a).map((p) => [p.focus, p.unlock])).toEqual([[true, false], [false, true]]);
    // Focus room 1: the newer root takes it, the older leaf then ranks by age behind two/o.
    const b = fixtures.focusRoot();
    expect(order(b)).toEqual(["one/froot", "two/o", "one/fleaf"]);
    expect(slotted(b.store, "p", T)).toEqual(new Set(["one\0froot", "two\0o"]));
    const c = fixtures.focusFull();
    expect([ok(c, "two", "root"), ok(c, "two", "leaf"), ok(c, "one", "f3")]).toEqual([true, false, false]);
    // Nothing of the focus squad is ready: the root still beats the older leaf.
    const d = fixtures.focusLeaf();
    d.unit("one", "fleaf", "planned", { hold: true });
    d.unit("two", "oleaf", "planned");
    expect(order(d)).toEqual(["two/root", "two/oleaf"]);
  });
});

describe("(8) unblock_first off gives today's line", () => {
  test("every fixture, by urgent, blocks, focus, dispatched, then age", () => {
    const r = fixtures.root(true);
    expect([ok(r, "two", "leaf"), ok(r, "one", "root")]).toEqual([true, false]);
    expect(order(fixtures.counts(true))).toEqual(["one/leaf", "one/a", "one/b", "one/c"]);
    const n = fixtures.noRoom(true);
    expect([ok(n, "one", "leaf"), ok(n, "one", "root")]).toEqual([true, false]);
    const o = fixtures.oneSeat(true);
    expect([ok(o, "one", "leaf"), ok(o, "one", "root")]).toEqual([true, false]);
    expect(order(fixtures.above(true))).toEqual(["one/u", "one/b", "one/w", "one/root"]);
    expect(order(fixtures.focusLeaf(true))).toEqual(["one/fleaf", "two/root"]);
    expect(order(fixtures.focusRoot(true))).toEqual(["one/fleaf", "two/o", "one/froot"]);
    const c = fixtures.focusFull(true);
    expect([ok(c, "two", "leaf"), ok(c, "two", "root")]).toEqual([true, false]);
    // No unit ranks by its count, though each still carries it.
    const l = line(fixtures.counts(true));
    expect(l.map((p) => [p.unlock, p.unlocks])).toEqual([[false, 0], [false, 1], [false, 2], [false, 2]]);
    expect(l.every((p) => p.rank[4] === 0)).toBe(true);
  });

  test("the limits key is on or off", () => {
    const f = setup(3);
    f.conf("unblock_first", "on");
    f.waiting("one", "leaf"); f.waiting("one", "root"); f.kids("one", "root", 1);
    expect(order(f)).toEqual(["one/root", "one/leaf"]);
  });
});

describe("(9) one line for slot(), readyLine(), slotted(), seatable() and the Flow", () => {
  test("they agree with queue()", () => {
    const f = setup(4);
    f.live("two", "x1"); f.live("two", "x2");                    // two seats free, unlock room 3
    f.unit("two", "o1", "planned"); f.unit("two", "o2", "planned");
    f.unit("one", "r1", "planned"); f.kids("one", "r1", 2);
    f.unit("one", "r2", "planned"); f.kids("one", "r2", 1);
    const want = ["one/r1", "one/r2", "two/o1", "two/o2"];
    expect(order(f)).toEqual(want);
    expect(readyLine(f.store, "p", T).map((c) => `${c.topic}/${c.slug}`)).toEqual(want);
    expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0r1", "one\0r2"]));
    expect(seatable(f.store, "p", T, planned(f)).map((p) => `${p.squad}/${p.suffix}`)).toEqual(["one/r1", "one/r2"]);
  });

  test("the board's Flow place orders the queue as queue() does", () => {
    const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "slot-unlock-board-")); roots.push(root);
    mkdirSync(join(root, "p", "squads"), { recursive: true });
    const plan = (slug: string, deps: string[] = []) => ({ slug, status: "planned", deps });
    const sq = {
      a: [{ slug: "x1", status: "dispatched", deps: [], builder_wt: "wt-x1" }, { slug: "x2", status: "dispatched", deps: [], builder_wt: "wt-x2" }, plan("o1"), plan("o2")],
      b: [plan("r1"), plan("r1-k1", ["r1"]), plan("r1-k2", ["r1"]), plan("r2"), plan("r2-k1", ["r2"])],
    };
    for (const [topic, units] of Object.entries(sq)) {
      const members = [{ role: "lead", wt: `lead-${topic}` }, ...units.filter((u: any) => u.builder_wt).map((u: any) => ({ role: "builder", suffix: u.slug, wt: u.builder_wt }))];
      writeFileSync(join(root, "p", "squads", `${topic}.json`), JSON.stringify({ task_id: topic, run_id: `run_${topic}`, repo: "path:/r/p", status: "running", members, units, worktrees: [] }));
    }
    writeFileSync(join(root, "seed.json"), JSON.stringify({ workers: [["lead-a", "working"], ["lead-b", "working"], ["wt-x1", "working"], ["wt-x2", "working"]] }));
    const env = { ...process.env, DS_STATE_ROOT: root };
    for (const cmd of [[join(REPO, "bin/ds"), "import"], [process.execPath, join(REPO, "tests/board-db.ts"), join(root, "seed.json"), "p"]]) {
      const r = spawnSync(cmd[0], cmd.slice(1), { env, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
    }
    const s = open(root); stores.push(s);
    s.upsert("config", { project: "p", file: "limits.conf", key: "max_builders" }, { value: "4", observed_at: 1 });
    const want = queue(s, "p", T, readyLine(s, "p", T).map((c) => ({ squad: c.topic, suffix: c.slug }))).map((p) => `${p.squad}/${p.suffix}`);
    expect(want).toEqual(["b/r1", "b/r2", "a/o1", "a/o2"]);
    // The Flow lists the queued units in the loop's order; those waiting on a dep follow, still by place.
    const flow = () => (buildBoard("p", "", root) as any).flow.queued_order.map((k: string) => k.replace(/^p\//, ""));
    expect(flow()).toEqual([...want, "b/r1-k1", "b/r1-k2", "b/r2-k1"]);
    s.upsert("config", { project: "p", file: "limits.conf", key: "unblock_first" }, { value: "off", observed_at: 1 });
    expect(flow().slice(0, 4)).toEqual(["a/o1", "a/o2", "b/r1", "b/r2"]);
  });
});
