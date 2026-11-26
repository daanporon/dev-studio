// codex.ts — Codex rollouts (U149): each recent `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` file's
// cwd and originator (its first line, session_meta) and its newest turn's model and effort (the last
// turn_context line) into observed_rollouts. The Orca observer reads a Codex main agent's live model
// from the newest interactive rollout whose cwd is its worktree; Codex argv carries no model flag.
//
// Host scope, every DS_LOOP_LIVE_ACCOUNT_S (30 s). Only files written since the oldest live Codex
// main started are read (a long session keeps appending to the day dir it started in, so every day
// dir is listed, one stat per file); a file seen before reads only its appended bytes. With no live
// Codex main nothing is read and the rows stay as they are.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Observer, TickCtx } from "../core/plugins.ts";
import type { Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";

// Originators that are not a member's own agent: review-unit's cross-model passes (acpx, codex exec)
// often run in a Builder's worktree.
export const HEADLESS = new Set(["acpx", "codex_exec"]);

type Turn = { model: string; effort: string | null; at: number | null };
type File = { path: string; mtime: number; size: number };

function chunk(p: string, from: number, len: number): Buffer {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(len);
    return buf.subarray(0, readSync(fd, buf, 0, len, from));
  } finally { closeSync(fd); }
}

const epoch = (t: unknown) => { const ms = typeof t === "string" ? Date.parse(t) : NaN; return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; };

// The last turn_context in text (whole lines only: a cut first line fails to parse and is skipped).
export function lastTurn(text: string): Turn | null {
  const ls = text.split("\n");
  for (let i = ls.length - 1; i >= 0; i--) {
    if (!ls[i].includes('"turn_context"')) continue;
    try {
      const j = JSON.parse(ls[i]);
      if (j?.type === "turn_context" && typeof j.payload?.model === "string" && j.payload.model) {
        return { model: j.payload.model, effort: typeof j.payload.effort === "string" && j.payload.effort ? j.payload.effort : null, at: epoch(j.timestamp) };
      }
    } catch { /* a cut line */ }
  }
  return null;
}

// session_meta: the first line (tens of KB: it carries the instructions).
export function sessionMeta(p: string): { cwd: string | null; originator: string | null } {
  const head = chunk(p, 0, 1024 * 1024).toString("utf8");
  try {
    const j = JSON.parse(head.slice(0, head.indexOf("\n") < 0 ? head.length : head.indexOf("\n")));
    if (j?.type === "session_meta") return { cwd: typeof j.payload?.cwd === "string" ? j.payload.cwd : null, originator: typeof j.payload?.originator === "string" ? j.payload.originator : null };
  } catch { /* not a rollout */ }
  return { cwd: null, originator: null };
}

// The newest turn of a whole file: back from the end in growing windows until one holds a turn_context.
// Just past the file's last newline (0 when it has none yet): where a first read stops, like a later one.
function lastLineEnd(p: string, size: number): number {
  for (let n = 64 * 1024; ; n *= 8) {
    const len = Math.min(n, size), at = chunk(p, size - len, len).lastIndexOf(0x0a);
    if (at >= 0) return size - len + at + 1;
    if (len === size) return 0;
  }
}

function newestTurn(p: string, size: number): Turn | null {
  for (let n = 256 * 1024; ; n *= 8) {
    const len = Math.min(n, size), t = lastTurn(chunk(p, size - len, len).toString("utf8"));
    if (t || len === size) return t;
  }
}

function rollouts(dir: string, since: number): File[] {
  const out: File[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      if (depth < 3) { if (/^\d+$/.test(n)) walk(p, depth + 1); continue; }
      if (!n.startsWith("rollout-") || !n.endsWith(".jsonl")) continue;
      try {
        const st = statSync(p), mtime = Math.floor(st.mtimeMs / 1000);
        if (mtime >= since) out.push({ path: p, mtime, size: st.size });
      } catch { /* gone between readdir and stat */ }
    }
  };
  walk(dir, 0);
  return out;
}

export function scanRollouts(store: Store, dir: string, since: number, at: number): void {
  const files = rollouts(dir, since);
  store.tx(() => {
    for (const f of files) {
      const prev = store.get("observed_rollouts", { path: f.path });
      if (prev && prev.mtime === f.mtime && prev.size === f.size) continue;
      try {
        const grew = prev && Number(prev.size) <= f.size && prev.cwd != null && Number(prev.read_to ?? 0) > 0;
        const from = grew ? Number(prev.read_to) : 0;
        const tail = grew ? chunk(f.path, from, f.size - from) : null;
        const meta = grew ? { cwd: prev.cwd as string, originator: prev.originator as string | null } : sessionMeta(f.path);
        const turn = tail ? lastTurn(tail.toString("utf8")) : newestTurn(f.path, f.size);
        // The next read starts after the last whole line; a line still being written is read again.
        const end = tail ? from + tail.lastIndexOf(0x0a) + 1 : lastLineEnd(f.path, f.size);
        store.upsert("observed_rollouts", { path: f.path }, { cwd: meta.cwd, originator: meta.originator, mtime: f.mtime, size: f.size,
          read_to: Math.max(end, from), ...(turn ? { model: turn.model, effort: turn.effort, model_at: turn.at } : {}), observed_at: at });
      } catch { /* unreadable now: tried again next scan */ }
    }
    store.db.run("DELETE FROM observed_rollouts WHERE mtime < ? AND host = 'local'", [since]);
  });
}

export function codexObserver(opts: { dir?: string } = {}): Observer {
  return {
    name: "codex",
    scope: "host",
    every: envInt("DS_LOOP_LIVE_ACCOUNT_S", 30),
    run(ctx: TickCtx) {
      const oldest = (ctx.store.db.query("SELECT MIN(started_at) AS t FROM observed_workers WHERE agent = 'codex' AND gone_at IS NULL AND started_at IS NOT NULL").get() as { t: number | null }).t;
      if (oldest == null) return;
      const dir = opts.dir ?? process.env.DS_CODEX_SESSIONS ?? join(process.env.HOME || "", ".codex", "sessions");
      scanRollouts(ctx.store, dir, oldest, ctx.now);
    },
  };
}

export default codexObserver();
