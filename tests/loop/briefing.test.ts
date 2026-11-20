// briefing.test.ts — the morning brief's schedule (U3): bin/loop/reconcilers/briefing.ts files the
// Studio one request per allowed date once briefing_time has passed on the host clock, never on an
// off day, never twice, and carries "since the last brief" in the request rows (KTD3/KTD4).
// The clock is pinned: the host zone is Europe/Berlin for the whole file, the ticks are epochs.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { DIRS, load, type Reconciler, type TickCtx } from "../../bin/loop/core/plugins.ts";
import briefing, { nextSlot, parseDays, parseTime, scheduleFrom } from "../../bin/loop/reconcilers/briefing.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ENV = ["TZ", "DS_LIMIT_BRIEFING_TIME", "DS_LIMIT_BRIEFING_DAYS", "DS_NOW"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.TZ = "Europe/Berlin";
  delete process.env.DS_LIMIT_BRIEFING_TIME;
  delete process.env.DS_LIMIT_BRIEFING_DAYS;
});
afterAll(() => { for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); });

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
// The schedule is in effect since `since` (U4's record), long before any tick by default; null leaves
// it unseen, as on the first tick after U4 shipped.
function store(time?: string, days?: string, since: number | null = LONG_AGO): Store {
  const d = mkdtempSync(join(tmpdir(), "zzbrief-"));
  temps.push(d);
  const s = open(d);
  stores.push(s);
  if (time !== undefined) conf(s, "briefing_time", time);
  if (days !== undefined) conf(s, "briefing_days", days);
  if (since !== null) scheduleFrom(s, "fx", since);
  return s;
}
const conf = (s: Store, key: string, value: string, project = "fx") =>
  s.upsert("config", { project, file: "limits.conf", key }, { value, observed_at: 1 });

// Local wall-clock time (Europe/Berlin) as epoch seconds; month is 1-based.
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;
// 2027-01-11 is a Monday.
const MON = (h: number, mi = 0) => at(2027, 1, 11, h, mi);
const TUE = (h: number, mi = 0) => at(2027, 1, 12, h, mi);
const WED = (h: number, mi = 0) => at(2027, 1, 13, h, mi);
const SAT = (h: number, mi = 0) => at(2027, 1, 16, h, mi);
const SUN = (h: number, mi = 0) => at(2027, 1, 17, h, mi);
const LONG_AGO = at(2026, 1, 1, 0);

function tick(s: Store, now: number, project = "fx") {
  process.env.DS_NOW = String(now);
  briefing.run({ store: s, project, tick: 0, now, fired: [], poked: new Set() } as TickCtx);
}
const briefs = (s: Store) => (s.db.query("SELECT * FROM requests WHERE kind = 'studio' ORDER BY id").all() as Row[])
  .map((r) => ({ ...r, p: JSON.parse(String(r.payload)) }));
const events = (s: Store, kind: string) => s.db.query("SELECT payload FROM events WHERE kind = ?").all(kind) as Row[];
const schedules = (s: Store) => events(s, "briefing_schedule").map((e) => JSON.parse(String(e.payload)));

describe("settings parse", () => {
  test("time: off, HH:MM, and anything else is bad", () => {
    expect(parseTime("off")).toBeNull();
    expect(parseTime("09:00")).toBe(540);
    expect(parseTime("23:59")).toBe(1439);
    for (const v of ["9:00", "24:00", "09:60", "", "nine"]) expect(parseTime(v)).toBeUndefined();
  });
  test("days: daily, lists, ranges (wrapping too); bad or empty is null", () => {
    expect([...parseDays("daily")!].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...parseDays("mon-fri")!].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...parseDays("mon-wed,fri")!].sort()).toEqual([1, 2, 3, 5]);
    expect([...parseDays("fri-mon")!].sort()).toEqual([0, 1, 5, 6]);
    for (const v of ["", "funday", "mon-", "mon;rm", "mon,,fri"]) expect(parseDays(v)).toBeNull();
  });
});

describe("schedule", () => {
  test("briefing_time off, or no key at all (the default), never sends", () => {
    for (const s of [store("off", "daily"), store()]) {
      for (const t of [MON(9), MON(12), SAT(10), SUN(23, 59)]) tick(s, t);
      expect(briefs(s)).toHaveLength(0);
    }
  });

  test("an off day (Saturday under mon-fri) sends nothing; the default days are mon-fri", () => {
    for (const s of [store("09:00", "mon-fri"), store("09:00")]) {
      tick(s, SAT(9)); tick(s, SAT(18)); tick(s, SUN(10));
      expect(briefs(s)).toHaveLength(0);
    }
  });

  test("Monday before 09:00 none; at 09:00 exactly one keyed by the date; ten more ticks and an open request add nothing", () => {
    const s = store("09:00", "mon-fri");
    tick(s, MON(8, 59));
    expect(briefs(s)).toHaveLength(0);
    tick(s, MON(9));
    const [b] = briefs(s);
    expect(briefs(s)).toHaveLength(1);
    expect(b.key).toBe("briefing:fx:2027-01-11");
    expect(b.project).toBe("fx");
    expect(b.done_at).toBeNull(); // nothing cleared it
    for (let i = 1; i <= 10; i++) tick(s, MON(9) + i * 30);
    tick(s, MON(17));
    expect(briefs(s)).toHaveLength(1);
  });

  test("the payload is KTD4: the first brief ever covers the 24h before it; the line names the collector", () => {
    const s = store("09:00", "mon-fri");
    tick(s, MON(9, 5));
    const { p } = briefs(s)[0];
    expect(Object.keys(p).sort()).toEqual(["action", "date", "label", "line", "merges_upto", "since", "spend", "until"]);
    expect(p).toMatchObject({ action: "briefing", label: "fx", date: "2027-01-11", until: MON(9, 5), since: MON(9, 5) - 86_400, spend: {} });
    expect(p.line).toBe(`briefing: write the morning brief for fx, 2027-01-11 (since Sun 09:05) — studio/studio.md "Morning brief"; facts: bin/ds briefing-input fx --date 2027-01-11`);
  });

  test("the request notes where each repo's merge record ends (merges_upto); a repo never read is left out", () => {
    const s = store("09:00", "mon-fri");
    s.db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES ('fx','github','repo:path:/a','acme/a',1), ('fx','github','repo:path:/b','acme/b',1)");
    s.db.run("INSERT INTO observed_github (repo, merges_from, merges_until, observed_at) VALUES ('acme/a', 100, 5000, 1), ('acme/b', NULL, NULL, 1)");
    tick(s, MON(9, 5));
    expect(briefs(s)[0].p.merges_upto).toEqual({ "acme/a": 5000 });
  });

  test("a loop down 08:00-15:00 sends once at 15:00", () => {
    const s = store("09:00", "mon-fri");
    tick(s, MON(7, 59));
    tick(s, MON(15));
    tick(s, MON(15, 1));
    expect(briefs(s).map((b) => [b.key, b.p.until])).toEqual([["briefing:fx:2027-01-11", MON(15)]]);
  });

  test("a loop down all Tuesday: nothing for Tuesday on Wednesday 08:00; Wednesday 09:00 runs since Monday's brief", () => {
    const s = store("09:00", "mon-fri");
    tick(s, MON(9));
    tick(s, WED(8));
    expect(briefs(s)).toHaveLength(1);
    tick(s, WED(9));
    const all = briefs(s);
    expect(all.map((b) => b.key)).toEqual(["briefing:fx:2027-01-11", "briefing:fx:2027-01-13"]);
    expect(all[1].p.since).toBe(MON(9));
    expect(all[1].p.line).toContain("(since Mon 09:00)");
  });

  test("Monday's brief runs since Friday's: the weekend is in it", () => {
    const s = store("08:30", "mon-fri");
    const FRI = at(2027, 1, 15, 8, 30);
    tick(s, FRI);
    tick(s, SAT(9)); tick(s, SUN(9));
    tick(s, at(2027, 1, 18, 8, 30));
    expect(briefs(s).map((b) => b.p.since)).toEqual([FRI - 86_400, FRI]);
  });

  test("the day after a DST change the slot is still 09:00 local", () => {
    // Europe/Berlin goes to summer time on Sunday 2027-03-28: Monday 09:00 local is 07:00 UTC.
    const s = store("09:00", "daily");
    tick(s, Date.UTC(2027, 2, 27, 8, 0) / 1000); // Saturday 09:00 CET
    const mon0900 = Date.UTC(2027, 2, 29, 7, 0) / 1000;
    tick(s, mon0900 - 60); // 08:59 CEST
    expect(briefs(s).map((b) => b.p.date)).toEqual(["2027-03-27"]);
    tick(s, mon0900);
    expect(briefs(s).map((b) => b.p.date)).toEqual(["2027-03-27", "2027-03-29"]);
  });

  test("briefing_days daily sends on Sunday; a list sends only on its days", () => {
    const s = store("09:00", "daily");
    tick(s, SUN(9));
    expect(briefs(s).map((b) => b.p.date)).toEqual(["2027-01-17"]);
    const w = store("09:00", "mon,wed");
    for (const day of [MON, TUE, WED]) tick(w, day(10));
    expect(briefs(w).map((b) => b.p.date)).toEqual(["2027-01-11", "2027-01-13"]);
  });

  test("a bad stored value sends nothing and logs one briefing_bad_setting event a day", () => {
    const s = store("9:00", "mon-fri");
    tick(s, MON(9)); tick(s, MON(10)); tick(s, MON(23));
    expect(briefs(s)).toHaveLength(0);
    expect(events(s, "briefing_bad_setting").map((e) => JSON.parse(String(e.payload)))).toEqual([{ date: "2027-01-11", key: "briefing_time", value: "9:00" }]);
    tick(s, TUE(9));
    expect(events(s, "briefing_bad_setting")).toHaveLength(2);
    const d = store("09:00", "funday");
    tick(d, MON(9)); tick(d, MON(9, 30));
    expect(briefs(d)).toHaveLength(0);
    expect(events(d, "briefing_bad_setting").map((e) => JSON.parse(String(e.payload)).key)).toEqual(["briefing_days"]);
  });

  test("the project's own value beats the conventions default, and the env override beats both", () => {
    const s = store();
    conf(s, "briefing_time", "09:00", "");
    conf(s, "briefing_time", "off");
    tick(s, MON(10));
    expect(briefs(s)).toHaveLength(0);
    process.env.DS_LIMIT_BRIEFING_TIME = "10:00";
    try { tick(s, MON(10)); } finally { delete process.env.DS_LIMIT_BRIEFING_TIME; }
    expect(briefs(s)).toHaveLength(1);
  });

  test("the spend snapshot holds each squad's observed_spend.total; the next brief's baseline is it", () => {
    const s = store("09:00", "mon-fri");
    const spend = (squad: string, total: number | null) =>
      s.upsert("observed_spend", { project: "fx", squad }, { total, observed_at: 1 });
    spend("alpha", 1000); spend("beta", 250); spend("gamma", null);
    s.upsert("observed_spend", { project: "other", squad: "zeta" }, { total: 9, observed_at: 1 });
    tick(s, MON(9));
    spend("alpha", 1600); spend("delta", 40);
    tick(s, TUE(9));
    expect(briefs(s).map((b) => b.p.spend)).toEqual([{ alpha: 1000, beta: 250 }, { alpha: 1600, beta: 250, delta: 40 }]);
  });

  test("a brief the loop gave up on is filed again; the next one's since skips it", () => {
    const s = store("09:00", "mon-fri");
    tick(s, MON(9));
    const [mon] = briefs(s);
    s.db.run("UPDATE requests SET done_at = ?, result = ? WHERE id = ?", [MON(9, 1), JSON.stringify({ ok: false, error: "x" }), Number(mon.id)]);
    tick(s, MON(9, 2));
    const again = briefs(s);
    expect(again).toHaveLength(2);
    expect(again[1].key).toBe("briefing:fx:2027-01-11");
    expect(again[1].p.since).toBe(MON(9, 2) - 86_400);
    tick(s, TUE(9));
    expect(briefs(s)[2].p.since).toBe(MON(9, 2));
  });

  test("each project keeps its own key and window", () => {
    const s = store("09:00", "mon-fri");
    conf(s, "briefing_time", "09:00", "two");
    tick(s, MON(9), "fx"); tick(s, MON(9), "two"); tick(s, TUE(9), "fx");
    expect(briefs(s).map((b) => b.key)).toEqual(["briefing:fx:2027-01-11", "briefing:two:2027-01-11", "briefing:fx:2027-01-12"]);
    expect(briefs(s)[2].p.since).toBe(MON(9));
  });
});

describe("a newly set schedule waits for its next slot (U4)", () => {
  test("time set at 18:48 to 09:00 (off -> on): nothing that day; filed at 09:00 the next allowed day", () => {
    const s = store("off", "mon-fri");
    tick(s, MON(8));
    conf(s, "briefing_time", "09:00");
    for (const t of [MON(18, 48), MON(18, 49), MON(23, 59), TUE(8, 59)]) tick(s, t);
    expect(briefs(s)).toHaveLength(0);
    tick(s, TUE(9)); tick(s, TUE(9, 1));
    expect(briefs(s).map((b) => [b.key, b.p.until])).toEqual([["briefing:fx:2027-01-12", TUE(9)]]);
    expect(schedules(s)).toEqual([{ time: "off", days: "mon-fri", at: LONG_AGO }, { time: "09:00", days: "mon-fri", at: MON(18, 48) }]);
  });

  test("time set before the slot sends at the slot", () => {
    const s = store("off", "mon-fri");
    tick(s, MON(8));
    conf(s, "briefing_time", "09:00");
    tick(s, MON(8, 30)); tick(s, MON(8, 59));
    expect(briefs(s)).toHaveLength(0);
    tick(s, MON(9));
    expect(briefs(s).map((b) => b.key)).toEqual(["briefing:fx:2027-01-11"]);
  });

  test("a time set exactly at the slot still sends that slot", () => {
    const s = store("off", "mon-fri");
    conf(s, "briefing_time", "09:00");
    tick(s, MON(9));
    expect(briefs(s)).toHaveLength(1);
  });

  test("days changed after the slot: nothing today, the next allowed day sends", () => {
    const s = store("09:00", "tue-fri");
    tick(s, MON(8));
    conf(s, "briefing_days", "mon-fri");
    tick(s, MON(10)); tick(s, MON(17));
    expect(briefs(s)).toHaveLength(0);
    tick(s, TUE(9));
    expect(briefs(s).map((b) => b.key)).toEqual(["briefing:fx:2027-01-12"]);
  });

  test("first sight after the slot (no record yet): nothing today, recorded from that tick", () => {
    const s = store("09:00", "mon-fri", null);
    tick(s, MON(10));
    expect(briefs(s)).toHaveLength(0);
    expect(schedules(s)).toEqual([{ time: "09:00", days: "mon-fri", at: MON(10) }]);
    tick(s, TUE(9));
    expect(briefs(s).map((b) => b.key)).toEqual(["briefing:fx:2027-01-12"]);
  });

  test("first sight before the slot sends that day", () => {
    const s = store("09:00", "mon-fri", null);
    tick(s, MON(8)); tick(s, MON(9));
    expect(briefs(s)).toHaveLength(1);
  });

  test("an env override counts as the schedule; each project keeps its own record", () => {
    const s = store("09:00", "mon-fri");
    conf(s, "briefing_time", "09:00", "two");
    process.env.DS_LIMIT_BRIEFING_TIME = "08:00";
    try { tick(s, MON(10)); tick(s, MON(10), "two"); } finally { delete process.env.DS_LIMIT_BRIEFING_TIME; }
    expect(briefs(s)).toHaveLength(0);
    tick(s, MON(11)); tick(s, MON(11), "two");
    expect(briefs(s)).toHaveLength(0);
    tick(s, TUE(9)); tick(s, TUE(9), "two");
    expect(briefs(s).map((b) => b.key)).toEqual(["briefing:fx:2027-01-12", "briefing:two:2027-01-12"]);
  });
});

describe("nextSlot (morning-brief-polish U2)", () => {
  const FRI = (h: number, mi = 0) => at(2027, 1, 15, h, mi);
  test("before today's slot: today's slot", () => expect(nextSlot(MON(7), "08:30", "mon-fri", false)).toBe(MON(8, 30)));
  test("slot passed today, nothing sent yet: today's slot (due now), never a later day", () =>
    expect(nextSlot(MON(10), "08:30", "mon-fri", false)).toBe(MON(8, 30)));
  test("sent today: the next allowed day", () => expect(nextSlot(MON(10), "08:30", "mon-fri", true)).toBe(TUE(8, 30)));
  test("across a weekend: Friday's sent slot gives Monday", () =>
    expect(nextSlot(FRI(10), "08:30", "mon-fri", true)).toBe(at(2027, 1, 18, 8, 30)));
  test("a day the schedule skips (Saturday) gives Monday", () =>
    expect(nextSlot(at(2027, 1, 16, 9), "08:30", "mon-fri", false)).toBe(at(2027, 1, 18, 8, 30)));
  test("a wrapping range (fri-mon) reaches Sunday", () =>
    expect(nextSlot(FRI(10), "08:30", "fri-mon", true)).toBe(at(2027, 1, 16, 8, 30)));
  test("off, a bad time or bad days: null", () => {
    expect(nextSlot(MON(7), "off", "mon-fri", false)).toBeNull();
    expect(nextSlot(MON(7), "8:30", "mon-fri", false)).toBeNull();
    expect(nextSlot(MON(7), "08:30", "funday", false)).toBeNull();
  });
  test("a schedule set after today's slot waits for the next allowed day (U4's rule)", () =>
    expect(nextSlot(MON(10), "08:30", "mon-fri", false, MON(9))).toBe(TUE(8, 30)));
  test("a schedule in effect before today's slot still shows it due", () =>
    expect(nextSlot(MON(10), "08:30", "mon-fri", false, MON(8))).toBe(MON(8, 30)));
});

describe("through the loop", () => {
  test("the Studio gets requests/_studio/briefing-<id>.txt, its first line the briefing line; one per date", async () => {
    const s = store("09:00", "mon-fri");
    const fulfillers = (await load<Fulfiller & Reconciler>(DIRS.fulfil)).filter((f) => f.kinds);
    const act = new LoopActuator({ orca: new FakeOrca(), fulfillers });
    const loop = new Loop(s, { observers: [], reconcilers: [briefing, ...fulfillers] }, act, { projects: () => ["fx"] });
    loop.boot(MON(8));
    const run = async (now: number) => { process.env.DS_NOW = String(now); await loop.tick(now); await act.drain(); };
    await run(MON(8, 30));
    await run(MON(9));
    await run(MON(9, 1));
    const dir = join(s.root, "fx", "requests", "_studio");
    const [b] = briefs(s);
    expect(readdirSync(dir)).toEqual([`briefing-${b.id}.txt`]);
    const first = readFileSync(join(dir, `briefing-${b.id}.txt`), "utf8").split("\n")[0];
    expect(first.startsWith("briefing: write the morning brief for fx, 2027-01-11")).toBe(true);
    expect(b.done_at).not.toBeNull();
    // The file's own row (what watch.sh shows and done-request.sh clears) stays open.
    expect(s.db.query("SELECT done_at FROM requests WHERE key = ?").get(`file:fx/_studio/briefing-${b.id}.txt`)).toEqual({ done_at: null });
  });
});
