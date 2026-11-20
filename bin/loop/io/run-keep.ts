// run-keep.ts — a Run's Orca reads kept across ticks (U248). The per-tick copy of a Run's worker-list pages and
// run-show (bin/backend/orca-cache.ts) is made again every tick; nearly always nothing in the Run changed. Here
// the loop keeps those copies in `loop/orca-keep/` and puts the still-valid ones into the next tick's directory
// before any step runs, so the step that reads them finds them there and Orca is not asked.
//
// A Run's kept copies are read again (and so not seeded) when:
//   age       DS_LOOP_RUN_READ_S (60) passed since the oldest of them was read (0 keeps nothing);
//   terminals a terminal in one of the Run's worktrees appeared, vanished or changed state;
//   mail      the Run's unread mail (inbox-unread-all: the Run's own and its workers') is not what it was;
//   new       nothing kept for it, or the loop has no earlier fingerprint of it (a restart that lost them);
//   write     a call that changes Orca went out: dropCached() takes every kept copy away at once;
//   failed    a read that failed is never stored, so there is nothing to keep.
// What no signal covers (a dispatch's status turning over with no mail and no terminal change) is read at most
// DS_LOOP_RUN_READ_S late.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spreadDue } from "../core/timers.ts";

const KEY = /^[0-9a-f]{40}$/;
export type Why = "age" | "terminals" | "mail" | "new";
export type Seeded = { kept: string[]; reread: { run: string; why: Why }[] };
export type Signals = { terminals: string; unread: string };

type Meta = { run: string; at: number };
const metaOf = (f: string): Meta | null => {
  try { const [run = "", at = ""] = readFileSync(`${f}.meta`, "utf8").trim().split("\t"); return run && Number(at) > 0 ? { run, at: Number(at) } : null; } catch { return null; }
};
const norm = (wt: string) => wt.replace(/^id:/, "");

/** Each Run's terminals as one string: handle and state of every terminal in its worktrees, sorted. */
export function terminalFps(terminalsJson: string, runs: Map<string, string[]>): Map<string, string> {
  let list: any[] = [];
  try { const d = JSON.parse(terminalsJson); list = d?.result?.terminals ?? []; } catch { /* no list: every Run reads */ }
  const out = new Map<string, string>();
  for (const [run, wts] of runs) {
    const mine = new Set(wts.map(norm));
    out.set(run, list.filter((t) => mine.has(norm(String(t?.worktreeId ?? ""))))
      .map((t) => `${t.handle}|${t.connected ?? ""}|${t.writable ?? ""}|${t.orphaned ?? ""}|${t.agentIdentity ?? ""}`).sort().join("\n"));
  }
  return out;
}

/** Each Run's unread mail as one string: the lines of inbox-unread-all (`<to>\t<run>\t<created>\t<id>`) for the Run, sorted. */
export function mailFps(unread: string, runs: Iterable<string>): Map<string, string> {
  const by = new Map<string, string[]>();
  for (const l of unread.split("\n")) {
    const run = l.split("\t")[1];
    if (run) by.set(run, [...(by.get(run) ?? []), l]);
  }
  return new Map([...runs].map((r) => [r, (by.get(r) ?? []).sort().join("\n")]));
}

type State = { fp: Record<string, string> };
const readState = (keep: string): State => { try { return JSON.parse(readFileSync(join(keep, "state.json"), "utf8")); } catch { return { fp: {} }; } };

/** Put the kept copies that are still good into `tickDir`; take the others out of `keep`. */
export function seedKept(o: { tickDir: string; keep: string; runs: Map<string, string[]>; signals: Signals | null; nowMs: number; ttlS: number }): Seeded {
  const { tickDir, keep, runs, signals, nowMs, ttlS } = o;
  mkdirSync(keep, { recursive: true });
  const kept: string[] = [], reread: { run: string; why: Why }[] = [];
  const entries = new Map<string, { key: string; at: number }[]>();
  for (const n of readdirSync(keep)) {
    if (!KEY.test(n)) continue;
    const m = metaOf(join(keep, n));
    if (!m) { rmSync(join(keep, n), { force: true }); continue; }
    entries.set(m.run, [...(entries.get(m.run) ?? []), { key: n, at: m.at }]);
  }
  const drop = (run: string) => { for (const e of entries.get(run) ?? []) { rmSync(join(keep, e.key), { force: true }); rmSync(join(keep, `${e.key}.meta`), { force: true }); } };
  for (const run of entries.keys()) if (!runs.has(run)) drop(run);
  const prev = readState(keep).fp;
  const term = signals ? terminalFps(signals.terminals, runs) : null, mail = signals ? mailFps(signals.unread, runs.keys()) : null;
  const fp: Record<string, string> = {};
  for (const run of runs.keys()) {
    if (term && mail) fp[run] = `${term.get(run)}\n--\n${mail.get(run)}`;
    const es = entries.get(run) ?? [];
    let why: Why | null = null;
    if (!es.length || prev[run] === undefined) why = "new";
    // U252: each Run ages out at its own moment of the interval (spreadDue), so the Runs all read at a start
    // do not all come due again on one tick.
    else if (!term || !mail || spreadDue(run, Math.min(...es.map((e) => e.at)), nowMs, ttlS * 1000)) why = "age";
    else if (prev[run].split("\n--\n")[0] !== term.get(run)) why = "terminals";
    else if (prev[run].split("\n--\n")[1] !== mail.get(run)) why = "mail";
    if (why) { drop(run); reread.push({ run, why }); continue; }
    for (const e of es) {
      try { copyFileSync(join(keep, e.key), join(tickDir, e.key)); copyFileSync(join(keep, `${e.key}.meta`), join(tickDir, `${e.key}.meta`)); } catch { /* not there: read again */ }
    }
    kept.push(run);
  }
  const tmp = join(keep, `state.json.${process.pid}`);
  writeFileSync(tmp, JSON.stringify({ fp: signals ? fp : {} }));
  renameSync(tmp, join(keep, "state.json"));
  return { kept, reread };
}

/** At the tick's end: the Run reads this tick made (not the copies it was given) join the kept ones. */
export function harvest(tickDir: string, keep: string): number {
  let n = 0;
  if (!existsSync(tickDir) || !existsSync(keep)) return n;
  for (const f of readdirSync(tickDir)) {
    if (!KEY.test(f) || existsSync(join(keep, f)) || !metaOf(join(tickDir, f))) continue;
    try { copyFileSync(join(tickDir, `${f}.meta`), join(keep, `${f}.meta`)); copyFileSync(join(tickDir, f), join(keep, f)); n++; } catch { /* the tick ended */ }
  }
  return n;
}

/** Take every kept copy and the fingerprints away (the loop stops keeping, or its signals failed). */
export function clearKept(keep: string): void { rmSync(keep, { recursive: true, force: true }); }
