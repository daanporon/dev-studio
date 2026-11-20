// token-cache.ts — what the token scan read last time, kept so the next scan reads only new bytes (U265).
// bin/commands/token-usage-ts.ts uses it; the pattern is U248's kept reads (bin/loop/io/run-keep.ts): a kept answer,
// the signals that make it stale, and a full re-read when in doubt.
//
// Per transcript (path) it keeps:
//   identity  inode, the size and mtime last seen, the first 64 bytes and the 64 bytes before `off`;
//   off       the offset just past the last complete line parsed (an unfinished last line is never consumed);
//   records   every record parsed so far with a timestamp at or after the cache's floor, in line order;
//   heads     the isReview and boot-topic answers with the size they were read at (-1: the window was full).
// It starts a file over (records and heads dropped, parsed from 0) when its inode changed, it shrank, or either
// 64-byte signature no longer matches; a file that is gone loses its entry.
//
// The floor is the oldest cutoff the records cover. A scan with that cutoff or a newer one uses the cache and
// moves the floor up to its own cutoff (older records are dropped); one with an older cutoff (squad-spent's
// --since, or the loop's 7-day scan after an operator's --days 1) empties the cache and refills it from its own
// cutoff, so one full scan, never a run of uncached ones. Every change of one scan is one SQLite transaction,
// so a scan killed halfway leaves the cache as it was. A cache that will not open or has another schema is
// deleted and the scan starts from nothing; DS_TOKEN_CACHE=0 scans with no cache at all.
import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = "1";
const SIG = 64;

export type FileStat = { ino: number; size: number; mtimeMs: number };
/** One assistant record: the fields token-usage aggregates (the worker, topic and role come from where the file is). */
export type CRec = { model: string; id: string; inp: number; cw: number; cr: number; out: number; ts: string; h1: number; m5: number; side: boolean };
/** A line's verdict: "bad" stops the file (jq stops at the first bad line), null is a line with no record. */
export type LineResult = CRec | null | "bad";

export type ScanStats = { full: number; incremental: number; kept: number; skipped: number; parsed: number; headBytes: number; cache: string };
export const newStats = (cache: string): ScanStats => ({ full: 0, incremental: 0, kept: 0, skipped: 0, parsed: 0, headBytes: 0, cache });

const absent = (v: unknown) => v === null || v === undefined || v === false;
const num = (v: unknown) => (absent(v) ? 0 : Number(v));
const str = (v: unknown, dflt: string) => (absent(v) ? dflt : String(v));

/** One transcript line as token-usage's records() reads it: a record if it is inside the window. */
export function parseLine(line: string, cutoff: string): LineResult {
  if (!line.trim()) return null;
  let j: any;
  try { j = JSON.parse(line); } catch { return "bad"; }
  if (!j || j.type !== "assistant") return null;
  const m = j.message;
  const u = m && typeof m === "object" ? m.usage : null;
  if (u === null || u === undefined) return null;
  const ts = str(j.timestamp, "");
  if (!(ts >= cutoff)) return null;
  const cc = u.cache_creation ?? null;
  return {
    model: str(m.model, "?"),
    id: str(m.id, ""),
    inp: num(u.input_tokens), cw: num(u.cache_creation_input_tokens), cr: num(u.cache_read_input_tokens), out: num(u.output_tokens),
    // the filter's ts and the record's differ only for `false`, which never passes the filter
    ts,
    h1: cc ? num(cc.ephemeral_1h_input_tokens) : 0,
    m5: cc ? num(cc.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens),
    side: j.isSidechain === true,
  };
}

/** Bytes [pos, pos+n) of a file, fewer at its end; empty when it cannot be read. */
export function readAt(file: string, pos: number, n: number): Buffer {
  if (n <= 0) return Buffer.alloc(0);
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(n);
      let got = 0;
      while (got < n) { const k = readSync(fd, buf, got, n - got, pos + got); if (k <= 0) break; got += k; }
      return buf.subarray(0, got);
    } finally { closeSync(fd); }
  } catch { return Buffer.alloc(0); }
}

type Entry = {
  fid: number; path: string; ino: number; size: number; mtime: number; off: number; seq: number; stopped: number;
  sigHead: Buffer; sigTail: Buffer;
  review: number | null; reviewAt: number | null; boot: string | null; bootAt: number | null;
  dirty: boolean;
};
export type Head<T> = { value: T; final: boolean };

const COLS = "fid, path, ino, size, mtime, off, seq, stopped, sig_head, sig_tail, review, review_at, boot, boot_at";
const buf = (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v) : Buffer.alloc(0));
const n2 = (v: unknown) => (v === null ? NaN : Number(v)); // SQLite keeps NaN as NULL

export class TokenCache {
  private db: Database;
  private cutoff: string;
  private entries = new Map<string, Entry>();
  private seen = new Set<string>();
  private ins: ReturnType<Database["prepare"]>;
  private sel: ReturnType<Database["prepare"]>;

  private constructor(db: Database, cutoff: string) {
    this.db = db; this.cutoff = cutoff;
    this.ins = db.prepare("INSERT INTO records (fid, seq, ts, model, id, inp, cw, cr, out, h1, m5, side) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    this.sel = db.prepare("SELECT ts, model, id, inp, cw, cr, out, h1, m5, side FROM records WHERE fid = ? ORDER BY seq");
  }

  /** The cache for a scan with this cutoff and its state (new, on, rebuild, reset), or why the scan runs without one (off, busy). */
  static open(path: string, cutoff: string): { cache: TokenCache | null; why: string } {
    if (process.env.DS_TOKEN_CACHE === "0") return { cache: null, why: "off" };
    let why = "on";
    for (let attempt = 0; attempt < 2; attempt++) {
      let db: Database | null = null;
      try {
        mkdirSync(dirname(path), { recursive: true });
        db = new Database(path, { create: true });
        db.run("PRAGMA busy_timeout = 2000");
        db.run("BEGIN IMMEDIATE");
        db.run("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
        const schema = db.query("SELECT v FROM meta WHERE k = 'schema'").get() as { v: string } | null;
        const files = db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name != 'meta'").get() as { n: number };
        if (schema === null && files.n === 0) {
          db.run(`CREATE TABLE files (fid INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, ino INTEGER NOT NULL, size INTEGER NOT NULL,
            mtime REAL NOT NULL, off INTEGER NOT NULL, seq INTEGER NOT NULL, stopped INTEGER NOT NULL, sig_head BLOB, sig_tail BLOB,
            review INTEGER, review_at INTEGER, boot TEXT, boot_at INTEGER)`);
          db.run(`CREATE TABLE records (fid INTEGER NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, model TEXT NOT NULL, id TEXT NOT NULL,
            inp REAL, cw REAL, cr REAL, out REAL, h1 REAL, m5 REAL, side INTEGER NOT NULL, PRIMARY KEY (fid, seq))`);
          db.run("CREATE INDEX records_ts ON records (ts)");
          db.run("INSERT INTO meta (k, v) VALUES ('schema', ?)", [SCHEMA]);
          if (attempt === 0) why = "new";
        } else if (schema?.v !== SCHEMA) {
          throw new Error(`token cache schema ${schema?.v ?? "none"}, want ${SCHEMA}`);
        }
        const floor = (db.query("SELECT v FROM meta WHERE k = 'floor'").get() as { v: string } | null)?.v ?? null;
        if (floor !== null && cutoff < floor) {
          // the records between this cutoff and the floor were never kept: start over from this cutoff (one full scan)
          db.run("DELETE FROM records");
          db.run("DELETE FROM files");
          why = "rebuild";
        }
        db.run("INSERT INTO meta (k, v) VALUES ('floor', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [cutoff]);
        db.run("DELETE FROM records WHERE ts < ?", [cutoff]);
        const c = new TokenCache(db, cutoff);
        for (const r of db.query(`SELECT ${COLS} FROM files`).all() as any[]) c.entries.set(r.path, c.row(r));
        return { cache: c, why };
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        try { db?.close(); } catch { /* already closed */ }
        if (/locked|busy/i.test(msg)) return { cache: null, why: "busy" };
        // corrupt, unreadable or another schema: delete it and start from nothing (once)
        for (const f of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
        why = "reset";
      }
    }
    return { cache: null, why: "reset-failed" };
  }

  private row(r: any): Entry {
    return {
      fid: r.fid, path: r.path, ino: r.ino, size: r.size, mtime: r.mtime, off: r.off, seq: r.seq, stopped: r.stopped,
      sigHead: buf(r.sig_head), sigTail: buf(r.sig_tail),
      review: r.review, reviewAt: r.review_at, boot: r.boot, bootAt: r.boot_at, dirty: false,
    };
  }

  private blank(path: string, st: FileStat, fid: number): Entry {
    return { fid, path, ino: st.ino, size: st.size, mtime: st.mtimeMs, off: 0, seq: 0, stopped: 0, sigHead: Buffer.alloc(0), sigTail: Buffer.alloc(0),
      review: null, reviewAt: null, boot: null, bootAt: null, dirty: true };
  }

  /** Marks a file as present in the scanned folders, so commit() keeps its entry. */
  see(path: string): void { this.seen.add(path); }

  /** The entry for a file as it is now: started over when it is not the file the entry describes. */
  private entry(path: string, st: FileStat, stats: ScanStats): Entry {
    this.seen.add(path);
    let e = this.entries.get(path);
    if (!e) { e = this.blank(path, st, 0); this.entries.set(path, e); return e; }
    if (e.size === st.size && e.mtime === st.mtimeMs && e.ino === st.ino) return e;
    let same = e.ino === st.ino && st.size >= e.size;
    if (same && e.sigHead.length) { const h = readAt(path, 0, e.sigHead.length); stats.headBytes += h.length; same = h.equals(e.sigHead); }
    if (same && e.sigTail.length) { const t = readAt(path, e.off - e.sigTail.length, e.sigTail.length); stats.headBytes += t.length; same = t.equals(e.sigTail); }
    if (!same) {
      if (e.fid) this.db.run("DELETE FROM records WHERE fid = ?", [e.fid]);
      e = this.blank(path, st, e.fid);
      this.entries.set(path, e);
      return e;
    }
    e.size = st.size; e.mtime = st.mtimeMs; e.dirty = true;
    return e;
  }

  private sign(e: Entry, head?: Buffer): void {
    if (e.sigHead.length < SIG && e.size > e.sigHead.length) {
      const h = head && head.length >= Math.min(SIG, e.size) ? head.subarray(0, Math.min(SIG, e.size)) : readAt(e.path, 0, Math.min(SIG, e.size));
      e.sigHead = Buffer.from(h); e.dirty = true;
    }
  }

  /** The file's records inside the window, in line order: the kept ones plus whatever was appended since. */
  records(path: string, st: FileStat, stats: ScanStats): CRec[] {
    const e = this.entry(path, st, stats);
    const fromZero = e.off === 0 && e.seq === 0;
    let tail: CRec | null = null;
    if (!e.stopped && st.size > e.off) {
      const bytes = readAt(path, e.off, st.size - e.off);
      stats.parsed += bytes.length;
      if (fromZero) stats.full++; else stats.incremental++;
      const nl = bytes.lastIndexOf(10);
      const done = nl >= 0 ? bytes.subarray(0, nl + 1) : Buffer.alloc(0);
      const rest = bytes.subarray(nl + 1);
      const fresh: CRec[] = [];
      let stopped = false;
      if (done.length) {
        for (const line of done.toString("utf8").split("\n")) {
          const r = parseLine(line, this.cutoff);
          if (r === "bad") { stopped = true; break; }
          if (r) fresh.push(r);
        }
      }
      if (!stopped && rest.length) {
        // the unfinished last line counts if it already parses (a full scan reads it too), but is never consumed
        const r = parseLine(rest.toString("utf8"), this.cutoff);
        if (r && r !== "bad") tail = r;
      }
      this.store(e, fresh);
      if (stopped) e.stopped = 1;
      e.off += done.length;
      if (done.length) {
        const k = Math.min(SIG, e.off);
        e.sigTail = done.length >= k ? Buffer.from(done.subarray(done.length - k)) : readAt(path, e.off - k, k);
      }
      this.sign(e, fromZero ? bytes : undefined);
      e.dirty = true;
    } else {
      stats.kept++;
    }
    const out = this.kept(e);
    if (tail) out.push(tail);
    return out;
  }

  private persist(e: Entry): void {
    if (e.fid) return;
    const r = this.db.query("INSERT INTO files (path, ino, size, mtime, off, seq, stopped) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING fid")
      .get(e.path, e.ino, e.size, e.mtime, e.off, e.seq, e.stopped) as { fid: number };
    e.fid = r.fid;
  }

  private store(e: Entry, recs: CRec[]): void {
    this.persist(e);
    for (const r of recs) this.ins.run(e.fid, e.seq++, r.ts, r.model, r.id, r.inp, r.cw, r.cr, r.out, r.h1, r.m5, r.side ? 1 : 0);
  }

  private kept(e: Entry): CRec[] {
    if (!e.fid) return [];
    const out: CRec[] = [];
    for (const r of this.sel.all(e.fid) as any[]) {
      if (!(r.ts >= this.cutoff)) continue;
      out.push({ ts: r.ts, model: r.model, id: r.id, inp: n2(r.inp), cw: n2(r.cw), cr: n2(r.cr), out: n2(r.out), h1: n2(r.h1), m5: n2(r.m5), side: r.side === 1 });
    }
    return out;
  }

  /**
   * A head answer (isReview, the boot-topic match): `compute` sees the first `n` bytes. It is kept for good once
   * `final` (the window is full, or the answer can no longer change), else for as long as the size is the same.
   */
  head<T extends number | string | null>(kind: "review" | "boot", path: string, st: FileStat, n: number, stats: ScanStats,
    compute: (head: Buffer) => Head<T>): T {
    const e = this.entry(path, st, stats);
    const at = kind === "review" ? e.reviewAt : e.bootAt;
    if (at !== null && (at === -1 || at === st.size)) return (kind === "review" ? e.review : e.boot) as T;
    const h = readAt(path, 0, n);
    stats.headBytes += h.length;
    const r = compute(h);
    const keepAt = r.final || st.size >= n ? -1 : st.size;
    if (kind === "review") { e.review = r.value as number; e.reviewAt = keepAt; } else { e.boot = r.value as string | null; e.bootAt = keepAt; }
    this.sign(e, h);
    e.dirty = true;
    return r.value;
  }

  /** Drops the entries of files under `dir` that this scan did not find, writes every change and closes. */
  commit(dir: string): void {
    const pre = dir.endsWith("/") ? dir : dir + "/";
    const upd = this.db.prepare("UPDATE files SET ino = ?, size = ?, mtime = ?, off = ?, seq = ?, stopped = ?, sig_head = ?, sig_tail = ?, review = ?, review_at = ?, boot = ?, boot_at = ? WHERE fid = ?");
    for (const e of this.entries.values()) {
      if (e.path.startsWith(pre) && !this.seen.has(e.path)) {
        if (e.fid) { this.db.run("DELETE FROM records WHERE fid = ?", [e.fid]); this.db.run("DELETE FROM files WHERE fid = ?", [e.fid]); }
        continue;
      }
      if (!e.dirty) continue;
      this.persist(e);
      upd.run(e.ino, e.size, e.mtime, e.off, e.seq, e.stopped, e.sigHead, e.sigTail, e.review, e.reviewAt, e.boot, e.bootAt, e.fid);
    }
    this.db.run("COMMIT");
    this.db.close();
  }

  /** Leaves the cache as it was (a scan that failed). */
  abort(): void {
    try { this.db.run("ROLLBACK"); } catch { /* nothing open */ }
    try { this.db.close(); } catch { /* already closed */ }
  }
}
