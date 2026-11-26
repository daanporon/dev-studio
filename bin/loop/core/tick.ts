// tick.ts — one turn of the loop (Bun). A tick, in the order of the removed sweep's steps:
//   1. fire the timers that came due (timers.ts), into ctx.fired
//   2. observers whose `every` ran out, per project (or once, host scope): facts into rows
//   3. reconcilers, then fulfillers, per project: rows into actions
//   4. the actuator's seats (each Run held by the loop's own pane), then each action whose episode
//      is new: one `action` event, then the actuator
//   5. every squad whose squad/members/units rows changed: its JSON snapshot (R4)
//   6. health: tick_at, tick_no, tick_ms; on a tick over its interval, a `tick_slow` event at most
//      every DS_LOOP_SLOW_EVERY_S (600 s): the slow ticks since the last one, their average and
//      longest, and the step that cost the most (U57) and the top 5 steps, with the actuator's time per action kind (U239)
// A plugin that throws is logged as a `plugin_error` event and the tick goes on; so is a squad
// whose export fails, which is tried again next tick. Health is written even when a step throws,
// and completed steps refresh progress_at so a long batch does not look stalled to the watchdog.
// A side host's loop (opts.role `side`) ticks the projects in its own `projects` rows, and leaves out what
// is main's alone: retiring capacity facts and the squad JSON snapshots (5) (side-loop-host U3).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJson, render, squadDoc } from "../db/export-json.ts";
import type { Action, Actuator, Plugins, Role, Scope, TickCtx, TickFacts } from "./plugins.ts";
import { sideProjects } from "./side-plugins.ts";
import { loopProjects } from "../settings/projects.ts";
import { now, type Row, type Store } from "./store.ts";
import { retireCapacityFacts } from "../fulfil/pending.ts";
import { fire } from "./timers.ts";
import { actionBlock, actionVersion } from "../pause/pause.ts";
import { clearKept, harvest, seedKept, type Seeded, type Signals } from "../io/run-keep.ts";

const LOOP_TS = join(import.meta.dir, "..", "main.ts");

/** U252: the most frequent `<caller>\t<verb>\t<kind>` spawn counts, as rows. */
// U264: the callers U264 trimmed (`limited`'s screen reads, the relay's peeks) are always listed, top or not.
const WATCHED = new Set(["limited", "run-inbox-peek"]);
function topCallers(counts: Map<string, number>, limit: number): { caller: string; verb: string; kind: string; n: number }[] {
  const all = [...counts].sort((a, b) => b[1] - a[1]);
  return all.filter((e, i) => i < limit || WATCHED.has(e[0].split("\t")[0])).map(([k, n]) => {
    const [caller = "", verb = "", kind = ""] = k.split("\t");
    return { caller, verb, kind, n };
  });
}

/** Counts as an average per tick, to one decimal. */
const perTick = (m: Map<string, number>, ticks: number): Record<string, number> =>
  Object.fromEntries([...m].map(([k, n]) => [k, Math.round(n / Math.max(1, ticks) * 10) / 10]));

export function tickSeconds(): number {
  const v = Number(process.env.DS_LOOP_TICK_S);
  return v > 0 ? v : 5;
}

export function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : dflt;
}

// fn over items, at most `limit` at once; the results in the order of the items.
export async function pmap<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
export const readSlots = () => envInt("DS_LOOP_READ_SLOTS", 6);

export type TickReport = { tick: number; fired: string[]; actions: Action[]; acted: Action[]; exported: string[]; ms: number };
type Squad = { project: string; topic: string; text: string };

export class Loop {
  tickNo = 0;
  private due = new Map<string, number>();   // observer -> when it runs next (all run on the first tick)
  private memo = new Map<string, string>();  // project/topic -> its JSON as last exported or seen at boot
  private seen = "";                         // the db's change counters after the last tick's own writes
  private slowAt: number | null = null;      // when the last tick_slow was written (null: look in the db)
  private win = { ticks: 0, slow: 0, sum: 0, max: 0, steps: new Map<string, number>() }; // since that tick_slow
  private stepMs = new Map<string, number>(); // this tick's time per step (guard name[:project])
  private spawns = new Map<string, number>();  // this tick's Orca CLI spawns by verb (U244)
  private callers = new Map<string, number>(); // U252: the same by `<caller>\t<verb>\t<kind>` (orca-cache.ts countSpawn)
  private spawnWin = { ticks: 0, total: 0, bun: 0, rereads: 0, verbs: new Map<string, number>(), callers: new Map<string, number>(), dropped: new Map<string, number>(), peeks: new Map<string, number>() }; // since that tick_slow
  private deferredTotal = new Map<string, number>();   // U249: background actions ready() turned down, by kind, since this process started
  private seeded: Seeded | null = null;        // this tick's Run reads: which were kept, which read again and why (U248)

  constructor(readonly store: Store, readonly plugins: Plugins, readonly actuator: Actuator,
    readonly opts: { tickS?: number; projects?: () => string[]; signals?: () => Promise<Signals>; role?: Role } = {}) {}

  private get side(): boolean { return this.opts.role === "side"; }

  // The health row for this process; tick_no carries on from the last run. The JSON snapshots are
  // remembered, not written: the loop exports what changes while it runs, never a boot-time rewrite.
  boot(at = now(), version: string | null = null): void {
    this.tickNo = Number(this.store.get("health", { id: 1 })?.tick_no ?? 0);
    this.store.upsert("health", { id: 1 }, { pid: process.pid, started_at: at, progress_at: at, version });
    for (const s of this.side ? [] : this.squads()) this.memo.set(`${s.project}/${s.topic}`, s.text);
    this.seen = this.changes();
  }

  async tick(at = now()): Promise<TickReport> {
    const start = performance.now(), store = this.store, tick = ++this.tickNo;
    const report: TickReport = { tick, fired: [], actions: [], acted: [], exported: [], ms: 0 };
    this.stepMs.clear();
    const orcaTick = await this.orcaTickStart(at);
    let exportedAll = false;
    try {
      const fired = fire(store, at);
      report.fired = fired.map((t) => t.key);
      const projects = this.opts.projects?.() ?? (this.side ? sideProjects(store) : loopProjects(store.root));
      const poked = new Set<string>();
      const facts: TickFacts = {};
      const ctx = (project: string): TickCtx => ({ store, project, tick, now: at, fired, poked, facts, role: this.opts.role });
      const each = (scope?: Scope) => (scope === "host" ? [""] : projects).map(ctx);

      for (const o of this.plugins.observers) {
        if ((this.due.get(o.name) ?? 0) > at) continue;
        this.due.set(o.name, at + (o.every ?? 0));
        await pmap(each(o.scope), readSlots(), (c) => this.guard(o.name, c.project, () => o.run(c)));
      }
      if (!this.side) retireCapacityFacts(store);
      for (const r of this.plugins.reconcilers) {
        // Projects run side by side, but their actions join in project order, as when they ran in a row.
        const got = await pmap(each(r.scope), readSlots(), async (c) => {
          let actions: Action[] = [];
          await this.guard(r.name, c.project, async () => {
            actions = (await r.run(c)) ?? [];
            for (const a of actions) a.pauseVersion ??= actionVersion(store, a);
          });
          return actions;
        });
        for (const actions of got) report.actions.push(...actions);
      }
      if (this.actuator.seats) for (const c of each()) await this.guard("actuator", c.project, () => this.actuator.seats!(c));
      const attempted = new Set<string>();
      for (const a of report.actions) {
        const key = JSON.stringify([a.project, a.subject, a.kind, a.episode]);
        if (attempted.has(key)) continue;
        attempted.add(key);
        const claimed = store.get("episodes", { project: a.project, subject: a.subject, kind: `action:${a.kind}` });
        if (claimed?.episode_key === a.episode && (claimed.state === "acted" || claimed.state === "running")) continue;
        const c = ctx(a.project);
        let ready = true;
        if (this.actuator.ready && !(await this.guard("placement", a.project, async () => { ready = await this.actuator.ready!(a, c); }))) continue;
        // The wait text this episode's last try ended on (`wait` in the episode's action JSON, set by the actuator's settle).
        const prev = claimed?.episode_key === a.episode && claimed.state === "pending" && claimed.action ? (JSON.parse(String(claimed.action)) as { wait?: unknown }).wait : undefined;
        if (!ready || !this.claim(a, at)) continue;
        report.acted.push(a);
        // A repeat writes none here; the actuator's settle writes it if the try ends on anything but that same wait.
        if (typeof prev !== "string") store.event("action", { project: a.project, squad: a.squad ?? null, member: a.member ?? null, payload: a });
        await this.guard("actuator", a.project, () => this.actuator.act(a, c));
      }
      for (const [k, v] of this.actuator.takeTimes?.() ?? []) this.stepMs.set(k, (this.stepMs.get(k) ?? 0) + v);
      this.noteDeferred(tick, at);
      const { written, failed } = this.side ? { written: [], failed: false } : await this.exportChanged();
      report.exported = written;
      exportedAll = !failed;
    } finally {
      this.orcaTickEnd(orcaTick, tick, at);
      const ms = report.ms = Math.round(performance.now() - start), tickS = this.opts.tickS ?? tickSeconds();
      store.upsert("health", { id: 1 }, { pid: process.pid, tick_at: at, tick_no: tick, tick_ms: ms, progress_at: now() });
      this.slow(tick, ms, tickS, at);
    }
    // Anything short of a full export leaves `seen` behind, so the next tick looks again.
    if (exportedAll) this.seen = this.changes();
    return report;
  }

  // U244: a read of Orca that several steps of this tick need is made once, in a directory made for the
  // tick (bin/backend/orca-cache.ts); the loop's own Orca CLI calls are counted by verb. DS_LOOP_ORCA_CACHE=0
  // turns the shared copies off (the count stays).
  // U248: with `opts.signals` (the real loop) a Run's reads are also kept from tick to tick (run-keep.ts): the
  // directory starts with the copies of every Run whose terminals and mail are as they were and whose copies
  // are younger than DS_LOOP_RUN_READ_S (60; 0 reads every Run every tick). The tick counts the bun starts the
  // loop made and the Runs it read again, with the reason.
  private async orcaTickStart(at: number): Promise<{ dir: string; log: string; keep: string | null } | null> {
    const loopDir = join(this.store.root, "loop"), dir = join(loopDir, "orca-tick"), log = join(loopDir, "orca-spawns.log"), keepDir = join(loopDir, "orca-keep");
    this.seeded = null;
    try {
      mkdirSync(loopDir, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(log, "");
      let keep: string | null = null;
      if (process.env.DS_LOOP_ORCA_CACHE !== "0") { mkdirSync(dir); process.env.DS_ORCA_TICK_DIR = dir; }
      process.env.DS_ORCA_SPAWN_LOG = log;
      if (this.opts.signals && process.env.DS_LOOP_ORCA_CACHE !== "0") {
        const ttl = Number(process.env.DS_LOOP_RUN_READ_S ?? 60);
        if (!(ttl > 0)) clearKept(keepDir);
        else {
          let sig: Signals | null = null;
          try { sig = await this.opts.signals(); } catch { /* no signals: every Run reads again */ }
          this.seeded = seedKept({ tickDir: dir, keep: keepDir, runs: this.openRuns(), signals: sig, nowMs: Date.now(), ttlS: ttl });
          process.env.DS_ORCA_KEEP_DIR = keep = keepDir;
        }
      }
      return { dir, log, keep };
    } catch { return null; }
  }

  // The Runs of the open squads and the worktrees of their members.
  private openRuns(): Map<string, string[]> {
    const runs = new Map<string, string[]>();
    const rows = this.store.db.query(`SELECT s.run_id AS run, m.wt AS wt FROM squads s
      LEFT JOIN members m ON m.project = s.project AND m.squad = s.topic AND m.wt IS NOT NULL
      WHERE s.run_id IS NOT NULL AND COALESCE(s.status, '') != 'closed'`).all() as { run: string; wt: string | null }[];
    for (const r of rows) runs.set(r.run, [...(runs.get(r.run) ?? []), ...(r.wt ? [r.wt] : [])]);
    return runs;
  }

  private orcaTickEnd(t: { dir: string; log: string; keep: string | null } | null, tick: number, at: number): void {
    const seeded = this.seeded;
    delete process.env.DS_ORCA_TICK_DIR;
    delete process.env.DS_ORCA_SPAWN_LOG;
    delete process.env.DS_ORCA_KEEP_DIR;
    this.spawns.clear();
    this.callers.clear();
    if (!t) return;
    if (t.keep) harvest(t.dir, t.keep);
    rmSync(t.dir, { recursive: true, force: true });
    try {
      let bun = 0, client = 0;
      const dropped = new Map<string, number>(), peeks = new Map<string, number>();
      const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
      for (const l of readFileSync(t.log, "utf8").split("\n")) {
        if (!l.trim()) continue;
        if (l.startsWith("bun ")) bun++;
        else if (l.startsWith("drop ")) add(dropped, l.slice(5).trim());
        // U264: `peek <gate>` is why the relay peeked a Run's inbox (actuator.seats): unread, due, safety, nofacts.
        else if (l.startsWith("peek ")) add(peeks, l.slice(5).trim());
        // U254: `client <verb>` is a read the long-lived helper served (DS_ORCA_CLIENT=1), not a spawn.
        else if (l.startsWith("client ")) client++;
        else {
          const [verb = "", caller = "", kind = ""] = l.split("\t").map((x) => x.trim()), who = `${caller || "-"}\t${verb}\t${kind || "-"}`;
          this.spawns.set(verb, (this.spawns.get(verb) ?? 0) + 1);
          this.callers.set(who, (this.callers.get(who) ?? 0) + 1);
        }
      }
      let total = 0;
      for (const [k, n] of this.spawns) { total += n; this.spawnWin.verbs.set(k, (this.spawnWin.verbs.get(k) ?? 0) + n); }
      for (const [k, n] of this.callers) this.spawnWin.callers.set(k, (this.spawnWin.callers.get(k) ?? 0) + n);
      for (const [k, n] of dropped) this.spawnWin.dropped.set(k, (this.spawnWin.dropped.get(k) ?? 0) + n);
      for (const [k, n] of peeks) this.spawnWin.peeks.set(k, (this.spawnWin.peeks.get(k) ?? 0) + n);
      this.spawnWin.ticks++; this.spawnWin.total += total; this.spawnWin.bun += bun; this.spawnWin.rereads += seeded?.reread.length ?? 0;
      const top = [...this.spawns].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([verb, n]) => ({ verb, n }));
      const runs = seeded ? { kept: seeded.kept.length, reread: seeded.reread.length, why: seeded.reread.reduce((o: Record<string, number>, r) => { o[r.why] = (o[r.why] ?? 0) + 1; return o; }, {}) } : null;
      // U252: who made them: the backend verb, the Orca call, and whether it was a shared read no copy answered
      // yet (keyed), a read with no shared copy (past) or a write.
      const by_caller = topCallers(this.callers, 10);
      writeFileSync(join(this.store.root, "loop", "orca-spawns.json"), JSON.stringify({ tick, at, total, bun, ...(client ? { client } : {}), runs, top, by_caller, dropped_by: Object.fromEntries(dropped), peek_why: Object.fromEntries(peeks) }) + "\n");
    } catch { /* a count is never worth a failed tick */ }
  }

  // U249: a background action ready() turns down (all slots or its subject busy) is counted, shown as `bg_deferred`
  // in loop.sh --status (state/loop/bg-deferred.json) and in the tick_slow payload. Written only when a tick deferred one.
  private noteDeferred(tick: number, at: number): void {
    const d = this.actuator.takeDeferred?.();
    if (!d || !d.size) return;
    for (const [k, n] of d) this.deferredTotal.set(k, (this.deferredTotal.get(k) ?? 0) + n);
    try {
      mkdirSync(join(this.store.root, "loop"), { recursive: true });
      writeFileSync(join(this.store.root, "loop", "bg-deferred.json"), JSON.stringify({ tick, at, last: Object.fromEntries(d), total: Object.fromEntries(this.deferredTotal) }) + "\n");
    } catch { /* a count is never worth a failed tick */ }
  }

  // Every tick counts toward the window; once it holds a slow tick, the first tick DS_LOOP_SLOW_EVERY_S
  // after the last `tick_slow` (read from the db after a restart) writes the next, then the window
  // starts over. A burst of slow ticks followed by fast ones is still reported.
  private slow(tick: number, ms: number, tickS: number, at: number): void {
    const w = this.win, sp = this.spawnWin;
    w.ticks++; w.sum += ms; w.max = Math.max(w.max, ms);
    for (const [k, v] of this.stepMs) w.steps.set(k, (w.steps.get(k) ?? 0) + v);
    if (ms > tickS * 1000) w.slow++;
    if (w.slow === 0) return;
    this.slowAt ??= Number((this.store.db.query("SELECT MAX(at) AS at FROM events WHERE kind = 'tick_slow'").get() as { at: number | null }).at ?? -Infinity);
    if (at - this.slowAt < envInt("DS_LOOP_SLOW_EVERY_S", 600)) return;
    // `bg:<kind>` is a background action's run, which the tick did not wait for: reported apart, not in the top 5.
    const top = [...w.steps].filter(([k]) => !k.startsWith("bg:")).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([step, total]) => ({ step, avg_ms: Math.round(total / w.ticks) }));
    this.store.event("tick_slow", { payload: { tick, slow: w.slow, ticks: w.ticks, avg_ms: Math.round(w.sum / w.ticks), max_ms: w.max,
      slowest: top[0] ?? null, top, tick_s: tickS, bg_deferred: Object.fromEntries(this.deferredTotal),
      bg: [...w.steps].filter(([k]) => k.startsWith("bg:")).map(([step, total]) => ({ step, avg_ms: Math.round(total / w.ticks) })),
      bun_starts: { avg: Math.round(sp.bun / Math.max(1, sp.ticks) * 10) / 10 },
      runs_reread: { avg: Math.round(sp.rereads / Math.max(1, sp.ticks) * 10) / 10 },
      orca_spawns: { avg: Math.round(sp.total / Math.max(1, sp.ticks) * 10) / 10,
        top: [...sp.verbs].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([verb, n]) => ({ verb, avg: Math.round(n / Math.max(1, sp.ticks) * 10) / 10 })),
        by_caller: topCallers(sp.callers, 5).map(({ n, ...c }) => ({ ...c, avg: Math.round(n / Math.max(1, sp.ticks) * 10) / 10 })),
        dropped_by: perTick(sp.dropped, sp.ticks), peek_why: perTick(sp.peeks, sp.ticks) } } });
    this.slowAt = at;
    this.win = { ticks: 0, slow: 0, sum: 0, max: 0, steps: new Map() };
    this.spawnWin = { ticks: 0, total: 0, bun: 0, rereads: 0, verbs: new Map(), callers: new Map(), dropped: new Map(), peeks: new Map() };
  }

  // Runs fn, timing it as step name[:project]; a throw is logged as `plugin_error` and reported as false.
  private async guard(name: string, project: string, fn: () => unknown): Promise<boolean> {
    const t = performance.now(), key = project ? `${name}:${project}` : name;
    try { await fn(); return true; } catch (e) {
      this.store.event("plugin_error", { project: project || null, payload: { plugin: name, error: (e as Error)?.message ?? String(e) } });
      return false;
    } finally {
      this.stepMs.set(key, (this.stepMs.get(key) ?? 0) + performance.now() - t);
      this.store.upsert("health", { id: 1 }, { progress_at: now() });
    }
  }

  // True when the action's episode is new: it takes the (project, subject, action:<kind>) row, with
  // the action in it so a crash before the actuator settles it can be put back (actuator boot). The
  // same episode is acted again only while the actuator left it `pending` and its next_at has come.
  private claim(a: Action, at: number): boolean {
    const key = { project: a.project, subject: a.subject, kind: `action:${a.kind}` };
    // Fresh reconciliation may reuse a preserved wish and its backend retry identity after
    // the old generation was dropped. A replay of the obsolete action remains fenced.
    const renewed = (r: Row | null) => r?.state === "dropped" && r.result === "generation changed" && a.pauseVersion === actionVersion(this.store, a) && !actionBlock(this.store, a);
    const held = (r: Row | null) => r?.episode_key === a.episode && !renewed(r) && !(r.state === "pending" && Number(r.next_at ?? 0) <= at);
    if (held(this.store.get("episodes", key))) return false;
    return this.store.tx(() => {
      const r = this.store.get("episodes", key);
      if (held(r)) return false;
      this.store.upsert("episodes", key, r?.episode_key === a.episode && !renewed(r)
        ? { count: Number(r.count ?? 0) + 1, state: "acted", observed_at: at }
        : { squad: a.squad ?? null, episode_key: a.episode, started_at: at, ended_at: null, next_at: null, action: JSON.stringify({ action: a, tries: 0 }), count: 1, state: "acted", source: "loop", observed_at: at });
      return true;
    });
  }

  // Another connection's commits move data_version, this one's move total_changes(); neither
  // moved since the last tick means no squad can have changed.
  private changes(): string {
    const dv = (this.store.db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    const tc = (this.store.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
    return `${dv}:${tc}`;
  }

  private squads(): Squad[] {
    const rows = this.store.db.query("SELECT project, topic FROM squads WHERE doc IS NOT NULL AND COALESCE(status, '') != 'closed' ORDER BY project, topic").all() as { project: string; topic: string }[];
    return rows.flatMap(({ project, topic }) => {
      const doc = squadDoc(this.store, project, topic);
      return doc ? [{ project, topic, text: render(doc) }] : [];
    });
  }

  private async exportChanged(): Promise<{ written: string[]; failed: boolean }> {
    const written: string[] = [];
    let failed = false;
    if (this.changes() === this.seen) return { written, failed };
    // A rollback took bin/loop/main.ts away during this tick: the files are main's scripts' now, and only
    // the loop's own way out (exportForRollback) may still write them.
    if (!existsSync(LOOP_TS)) return { written, failed };
    for (const s of this.squads()) {
      const k = `${s.project}/${s.topic}`;
      if (this.memo.get(k) === s.text) continue;
      const ok = await this.guard("export", s.project, () => {
        written.push(...exportJson(this.store, this.store.root, { project: s.project, topic: s.topic }).written);
        this.memo.set(k, s.text);
      });
      failed ||= !ok;
    }
    return { written, failed };
  }
}
