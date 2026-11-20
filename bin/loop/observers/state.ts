// state.ts — the state-file observer (U4): the runtime files the loop and the hooks write,
// into observed_* rows, each file re-read only when its mtime or size moved (gate.ts).
//
//   host:     accounts.tsv -> observed_accounts (+ accounts), tokens.tsv -> observed_tokens,
//             Lavish state.json + start log -> observed_sessions
//   project:  dispatcher.json -> projects, requests/<dir>/*.txt -> requests, alerts.json -> observed_alerts,
//             loop/squad-spent.tsv -> observed_spend,
//             loop/limited.json -> observed_limited,
//             picker mirrors (squads rows + picker-done/ + the transcript) -> observed_pickers,
//             each member's newest transcript (path, mtime, size, last model, last effort, entrypoint) -> observed_transcripts,
//             each Lead's watch beat (squads/<topic>.beat, its mtime) -> observed_markers
// Never the squad JSON: the squads, members and units rows are the truth and the JSON is the loop's
// own export, so re-reading it would roll back what was written since (U18's migration imports it
// once). Never the marker files either (sweep/*.poke, *.pending, ...): the sweep is off after the switch.
//
// Accounts: when accounts.tsv is older than DS_LOOP_ACCOUNTS_S (60 s) the
// observer starts bin/lib/accounts-refresh.sh in the background; the script's own lock keeps it to one
// refresh at a time, whoever starts it.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { confirm, Gate, replace, sig } from "../core/gate.ts";
import { accountRows, alertRows, dispatcherRows, doneRequests, isObj, mtime, num, readJson, requestFiles, requestRows, spendRows, tokenRows, tsv } from "../db/import-json.ts";
import type { Observer, TickCtx } from "../core/plugins.ts";
import { discoverProjects } from "../settings/projects.ts";
import { ROOT, type FactRow, type Row, type Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { mangle, wtPath } from "./orca.ts";

export type StateOpts = {
  refreshAccounts?: (root: string, maxAge: number) => void;
  tokenDir?: string;     // where Claude keeps transcripts: <dir>/<mangled worktree path>/*.jsonl
  lavishDir?: string;    // lavish-axi's state.json
  lavishLog?: string;    // fulfil/lavish.ts's Lavish start log
};

function refreshAccounts(root: string, maxAge: number): void {
  const p = Bun.spawn([join(ROOT, "bin", "lib", "accounts-refresh.sh"), "--max-age", String(maxAge)],
    { env: { ...process.env, DS_STATE_ROOT: root }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  p.unref();
}

const pathOf = (wt: string) => wtPath(wt) ?? wt;

// The last `n` bytes of a file.
export function tailOf(p: string, n: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(p, "r");
    const size = statSync(p).size, len = Math.min(n, size), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch { return ""; } finally { if (fd !== null) closeSync(fd); }
}

// The transcript's entrypoint (`cli` for an interactive session, `sdk-cli` for a headless
// `claude -p`): the last entrypoint on a message line in its last 256 KB, null when none.
// A transcript belongs to one session, so any entrypoint line agrees; the newest line wins.
export function entrypointOf(p: string): string | null {
  const ls = tailOf(p, 256 * 1024).split("\n");
  for (let i = ls.length - 1; i >= 0; i--) {
    if (!ls[i].includes('"entrypoint"')) continue;
    try {
      const j = JSON.parse(ls[i]);
      if (j && typeof j.entrypoint === "string" && j.entrypoint) return j.entrypoint;
    } catch { /* the first, cut line */ }
  }
  return null;
}

// The model of the newest assistant reply in a transcript (read from its last 256 KB), and when
// that reply was written (epoch s, null without a readable timestamp; U149 compares it with the
// agent's process start).
export function lastModelAt(p: string): { model: string; at: number | null } | null {
  const ls = tailOf(p, 256 * 1024).split("\n");
  for (let i = ls.length - 1; i >= 0; i--) {
    if (!ls[i].includes('"assistant"')) continue;
    try {
      const j = JSON.parse(ls[i]);
      if (j?.type === "assistant" && typeof j.message?.model === "string" && !j.message.model.startsWith("<")) { // "<synthetic>" is an error entry, not a model
        const at = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : NaN;
        return { model: j.message.model, at: Number.isFinite(at) ? Math.floor(at / 1000) : null };
      }
    } catch { /* the first, cut line */ }
  }
  return null;
}
export const lastModel = (p: string): string | null => lastModelAt(p)?.model ?? null;

// The effort of the newest assistant reply that records one (`perTurnEffort`), from the last 256 KB;
// null when the transcript has none (not a Claude transcript, or an older one).
export function lastEffort(p: string): string | null {
  const ls = tailOf(p, 256 * 1024).split("\n");
  for (let i = ls.length - 1; i >= 0; i--) {
    if (!ls[i].includes('"perTurnEffort"')) continue;
    try {
      const j = JSON.parse(ls[i]);
      if (typeof j?.perTurnEffort === "string" && j.perTurnEffort) return j.perTurnEffort;
    } catch { /* the first, cut line */ }
  }
  return null;
}

// pickerClosed: has the transcript a tool_result for the picker's tool_use_id?
// null when the transcript can't be read.
export function pickerClosed(path: unknown, toolUseId: unknown): boolean | null {
  if (typeof path !== "string" || !path || typeof toolUseId !== "string" || !toolUseId) return null;
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  for (const line of raw.split("\n")) {
    if (!line.includes(toolUseId) || !line.includes("tool_result")) continue;
    try {
      const c = JSON.parse(line)?.message?.content;
      if (Array.isArray(c) && c.some((x: Row) => x?.type === "tool_result" && x.tool_use_id === toolUseId)) return true;
    } catch { /* a half-written last line */ }
  }
  return false;
}

// The member's own transcript: its *.jsonl files newest-first, the first whose entrypoint is
// not `sdk-cli` (a reviewer's `claude -p` transcript writes beside the member's own, U98); the
// newest file when every file is headless or unreadable, so the row still moves with the review.
// Entry points come from the observed row when the file did not move, as last_model does.
export function memberTranscript(dir: string, store: Store): { path: string; mtime: number; size: number; entrypoint: string | null } | null {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return null; }
  const files: { path: string; mtime: number; size: number; ms: number }[] = [];
  for (const f of names) {
    try {
      const s = statSync(join(dir, f));
      files.push({ path: join(dir, f), mtime: Math.floor(s.mtimeMs / 1000), size: s.size, ms: s.mtimeMs });
    } catch { /* gone meanwhile */ }
  }
  files.sort((a, b) => b.ms - a.ms);
  let fallback: { path: string; mtime: number; size: number; entrypoint: string | null } | null = null;
  for (const f of files) {
    const prev = store.get("observed_transcripts", { path: f.path });
    const entrypoint = prev && prev.mtime === f.mtime && prev.size === f.size ? (prev.entrypoint as string | null) : entrypointOf(f.path);
    const row = { path: f.path, mtime: f.mtime, size: f.size, entrypoint };
    fallback ??= row;
    // A file with no readable entrypoint (a just-created transcript) is not the member's own;
    // the newest file stays the fallback, so an old transcript without entrypoint lines still works.
    if (entrypoint !== null && entrypoint !== "sdk-cli") return row;
  }
  return fallback;
}

// The newest *.jsonl in a directory, or null.
export function newestJsonl(dir: string): { path: string; mtime: number; size: number } | null {
  let best: { path: string; mtime: number; size: number; ms: number } | null = null;
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return null; }
  for (const f of names) {
    try {
      const s = statSync(join(dir, f));
      if (!best || s.mtimeMs > best.ms) best = { path: join(dir, f), mtime: Math.floor(s.mtimeMs / 1000), size: s.size, ms: s.mtimeMs };
    } catch { /* gone meanwhile */ }
  }
  return best && { path: best.path, mtime: best.mtime, size: best.size };
}

export function limitedRows(root: string, project: string): FactRow[] {
  const f = join(root, project, "loop", "limited.json"), a = readJson(f), at = mtime(f);
  return (Array.isArray(a) ? a.filter(isObj) : []).filter((e) => typeof e.wt === "string").map((e) => ({ table: "observed_limited",
    key: { project, wt: e.wt as string }, set: { line: (e.line as string) ?? null, since: num(String(e.since ?? "")),
      wait_until: num(String(e.wait_until ?? "")), doc: JSON.stringify(e), mtime: at, observed_at: at } }));
}

// The Leads' watch beats: squads/<topic>.beat, touched each time a Lead polls its inbox. Only the
// mtime counts (the board's lead.silent and stall banner); path is relative to the state root.
export function beatRows(root: string, project: string): FactRow[] {
  const sq = join(root, project, "squads");
  let names: string[] = [];
  try { names = readdirSync(sq).filter((f) => f.endsWith(".beat")).sort(); } catch { /* no squads yet */ }
  return names.map((f) => ({ table: "observed_markers", key: { project, path: `${project}/squads/${f}` },
    set: { mtime: mtime(join(sq, f)), body: null } }));
}

export function stateObserver(opts: StateOpts = {}): Observer {
  const gate = new Gate();
  const pickerMemo = new Map<string, { sig: string; closed: boolean | null }>(); // `<project>/<picker id>`
  let askedAt = 0;

  // One file (or file set) into its rows: re-read when its signature moved, else confirmed.
  const file = (store: Store, at: number, key: string, signature: string, rows: () => FactRow[], scopes: [string, Row][]) =>
    store.tx(() => gate.run(key, signature, () => replace(store, rows(), at, scopes), () => confirm(store, at, scopes)));

  function accounts(store: Store, at: number) {
    const f = join(store.root, "accounts.tsv"), maxAge = envInt("DS_LOOP_ACCOUNTS_S", 60);
    if (at - mtime(f) >= maxAge && at - askedAt >= maxAge) {
      askedAt = at;
      (opts.refreshAccounts ?? refreshAccounts)(store.root, maxAge);
    }
    file(store, at, "accounts.tsv", sig(f), () => accountRows(store.root), [["observed_accounts", {}]]);
  }

  // Lavish review pages: each belongs to the project whose member worktree holds its file, or whose
  // state folder holds it: `<root>/<label>/pages/<topic>/` and the legacy `<root>/<label>/squads/<topic>-board/`.
  function sessions(store: Store, at: number) {
    const dir = opts.lavishDir ?? process.env.LAVISH_AXI_STATE_DIR ?? join(process.env.HOME || "", ".lavish-axi");
    const st = join(dir, "state.json"), log = opts.lavishLog ?? join(process.env.TMPDIR || "/tmp", "ds-lavish-start.log");
    const members = store.db.query("SELECT project, wt FROM members WHERE wt IS NOT NULL AND COALESCE(status, '') != 'gone' ORDER BY project, wt").all() as { project: string; wt: string }[];
    const roots = members.map((m) => ({ project: m.project, dir: `${pathOf(m.wt)}/` }));
    file(store, at, "lavish", `${sig(st, log)}|${JSON.stringify(roots)}`, () => {
      const s = readJson(st) as { sessions?: Record<string, Row> } | undefined;
      const rows: FactRow[] = Object.entries(isObj(s?.sessions) ? s.sessions : {}).filter((e): e is [string, Row] => isObj(e[1])).map(([key, v]) => {
        const f = String(v.file ?? "");
        const home = f.startsWith(`${store.root}/`) ? /^([^/]+)\/(?:pages\/[^/]+|squads\/[^/]+-board)\//.exec(f.slice(store.root.length + 1))?.[1] : undefined;
        return { table: "observed_sessions", key: { project: roots.find((r) => f.startsWith(r.dir))?.project ?? home ?? "", file: f },
          set: { url: (v.url as string) ?? null, status: (v.status as string) ?? null, doc: JSON.stringify({ key, ...v }), observed_at: at } };
      });
      if (existsSync(log)) rows.push({ table: "observed_sessions", key: { project: "", file: log },
        set: { url: null, status: "log", doc: JSON.stringify({ tail: tailOf(log, 4096).split("\n").slice(-20).join("\n") }), observed_at: at } });
      return rows;
    }, [["observed_sessions", {}]]);
  }

  // Picker mirrors: the squads rows' waiting_on_you entries with source "picker", with whether the
  // picker closed (picker-done/<id> tombstone, or a tool_result in the transcript).
  function pickers(store: Store, at: number, project: string) {
    const squads = store.db.query("SELECT topic, doc FROM squads WHERE project = ? AND doc IS NOT NULL AND COALESCE(status, '') != 'closed'").all(project) as { topic: string; doc: string }[];
    const rows: FactRow[] = [], seen = new Set<string>();
    for (const s of squads) {
      let doc: Row;
      try { doc = JSON.parse(s.doc) as Row; } catch { continue; }
      for (const q of (Array.isArray(doc.waiting_on_you) ? doc.waiting_on_you : []).filter(isObj).filter((q) => q.source === "picker" && q.id)) {
        const tomb = existsSync(join(store.root, project, "picker-done", String(q.id)));
        const k = `${project}/${q.id}`, ts = sig(String(q.transcript_path ?? "")), m = pickerMemo.get(k);
        seen.add(k);
        // The transcript is scanned again only when it moved, and never once the picker closed.
        if (!tomb && (!m || (m.closed !== true && m.sig !== ts))) pickerMemo.set(k, { sig: ts, closed: pickerClosed(q.transcript_path, q.tool_use_id) });
        rows.push({ table: "observed_pickers", key: { project, squad: s.topic, id: String(q.id) },
          set: { doc: JSON.stringify({ ...q, tombstone: tomb, closed: tomb || (pickerMemo.get(k)?.closed ?? null) }), observed_at: at } });
      }
    }
    for (const k of pickerMemo.keys()) if (k.startsWith(`${project}/`) && !seen.has(k)) pickerMemo.delete(k);
    store.tx(() => replace(store, rows, at, [["observed_pickers", { project }]]));
  }

  // Each member's own transcript; one that did not move keeps its last model unread.
  function transcripts(store: Store, at: number, project: string) {
    const dir = opts.tokenDir ?? process.env.DS_TOKEN_DIR ?? join(process.env.HOME || "", ".claude", "projects");
    const members = store.db.query("SELECT wt FROM members WHERE project = ? AND wt IS NOT NULL AND COALESCE(status, '') != 'gone'").all(project) as { wt: string }[];
    const rows: FactRow[] = [];
    for (const { wt } of members) {
      const t = memberTranscript(join(dir, mangle(pathOf(wt))), store);
      if (!t) continue;
      const prev = store.get("observed_transcripts", { path: t.path });
      const same = prev && prev.mtime === t.mtime && prev.size === t.size;
      const last = same
        ? { model: prev.last_model as string | null, at: prev.model_at as number | null } : lastModelAt(t.path);
      // A null is re-read: the row predates the column (U105), or the file never had the field.
      const effort = same && prev.last_effort != null ? (prev.last_effort as string) : lastEffort(t.path);
      rows.push({ table: "observed_transcripts", key: { path: t.path }, set: { project, wt, mtime: t.mtime, size: t.size, last_model: last?.model ?? null,
        model_at: last?.at ?? null, last_effort: effort, entrypoint: t.entrypoint, observed_at: at } });
    }
    store.tx(() => replace(store, rows, at, [["observed_transcripts", { project }]]));
  }

  // Beats move every few seconds, so no gate: one readdir + stat per squad each tick. A beat file
  // that left drops its row; the sweep's marker rows (import-markers.ts) are never touched.
  function beats(store: Store, at: number, p: string) {
    const rows = beatRows(store.root, p);
    store.tx(() => {
      for (const r of rows) store.upsert(r.table, r.key, { ...r.set, observed_at: at });
      store.db.run(`DELETE FROM observed_markers WHERE project = ? AND path LIKE ? ESCAPE '\\' AND path NOT IN (SELECT value FROM json_each(?))`,
        [p, `${p.replace(/[\\%_]/g, "\\$&")}/squads/%.beat`, JSON.stringify(rows.map((r) => r.key.path))]);
    });
  }

  function project(store: Store, at: number, p: string) {
    const root = store.root, d = join(root, p), runtime = join(d, "loop");
    const repo = (store.db.query("SELECT repo FROM squads WHERE project = ? AND repo IS NOT NULL ORDER BY topic").get(p) as { repo: string } | null)?.repo ?? null;
    file(store, at, `${p}/dispatcher.json`, `${sig(join(d, "dispatcher.json"))}|${repo}`, () => dispatcherRows(root, p, repo), [["projects", { label: p }]]);
    const reqs = requestFiles(root, p);
    store.tx(() => gate.run(`${p}/requests`, `${reqs.join("|")}|${sig(...reqs)}`, () => {
      replace(store, requestRows(root, p), at, []);
      doneRequests(store, root, p, at);
    }));
    file(store, at, `${p}/alerts.json`, sig(join(d, "alerts.json")), () => alertRows(root, p), [["observed_alerts", { project: p }]]);
    file(store, at, `${p}/squad-spent.tsv`, sig(join(runtime, "squad-spent.tsv")), () => spendRows(root, p), [["observed_spend", { project: p }]]);
    file(store, at, `${p}/limited.json`, sig(join(runtime, "limited.json")), () => limitedRows(root, p), [["observed_limited", { project: p }]]);
    pickers(store, at, p);
    transcripts(store, at, p);
    beats(store, at, p);
  }

  return {
    name: "state",
    scope: "host",
    run(ctx: TickCtx) {
      const { store, now } = ctx;
      accounts(store, now);
      file(store, now, "tokens.tsv", sig(join(store.root, "tokens.tsv")), () => tokenRows(store.root), [["observed_tokens", {}]]);
      sessions(store, now);
      for (const p of discoverProjects(store.root)) project(store, now, p);
    },
  };
}

export default stateObserver();
