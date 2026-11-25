// replay.ts — the loop's side of a request a script wrote (U13b, KTD15, R35; U159: the wish
// replay is gone). send-peer.sh, send-role.sh, finish-unit.sh and reassert-roles.sh check their
// arguments as before, write one request (`ds nudge`) whose payload is the script's replay, and
// return (the old shell lib ds_loop_front):
//   { kind, key, argv: [<script>, <args>…], cwd, from }
// The fulfillers built here (fulfil/role.ts, message.ts, finish.ts) run argv again as a
// child with DS_LOOP_CHILD=1, in cwd and as the terminal `from` that asked, so the script does
// today's Orca mechanics as it did when it ran them. Member and squad wishes are plain wishes
// the decider acts on in Bun; no script writes an argv payload anymore.
//
// Exit 0 is done: the request's row is done, with the stdout tail as the result. Non-zero is
// retried (the actuator's DS_LOOP_SEND_TRIES), the stderr tail in the request's result as
// `retrying: …` and a `toast` event per failed try. Exit 2, and exit 3 without a WAIT, is the
// script refusing what it was given (the state moved since the ask, no sender, a peer not
// live) and is not retried; exit 3 "WAIT <epoch>" leaves the unfinished work idle for the next
// tick's pipeline check. notify-squads is not re-runnable (a second run sends again), so its
// first failure is final. A run a loop restart cut short is given up rather than run again (it
// may have run). Given up: the request fails and one Studio alert (a message that ends failed
// is told back to its sender instead, fulfil/message.ts).
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { alert, failRequest, finishRequest, requestActions, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { gone } from "./coordinator.ts";
import { spawn } from "../io/orca.ts";
import { identityEnv } from "../core/whoami.ts";
import type { Action } from "../core/plugins.ts";
import { now, type Row, type Store } from "../core/store.ts";
import { actionBlock } from "../pause/pause.ts";
import { SLOT_WAIT } from "../capacity/slot.ts";

// member, gen and wt: who filed it (whoami.ts filerIdentity), set back as DS_MEMBER, DS_GEN and DS_WT (U4).
export type Replay = { kind?: string; key?: string; argv: string[]; cwd?: string; from?: string; member?: string; gen?: string; wt?: string };

export function replayOf(raw: unknown): Replay | null {
  let p = raw;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return null; } }
  const r = p as Replay | null;
  return r && Array.isArray(r.argv) && r.argv.length > 0 && r.argv.every((a) => typeof a === "string") ? r : null;
}

// A wish row that still carries a pre-U159 script replay (no script writes one anymore).
// queuedWork below still reads them so a rollback gives them up; the decider treats them as
// plain wishes.
const REPLAY = "COALESCE(CASE WHEN json_valid(want_payload) THEN json_type(want_payload, '$.argv') = 'array' END, 0)";
// A wish's work not settled yet: no result, or a retry (queuedWork below).
const WISH_OPEN = "COALESCE(want_result, '') NOT LIKE 'done%' AND COALESCE(want_result, '') NOT LIKE 'failed%' AND COALESCE(want_result, '') NOT LIKE 'dropped%'";

const tail = (s: string, n = 400) => { const t = s.trim(); return t.length > n ? `…${t.slice(-n)}` : t; };
const script = (r: Replay) => r.argv[0].split("/").pop() ?? r.argv[0];
const ONCE = new Set(["notify-squads"]);
const NOT_AFTER_RESTART = new Set([...ONCE]);

// U208: a request written before a bin move names `<root>/bin/<name>`. When argv[0] is gone, the one
// file of that name in <root>/bin/*/ (the loop root argv[0] names) is run instead.
export function movedScript(argv0: string): { path: string } | { error: string } | null {
  if (existsSync(argv0)) return null;
  const name = basename(argv0), bin = dirname(argv0);
  let dirs: string[] = []; try { dirs = readdirSync(bin); } catch { /* no bin */ }
  const found = dirs.map((d) => join(bin, d, name)).filter((p) => existsSync(p));
  if (found.length === 1) return { path: found[0] };
  return { error: `script ${name} not found under bin/` };
}

function rerun(store: Store, r: Replay, from = r.from, env: Record<string, string | undefined> = {}) {
  return spawn(r.argv, { DS_STATE_ROOT: store.root, ORCA_TERMINAL_HANDLE: from, ...identityEnv(r), ...env }, 600_000, r.cwd && existsSync(r.cwd) ? r.cwd : undefined);
}

// Request replays run as the terminal that asked (ORCA_TERMINAL_HANDLE says who sent it).

// A send-peer goes out --from its asker's squad sender pane (U64). A standing Lead or Thinker never
// calls worker_done, so its own dispatch stays active, and Orca pins an active dispatch's --run to its
// own Run (dispatch_run_mismatch): from its own terminal it can't reach a peer's Run. The script still
// runs as the asker (ORCA_TERMINAL_HANDLE says who sent it); only --from (DS_ORCA_FROM) moves. An
// asker in no squad, or a squad with no sender yet, sends as itself, as before.
async function peerFrom(x: Exec, r: Replay): Promise<Record<string, string>> {
  if (r.kind !== "send-peer" || !r.from) return {};
  const m = x.store.db.query(`SELECT m.project, m.squad FROM observed_terminals t JOIN members m ON m.project = t.project AND m.wt = t.wt
    WHERE t.handle = ? AND COALESCE(m.status, '') != 'gone' ORDER BY m.id DESC`).get(r.from) as Row | null;
  if (!m) return {};
  try { return { DS_ORCA_FROM: await x.act.senderOf(x.store, String(m.project), String(m.squad), x.now) }; } catch { return {}; }
}

// The positional words of a send-peer/send-role/notify-squads replay (squad, role, subject, body), as
// the scripts parse them: --project and --from take a value, --ruling none.
export function wordsOf(r: Replay): string[] {
  const out: string[] = [], a = r.argv.slice(1);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--project" || a[i] === "--from") i++;
    else if (a[i] === "--ruling") continue;
    else if (a[i] === "--") { out.push(...a.slice(i + 1)); break; } else out.push(a[i]);
  }
  return out;
}

// The project a request belongs to: its own, else the sender's (U75): its cwd's worktree name, its
// terminal, or the project of the squad's topic.
export function projectOf(x: { store: Exec["store"] }, a: Action): string {
  if (a.project) return a.project;
  const { store } = x, r = replayOf(a.payload);
  const labels = (store.db.query("SELECT label FROM projects").all() as Row[]).map((p) => String(p.label)).sort((p, q) => q.length - p.length);
  const wt = r?.cwd ? basename(r.cwd) : "";
  const named = labels.find((l) => wt.startsWith(`${process.env.DS_PREFIX ?? "ds-"}${l}-`));
  if (named) return named;
  const t = r?.from ? store.db.query("SELECT project FROM observed_terminals WHERE handle = ? ORDER BY (gone_at IS NULL) DESC, observed_at DESC").get(r.from) as Row | null : null;
  if (t?.project) return String(t.project);
  return String((store.db.query("SELECT project FROM squads WHERE topic = ? ORDER BY id DESC").get(a.squad ?? "") as Row | null)?.project ?? "");
}

// A send-peer Orca refused because its sender has an active dispatch (the pin to its own Run) is sent
// once more from the target squad's pane, the ds-loop pane that holds that Run (U75). The asker stays
// the terminal that sent it (ORCA_TERMINAL_HANDLE), so the from line still names it. null: the target
// squad has no bound pane.
const CROSS_RUN = /cross-run delivery needs|dispatch_run_mismatch/;
function targetPane(x: Exec, a: Action, r: Replay): string | null {
  const squad = wordsOf(r)[0], project = projectOf(x, a);
  if (!squad || !project) return null;
  const c = x.store.get("coordinators", { project, squad });
  return c?.handle && c.run_id && !gone(x.store, project, String(c.handle)) ? String(c.handle) : null;
}

// A run of a NOT_AFTER_RESTART replay marks its episode before the child starts. The actuator's boot
// puts an action that was running back to pending, so a marked one found again was cut short by a loop
// restart and may have run: it is given up, not run a second time. Settling a wait or a retry writes
// the action anew, unmarked, so only a run that never settled counts.
function started(x: Exec, a: Action, mark = true): boolean {
  const q = [a.project, a.subject, `action:${a.kind}`, a.episode];
  const where = "project = ? AND subject = ? AND kind = ? AND episode_key = ?";
  const row = x.store.db.query(`SELECT action FROM episodes WHERE ${where}`).get(...q) as Row | null;
  const cur = row?.action ? JSON.parse(String(row.action)) : { action: a, tries: 0 };
  if (cur.started) return true;
  if (mark) x.store.db.run(`UPDATE episodes SET action = ? WHERE ${where}`, [JSON.stringify({ ...cur, started: true }), ...q]);
  return false;
}

async function background(x: Exec, a: Action, r0: Replay, ok: (out: string) => void, fail: (why: string) => void): Promise<Result> {
  let r = r0;
  const block = actionBlock(x.store, a);
  if (block) return block === "paused" ? { wait: block } : { dropped: block };
  const once = NOT_AFTER_RESTART.has(r.kind ?? "");
  if (once && started(x, a, false)) return { failed: `${script(r)} was running when the loop restarted and may have run: check, then ask again` };
  if (once) started(x, a);
  return {
    background: (async (): Promise<Result> => {
      const moved = movedScript(r.argv[0]);
      if (moved && "error" in moved) { const why = moved.error; fail(why); return { failed: why }; }
      if (moved) {
        const id = (a.payload as { request?: number } | null)?.request ?? null;
        const seen = x.store.db.query("SELECT 1 FROM events WHERE kind = 'replay_path_moved' AND payload LIKE ?").get(`%"request":${id},%`);
        if (!seen) x.store.event("replay_path_moved", { project: a.project || null, squad: a.squad ?? null, payload: { request: id, old: r.argv[0], new: moved.path } });
        r = { ...r, argv: [moved.path, ...r.argv.slice(1)] };
      }
      const peer = await peerFrom(x, r);
      if (actionBlock(x.store, a)) return { wait: "activity changed before replay" };
      let o = await rerun(x.store, r, r.from, { ...x.act.childActivity(x.store, a), ...peer });
      if (o.code !== 0 && r.kind === "send-peer" && CROSS_RUN.test(o.err + o.out)) {
        const pane = targetPane(x, a, r);
        if (pane && !actionBlock(x.store, a)) o = await rerun(x.store, r, r.from, { ...x.act.childActivity(x.store, a), DS_ORCA_FROM: pane });
      }
      if (o.code === 0) {
        // The script ran: a bookkeeping error after it is not a reason to run it again.
        try { ok(tail(o.out)); } catch (e) { x.store.event("plugin_error", { project: a.project || null, payload: { kind: a.kind, error: (e as Error)?.message ?? String(e) } }); }
        return { done: true, result: tail(o.out) };
      }
      const until = o.code === 3 ? Number(/^WAIT (\d+)/m.exec(o.out)?.[1]) : NaN;
      if (o.code !== 0 && actionBlock(x.store, a)) return { wait: "activity changed during replay" };
      if (until || (o.code === 3 && SLOT_WAIT.test(o.out))) return { idle: true };
      const why = `${script(r)} exit ${o.code}: ${tail(o.err || o.out)}`;
      fail(why);
      // The cross-run pin is no transient failure (and the pane retry above has already been tried).
      const pinned = r.kind === "send-peer" && CROSS_RUN.test(o.err + o.out);
      return o.code === 2 || o.code === 3 || pinned || ONCE.has(r.kind ?? "") ? { failed: why } : { retry: why };
    })(),
  };
}

// A script's wish or request the loop has not finished, made before `before` (epoch seconds). A request
// imported from a file is not in hand: it stays open until its file goes, whoever drives the host.
export type Queued = { table: "squads" | "members" | "requests"; id: number; project: string; squad: string | null; what: string; subject: string; kind: string; episode: string };
const WISH_KIND = { squads: "squad", members: "role" } as const;

export function queuedWork(store: Store, before = Number.MAX_SAFE_INTEGER): Queued[] {
  const open = WISH_OPEN;
  const wishes = (t: Table) => (store.db.query(`SELECT id, project, ${t === "squads" ? "topic" : "squad"} AS squad, want_at, want_payload FROM ${t}
    WHERE want IS NOT NULL AND ${REPLAY} AND ${open} AND want_at < ? ORDER BY id`).all(before) as Row[]).map((r): Queued => {
    const replay = replayOf(r.want_payload);
    return { table: t, id: Number(r.id), project: String(r.project), squad: r.squad as string | null, what: replay?.kind ?? "wish",
      subject: `${WISH_KIND[t]}:${replay?.key ?? r.id}`, kind: WISH_KIND[t], episode: `want:${r.want_at}` };
  });
  const requests = (store.db.query("SELECT id, project, squad, kind FROM requests WHERE done_at IS NULL AND COALESCE(key, '') NOT LIKE 'file:%' AND created_at < ? ORDER BY id").all(before) as Row[]).map((r): Queued => ({
    table: "requests", id: Number(r.id), project: String(r.project ?? ""), squad: r.squad as string | null, what: String(r.kind), subject: `req:${r.id}`, kind: String(r.kind), episode: `req:${r.id}` }));
  return [...wishes("squads"), ...wishes("members"), ...requests];
}

// What the loop still held when it left for a rollback. The asker got its answer and the sweep never
// ran it, so the asker has moved on: at the re-switch, possibly weeks later and in a squad the sweep has
// changed, it is given up on the record, not run. A wish made since then has a newer want_at and is kept.
export function giveUpQueued(store: Store, before: number): Queued[] {
  const queued = queuedWork(store, before), at = now(), why = "queued before a rollback to the sweep: ask again if it is still wanted";
  for (const q of queued) {
    if (q.table === "requests") store.db.run("UPDATE requests SET done_at = ?, result = ? WHERE id = ?", [at, JSON.stringify({ ok: false, error: why }), q.id]);
    else store.db.run(`UPDATE ${q.table} SET want_result = ?, updated_at = ? WHERE id = ?`, [`failed: ${why}`, at, q.id]);
    store.db.run("UPDATE episodes SET state = 'failed', ended_at = ?, next_at = NULL, action = NULL, observed_at = ? WHERE project = ? AND subject = ? AND kind = ? AND episode_key = ? AND ended_at IS NULL",
      [at, at, q.project, q.subject, `action:${q.kind}`, q.episode]);
  }
  if (queued.length) store.event("queued_given_up", { payload: { why, queued } });
  return queued;
}

type Table = "squads" | "members";

// The row that holds the wish now. An import can hand a rekeyed member's wish to another row
// (pruneSquad); a gone squad's row may be gone. Kept for `ds want --wait` (bin/commands/want.ts).
export function follow(store: Store, t: Table, id: number, at: unknown, payload: unknown): Row | null {
  const r = store.get(t, { id });
  if (r && r.want_at === at) return r;
  return store.db.query(`SELECT * FROM ${t} WHERE want_at IS ? AND want_payload IS ? ORDER BY id DESC`).get(at as number, payload as string) as Row | null;
}

const toast = (store: Store, a: Action, text: string) =>
  store.event("toast", { project: a.project || null, squad: a.squad ?? null, member: a.member ?? null, payload: { level: "error", subject: a.subject, kind: a.kind, text } });

// One toast per episode (U93): a request that fails again with the same reason in the
// same episode writes no new toast; its request row and the give-up card still record it.
// `same` is whether the row already carries this exact failure from this episode.
const toastOnce = (store: Store, a: Action, text: string, same: boolean): void => { if (!same) toast(store, a, text); };

// U11: a finish-unit request for a unit that is already done (or whose Builder worktree is gone and whose PR
// merged) has nothing left to finish: it ends done, nothing runs, no try is spent and no refusal is written.
// The unit comes from the key `finish-unit:<project>/<squad>/<slug>@<sha>`.
function alreadyFinished(x: Exec, a: Action, r: Replay): boolean {
  const m = /^finish-unit:([^/]+)\/([^/]+)\/([^@]+)@/.exec(String((a.payload as { key?: string } | null)?.key ?? r.key ?? ""));
  if (!m) return false;
  const u = x.store.db.query("SELECT status, done_at, pr FROM units WHERE project = ? AND squad = ? AND slug = ?").get(m[1], m[2], m[3]) as Row | null;
  if (!u) return false;
  if (u.status === "done" || u.done_at != null) return true;
  if (r.cwd && existsSync(r.cwd)) return false;
  const n = Number(String(u.pr ?? "").match(/(\d+)\s*$/)?.[1]);
  if (!n) return false;
  const pr = x.store.db.query("SELECT state FROM observed_prs WHERE project = ? AND pr = ? ORDER BY observed_at DESC").get(m[1], n) as Row | null;
  return pr?.state === "MERGED";
}

// The fulfiller of request kinds whose payload is a replay (finish, send, notify, reassert).
export function requests(name: string, kinds: string[]): Fulfiller & { scope: "host" } {
  return {
    name,
    scope: "host",
    kinds,
    run: (ctx) => requestActions(ctx, kinds),
    exec(a, x) {
      const r = replayOf(a.payload);
      if (!r) return { failed: "the request carries no replay" };
      const id = (a.payload as { request: number }).request;
      if (r.kind === "finish-unit" && alreadyFinished(x, a, r)) { finishRequest(x.store, a, { ok: true, skipped: "already finished" }, x.now); return { done: true, result: "skipped: already finished" }; }
      return background(x, a, r, (out) => finishRequest(x.store, a, { ok: true, out }, x.now), (why) => {
        const cur = x.store.db.query("SELECT result FROM requests WHERE id = ?").get(id) as Row | null;
        let same = false;
        try { const p = cur?.result ? JSON.parse(String(cur.result)) as { error?: unknown; retrying?: unknown } : null; same = !!p?.retrying && p?.error === why; } catch { same = false; }
        x.store.db.run("UPDATE requests SET result = ? WHERE id = ? AND done_at IS NULL", [JSON.stringify({ ok: false, error: why, retrying: true }), id]);
        toastOnce(x.store, a, why, same);
      });
    },
    async giveUp(a, x, why) {
      failRequest(a, x, why);
      // send-peer/send-role without --project: the squad's own project hears it.
      const project = a.project || String((x.store.db.query("SELECT project FROM squads WHERE topic = ? ORDER BY id DESC").get(a.squad ?? "") as Row | null)?.project ?? "");
      await alert(x.store, project, a.subject, a.episode, `The loop could not run ${a.kind}: ${why}`, { title: "Lifecycle failed" });
    },
  };
}
