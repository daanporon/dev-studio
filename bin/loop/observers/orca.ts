// orca.ts — the Orca observer (U4): worktrees, workers, terminals and unread mail into observed_*.
//
// Per tick it costs one `ps` and one host-wide inbox read (shared by every project), one
// `directory.sh list --project <label> --json` per project, and a screen read only for a worker
// that is new, changed state, moved its token count, or that a reconciler marked suspect — a quiet
// working terminal costs nothing. Everything goes through one adapter (OrcaAdapter): the shell one
// below wraps bin/backend/orca.sh, bin/loop/fakes/orca.ts replays recorded outputs.
//
// A project's worktrees: its directory rows, its members rows, its Studio worktree, and any worktree
// named <prefix><label>-… and no longer label's prefix (`ds-dev-studio-public-…` is not dev-studio's).
// A row whose worktree or terminal left, or whose worktree is no longer the project's, gets gone_at
// (kept, not deleted); seen again, gone_at clears. An empty `ps` while rows are live is an Orca hiccup, not a mass exit:
// the tick throws (plugin_error) and nothing is marked gone.
import { join } from "node:path";
import type { Observer, TickCtx } from "../core/plugins.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { builderQuestions, idleBuilderDue, knob, liveSquads, SETTLED } from "../reconcilers/liveness.ts";
import { paused } from "../pause/pause.ts";
import { stopping } from "../squad/cancel.ts";
import { lastStart, stopOpen } from "../squad/member-state.ts";
import { HEADLESS } from "./codex.ts";
import { backendOp, backendPath, inProcess } from "../io/orca.ts";
import { redact } from "../core/redact.ts";
import { adoptStudio, STUDIO_SQUAD, studioAgent } from "../squad/studio.ts";
import { loopProjects } from "../settings/projects.ts";
import { offOrca } from "../squad/backend.ts";
import { KEYS_STALE_S } from "../chat/keys.ts";

export type PsAgent = { state?: string; stateStartedAt?: number; lastAssistantMessage?: string };
export type PsWorktree = { worktreeId: string; path?: string; branch?: string; displayName?: string; lastOutputAt?: number;
  unread?: boolean; isArchived?: boolean; parentWorktreeId?: string | null; agents?: PsAgent[] };
export type DirMember = { squad: string; role: string; suffix?: string; name?: string; wt: string; live?: boolean; kind?: string;
  run_id?: string | null; terminals?: string[] };
export type Unread = { to: string; run: string };
// orca.sh agent-accounts: a live agent process, its working dir, the account it runs on, and
// whether it is its worktree's own agent (main) or one it started beside it (sub, U90: a muse
// Builder's review-unit `claude -p`). `model` and `effort` are its `--model`/`--effort` flags ("-"
// when unread). A main line also carries the process's pid, start (epoch s) and RSS (kB) (U149).
export type LiveAccount = { cwd: string; agent: string; account: string; kind?: string; model?: string; effort?: string;
  pid?: number; start?: number; rss?: number };
// A worktree's main agent as one process-walk read sees it (U149): running (one agent, or several
// that agree on agent and account: the newest start wins), none (no agent process in it), unknown
// (mains that disagree).
export type MainAgent = { agent: string; account: string; cwd: string; model: string | null; effort: string | null;
  pid: number | null; start: number | null; rss: number | null };
export type Walk = { walk: "running" | "none" | "unknown"; main: MainAgent | null };
export type SubAgent = { agent: string; model: string; account: string; effort?: string };
// orca.sh run-dispatches: a worktree's newest dispatch in a Run and its status (U64).
export type RunDispatch = { wt: string; id: string; status: string };
export type LiveTerminal = { handle: string; worktreeId: string; title?: string; agentIdentity?: string | null;
  connected?: boolean; writable?: boolean; orphaned?: boolean; lastOutputAt?: number };

export interface OrcaAdapter {
  ps(): Promise<PsWorktree[]>;                                  // orca.sh ps (.result.worktrees)
  unread(): Promise<Unread[]>;                                  // orca.sh inbox-unread-all: one host-wide inbox read
  directory(project: string, root: string): Promise<DirMember[]>; // directory.sh list --project <label> --json
  screenTail(wt: string): Promise<string>;                      // orca.sh screen-tail <wt | terminal handle>
  agentAccounts?(): Promise<LiveAccount[]>;                     // orca.sh agent-accounts (host-wide; U55)
  dispatches?(run: string): Promise<RunDispatch[]>;             // orca.sh run-dispatches <run> (U64)
  terminals?(): Promise<LiveTerminal[]>;                       // host-wide exact terminal identity, shared per tick
}

async function sh(cmd: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env }, timeout: 60_000 });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(1, 2).join(" ") || cmd[0]}: exit ${code}: ${err.trim().slice(0, 300)}`);
  return out;
}

// A backend read: in process for orca.sh (U227), spawned for any other $BACKEND; fails as sh() did.
async function be(op: string, ...args: string[]): Promise<string> {
  const o = await backendOp(backendPath(), op, args, { ...process.env } as Record<string, string>, 60_000);
  if (o.code !== 0) throw new Error(`${op}: exit ${o.code}: ${o.err.trim().slice(0, 300)}`);
  return o.out;
}

// inbox-unread-all's lines: <to_handle>\t<run_id>\t...
export function parseUnread(text: string): Unread[] {
  return text.split("\n").filter(Boolean).map((l) => {
    const [to = "", run = ""] = l.split("\t");
    return { to, run };
  });
}

/** U252: the Runs with unread mail for their coordinator, the relay's gate (actuator.seats): Orca files a worker's
 *  Run mail under `run:<id>`, and mail to a seat's own handle counts too. Mail to a Run's workers (`dispatch:…`, their
 *  terminals) is theirs to read and never in the coordinator's peek, so it does not count. */
export function coordinatorMail(store: Store, unread: Unread[]): Set<string> {
  const seats = new Set((store.db.query("SELECT handle FROM coordinators").all() as { handle: string }[]).map((r) => r.handle));
  return new Set(unread.flatMap((u) => u.to.startsWith("run:") ? [u.to.slice(4)] : u.run && seats.has(u.to) ? [u.run] : []));
}

// run-dispatches' lines: <worktree id>\t<dispatch id>\t<status>
export function parseDispatches(text: string): RunDispatch[] {
  return text.split("\n").filter(Boolean).map((l) => {
    const [wt = "", id = "", status = ""] = l.split("\t");
    return { wt, id, status };
  }).filter((d) => d.wt && d.id);
}

// The Runs worth a run-dispatches read this tick (U100): a live squad's Run that has a live
// standing member (any non-builder role — leads, thinkers and the rest stay up between turns).
// Inside crash_window_min of a start every tick, as U64 did (only then can a settle be a crash);
// past it at most once per DISPATCH_READ_MIN (default 5), so a later settle still refreshes the
// verdict instead of reading `waiting` forever. U132 also reads before eligible Builder question
// decisions, including Builder-only Runs, and every tick while a member's stop waits on its old
// dispatch (account-move-slow U1: `stopOpen`). Each complete read stamps all checked current members;
// an absent Builder must not retain an old dispatch ID.
export function dispatchRuns(store: Store, project: string, now: number): { run: string; wts: string[] }[] {
  const win = knob(store, project, "CRASH_WINDOW_MIN", 10) * 60;
  const every = knob(store, project, "DISPATCH_READ_MIN", 5) * 60;
  const out: { run: string; wts: string[] }[] = [];
  // U231: a squad wished gone or suspended keeps its dispatch reads while a member still has a wt.
  const closing = (store.db.query(`SELECT s.* FROM squads s WHERE s.project = ? AND s.run_id IS NOT NULL
    AND (COALESCE(s.want, s.status) IN ('suspended', 'gone', 'closed', 'archived') OR s.status IN ('suspended', 'gone', 'closed', 'archived'))
    AND s.status != 'closed'
    AND EXISTS (SELECT 1 FROM members m WHERE m.project = s.project AND m.squad = s.topic AND m.wt IS NOT NULL AND COALESCE(m.status, '') != 'gone')`)
    .all(project) as Row[]);
  const live = liveSquads(store, project);
  for (const sq of [...live, ...closing.filter((c) => !live.some((l) => l.topic === c.topic))]) {
    if (!sq.run_id) continue;
    const isClosing = closing.some((c) => c.topic === sq.topic);
    const ms = store.db.query(`SELECT m.id, m.wt, m.role, m.limited_until, COALESCE(m.started, m.since) AS since, w.dispatch_seen_at AS seen,
      p.state AS pause_state FROM members m
      LEFT JOIN observed_workers w ON w.project = m.project AND w.wt = m.wt
      LEFT JOIN pause_members p ON p.project = m.project AND p.squad = m.squad AND p.role = m.role AND p.suffix = m.suffix
      WHERE m.project = ? AND m.squad = ? AND m.wt IS NOT NULL AND (COALESCE(m.want, '') != 'gone' OR ?)
      AND m.id = (SELECT MAX(id) FROM members WHERE project = m.project AND squad = m.squad AND role = m.role AND suffix = m.suffix)
      AND ((COALESCE(m.status, '') != 'gone' AND w.gone_at IS NULL AND w.wt IS NOT NULL)
        OR p.state = 'pausing')`).all(project, String(sq.topic), isClosing ? 1 : 0) as { id: number; wt: string; role: string; limited_until: number | null; since: string | null; seen: number | null; pause_state: string | null }[];
    if (!ms.length) continue;
    const standing = ms.filter((m) => m.role !== "builder" || m.pause_state === "pausing");
    const fresh = standing.some((m) => m.pause_state === "pausing" || (m.since != null && now - Date.parse(m.since) / 1000 < win));
    // account-move-slow U1: a member whose stop went out waits for its old dispatch to settle; read
    // every tick until that stop ends, not up to DISPATCH_READ_MIN later. Any member, any role.
    const stopWaits = ms.some((m) => stopOpen(store, project, m.id));
    const last = Math.max(...standing.map((m) => Number(m.seen ?? -Infinity)));
    const builders = ms.filter((m) => {
      if (m.role !== "builder" || Number(m.limited_until ?? 0) > now || paused(store, { project, squad: String(sq.topic), member: m.wt }) || stopping(store, project, m.wt)) return false;
      const w = store.get("observed_workers", { project, wt: m.wt });
      const tree = store.get("observed_worktrees", { project, wt: m.wt });
      if (!w || w.limited || Number(JSON.parse(String(tree?.doc ?? "{}"))?.agents ?? 0) === 0) return false;
      const units = store.db.query("SELECT slug, pr, hold, doc FROM units WHERE project = ? AND squad = ? AND builder_wt = ? AND status = 'dispatched'")
        .all(project, String(sq.topic), m.wt) as { slug: string; pr: string | null; hold: number | null; doc: string | null }[];
      return units.some((u) => {
        try { if (JSON.parse(u.doc ?? "{}")?.waiting_on) return false; } catch { /* a torn doc: not waiting */ }
        return idleBuilderDue(store, project, m.wt, now, { ...u, squad: String(sq.topic) }, w);
      });
    });
    const ownQuestion = builders.some((m) => builderQuestions(store, project, String(sq.topic), m.wt, now).candidate);
    // A newly seen dispatch sender can need a read before its member is known. It never waits
    // unrelated Builders: only the subsequent authoritative listing can associate that sender.
    const oldest = Math.min(...builders.map((m) => Number(m.seen ?? -Infinity)));
    const newDispatchQuestion = builders.length > 0 && !!store.db.query(`SELECT 1 FROM relayed r
      WHERE r.project = ? AND r.squad = ? AND r.run_id = ? AND r.type = 'question'
        AND r.from_handle LIKE 'dispatch:%' AND r.seen_at >= ?
        AND NOT EXISTS (SELECT 1 FROM requests q WHERE q.kind = 'reply' AND q.project = r.project AND q.squad = r.squad
          AND q.done_at IS NOT NULL AND json_type(q.result, '$.ok') = 'true'
          AND json_extract(q.payload, '$.id') = r.msg_id AND json_extract(q.payload, '$.run') = r.run_id) LIMIT 1`)
      .get(project, String(sq.topic), String(sq.run_id), oldest);
    if (stopWaits || ownQuestion || newDispatchQuestion || (standing.length > 0 && (fresh || !(last > 0) || now - last >= every))) {
      out.push({ run: String(sq.run_id), wts: ms.map((m) => m.wt) });
    }
  }
  return out;
}

export function shellAdapter(): OrcaAdapter {
  return {
    async ps() { return (JSON.parse(await be("ps")) as { result?: { worktrees?: PsWorktree[] } }).result?.worktrees ?? []; },
    async unread() { return parseUnread(await be("inbox-unread-all")); },
    async directory(project, root) {
      if (inProcess(backendPath())) {
        // U248: the phone book as a function; its wt-terminals, worker-detail and current reads are in-process verbs.
        const { runWith } = await import("../../commands/directory-ts.ts");   // lazy: a copy of bin/loop has no bin/commands
        const out: string[] = [], err: string[] = [];
        const code = await runWith({ stateRoot: root, out: (t) => out.push(t), err: (t) => err.push(t),
          backend: async (a) => { const r = await backendOp(backendPath(), a[0], a.slice(1), { ...process.env } as Record<string, string>, 60_000); return { out: r.out, err: r.err, rc: r.code }; } },
        ["list", "--project", project, "--json"]);
        if (code !== 0) throw new Error(`directory.sh: exit ${code}: ${err.join("").trim().slice(0, 300)}`);
        return JSON.parse(out.join("") || "[]") as DirMember[];
      }
      const out = await sh([join(ROOT, "bin", "lib", "directory.sh"), "list", "--project", project, "--json"], { DS_STATE_ROOT: root, BACKEND: backendPath() });
      return JSON.parse(out || "[]") as DirMember[];
    },
    screenTail(wt) { return be("screen-tail", wt); },
    async agentAccounts() { return parseAgentAccounts(await be("agent-accounts")); },
    async dispatches(run) { return parseDispatches(await be("run-dispatches", run)); },
    async terminals() {
      const data = JSON.parse(await be("loop-terminals"));
      if (data.ok === false || !Array.isArray(data.result?.terminals)) throw new Error("invalid terminal listing");
      return data.result.terminals;
    },
  };
}

// agent-accounts' lines: a main line <cwd>\tmain\t<agent>\t<model>\t<account>\t<effort>\t<pid>\t<start>\t<rss>
// (U149), a sub line <cwd>\tsub\t<agent>\t<model>\t<account>[\t<effort>] (U90, U105). A 3-field line is
// a main line from before U149: no model, effort, pid, start or RSS.
const int = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
export function parseAgentAccounts(text: string): LiveAccount[] {
  return text.split("\n").filter(Boolean).flatMap((l) => {
    const f = l.split("\t");
    if (f.length >= 5 && (f[1] === "main" || f[1] === "sub")) {
      const [cwd = "", kind = "", agent = "", model = "", account = "", effort = "", pid, start, rss] = f;
      if (!cwd || !agent || !account) return [];
      const proc = kind === "main" ? { pid: int(pid), start: int(start), rss: int(rss) } : {};
      return [{ cwd, agent, account, kind, model, ...(effort && effort !== "-" ? { effort } : {}), ...proc }];
    }
    const [cwd = "", agent = "", account = ""] = f;
    return cwd && agent && account ? [{ cwd, agent, account }] : [];
  });
}

const isMain = (pr: LiveAccount) => (pr.kind ?? "main") === "main";

// Each worktree's main agent: its MAIN agent processes' working dirs (the deepest worktree holding
// that dir wins). A sub line never counts here (U90): the member's own agent decides, however many
// sub-agents it runs. `pin` names a worktree's own agent where others run beside it (U261: the
// Studio worktree also holds ds-loop panes running codex): only mains of that agent count there.
export function mainAgents(ps: PsWorktree[], procs: LiveAccount[], pin: Map<string, string> = new Map()): Map<string, Walk> {
  const byWt = byWorktree(ps, procs.filter(isMain));
  const out = new Map<string, Walk>();
  for (const w of ps) {
    const only = pin.get(w.worktreeId);
    const mains = (byWt.get(w.worktreeId) ?? []).filter((m) => !only || m.agent === only);
    if (!mains.length) { out.set(w.worktreeId, { walk: "none", main: null }); continue; }
    if (new Set(mains.map((m) => `${m.agent}\t${m.account}`)).size > 1) { out.set(w.worktreeId, { walk: "unknown", main: null }); continue; }
    const m = mains.reduce((a, b) => ((b.start ?? -1) > (a.start ?? -1) ? b : a));
    out.set(w.worktreeId, { walk: "running", main: { agent: m.agent, account: m.account, cwd: m.cwd, model: m.model && m.model !== "-" ? m.model : null,
      effort: m.effort ?? null, pid: m.pid ?? null, start: m.start ?? null, rss: m.rss ?? null } });
  }
  return out;
}

// Each worktree's live sub-agents (U90): the sub lines' processes in it, as {agent, model, account}.
// A sub line maps to the same worktree its cwd's main line would; none known reads as [].
export function subAgents(ps: PsWorktree[], procs: LiveAccount[]): Map<string, SubAgent[]> {
  const byWt = byWorktree(ps, procs.filter((pr) => !isMain(pr)));
  const out = new Map<string, SubAgent[]>();
  for (const w of ps) {
    const keys = new Set((byWt.get(w.worktreeId) ?? []).map((pr) => JSON.stringify({ agent: pr.agent, model: pr.model || "-", account: pr.account, ...(pr.effort ? { effort: pr.effort } : {}) })));
    out.set(w.worktreeId, [...keys].map((k) => JSON.parse(k) as SubAgent));
  }
  return out;
}

function byWorktree(ps: PsWorktree[], procs: LiveAccount[]): Map<string, LiveAccount[]> {
  const paths = ps.flatMap((w) => { const p = pathOf(w); return p ? [{ wt: w.worktreeId, p: p.replace(/\/+$/, "") }] : []; })
    .sort((a, b) => b.p.length - a.p.length);
  const out = new Map<string, LiveAccount[]>();
  for (const pr of procs) {
    const hit = paths.find((x) => pr.cwd === x.p || pr.cwd.startsWith(`${x.p}/`));
    if (hit) out.set(hit.wt, [...out.get(hit.wt) ?? [], pr]);
  }
  return out;
}

// The model a main agent runs now (U149). Claude: its --model flag, unless its transcript's newest
// reply was written after the process started (an in-session /model switch, or a start without the
// flag). Codex: the newest turn of the newest interactive rollout begun in its cwd since it started
// (its argv names no model). Muse: unknown. Effort follows the same source.
export function liveModel(store: Store, project: string, wt: string, m: MainAgent): { model: string | null; effort: string | null } {
  if (m.agent === "claude") {
    const t = store.db.query("SELECT last_model, model_at, last_effort FROM observed_transcripts WHERE project = ? AND wt = ? ORDER BY mtime DESC LIMIT 1")
      .get(project, wt) as { last_model: string | null; model_at: number | null; last_effort: string | null } | null;
    if (t?.last_model && t.model_at != null && (m.start == null || t.model_at > m.start)) return { model: t.last_model, effort: t.last_effort ?? m.effort };
    return { model: m.model, effort: m.effort };
  }
  if (m.agent === "codex") {
    const r = store.db.query(`SELECT model, effort FROM observed_rollouts WHERE cwd = ? AND model IS NOT NULL
      AND COALESCE(originator, '') NOT IN (SELECT value FROM json_each(?)) AND COALESCE(model_at, mtime) >= ? ORDER BY mtime DESC LIMIT 1`)
      .get(m.cwd, JSON.stringify([...HEADLESS]), m.start ?? 0) as { model: string; effort: string | null } | null;
    return r ? { model: r.model, effort: r.effort } : { model: null, effort: null };
  }
  return { model: null, effort: null };
}

// Presence (U149): running when the walk saw the agent or Orca has a live dispatch for it; none when
// the walk read the worktree empty and no dispatch is live; otherwise unknown (a failed walk, mains
// that disagree, or no walk yet). Orca's worker state and a leftover terminal are no evidence.
// U231: a dispatch counts only when the latest dispatch read for its run saw it (`current`).
// U21a: when the walk first read none in the current spell (observed_workers.walk_none_at). A walk that
// reads none keeps a spell begun after the member's last start and begins one otherwise; a walk that
// finds the agent ends it (null); a failed or split walk (`unknown`) proves nothing and keeps it.
export function walkNoneAt(walk: unknown, prev: unknown, startedAt: number, now: number): number | null {
  const was = prev == null ? null : Number(prev);
  if (walk === "running") return null;
  if (walk !== "none") return was;
  return was != null && was > startedAt ? was : now;
}

export function presence(walk: unknown, dispatch: unknown, current = true): "running" | "none" | "unknown" {
  if (walk === "running" || (current && typeof dispatch === "string" && dispatch && !SETTLED.has(dispatch))) return "running";
  return walk === "none" ? "none" : "unknown";
}

// orca.sh worker-states' rule: any agent working -> working, else waiting, else done, else idle.
export function workerState(w: PsWorktree): string {
  const s = (w.agents ?? []).map((a) => a.state);
  return s.includes("working") ? "working" : s.includes("waiting") ? "waiting" : s.includes("done") ? "done" : "idle";
}
const secs = (ms: unknown) => (typeof ms === "number" && ms > 0 ? Math.floor(ms / 1000) : null);
// A worktree id is `<repo id>::<path>`.
export const wtPath = (id: string) => (id.includes("::") ? id.slice(id.indexOf("::") + 2) : null);
const pathOf = (w: PsWorktree) => w.path ?? wtPath(w.worktreeId);
// tokens.tsv keys a worker by its mangled worktree path, as board-data.ts reads it.
export const mangle = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
export const prefix = () => process.env.DS_PREFIX || "ds-";
const TAILS = 8; // screen reads in flight at once
const STUDIO_SETTLE_S = 5; // the Studio's screen is re-read once its output has rested this long
const SCREEN_EVERY_S = 3; // U19: a watched member's screen (board keys, a screen-only chat) is re-read at most this often

// The project's worktree ids besides its directory rows: members, the Studio, and the name prefix.
// A worktree belongs to one project: a name that also starts with a longer label's prefix
// (`ds-dev-studio-public-` beside `ds-dev-studio-`) is that project's, not this one's.
function knownWts(store: Store, project: string, ps: PsWorktree[]): Set<string> {
  const ids = new Set((store.db.query("SELECT wt FROM members WHERE project = ? AND wt IS NOT NULL AND COALESCE(want, '') != 'gone' UNION SELECT builder_wt AS wt FROM units WHERE project = ? AND status = 'cancelled' AND COALESCE(builder_wt, '') != ''")
    .all(project, project) as { wt: string }[]).map((r) => r.wt));
  const studio = (store.get("projects", { label: project })?.studio_wt as string | null) ?? null;
  if (studio) ids.add(studio);
  const named = `${prefix()}${project}-`;
  const labels = new Set([...loopProjects(store.root), ...(store.db.query("SELECT label FROM projects").all() as { label: string }[]).map((r) => r.label)]);
  const longer = [...labels].filter((l) => l.startsWith(`${project}-`)).map((l) => `${prefix()}${l}-`);
  for (const w of ps) {
    const name = w.displayName ?? "";
    if (name.startsWith(named) && !longer.some((p) => name.startsWith(p))) ids.add(w.worktreeId);
  }
  return ids;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { for (let t = q.shift(); t !== undefined; t = q.shift()) await fn(t); }));
}

export function orcaObserver(adapter: OrcaAdapter = shellAdapter()): Observer {
  // ps and the inbox are host-wide: read once per tick, whichever project asks first.
  let shared: { tick: number; ps: Promise<PsWorktree[]>; unread: Promise<Unread[]>; accounts: Promise<LiveAccount[] | "failed" | null>;
    terminals: Promise<LiveTerminal[] | null>; dispatches: Map<string, Promise<RunDispatch[] | null>> } | null = null;
  // The process walk costs a /proc scan: read at most every DS_LOOP_LIVE_ACCOUNT_S (30 s); a tick in
  // between leaves the main-agent columns as they are, and a failed read too but for `walk`, which
  // reads unknown (account_at says how old the kept values are).
  let accountsAt = -Infinity;
  const host = (tick: number, now: number) => {
    if (shared?.tick !== tick) {
      const due = !!adapter.agentAccounts && now - accountsAt >= envInt("DS_LOOP_LIVE_ACCOUNT_S", 30);
      if (due) accountsAt = now;
      shared = { tick, ps: adapter.ps(), unread: adapter.unread(), accounts: due ? adapter.agentAccounts!().catch(() => "failed" as const) : Promise.resolve(null),
        terminals: adapter.terminals ? adapter.terminals().catch(() => null) : Promise.resolve(null), dispatches: new Map() };
      shared.ps.catch(() => {}); shared.unread.catch(() => {}); // awaited per project; no unhandled rejection
      shared.terminals.catch(() => {});
    }
    return shared;
  };

  return {
    name: "orca",
    async run(ctx: TickCtx) {
      const { store, project, now } = ctx;
      const h = host(ctx.tick, now);
      const [dir, ps, unread, procs, terminals] = await Promise.all([adapter.directory(project, store.root), h.ps, h.unread, h.accounts, h.terminals]);
      if (ctx.facts) {
        ctx.facts.unreadRuns = coordinatorMail(store, unread);
        if (terminals) ctx.facts.terminalHandles = new Set(terminals.map((t) => t.handle));
      }
      const live = store.db.query("SELECT COUNT(*) AS n FROM observed_workers WHERE project = ? AND gone_at IS NULL AND wt NOT LIKE 'local::%'").get(project) as { n: number };
      if (ps.length === 0 && live.n > 0) throw new Error("orca ps listed no worktrees (an Orca hiccup?); nothing marked gone");

      // U12: squads on Orca and the Studio only. A member of a squad off Orca, and any folder such a
      // squad's worktrees row owns, is the contract observer's (observers/contract.ts): never read,
      // never marked gone here.
      const off = offOrca(store, project);
      const offPath = (w: PsWorktree) => { const p = pathOf(w); return !!p && off.paths.has(p.replace(/\/+$/, "")); };
      const ids = knownWts(store, project, ps.filter((w) => !offPath(w)));
      for (const d of dir) if (d.wt) ids.add(d.wt);
      for (const wt of ids) if (off.wts.has(wt) || wt.startsWith("local::") || off.paths.has(String(wtPath(wt) ?? "").replace(/\/+$/, ""))) ids.delete(wt);
      const byWt = new Map(dir.map((d) => [d.wt, d]));
      const mine = ps.filter((w) => ids.has(w.worktreeId) && !w.isArchived);
      const mail = new Map<string, number>();
      for (const u of unread) mail.set(u.to, (mail.get(u.to) ?? 0) + 1);
      const tokensOf = store.db.query("SELECT SUM(output) AS n FROM observed_tokens WHERE worker = ?");
      const read = Array.isArray(procs) ? procs : null;
      const proj = store.get("projects", { label: project });
      const studioWt = (proj?.studio_wt as string | null) || "";
      const walks = read ? mainAgents(ps, read, new Map(studioWt ? [[studioWt, studioAgent(proj)]] : [])) : null;
      const subs = read ? subAgents(ps, read) : null;

      const tails: string[] = [];
      // A member with a board chat queued (fulfil/chat.ts) is re-read like the Studio below: once its
      // output moved past the last read and rested STUDIO_SETTLE_S, so memberReady() sees the prompt it settled on.
      const chatting = new Set((store.db.query("SELECT DISTINCT member FROM requests WHERE project = ? AND kind = 'chat' AND done_at IS NULL AND member IS NOT NULL").all(project) as Row[]).map((r) => String(r.member)));
      // U19: a member the board pressed keys at within KEYS_STALE_S, or one whose chat panel shows its screen
      // (observed_chat source 'screen'), is re-read once its output moved past the last read, at most every SCREEN_EVERY_S,
      // so the panel's screen view follows a menu as it changes.
      const watched = new Set((store.db.query(`SELECT member AS wt FROM requests WHERE project = ? AND kind = 'keys' AND member IS NOT NULL AND created_at >= ?
        UNION SELECT wt FROM observed_chat WHERE project = ? AND source = 'screen' AND gone_at IS NULL`).all(project, now - KEYS_STALE_S, project) as Row[]).map((r) => String(r.wt)));
      store.tx(() => {
        for (const w of mine) {
          const path = pathOf(w), d = byWt.get(w.worktreeId), state = workerState(w);
          const newest = (w.agents ?? []).reduce<PsAgent | null>((a, b) => ((b.stateStartedAt ?? 0) >= (a?.stateStartedAt ?? 0) ? b : a), null);
          store.upsert("observed_worktrees", { project, wt: w.worktreeId }, { path, branch: w.branch?.replace(/^refs\/heads\//, "") ?? null, parent: w.parentWorktreeId ?? null,
            doc: { displayName: w.displayName ?? null, unread: w.unread ?? null, agents: (w.agents ?? []).length }, observed_at: now, gone_at: null });
          // Unread mail: to any of its terminals, and a Lead's (kind run) to its Run.
          let n = (d?.terminals ?? []).reduce((s, t) => s + (mail.get(t) ?? 0), 0);
          if (d?.kind === "run" && d.run_id) n += mail.get(`run:${d.run_id}`) ?? 0;
          const tokens = path ? ((tokensOf.get(mangle(path)) as { n: number | null }).n ?? null) : null;
          const prev = store.get("observed_workers", { project, wt: w.worktreeId });
          const out = secs(w.lastOutputAt) ?? 0;
          if (!prev || prev.tail_at == null || prev.gone_at != null || prev.state !== state || prev.tokens !== tokens || prev.suspect
            || (chatting.has(w.worktreeId) && out >= Number(prev.tail_at) && now - out >= STUDIO_SETTLE_S)
            || (watched.has(w.worktreeId) && out > Number(prev.tail_at) && now - Number(prev.tail_at) >= SCREEN_EVERY_S)) tails.push(w.worktreeId);
          // The main agent (U149) and its sub-agents refresh on the walk's cadence and are kept when a
          // read fails; sub_agents is NULL once none are live, so a sub line never overwrites `account`.
          let ran: Row = procs === "failed" ? { walk: "unknown" } : {};
          if (walks) {
            const { walk, main } = walks.get(w.worktreeId) ?? { walk: "none" as const, main: null };
            const sub = JSON.stringify(subs!.get(w.worktreeId) ?? []);
            const live = main ? liveModel(store, project, w.worktreeId, main) : { model: null, effort: null };
            const m = store.db.query("SELECT placed_at, started FROM members WHERE project = ? AND wt = ? ORDER BY id DESC LIMIT 1").get(project, w.worktreeId) as Row | null;
            ran = { walk, walk_none_at: walkNoneAt(walk, prev?.walk_none_at, m ? lastStart(m) : 0, now), agent: main?.agent ?? null, account: main?.account ?? null, account_at: now, pid: main?.pid ?? null,
              started_at: main?.start ?? null, rss_kb: main?.rss ?? null, live_model: live.model, live_effort: live.effort,
              sub_agents: sub !== "[]" ? sub : null };
          }
          store.upsert("observed_workers", { project, wt: w.worktreeId }, { state, unread: n, last_output_at: secs(w.lastOutputAt),
            name: w.displayName ?? null, since: secs(newest?.stateStartedAt), said: redact(newest?.lastAssistantMessage ?? "").replace(/[\t\r\n]+/g, " ").slice(-200) || null,
            tokens, doc: { ...(d ? { squad: d.squad, role: d.role, suffix: d.suffix ?? "", run_id: d.run_id ?? null } : {}),
              agent_states: (w.agents ?? []).map((a) => a.state ?? null), terminals_seen_at: terminals ? now : null }, ...ran, observed_at: now, gone_at: null });
        }
        if (!adapter.terminals) for (const d of dir) {
          for (const handle of d.terminals ?? []) {
            store.upsert("observed_terminals", { project, handle }, { wt: d.wt, title: `${d.squad}/${d.name ?? d.role}`,
              doc: { squad: d.squad, role: d.role, suffix: d.suffix ?? "", newest: handle === d.terminals![0] }, observed_at: now, gone_at: null });
          }
        }
        if (terminals) {
          for (const t of terminals.filter((t) => ids.has(t.worktreeId) && t.connected === true && t.writable !== false && t.orphaned !== true)) {
            const d = byWt.get(t.worktreeId);
            store.upsert("observed_terminals", { project, handle: t.handle }, { wt: t.worktreeId, title: t.title ?? (d ? `${d.squad}/${d.name ?? d.role}` : null),
              doc: { agent: t.agentIdentity != null && !/^ds-loop\b|claude -p/.test(t.title ?? ""),
                ...(d ? { squad: d.squad, role: d.role, suffix: d.suffix ?? "", newest: t.handle === d.terminals?.[0] } : {}),
                // U261: the Studio's adoption and studioReady read the terminal itself, not its worktree.
                identity: t.agentIdentity ?? null, last_output_at: secs(t.lastOutputAt), unread: mail.get(t.handle) ?? 0 }, observed_at: now, gone_at: null });
          }
        }
        // Whatever this tick did not see is gone (a stamp, not a delete).
        const seen = JSON.stringify(mine.map((w) => w.worktreeId));
        const live = new Set(mine.map((w) => w.worktreeId));
        for (const wt of ids) if (!live.has(wt)) {
          const previous = store.get("observed_workers", { project, wt });
          store.upsert("observed_workers", { project, wt }, { gone_at: previous?.gone_at ?? now, observed_at: now,
            doc: { agent_states: [], terminals_seen_at: terminals ? now : null } });
        }
        // U12: the contract observer's rows (a `local::` worktree, a member off Orca) are left alone.
        const theirs = JSON.stringify([...off.wts]);
        for (const t of ["observed_worktrees", "observed_workers"]) {
          store.db.run(`UPDATE ${t} SET gone_at = ? WHERE project = ? AND gone_at IS NULL AND wt NOT IN (SELECT value FROM json_each(?))
            AND wt NOT LIKE 'local::%' AND wt NOT IN (SELECT value FROM json_each(?))`, [now, project, seen, theirs]);
        }
        if (terminals || !adapter.terminals) store.db.run(`UPDATE observed_terminals SET gone_at = ? WHERE project = ? AND gone_at IS NULL AND handle NOT IN (SELECT value FROM json_each(?))
            AND COALESCE(wt, '') NOT LIKE 'local::%' AND COALESCE(wt, '') NOT IN (SELECT value FROM json_each(?))`,
          [now, project, JSON.stringify(terminals ? terminals.filter((t) => t.connected === true && t.writable !== false && t.orphaned !== true).map((t) => t.handle) : dir.flatMap((d) => d.terminals ?? [])), theirs]);
        // A terminal row whose worktree is no longer the project's (an over-wide name match before) is
        // gone too, though its handle is still live under the project that owns it.
        store.db.run(`UPDATE observed_terminals SET gone_at = ? WHERE project = ? AND gone_at IS NULL AND wt IS NOT NULL AND wt NOT IN (SELECT value FROM json_each(?))
            AND wt NOT LIKE 'local::%' AND wt NOT IN (SELECT value FROM json_each(?))`,
          [now, project, JSON.stringify([...ids]), theirs]);
        // U261: only a listing that succeeded can adopt, keep or release the Studio's terminal.
        if (terminals) adoptStudio(store, project, now);
      });

      // A standing member's dispatch status and when it was seen to change (U64). worker-list has no
      // settle time, so a worktree's first dispatch seen already settled (the one before a restart)
      // gets none. A NEW dispatch seen settled after another was on record is this start's (a restart
      // starts before it stamps members.started), settled between two reads: dated now.
      // U100: every read also stamps dispatch_seen_at on the run's live standing members, even ones
      // the run names no dispatch for (checked and absent is fresh too).
      if (adapter.dispatches) {
        const live = new Set(mine.map((w) => w.worktreeId));
        for (const { run, wts } of dispatchRuns(store, project, now)) {
          // A failed read stamps nothing: the verdict falls back to unknown on the old stamp
          // instead of trusting stale data as fresh.
          let read = h.dispatches.get(run);
          if (!read) {
            read = adapter.dispatches(run).catch(() => null as RunDispatch[] | null);
            h.dispatches.set(run, read);
          }
          const ds = await read;
          if (ds === null) continue;
          store.tx(() => {
            for (const d of ds) {
              if (!live.has(d.wt) && !wts.includes(d.wt)) continue;
              const prev = store.get("observed_workers", { project, wt: d.wt });
              const at = prev?.dispatch_id !== d.id ? (SETTLED.has(d.status) && !prev?.dispatch_id ? null : now)
                : prev.dispatch === d.status ? prev.dispatch_at : now;
              store.upsert("observed_workers", { project, wt: d.wt }, { dispatch_id: d.id, dispatch: d.status, dispatch_at: at, dispatch_seen_at: now });
              // U2: every dispatch ever seen keeps its member, so the board can still name an
              // old ctx_* id after this worktree is re-dispatched. First sighting wins.
              store.db.run("INSERT OR IGNORE INTO dispatches (dispatch_id, project, wt, first_seen) VALUES (?, ?, ?, ?)", [d.id, project, d.wt, now]);
            }
            for (const wt of wts) {
              if (!ds.some((d) => d.wt === wt)) store.upsert("observed_workers", { project, wt }, { dispatch_id: null, dispatch: null, dispatch_at: null });
              store.upsert("observed_workers", { project, wt }, { dispatch_seen_at: now });
            }
          });
        }
      }

      // Presence from the walk's verdict and the dispatch status, both as last read (U149).
      store.tx(() => {
        for (const w of mine) {
          const r = store.get("observed_workers", { project, wt: w.worktreeId });
          const seenAt = Number(r?.dispatch_seen_at ?? 0), readEvery = knob(store, project, "DISPATCH_READ_MIN", 5) * 60 * 2;
          store.upsert("observed_workers", { project, wt: w.worktreeId }, { presence: presence(r?.walk, r?.dispatch, now - seenAt <= readEvery || seenAt >= Number(r?.account_at ?? 0)) });
        }
      });

      // The Studio's screen is read by its adopted handle only, never by worktree (R14: that would
      // pick whichever agent terminal there printed last); not adopted, it is not read. The handle is
      // read again once its output moved past the last read and then stayed quiet STUDIO_SETTLE_S, so
      // studioReady sees the prompt row as it rests, without a read per tick while the Studio prints.
      const reads: { wt: string; handle?: string }[] = tails.filter((wt) => wt !== studioWt).map((wt) => ({ wt }));
      const held = studioWt ? (store.db.query("SELECT m.handle, t.tail_at, t.doc FROM members m LEFT JOIN observed_terminals t ON t.project = m.project AND t.handle = m.handle AND t.gone_at IS NULL WHERE m.project = ? AND m.squad = ? AND m.wt = ? AND m.handle IS NOT NULL ORDER BY m.id DESC")
        .get(project, STUDIO_SQUAD, studioWt) as Row | null) : null;
      if (held) {
        let out = 0; try { out = Number(JSON.parse(String(held.doc ?? "{}")).last_output_at ?? 0); } catch { /* no doc */ }
        if (tails.includes(studioWt) || held.tail_at == null || (out >= Number(held.tail_at) && now - out >= STUDIO_SETTLE_S)) reads.push({ wt: studioWt, handle: String(held.handle) });
      }
      await pool(reads, TAILS, async ({ wt, handle }) => {
        const tail = await adapter.screenTail(handle ?? wt).catch(() => null);
        // An unread screen: suspect, so the next tick reads it again.
        if (tail === null) { store.upsert("observed_workers", { project, wt }, { suspect: 1 }); return; }
        const kept = redact(tail).trimEnd(); // KTD3: no raw secret shape reaches loop.db
        store.upsert("observed_workers", { project, wt }, { tail: kept, tail_at: now, suspect: 0 });
        if (handle) store.upsert("observed_terminals", { project, handle }, { tail: kept, tail_at: now });
      });
    },
  };
}

export default orcaObserver();
