// briefing — the morning brief's schedule (U3). Each tick, per project, it recomputes today's slot on
// the host clock: on a day `briefing_days` allows, once now ≥ `briefing_time`, it files the Studio one
// request keyed briefing:<label>:<YYYY-MM-DD>. The key makes it one per date: ten more ticks, an open
// request the Studio has not cleared, or a loop restart add nothing. A loop that was down at the slot
// sends on its first tick later that day; a whole missed day is never sent later, since the next brief
// covers the time since the last one. fulfil/studio.ts writes it as requests/_studio/briefing-<id>.txt.
//
// A slot counts only if the schedule in effect took effect at or before it (morning-brief-polish U4):
// a time or days set after today's slot (off -> on too) waits for the next allowed day, while a slot
// the loop missed under an unchanged schedule still sends late. The reconciler records each change of
// the effective (time, days) as one briefing_schedule event {time, days, at}; config.observed_at
// will not do, since an import refreshes it. The first sight of a project records it as in effect
// from that tick, so a project already on a schedule may skip at most that one day's late send.
//
// The payload (the contract bin/ds briefing-input reads, U4):
//   {action:"briefing", label, date, since, until, spend:{<topic>: total}, merges_upto:{<repo>: epoch}, line}
// `until` is the tick's time, `spend` each squad's observed_spend.total then; `since` is the previous
// brief's `until` (until − 24h for the first). A bad stored setting sends nothing and logs one
// briefing_bad_setting event a day; `off` (the default) sends nothing.
import { limit } from "../settings/limits.ts";
import type { Reconciler } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";

const DAY = 86_400;
const NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TITLE = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DEFAULTS = { briefing_time: "off", briefing_days: "mon-fri" } as const;

// "off" -> null; HH:MM (24h) -> minutes after midnight; anything else -> undefined (bad).
export function parseTime(v: string): number | null | undefined {
  if (v === "off") return null;
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

// daily | comma list of mon..sun and ranges (mon-wed,fri; a range may wrap: fri-mon) -> the weekdays
// (0 = Sunday, as Date.getDay); null when bad or empty.
export function parseDays(v: string): Set<number> | null {
  if (v === "daily") return new Set([0, 1, 2, 3, 4, 5, 6]);
  const out = new Set<number>();
  for (const tok of v.split(",")) {
    const m = /^([a-z]{3})(?:-([a-z]{3}))?$/.exec(tok);
    if (!m) return null;
    const a = NAMES.indexOf(m[1]), b = NAMES.indexOf(m[2] ?? m[1]);
    if (a < 0 || b < 0) return null;
    for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
  }
  return out.size ? out : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
// The host-clock calendar date of an epoch second, as YYYY-MM-DD.
export function localDate(at: number): string {
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// "Mon 09:00" on the host clock.
const stamp = (at: number) => { const d = new Date(at * 1000); return `${TITLE[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export const gaveUp = (r: Row) => r.done_at != null && /"ok":\s*false/.test(String(r.result ?? ""));

// The last brief before `date` that reached the Studio (a request the loop gave up on never did).
function previous(store: Store, label: string, date: string): { until: number; spend: Record<string, number> } | null {
  const rows = store.db.query(`SELECT payload, done_at, result FROM requests WHERE kind = 'studio' AND project = ?
    AND json_extract(payload, '$.action') = 'briefing' AND json_extract(payload, '$.date') < ? ORDER BY id DESC`).all(label, date) as Row[];
  for (const r of rows) {
    if (gaveUp(r)) continue;
    const p = JSON.parse(String(r.payload)) as { until?: number; spend?: Record<string, number> };
    if (typeof p.until === "number") return { until: p.until, spend: p.spend ?? {} };
  }
  return null;
}

// One briefing_bad_setting event per project a day.
function bad(store: Store, label: string, date: string, key: string, value: string): void {
  const seen = store.db.query("SELECT 1 FROM events WHERE kind = 'briefing_bad_setting' AND project = ? AND json_extract(payload, '$.date') = ?").get(label, date);
  if (!seen) store.event("briefing_bad_setting", { project: label, payload: { date, key, value } });
}

// The project's effective briefing_time and briefing_days, defaults included.
const settings = (store: Store, label: string) => ({
  time: limit(store, label, "briefing_time") ?? DEFAULTS.briefing_time,
  days: limit(store, label, "briefing_days") ?? DEFAULTS.briefing_days,
});

// When the schedule in effect now took effect: the `at` of the project's latest briefing_schedule
// event while it holds the effective time and days. On a change, or the first time it is seen, it
// records one event and returns `now`.
// Read-only half of scheduleFrom: the `at` of the latest briefing_schedule event while it holds this
// time and days, else null (not recorded yet, or the schedule changed since).
export function scheduleSince(store: Store, label: string, time: string, days: string): number | null {
  const last = store.db.query("SELECT payload FROM events WHERE kind = 'briefing_schedule' AND project = ? ORDER BY id DESC LIMIT 1").get(label) as Row | null;
  const p = last ? JSON.parse(String(last.payload)) as { time?: string; days?: string; at?: number } : null;
  return p && p.time === time && p.days === days && typeof p.at === "number" ? p.at : null;
}
export function scheduleFrom(store: Store, label: string, now: number, { time, days } = settings(store, label)): number {
  const at = scheduleSince(store, label, time, days);
  if (at !== null) return at;
  store.event("briefing_schedule", { project: label, payload: { time, days, at: now } });
  return now;
}

// Local-clock slot of the day `d` falls on, built from components so a DST change keeps the wall-clock time.
const slotOf = (d: Date, mins: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(mins / 60), mins % 60).getTime() / 1000;
// The one send rule for a slot: it has come, and the schedule in effect took effect at or before it.
const slotOpen = (now: number, slot: number, from: number) => now >= slot && from <= slot;

// The epoch of the next brief slot, or null when the schedule is off or bad. A slot that has opened
// with nothing sent is today's (the loop sends on its next tick, so it is <= now: "due now"); a slot
// the schedule took effect after (`from`, U4) or one already sent today waits for the next allowed day.
export function nextSlot(now: number, time: string, daysRaw: string, sentToday: boolean, from = -Infinity): number | null {
  const mins = parseTime(time), days = parseDays(daysRaw);
  if (mins === null || mins === undefined || !days) return null;
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now * 1000);
    d.setDate(d.getDate() + i);
    if (!days.has(d.getDay())) continue;
    const slot = slotOf(d, mins);
    if (i === 0) {
      if (sentToday) continue;
      if (slotOpen(now, slot, from)) return slot;
      if (now < slot) return slot;
      continue; // passed, but the schedule took effect after it
    }
    return slot;
  }
  return null;
}

export function briefingDue(store: Store, label: string, now: number): Row | null {
  const { time, days: daysRaw } = settings(store, label);
  const from = scheduleFrom(store, label, now, { time, days: daysRaw });
  const date = localDate(now);
  const mins = parseTime(time);
  if (mins === undefined) { bad(store, label, date, "briefing_time", time); return null; }
  if (mins === null) return null;
  const days = parseDays(daysRaw);
  if (!days) { bad(store, label, date, "briefing_days", daysRaw); return null; }
  const d = new Date(now * 1000);
  if (!days.has(d.getDay())) return null;
  if (!slotOpen(now, slotOf(d, mins), from)) return null;
  const key = `briefing:${label}:${date}`;
  const hit = store.db.query("SELECT * FROM requests WHERE key = ?").get(key) as Row | null;
  if (hit && !gaveUp(hit)) return null;

  const until = now, prev = previous(store, label, date);
  const since = prev ? prev.until : until - DAY;
  const spend: Record<string, number> = {};
  for (const r of store.db.query("SELECT squad, total FROM observed_spend WHERE project = ? AND total IS NOT NULL ORDER BY squad").all(label) as Row[])
    spend[String(r.squad)] = Number(r.total);
  // Where each of the project's repos' merge record ends now: the next brief starts its Elsewhere
  // block there, so the minutes the record has not read yet fall into it (briefing-input).
  const merges_upto: Record<string, number> = {};
  try {
    for (const c of store.db.query("SELECT value FROM config WHERE project = ? AND file = 'github' AND key LIKE 'repo:%' ORDER BY key").all(label) as Row[]) {
      const repo = String(c.value ?? "");
      const g = repo ? store.db.query("SELECT merges_until FROM observed_github WHERE repo = ?").get(repo) as Row | null : null;
      if (g?.merges_until != null && Number.isFinite(Number(g.merges_until))) merges_upto[repo] = Number(g.merges_until);
    }
  } catch { /* no github rows: no carry-over */ }
  const line = `briefing: write the morning brief for ${label}, ${date} (since ${stamp(since)}) — studio/studio.md "Morning brief"; facts: bin/ds briefing-input ${label} --date ${date}`;
  return store.request("studio", { action: "briefing", label, date, since, until, spend, merges_upto, line }, { key, project: label, by: "loop:briefing" }).row;
}

const briefing: Reconciler = {
  name: "briefing",
  run(ctx) {
    if (ctx.project) briefingDue(ctx.store, ctx.project, ctx.now);
  },
};
export default briefing;
