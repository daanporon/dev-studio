// ds token-usage-ts — tokens spent per dev-studio role, from Claude Code's session logs (U222):
// what bin/lib/token-usage.sh runs. Same options, same table, same exit codes.
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { stateRoot, readJson, writeOut } from "../lib/shared";
import { TokenCache, newStats, parseLine, readAt, type CRec, type FileStat, type Head, type ScanStats } from "../lib/token-cache";

export const help = `[--days N | --since EPOCH] [--dir <claude-projects-dir>] [--by-worker] [--top N] — tokens per role (or worker) from the session logs (token-usage.sh)`;

export type UsageOpts = { days: number; since: string; dir: string; byWorker: boolean; top: number };

const BOOT_HEAD = 65536, REVIEW_HEAD = 1 << 20;
/** A transcript last written this long before the cutoff holds no record inside the window: it is not read. */
const SKIP_SLACK_S = 3600;

const USAGE = "usage: token-usage.sh [--days N | --since EPOCH] [--dir <claude-projects-dir>] [--by-worker] [--top N]";

function todate(epoch: number): string {
  return new Date(Math.floor(epoch) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

/** Sorted directory entries (a shell glob). */
function ls(dir: string): string[] {
  try { return readdirSync(dir).sort(); } catch { return []; }
}
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

const statOf = (p: string): Stats | null => { try { return statSync(p); } catch { return null; } };
const mtimeS = (st: FileStat) => Math.floor(st.mtimeMs / 1000);

/** A file's first boot-prompt topic: the last match on the first line of its head that has one. */
function bootMatch(head: Buffer): Head<string | null> {
  for (const line of head.toString("utf8").split("\n")) {
    const re = /of squad \\*"([^"\\]*)\\*"/g;
    let m: RegExpExecArray | null, last: string | null = null;
    while ((m = re.exec(line))) { last = m[1]; re.lastIndex = m.index + 1; }
    if (last) return { value: last, final: false };
  }
  return { value: null, final: false };
}

/** The squad topic from the newest surviving boot prompt, "?" when none. */
function bootTopic(files: { f: string; st: FileStat }[], cache: TokenCache | null, stats: ScanStats): string {
  const byAge = files.map(({ f, st }) => ({ f, st, m: mtimeS(st) }));
  // sort -rn on the mtime, ties by the whole line reversed
  byAge.sort((a, b) => (b.m - a.m) || (`${a.m}\t${a.f}` < `${b.m}\t${b.f}` ? 1 : -1));
  for (const { f, st } of byAge) {
    const hit = cache ? cache.head("boot", f, st, BOOT_HEAD, stats, bootMatch) : bootMatch(readHead(f, BOOT_HEAD, stats)).value;
    if (hit) return hit;
  }
  return "?";
}

/** A headless ce-code-review session: its first 40 lines (within 1 MB) say so. */
function reviewHead(head: Buffer): Head<number> {
  const lines = head.toString("utf8").split("\n");
  const h = lines.slice(0, 40).join("\n");
  const yes = h.includes('"entrypoint":"sdk-cli"') && /"content":"(\/|<command-message>)compound-engineering:ce-code-review/.test(h);
  return { value: yes ? 1 : 0, final: lines.length > 40 };
}

function isReview(file: string, st: Stats | null, cache: TokenCache | null, stats: ScanStats): boolean {
  if (!st?.isFile()) return false;
  return (cache ? cache.head("review", file, st, REVIEW_HEAD, stats, reviewHead) : reviewHead(readHead(file, REVIEW_HEAD, stats)).value) === 1;
}

function readHead(file: string, n: number, stats: ScanStats): Buffer {
  const h = readAt(file, 0, n);
  stats.headBytes += h.length;
  return h;
}

function metadataTopics(stateRootDir: string): [string, string][] {
  const mangle = (wt: string) => wt.replace(/^.*::/, "").replace(/[^A-Za-z0-9]/g, "-");
  const db = join(stateRootDir, "loop.db");
  if (statOf(db)?.isFile()) {
    try {
      const conn = new Database(db, { readonly: true });
      try {
        const rows = conn.query("SELECT wt, squad AS topic FROM members WHERE role = ? AND length(wt) > 0 UNION SELECT builder_wt AS wt, squad AS topic FROM units WHERE length(builder_wt) > 0").all("builder") as { wt: string; topic: string }[];
        return rows.map((r) => [mangle(r.wt), r.topic]);
      } finally { conn.close(); }
    } catch { /* fall through to the squad files */ }
  }
  const out: [string, string][] = [];
  for (const sub of ["squads", "archive"]) {
    for (const label of ls(stateRootDir)) {
      const dir = join(stateRootDir, label, sub);
      for (const f of ls(dir)) {
        if (!f.endsWith(".json")) continue;
        const d = readJson(join(dir, f));
        if (!d || typeof d !== "object") continue;
        const topic = d.topic ? String(d.topic) : f.slice(0, -5);
        const wts: unknown[] = [];
        if (Array.isArray(d.members)) for (const m of d.members) if (m?.role === "builder") wts.push(m.wt);
        if (Array.isArray(d.units)) for (const u of d.units) wts.push(u?.builder_wt);
        for (const w of wts) if (typeof w === "string" && w.length > 0) out.push([mangle(w), topic]);
      }
    }
  }
  return out;
}

// Sub-agent transcripts: any `subagents/` folder at least two levels under the session folder.
function walk(dir: string, depth: number, out: string[]): void {
  for (const e of ls(dir)) {
    const full = join(dir, e);
    if (isDir(full)) walk(full, depth + 1, out);
    else if (depth >= 2 && full.includes("/subagents/") && e.endsWith(".jsonl")) out.push(full);
  }
}

/** Every record of a file inside the window, read in full (no cache). */
function fullRecords(file: string, cutoff: string, stats: ScanStats): CRec[] {
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return []; }
  stats.full++; stats.parsed += bytes.length;
  const out: CRec[] = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    const r = parseLine(line, cutoff);
    if (r === "bad") break; // jq stops at the first bad line
    if (r) out.push(r);
  }
  return out;
}

/** Where the scan keeps what it read (bin/lib/token-cache.ts). */
export const tokenCachePath = () => join(stateRoot(), "loop", "token-cache.db");

export function tokenUsage(o: UsageOpts, stats: ScanStats = newStats("")): string {
  const stateDir = stateRoot();
  const PREFIX = (process.env.DS_PREFIX ?? "ds-").replace(/[^A-Za-z0-9]/g, "-");
  const cutoffS = Math.floor(o.since !== "" ? Number(o.since) : Date.now() / 1000 - o.days * 86400);
  const cutoff = todate(cutoffS);
  const dir = resolve(o.dir);

  const builderTopics = new Map<string, string>();
  if (o.byWorker) {
    for (const [worker, topic0] of metadataTopics(stateDir)) {
      let topic = topic0;
      if (!worker || !topic) continue;
      const have = builderTopics.get(worker);
      if (have && have !== topic) topic = "?";
      builderTopics.set(worker, topic);
    }
  }

  let header: string;
  let sortk: number;
  if (o.byWorker) { header = "worker\ttopic\trole\tmodel\tturns\tinput\tcache_write\tcache_read\toutput\tctx\tcw_1h\tcw_5m"; sortk = 7; }
  else { header = "role\tmodel\tturns\tinput\tcache_write\tcache_read\toutput"; sortk = 5; }

  type Agg = { meta: string[]; wk: string; t: number; i: number; w: number; r: number; o: number; h1: number; m5: number };
  const agg = new Map<string, Agg>();
  const seen = new Set<string>();
  const ts = new Map<string, string>(), ctx = new Map<string, number>();

  const { cache, why } = TokenCache.open(tokenCachePath(), cutoff);
  stats.cache = why;
  try {
    for (const name of ls(dir)) {
      const d = join(dir, name) + "/";
      if (!isDir(d)) continue;
      if (name.startsWith(".") || !name.includes("-" + PREFIX)) continue; // the glob *-<PREFIX>*/
      const at = name.indexOf("-" + PREFIX);
      // Worktree folders are `...-<project>-<prefix><project>-<role>-<topic>`.
      let rest = name.slice(at + 1 + PREFIX.length);
      const pre = name.slice(0, at);
      let p = "", tail = rest;
      for (;;) {
        const seg = tail.split("-")[0];
        if (!seg) break;
        p = p ? p + "-" + seg : seg;
        if (pre.endsWith("-" + p)) { if (rest.startsWith(p + "-")) rest = rest.slice(p.length + 1); break; }
        if (tail === seg) break;
        tail = tail.slice(tail.indexOf("-") + 1);
      }
      const rm = /(^|-)(lead|thinker|builder|tester|researcher|reviewer|studio|dispatcher)(-|$)/.exec(rest);
      const role = rm ? rm[0].replace(/-/g, "") : "other";
      // Transcripts: top-level sessions, then each session's sub-agents.
      const top: { f: string; st: Stats }[] = [];
      const subs: string[] = [];
      for (const e of ls(d)) {
        const full = d + e;
        const st = statOf(full);
        if (st?.isDirectory()) walk(full, 1, subs);
        else if (st?.isFile() && e.endsWith(".jsonl")) top.push({ f: full, st });
      }
      subs.sort();
      const files: { f: string; st: FileStat | null }[] = [...top, ...subs.map((f) => ({ f, st: statOf(f) }))];
      // whether each session is a headless review, asked once per session for it and all its sub-agents
      const topStat = new Map(top.map(({ f, st }) => [f, st]));
      const review = new Map<string, boolean>();
      let topic = "?";
      if (o.byWorker) {
        // the shell's boot_topic echoes "?\n" when nothing matches, and the newline became a space
        const bt = bootTopic(top, cache, stats);
        topic = bt === "?" ? "? " : bt.replace(/[\t\n]/g, " ");
        if (topic.replace(/ $/, "") === "?" && (role === "lead" || role === "thinker") && rest.startsWith(role + "-") && rest.length > role.length + 1) topic = rest.slice(role.length + 1);
        if (topic.replace(/ $/, "") === "?" && role === "builder") topic = builderTopics.get(name) || "?";
      }
      for (const { f, st } of files) {
        cache?.see(f);
        if (!st || mtimeS(st) < cutoffS - SKIP_SLACK_S) { stats.skipped++; continue; }
        let sid = f.slice(d.length); sid = sid.split("/")[0]; sid = sid.replace(/\.jsonl$/, "");
        let w = name, r = role;
        const sf = d + sid + ".jsonl";
        let rv = review.get(sf);
        if (rv === undefined) { rv = isReview(sf, topStat.get(sf) ?? statOf(sf), cache, stats); review.set(sf, rv); }
        if (rv) { w = name + ":review"; r = "review"; }
        const recs = cache ? cache.records(f, st, stats) : fullRecords(f, cutoff, stats);
        for (const x of recs) {
          if (x.id !== "") { if (seen.has(x.id)) continue; seen.add(x.id); }
          if (o.byWorker) {
            const k = w + "\t" + x.model;
            let a = agg.get(k);
            if (!a) { a = { meta: [], wk: w, t: 0, i: 0, w: 0, r: 0, o: 0, h1: 0, m5: 0 }; agg.set(k, a); }
            a.meta = [w, topic, r, x.model]; a.t++; a.i += x.inp; a.w += x.cw; a.r += x.cr; a.o += x.out; a.h1 += x.h1; a.m5 += x.m5;
            if (x.model !== "<synthetic>" && !x.side && x.ts >= (ts.get(w) ?? "")) { ts.set(w, x.ts); ctx.set(w, x.inp + x.cw + x.cr); }
          } else {
            const k = r + "\t" + x.model;
            let a = agg.get(k);
            if (!a) { a = { meta: [], wk: "", t: 0, i: 0, w: 0, r: 0, o: 0, h1: 0, m5: 0 }; agg.set(k, a); }
            a.meta = [r, x.model]; a.t++; a.i += x.inp; a.w += x.cw; a.r += x.cr; a.o += x.out;
          }
        }
      }
    }
    cache?.commit(dir);
  } catch (e) {
    cache?.abort();
    throw e;
  }

  const rows: string[] = [];
  for (const a of agg.values()) {
    if (o.byWorker) rows.push([...a.meta, a.t, a.i, a.w, a.r, a.o, ctx.has(a.wk) ? ctx.get(a.wk) : "-", a.h1, a.m5].join("\t"));
    else rows.push([...a.meta, a.t, a.i, a.w, a.r, a.o].join("\t"));
  }
  // sort(1) itself, so ties and collation are the shell version's (the host's locale)
  const sorted = rows.length
    ? Bun.spawnSync(["sort", "-t", "\t", `-k${sortk},${sortk}nr`], { stdin: new TextEncoder().encode(rows.join("\n") + "\n") }).stdout.toString().split("\n").filter((l) => l !== "")
    : [];
  const body = o.top > 0 ? sorted.slice(0, o.top) : sorted;
  return header + "\n" + body.map((l) => l + "\n").join("");
}

export async function run(argv: string[]): Promise<number> {
  let days = "7", since = "", dir = join(process.env.HOME ?? "", ".claude", "projects"), byWorker = false, top = "0";
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--days") { days = argv[i + 1] ?? ""; since = ""; i += 2; }
    else if (a === "--since") { since = argv[i + 1] ?? ""; i += 2; }
    else if (a === "--dir") { dir = argv[i + 1] ?? ""; i += 2; }
    else if (a === "--by-worker") { byWorker = true; i++; }
    else if (a === "--top") { top = argv[i + 1] ?? ""; i += 2; }
    else { console.error(USAGE); return 2; }
  }
  if (!/^[0-9]+$/.test(days)) { console.error(`token-usage: --days must be a whole number, got '${days}'`); return 2; }
  if (/[^0-9]/.test(since)) { console.error(`token-usage: --since must be a unix timestamp, got '${since}'`); return 2; }
  if (!/^[0-9]+$/.test(top)) { console.error(`token-usage: --top must be a whole number, got '${top}'`); return 2; }
  if (!isDir(dir)) { console.error(`token-usage: no such directory: ${dir}`); return 1; }
  const t0 = performance.now(), stats = newStats("");
  writeOut(tokenUsage({ days: Number(days), since, dir, byWorker, top: Number(top) }, stats));
  console.error(`token-usage: ${((performance.now() - t0) / 1000).toFixed(2)}s, files ${stats.full} parsed in full, ${stats.incremental} read incrementally, `
    + `${stats.kept} unchanged, ${stats.skipped} skipped; ${stats.parsed} bytes parsed, ${stats.headBytes} head bytes; cache ${stats.cache}`);
  return 0;
}
