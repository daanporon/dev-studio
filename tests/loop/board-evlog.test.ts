// evFolded (U281): an action row and its action_done row show as one line; and the squad detail bar keeps the
// costly buttons (Restart squad, Archive squad) in the squad ⋯ menu (squad-priority U2).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const page = readFileSync(join(import.meta.dir, "..", "..", "web", "board.html"), "utf8");
const i = page.indexOf("function evFolded("), evFolded: (evs: any[]) => any[] = new Function(`${page.slice(i, page.indexOf("\n}\n", i) + 2)} return evFolded;`)();
const sent = new Function(`${page.slice(page.indexOf("function evSentence("), page.indexOf("// The rows the event log shows"))} return evSentence;`);

let id = 0;
const ev = (kind: string, subject: string, at: number, extra: any = {}) => ({ id: ++id, kind, at, squad: "sq", member: null, sev: "info", payload: { kind: "restart", subject }, ...extra });
// newest first
const page1 = (...rows: any[]) => rows.sort((a, b) => b.at - a.at);

test("a pair for one subject folds into one `action` row keeping the done row's id, with the took text", () => {
  const acting = ev("action", "s1", 100), done = ev("action_done", "s1", 103);
  const out = evFolded(page1(acting, done));
  expect(out).toHaveLength(1);
  expect(out[0].id).toBe(done.id);
  expect(out[0].kind).toBe("action");
  expect(out[0].took).toBe("3s");
  expect(out[0].fold).toEqual({ acting, done });
  expect(evFolded([ev("action_done", "s2", 100), ev("action", "s2", 100)])[0].took).toBe("<1s");
});

test("an action_pending between them, or an action_failed, is not folded", () => {
  const rows = page1(ev("action", "s1", 100), ev("action_pending", "s1", 101), ev("action_done", "s1", 103));
  expect(evFolded(rows).map((e) => e.kind)).toEqual(["action_done", "action_pending", "action"]);
  const failed = page1(ev("action", "s1", 100), ev("action_failed", "s1", 103));
  expect(evFolded(failed).map((e) => e.kind)).toEqual(["action_failed", "action"]);
});

test("an action with no action_done keeps its acting row", () => {
  const out = evFolded(page1(ev("action", "s1", 100)));
  expect(out).toHaveLength(1);
  expect(out[0].kind).toBe("action");
  expect(out[0].took).toBeUndefined();
});

test("two interleaved pairs for different subjects fold each to its own row", () => {
  const out = evFolded(page1(ev("action", "a", 100), ev("action", "b", 101), ev("action_done", "a", 104), ev("action_done", "b", 105)));
  expect(out.map((e) => e.took)).toEqual(["4s", "4s"]);
  expect(out.map((e) => e.payload.subject)).toEqual(["b", "a"]);
});

test("the folded row's sentence reads `<act> · took Ns`", () => {
  const out = evFolded(page1(ev("action", "s1", 100), ev("action_done", "s1", 103)));
  expect(sent.call(null)(out[0])).toContain("· took 3s");
});

test("a wish_done row with only {want, result} reads who, what and why, never undefined", () => {
  const row = (member: string | null, payload: any) => ({ ...ev("wish_done", "s1", 100), member, payload });
  const a = sent.call(null)(row("0a1b2c3d-0000-4000-8000-00000000d3a0::/x/ds-p-builder-u1-x-sq", { want: "gone", result: "archived: worktree removed" }));
  expect(a).toBe("builder-u1-x is gone: archived: worktree removed");
  const b = sent.call(null)(row(null, { want: "running" }));
  expect(b).toBe("sq is running");
  for (const t of [a, b]) expect(t).not.toContain("undefined");
});

test("with the type picker on one exact event, nothing is folded", () => {
  expect(page).toMatch(/exact \? shown : evFolded\(shown\)/);
});

test("squad-priority U4: the squad row's ⋯ menu holds Pause, Events, Focus, the restarts, Suspend and Archive squad (last, in red); the box has no bar of its own for them", () => {
  const a = page.indexOf("function SquadMenu("), menu = page.slice(a, page.indexOf("function Detail(", a));
  const at = (t: string) => menu.indexOf(t);
  const order = ["PauseControls", ">Events<", "Unfocus squad", ">Restart Lead<", ">Restart squad<", ">Suspend squad<", 'class="sep"', ">Archive squad<"];
  order.forEach((t, i) => { expect(at(t)).toBeGreaterThan(-1); if (i) expect(at(t)).toBeGreaterThan(at(order[i - 1])); });
  expect(menu).not.toContain("mutedline");
  const d = page.indexOf("function Detail("), detail = page.slice(d, page.indexOf("function ovWhat", d));
  expect(detail).not.toContain("PauseControls");
  expect(detail).not.toContain("<${SquadMenu}");
  expect(detail).not.toContain("dbar-danger");
  expect(page).toMatch(/\.flow-col\.empty>\*\{opacity:\.45\}/);
});

const day: (at: number, now?: number) => string = new Function(`${page.slice(page.indexOf("function evDay("), page.indexOf("// `Sun 15 Nov 18:02"))} return evDay;`)();
const range: (evs: any[], now?: number) => string = new Function(`${page.slice(page.indexOf("function evDay("), page.indexOf("// The newest page follows"))} return evRange;`)();
const live: (cur: any) => boolean = new Function(`${page.slice(page.indexOf("const evLive ="), page.indexOf("\n", page.indexOf("const evLive =")))} return evLive;`)();

test("evDay names Today, Yesterday and a dated day in local time", () => {
  const now = new Date(2026, 10, 17, 10, 0).getTime() / 1000, at = (d: number, h: number) => new Date(2026, 10, d, h, 0).getTime() / 1000;
  expect(day(at(17, 0), now)).toBe("Today");
  expect(day(at(16, 23), now)).toBe("Yesterday");
  expect(day(at(15, 18), now)).toBe("Sun 15 Nov");
  expect(range([{ at: at(17, 9) }, { at: at(15, 18) }], now)).toBe("Sun 15 Nov 18:00 – Today 09:00");
  expect(range([{ at: at(17, 9) }, { at: at(17, 8) }], now)).toBe("Today 08:00 – 09:00");
  expect(range([], now)).toBe("");
});

test("evLive: only the newest page is live", () => {
  expect(live({})).toBe(true);
  expect(live({ before: 5 })).toBe(false);
  expect(live({ after: 5 })).toBe(false);
});

const now = Math.floor(Date.now() / 1000);
const fixtures = () => {
  const pg = readFileSync(join(import.meta.dir, "../fixtures/evlog/page.json"), "utf8");
  const d = new Date(); d.setDate(d.getDate() - 1);
  return {
    "api/events/lists": JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/evlog/lists.json"), "utf8")),
    "api/events?": JSON.parse(pg.replace("__NEW__", String(now)).replace("__OLD__", String(Math.floor(d.getTime() / 1000)))),
  };
};
const board = { ...JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/board-empty.json"), "utf8")), project: "fixture", page_version: "v1",
  squads: [{ label: "fixture", topic: "alpha", status: "running", members: [], display_status: "running", type: "feature", autonomy: "checkpoint", ship_mode: "ce-pipeline", units: [] }] };
const settle = () => new Promise((r) => setTimeout(r, 60));

test("the mounted log: grouped squad picker, crew, a Yesterday line, Events link and Clear filters", async () => {
  const r = await mount(board, true, fixtures()); // opens every details, the log's too
  try {
    const doc = r.window.document, ev = doc.getElementById("events");
    await settle();
    const groups = [...ev.querySelectorAll('select[aria-label="squad"] optgroup')].map((g: any) => g.label);
    expect(groups).toEqual(["Live squads", "Studio and project-wide", "Closed squads"]);
    expect([...ev.querySelectorAll(".evday")].map((x: any) => x.textContent)).toEqual(["Today", "Yesterday"]);
    // The squad's Events button opens the log on that squad; the next request carries it.
    doc.querySelector(".row.squad").dispatchEvent(new r.window.MouseEvent("click", { bubbles: true })); await settle();
    const squad = doc.querySelector('[data-ev="squad-events"]');
    expect(squad).not.toBeNull();
    {
      r.urls.length = 0; squad.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true })); await settle();
      expect(r.urls.some((u: string) => u.startsWith("api/events?") && u.includes("squad=alpha"))).toBe(true);
      expect([...ev.querySelectorAll('select[aria-label="crew"] option')].map((o: any) => o.textContent)).toEqual(["whole squad", "lead", "builder-u1"]);
      const gone = ev.querySelector('select[aria-label="crew"] optgroup');
      expect(gone.label).toBe("Gone");
      expect([...gone.querySelectorAll("option")].map((o: any) => o.textContent)).toEqual(["builder-u1"]);
    }
    r.urls.length = 0;
    const clear = ev.querySelector('[data-ev="clear"]');
    expect(clear.disabled).toBe(false);
    clear.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true })); await settle();
    const last = r.urls.filter((u: string) => u.startsWith("api/events?")).pop()!;
    expect(last).not.toContain("squad=");
    expect(last).toContain("noise=hide");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});
