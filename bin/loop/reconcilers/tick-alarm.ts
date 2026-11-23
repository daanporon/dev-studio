// tick-alarm.ts — a Studio card while loop ticks stay slow (loop-tick-8s U4).
//
// bin/loop/core/tick.ts writes one `tick_slow` event per window (at most every DS_LOOP_SLOW_EVERY_S, 600 s, and
// only while some tick of the window was slow); its payload has `avg_ms` and `top` ({step, avg_ms}). Per project:
//   - the limit tick_alarm_ms (default 6000; 0 = off) is under the avg_ms of each of the last tick_alarm_windows
//     (default 3) `tick_slow` rows: a spell opens (episode kind `tick-alarm`, subject `tick-alarm.slow`) and ONE
//     alert is raised through alertAction, titled `Loop ticks slow: <avg> s`. It names the three slowest steps
//     (their average over those windows) and how long ticks have been slow, and offers one option (Seen).
//   - the spell ends when the newest row's avg_ms is at or under the limit, when no row was written for
//     2 × DS_LOOP_SLOW_EVERY_S (no row means no slow tick), or when the limit is 0. The alerts reconciler's
//     alertGone then clears the card. A later slow spell is a new spell with a new alert id.
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { envInt } from "../core/tick.ts";
import { limitInt } from "../settings/limits.ts";
import { alertAction } from "./alerts.ts";
export const KIND = "tick-alarm";
export const KEY = "tick-alarm.slow";
type Window = { at: number; avg_ms: number; top: { step: string; avg_ms: number }[] };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
// The newest `n` tick_slow rows, newest first (a row with no usable avg_ms is skipped).
export function windows(store: TickCtx["store"], n: number): Window[] {
  const rows = store.db.query("SELECT at, payload FROM events WHERE kind = 'tick_slow' ORDER BY id DESC LIMIT ?").all(n * 2 + 10) as { at: number; payload: string | null }[];
  const out: Window[] = [];
  for (const r of rows) {
    let p: { avg_ms?: unknown; top?: unknown } = {};
    try { p = JSON.parse(r.payload ?? "{}"); } catch { continue; }
    const avg = num(p.avg_ms);
    if (avg === null) continue;
    const top = (Array.isArray(p.top) ? p.top : []).flatMap((t: { step?: unknown; avg_ms?: unknown }) => typeof t?.step === "string" && num(t.avg_ms) !== null ? [{ step: t.step, avg_ms: t.avg_ms as number }] : []);
    out.push({ at: r.at, avg_ms: avg, top });
    if (out.length === n) break;
  }
  return out;
}
const secs = (ms: number) => (ms / 1000).toFixed(1);
const ago = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.max(1, Math.round(s / 60))} min`);
export function tickAlarm(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx;
  const limit = limitInt(store, project, "tick_alarm_ms", 6000), need = Math.max(1, limitInt(store, project, "tick_alarm_windows", 3));
  const every = envInt("DS_LOOP_SLOW_EVERY_S", 600);
  const spell = { project, subject: KEY, kind: KIND };
  const ep = store.get("episodes", spell), open = !!ep && ep.ended_at == null;
  const w = limit > 0 ? windows(store, need) : [];
  const fresh = w.length > 0 && now - w[0].at <= 2 * every;
  const slow = fresh && w.length >= need && w.every((x) => x.avg_ms > limit);
  if (open && (limit === 0 || !fresh || w[0].avg_ms <= limit)) {
    store.upsert("episodes", spell, { state: "closed", ended_at: now, observed_at: now });
    return [];
  }
  if (!open && !slow) return [];
  const started = open ? Number(ep?.started_at ?? now) : w[w.length - 1].at;
  if (!open) store.upsert("episodes", spell, { squad: null, started_at: started, ended_at: null, state: "slow", episode_key: String(started), source: "loop", observed_at: now });
  const sums = new Map<string, number>();
  for (const x of w) for (const t of x.top) sums.set(t.step, (sums.get(t.step) ?? 0) + t.avg_ms);
  const steps = [...sums].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, ms]) => `${s} ${secs(ms / w.length)} s`);
  const avg = w.reduce((a, x) => a + x.avg_ms, 0) / w.length;
  const title = `Loop ticks slow: ${secs(avg)} s`;
  return alertAction(store, { project, squad: null, key: KEY, episode: `tick|${started}`, idEpisode: `tick|${started}`, title,
    text: `${title} a tick over the last ${w.length} windows (limit ${secs(limit)} s), slow for ${ago(now - started)}. ${steps.length ? `Slowest steps a tick: ${steps.join("; ")}.` : "No step times were recorded."} The card clears once ticks average ${secs(limit)} s or less, or no slow tick is reported for ${ago(2 * every)}.`,
    option: "Seen", why: `tick_slow avg_ms over ${limit} ms (tick_alarm_ms) for ${need} windows in a row` });
}
export default {
  name: "tick-alarm",
  run(ctx: TickCtx) { return tickAlarm(ctx); },
} satisfies Reconciler;
