// squad-finish.test.ts — the one "is this squad finished" rule (squad-done-definition U1).
import { describe, expect, test } from "bun:test";
import { settle } from "../../bin/loop/squad/squad-finish.ts";

const lead = [{ role: "lead" }];
const u = (slug: string, status: string, more: Record<string, unknown> = {}) => ({ slug, status, ...more });

const held = { hold: true };
const fin = (units: any[]) => settle({ type: "feature", units, members: lead });

describe("settle: planned units waiting on held ones (U8)", () => {
  test("held + a planned dependent is held-only, the dependent is waiting", () => {
    const f = fin([u("h", "planned", held), u("p", "planned", { deps: ["h"] })]);
    expect(f.state).toBe("held-only");
    expect(f.held).toEqual(["h"]);
    expect(f.waiting).toEqual(["p"]);
    expect(f.planned).toEqual(["p"]);
  });
  test("chain held <- planned <- planned is held-only; deps may be a JSON string", () => {
    const f = fin([u("h", "planned", held), u("p", "planned", { deps: '["h"]' }), u("q", "planned", { deps: ["p"] })]);
    expect(f.state).toBe("held-only");
    expect(f.waiting).toEqual(["p", "q"]);
  });
  test("held + an independent planned unit is active", () => {
    expect(fin([u("h", "planned", held), u("p", "planned", { deps: ["h"] }), u("i", "planned")]).state).toBe("active");
  });
  test("a dependency cycle among planned units terminates as active", () => {
    expect(fin([u("h", "planned", held), u("p", "planned", { deps: ["q"] }), u("q", "planned", { deps: ["p"] })]).state).toBe("active");
  });
  test("a planned unit with only an ext-dep is active; a dispatched unit keeps it active", () => {
    expect(fin([u("h", "planned", held), u("p", "planned", { ext_deps: ["other/x"] })]).state).toBe("active");
    expect(fin([u("h", "planned", held), u("p", "planned", { deps: ["h"] }), u("d", "dispatched")]).state).toBe("active");
  });
});

describe("settle", () => {
  test("no units is empty", () => {
    expect(settle({ type: "feature", units: [], members: lead }).state).toBe("empty");
  });

  test("every unit done or cancelled, no Tester, no open PR: wrapping up", () => {
    const f = settle({ type: "feature", units: [u("a", "done"), u("b", "cancelled")], members: lead });
    expect(f).toEqual({ state: "wrapping-up", dispatched: [], planned: [], held: [], waiting: [], pr_open: [] });
    expect(settle({ units: [u("a", "cancelled")], members: [] }).state).toBe("wrapping-up"); // type defaults to feature
  });

  test("each hold kind makes it held-only, with the held slugs", () => {
    for (const hold of [{ hold: true, hold_by: "plan" }, { hold: true, hold_by: "parked" }, { hold: true, hold_reason: "freeze" }, { hold: 1 }, { held: true }]) {
      const f = settle({ type: "feature", units: [u("a", "done"), u("h", "planned", hold)], members: lead });
      expect(f.state).toBe("held-only");
      expect(f.held).toEqual(["h"]);
    }
  });

  test("a dispatched or unheld planned unit (status missing reads planned) is active, with the lists", () => {
    const f = settle({ type: "feature", units: [u("a", "done"), u("d", "dispatched"), u("p", "planned"), { slug: "q" }, u("h", "planned", { hold: true })], members: lead });
    expect(f).toEqual({ state: "active", dispatched: ["d"], planned: ["p", "q"], held: ["h"], waiting: [], pr_open: [] });
  });

  test("held plus a Tester is active; a Tester alone blocks wrapping up", () => {
    const tester = [...lead, { role: "tester" }];
    expect(settle({ type: "feature", units: [u("a", "done"), u("h", "planned", { hold: true })], members: tester }).state).toBe("active");
    expect(settle({ type: "feature", units: [u("a", "done")], members: tester }).state).toBe("active");
  });

  test("a done unit with an open PR is active", () => {
    const f = settle({ type: "feature", units: [u("a", "done", { pr_open: true }), u("b", "done")], members: lead });
    expect(f.state).toBe("active");
    expect(f.pr_open).toEqual(["a"]);
    expect(settle({ type: "feature", units: [u("a", "done", { pr_open: true }), u("h", "planned", { hold: true })], members: lead }).state).toBe("active");
  });

  test("a testing squad is never finished; an unknown status is open work", () => {
    expect(settle({ type: "testing", units: [u("a", "done")], members: lead }).state).toBe("active");
    expect(settle({ type: "feature", units: [u("a", "done"), u("x", "weird")], members: lead }).state).toBe("active");
  });
});
