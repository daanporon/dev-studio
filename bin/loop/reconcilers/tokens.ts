// tokens.ts — sweep step 0 as a reconciler (U10, R17). Ported from the removed sweep on main at
// 0fbb8be654cda578a94410017c6a1d8c63f2e3e8 (step 0) and bin/lib/squad-spent.sh.
//
// Every DS_SWEEP_TOKENS_MIN (5) minutes:
//   - state/tokens.tsv: once it is that old (or missing), `token-usage.sh --by-worker --days
//     DS_TOKEN_DAYS (7) --dir DS_TOKEN_DIR` rewrites it in the background, under its own
//     tokens.tsv.lock (one older than 30 min is a crashed scan's), so two scans never overlap. The state observer reads it into observed_tokens.
//   - state/<label>/loop/squad-spent.tsv (topic since total lead thinker builders other frozen):
//     once it is that old, each squad's spend from observed_tokens — no log scan of its own — is
//     written to it and to observed_spend. A squad's workers are its topic's rows of this label
//     (`-<DS_PREFIX><label>-` in the worker, so a `<worker>:review` row counts too), never <synthetic>;
//     spent = weighted cache_write + weighted cache_read + output x5 + input, by role (lead, thinker, builder,
//     else other; the review role is other). See `spentOf` for the weights. observed_tokens only holds
//     the DS_TOKEN_DAYS window, so a live squad's lifetime total never drops below the row last written.
//     Role buckets reflect the current scan; unavailable history goes under other, so reclassified
//     review spend is never kept in both its old and new buckets. `since` is its first member start, else the last row's,
//     else when the squad was first seen. A closed squad is computed once more and frozen.
import { existsSync, mkdirSync, realpathSync, renameSync, rmdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mtime, tsv } from "../db/import-json.ts";
import { mangle, prefix } from "../observers/orca.ts";
import type { Reconciler, TickCtx } from "../core/plugins.ts";
import { discoverProjects } from "../settings/projects.ts";
import { ROOT, type FactRow, type Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";

export type TokensOpts = { refreshTokens?: (root: string, days: number, dir: string) => void };

const LOCK_STALE_S = 30 * 60;
const ROLES = ["lead", "thinker", "builder"] as const;
type Spend = { since: number; total: number; lead: number; thinker: number; builders: number; other: number; frozen: number };

export const tokenDir = () => process.env.DS_TOKEN_DIR || join(process.env.HOME || "", ".claude", "projects");
const due = (p: string, now: number, every: number) => now - mtime(p) > every; // a missing file has mtime 0

// Whether the default scan may read the real session logs: an explicit DS_TOKEN_DIR always, else only when
// `root` is this checkout's own state root (realpath of ROOT/state, the root install.sh gives the loop unit).
// A test or a copy writing to a temp root must not start a 7-day scan of the host's logs (KTD4).
export function realLogScanAllowed(root: string, hostRoot = join(ROOT, "state")): boolean {
  if (process.env.DS_TOKEN_DIR) return true;
  try { return realpathSync(root) === realpathSync(hostRoot); } catch { return false; }
}
// Background scan: mkdir the lock or leave it to whoever holds it.
function refreshTokens(root: string, days: number, dir: string): void {
  if (!realLogScanAllowed(root)) return;
  const out = join(root, "tokens.tsv"), lock = `${out}.lock`;
  if (existsSync(lock) && Date.now() / 1000 - mtime(lock) > LOCK_STALE_S) { try { rmdirSync(lock); } catch { /* taken meanwhile */ } }
  try { mkdirSync(lock); } catch { return; }
  const p = Bun.spawn(["bash", "-c", '"$1" --by-worker --days "$2" --dir "$3" > "$4.tmp" && mv "$4.tmp" "$4"; rm -f "$4.tmp"; rmdir "$4.lock"',
    "tokens", join(ROOT, "bin", "lib", "token-usage.sh"), String(days), dir, out], { env: { ...process.env, DS_STATE_ROOT: root }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  p.unref();
}

// When a squad started: its first member's start, else null.
function firstStart(store: Store, project: string, squad: string): number | null {
  const ts = (store.db.query("SELECT since FROM members WHERE project = ? AND squad = ? AND since IS NOT NULL").all(project, squad) as { since: string }[])
    .map((m) => Date.parse(m.since)).filter(Number.isFinite);
  return ts.length ? Math.floor(Math.min(...ts) / 1000) : null;
}

// What a row's tokens cost relative to plain input: a cache write x2 on the 1-hour TTL and x1.25 on the
// 5-minute one (cw_1h / cw_5m; a row without the split weighs all of cache_write at x1.25), a cache read
// x0.05 on Opus and x0.1 on other models, output x5, input x1. API list ratios, not quota weights.
export type TokenRow = { model?: string | null; input: number | null; cache_write: number | null; cache_read: number | null; output: number | null; cw_1h?: number | null; cw_5m?: number | null };
export function spentOf(r: TokenRow): number {
  const cw = r.cache_write ?? 0, h = r.cw_1h ?? 0, f = r.cw_5m ?? 0;
  const write = h + f > 0 ? h * 2 + f * 1.25 + Math.max(cw - h - f, 0) * 1.25 : cw * 1.25;
  return write + (r.cache_read ?? 0) * (/opus/i.test(r.model ?? "") ? 0.05 : 0.1) + (r.output ?? 0) * 5 + (r.input ?? 0);
}
export function squadSpend(store: Store, project: string, squad: string): Omit<Spend, "since" | "frozen"> {
  const rows = store.db.query("SELECT role, model, input, cache_write, cache_read, output, cw_1h, cw_5m FROM observed_tokens WHERE topic = ? AND instr(worker, ?) > 0 AND model != '<synthetic>'")
    .all(squad, `-${mangle(prefix() + project)}-`) as ({ role: string | null } & TokenRow)[];
  const s = { total: 0, lead: 0, thinker: 0, builder: 0, other: 0 };
  for (const r of rows) {
    const v = spentOf(r);
    s[(ROLES as readonly string[]).includes(r.role ?? "") ? (r.role as typeof ROLES[number]) : "other"] += v;
    s.total += v;
  }
  return { total: Math.trunc(s.total), lead: Math.trunc(s.lead), thinker: Math.trunc(s.thinker), builders: Math.trunc(s.builder), other: Math.trunc(s.other) };
}

// squad-spent.tsv of one project, rewritten from observed_tokens; returns its rows.
export function writeSpend(store: Store, project: string, now: number): Map<string, Spend> {
  const f = join(store.root, project, "loop", "squad-spent.tsv");
  const prev = new Map(tsv(f).filter((r) => r[0]).map((r) => [r[0], { since: Number(r[1]) || 0, total: Number(r[2]) || 0, lead: Number(r[3]) || 0,
    thinker: Number(r[4]) || 0, builders: Number(r[5]) || 0, other: Number(r[6]) || 0, frozen: Number(r[7]) || 0 } as Spend]));
  const squads = store.db.query("SELECT topic, status, observed_at FROM squads WHERE project = ? AND (doc IS NOT NULL OR status IN ('closed', 'gone')) ORDER BY topic")
    .all(project) as { topic: string; status: string | null; observed_at: number }[];
  const out = new Map<string, Spend>();
  for (const s of squads) {
    const p = prev.get(s.topic), closed = s.status === "closed" || s.status === "gone";
    if (closed && p?.frozen === 1) { out.set(s.topic, p); continue; }
    const spent = squadSpend(store, project, s.topic);
    const row: Spend = { since: firstStart(store, project, s.topic) ?? p?.since ?? s.observed_at, ...spent, frozen: closed ? 1 : 0 };
    row.total = Math.max(row.total, p?.total ?? 0);
    row.other = row.total - row.lead - row.thinker - row.builders;
    out.set(s.topic, row);
  }
  mkdirSync(dirname(f), { recursive: true });
  const body = [...out].map(([t, r]) => [t, r.since, r.total, r.lead, r.thinker, r.builders, r.other, r.frozen].join("\t") + "\n").join("");
  writeFileSync(`${f}.tmp`, body);
  renameSync(`${f}.tmp`, f);
  utimesSync(f, now, now); // the cadence counts in the tick's clock
  const rows: FactRow[] = [...out].map(([squad, r]) => ({ table: "observed_spend", key: { project, squad }, set: { ...r, observed_at: now } }));
  store.fact("spend", rows, { project, payload: { squads: out.size } });
  return out;
}

export function tokensReconciler(opts: TokensOpts = {}): Reconciler {
  let askedAt = 0;
  return {
    name: "tokens",
    scope: "host",
    run(ctx: TickCtx) {
      const { store, now } = ctx, every = envInt("DS_SWEEP_TOKENS_MIN", 5) * 60;
      if (due(join(store.root, "tokens.tsv"), now, every) && now - askedAt > every) {
        askedAt = now;
        (opts.refreshTokens ?? refreshTokens)(store.root, envInt("DS_TOKEN_DAYS", 7), tokenDir());
      }
      for (const p of discoverProjects(store.root)) {
        if (due(join(store.root, p, "loop", "squad-spent.tsv"), now, every)) writeSpend(store, p, now);
      }
      return [];
    },
  };
}

export default tokensReconciler();
