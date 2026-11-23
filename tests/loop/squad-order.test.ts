// squad-order.test.ts — the Squads table's one order rule (squad-table-ordering U1).
import { expect, test } from "bun:test";
import { compareSquads, squadRank } from "../../bin/board/squad-order.ts";

const sq = (topic: string, o: Record<string, unknown> = {}, done = 0, total = 0, label = "p") => ({
  label, topic, status: "running", display_key: "implementing", focus: false, questions: [], pause: { state: "active" },
  progress: { done, dispatched: 0, planned: 0, cancelled: 0, total }, ...o,
});
const order = (rows: any[]) => [...rows].sort(compareSquads).map((r) => r.topic).join(" ");

test("every band, top to bottom", () => {
  const rows = [
    sq("done", { status: "done" }, 3, 3),
    sq("susp", { status: "suspended" }, 1, 2),
    sq("paused", { pause: { state: "paused" } }, 1, 2),
    sq("parked", { display_key: "held-only" }, 1, 2),
    sq("wrap", { display_key: "wrapping-up" }, 2, 2),
    sq("run", {}, 1, 2),
    sq("star", { focus: true }, 0, 5),
    sq("ask", { questions: [{ id: "q" }] }, 0, 5),
  ];
  expect(order(rows)).toBe("ask star run wrap parked paused susp done");
  expect(order([...rows].reverse())).toBe("ask star run wrap parked paused susp done");
});

test("a question never lifts a done, suspended or failed squad; paused/starred with one is needs-you", () => {
  const q = [{ id: "q" }];
  expect(squadRank(sq("a", { status: "done", questions: q })).band).toBe(8);
  expect(squadRank(sq("a", { status: "failed", questions: q })).band).toBe(8);
  expect(squadRank(sq("a", { status: "suspended", questions: q })).band).toBe(7);
  expect(squadRank(sq("a", { status: "on-hold", questions: q })).band).toBe(7);
  expect(squadRank(sq("a", { pause: { state: "paused" }, questions: q })).band).toBe(1);
  expect(squadRank(sq("a", { focus: true, questions: q })).band).toBe(1);
  expect(squadRank(sq("a", { status: "blocked" })).band).toBe(1);
});

test("resuming keeps running; pausing is paused; retest due and empty waiting-on-you run", () => {
  expect(squadRank(sq("a", { pause: { state: "resuming" } })).band).toBe(3);
  expect(squadRank(sq("a", { pause: { state: "pausing" } })).band).toBe(6);
  expect(squadRank(sq("a", { display_key: "retest due" })).band).toBe(3);
  expect(squadRank(sq("a", { status: "waiting-on-you" })).band).toBe(3);
});

test("running: share done, then done count, no-unit after, broken last, then name", () => {
  const rows = [
    sq("none", {}, 0, 0),
    sq("broken", { error: true, status: "broken", display_key: "broken", progress: undefined, pause: undefined, focus: undefined }),
    sq("quarter", {}, 1, 4),
    sq("threeq", {}, 3, 4),
    sq("big", {}, 6, 8),
    sq("half-b", {}, 1, 2),
    sq("half-a", {}, 1, 2),
    sq("cancelled", {}, 1, 2),
  ];
  (rows[7] as any).progress = { done: 1, dispatched: 0, planned: 0, cancelled: 1, total: 2 }; // as progress() builds it: total leaves cancelled out
  expect(order(rows)).toBe("big threeq cancelled half-a half-b quarter none broken");
});

test("cancelled units are left out once: 3 done of 5 with 3 cancelled sorts below 4 of 5", () => {
  const cancelled = sq("cancelled", {}, 3, 5);
  (cancelled as any).progress = { done: 3, dispatched: 0, planned: 0, cancelled: 3, total: 5 };
  const further = sq("further", {}, 4, 5);
  expect(order([cancelled, further])).toBe("further cancelled");
  expect(order([further, cancelled])).toBe("further cancelled");
  for (const r of [cancelled, further]) expect(squadRank(r).keys[1]).toBeGreaterThanOrEqual(-1);
});

test("the project then the name break a tie; a malformed row does not throw", () => {
  expect(order([sq("x", {}, 1, 2, "q"), sq("x", {}, 1, 2, "p"), sq("a", {}, 1, 2, "q")])).toBe("x a x");
  expect(() => compareSquads({}, null)).not.toThrow();
});
