// chat.ts — each live member's recent conversation into observed_chat (crew-terminal-access U1, KTD1–3),
// the only thing the board's chat panel reads.
//
// Project scope, every tick. A live member is a members row not gone whose worktree the Orca observer
// still sees (observed_workers.gone_at NULL). Its agent picks a reader under bin/loop/chat/ (READERS),
// which names the transcript to read (Claude: observed_transcripts, never `sdk-cli`; Codex:
// observed_rollouts) and turns its lines into turns. An agent with no reader, or no transcript yet, gets
// one `screen` turn from the observed screen tail. A new provider is a new reader file in READERS.
//
// Reads are incremental: one stat per member, and only the bytes appended since `read_to` when the
// size moved (an idle squad's tick reads no content and writes no row). An append to a followed path is
// read whole, in chunks of READ_WINDOW with a half line carried across chunks (a compaction can write
// 1 MB at once). A first read, a new path, a shrunk file or an append over FOLLOW_MAX starts at most
// READ_WINDOW before the end, never at byte 0, and drops the cut first line; a half-written last line
// is held back until it completes. Text is redacted
// before it is written (chat/redact.ts) and capped to 20 turns / 16 KB (chat/turns.ts).
// A member that ended keeps its row with gone_at set and turns emptied; no row is deleted.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import * as claude from "../chat/claude.ts";
import * as codex from "../chat/codex.ts";
import { screenTurns } from "../chat/screen.ts";
import { capTurns, remark, type Turn } from "../chat/turns.ts";
import type { Observer, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";

export type Reader = { agent: string; pathFor(store: Store, project: string, wt: string): string | null; parse(text: string): Turn[] };
export const READERS: Reader[] = [claude, codex];

export const READ_WINDOW = 256 * 1024;
export const FOLLOW_MAX = 32 * 1024 * 1024;   // an append over this jumps to the end window, as before

function chunk(p: string, from: number, len: number): Buffer {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(len);
    return buf.subarray(0, readSync(fd, buf, 0, len, from));
  } finally { closeSync(fd); }
}

const parseTurns = (s: unknown): Turn[] => {
  try { const a = JSON.parse(String(s ?? "[]")); return Array.isArray(a) ? a as Turn[] : []; } catch { return []; }
};

type Live = { wt: string; agent: string | null; worker: Row };

function liveMembers(store: Store, project: string): Live[] {
  const rs = store.db.query(`SELECT DISTINCT m.wt AS wt, COALESCE(w.agent, m.agent) AS agent FROM members m
    JOIN observed_workers w ON w.project = m.project AND w.wt = m.wt
    WHERE m.project = ? AND m.wt IS NOT NULL AND COALESCE(m.status, '') != 'gone' AND w.gone_at IS NULL ORDER BY m.wt`)
    .all(project) as { wt: string; agent: string | null }[];
  const seen = new Set<string>();
  return rs.filter((r) => !seen.has(r.wt) && seen.add(r.wt))
    .map((r) => ({ ...r, worker: store.get("observed_workers", { project, wt: r.wt }) as Row }));
}

export function chatObserver(opts: { log?: (line: string) => void; followMax?: number } = {}): Observer {
  const log = opts.log ?? ((l: string) => console.error(l));
  const followMax = opts.followMax ?? FOLLOW_MAX;
  const jumped = new Set<string>();   // paths whose over-ceiling append was logged
  const failing = new Set<string>();   // paths whose last read failed: logged once until a read works

  function write(store: Store, project: string, wt: string, prev: Row | null, at: number, set: Row & { turns: Turn[] }) {
    const turns = JSON.stringify(set.turns);
    const updated = prev && prev.turns === turns && prev.gone_at == null ? prev.updated_at : at;
    store.upsert("observed_chat", { project, wt }, { ...set, turns, updated_at: updated, gone_at: null });
  }

  function transcript(store: Store, project: string, m: Live, reader: Reader, path: string, prev: Row | null, at: number) {
    let size: number;
    try { size = statSync(path).size; } catch (e) { return fail(path, e); }
    const same = prev != null && prev.gone_at == null && prev.source === "transcript" && prev.path === path;
    if (same && Number(prev.size) === size) {          // nothing new: stat only, no transcript read
      const old = parseTurns(prev.turns), fixed = remark(old);   // a row from before U7: mark its typed lines once
      if (fixed.some((t, i) => t !== old[i])) write(store, project, m.wt, prev, at, { agent: m.agent, source: "transcript", path, size, read_to: prev.read_to, turns: fixed });
      return;
    }
    const readTo = same ? Number(prev.read_to ?? 0) : 0;
    const follow = same && readTo <= size && size - readTo <= followMax;
    if (follow) {
      jumped.delete(path);
      let pos = readTo, pending = Buffer.alloc(0), turns = remark(parseTurns(prev!.turns));
      try {
        while (pos < size) {
          const b = chunk(path, pos, Math.min(READ_WINDOW, size - pos));
          if (b.length === 0) break;
          pos += b.length;
          pending = pending.length ? Buffer.concat([pending, b]) : b;
          const e = pending.lastIndexOf(0x0a) + 1;       // a half line is carried to the next chunk
          if (e > 0) { turns = capTurns([...turns, ...reader.parse(pending.subarray(0, e).toString("utf8"))]); pending = pending.subarray(e); }
        }
      } catch (e) { return fail(path, e); }
      failing.delete(path);
      write(store, project, m.wt, prev, at, { agent: m.agent, source: "transcript", path, size, read_to: pos - pending.length, turns });
      return;
    }
    if (same && readTo <= size && !jumped.has(path)) {
      jumped.add(path);
      log(`chat: ${path} grew ${Math.round((size - readTo) / 1048576)} MB in one tick; read the last ${READ_WINDOW / 1024} KB`);
    }
    const from = Math.max(0, size - READ_WINDOW);
    let buf: Buffer;
    try { buf = chunk(path, from, size - from); } catch (e) { return fail(path, e); }
    failing.delete(path);
    // A start inside the file begins mid-line: skip to the next line.
    const nl = buf.indexOf(0x0a), skip = from > 0 ? (nl < 0 ? buf.length : nl + 1) : 0;
    const end = buf.lastIndexOf(0x0a) + 1;           // a half-written last line waits for its newline
    const text = end > skip ? buf.subarray(skip, end).toString("utf8") : "";
    const base = same && size >= readTo ? remark(parseTurns(prev.turns)) : [];
    write(store, project, m.wt, prev, at, { agent: m.agent, source: "transcript", path, size,
      read_to: end > skip ? from + end : Math.max(from + skip, readTo), turns: capTurns([...base, ...reader.parse(text)]) });
  }

  function fail(path: string, e: unknown) {
    if (failing.has(path)) return;
    failing.add(path);
    log(`chat: cannot read ${path}: ${e instanceof Error ? e.message : String(e)} (last turns kept)`);
  }

  return {
    name: "chat",
    run(ctx: TickCtx) {
      const { store, project, now: at } = ctx;
      const live = liveMembers(store, project);
      store.tx(() => {
        for (const m of live) {
          const prev = store.get("observed_chat", { project, wt: m.wt });
          const reader = READERS.find((r) => r.agent === m.agent);
          const path = reader?.pathFor(store, project, m.wt) ?? null;
          if (reader && path) transcript(store, project, m, reader, path, prev, at);
          else write(store, project, m.wt, prev, at, { agent: m.agent, source: "screen", path: null, size: null, read_to: null, turns: screenTurns(m.worker) });
        }
        const keep = new Set(live.map((m) => m.wt));
        const ended = store.db.query("SELECT wt FROM observed_chat WHERE project = ? AND gone_at IS NULL").all(project) as { wt: string }[];
        for (const { wt } of ended) if (!keep.has(wt)) store.upsert("observed_chat", { project, wt }, { gone_at: at, turns: "[]" });
      });
    },
  };
}

export default chatObserver();
