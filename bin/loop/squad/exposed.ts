// exposed.ts — what squad members host for the operator to open (expose-hosted-services U1): the input
// rules, who the caller is, and the one write path for `ds expose` / `ds unexpose` and the loop's ending
// of an entry. Tables in migrations/0038-exposed.sql and 0048-exposed-stop.sql. An entry ends with gone_at +
// gone_why and keeps its row (only `ds remove-project` deletes it, into the project's archive). exposed-cleanup U2: an entry may carry a stop command (--stop), an
// audience (--self) and extra ports (--ports); an entry that ends with its squad or owner queues its stop,
// which the loop runs once (reconcilers/exposed.ts, fulfil/expose-stop.ts) before the worktree goes.
import { execFileSync } from "node:child_process";
import { now, type Row, type Store } from "../core/store.ts";
import { roleOf } from "../settings/skills.ts";
import { limitInt } from "../settings/limits.ts";
import { linkWt } from "../../link/split.ts";
import { LOCAL_HOST } from "../../backend/registry.ts";
import { onSide, wtHost } from "./backend.ts";
import { hostLink } from "./host-reach.ts";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
export const NOTE_MAX = 200;
export const GONE_WHYS = ["unexposed", "owner-gone", "worktree-removed", "squad-closed", "squad-done", "down"] as const;
export type GoneWhy = (typeof GONE_WHYS)[number];
// The end reasons that run an entry's stop command. `down` never does by itself (a late stop is queued
// when its squad or owner ends); a manual `unexposed` never does: the role stopped it itself.
export const STOP_TRIGGERS: readonly GoneWhy[] = ["squad-closed", "squad-done", "owner-gone", "worktree-removed"];
export const STOP_MAX = 500;
export const PORTS_MAX = 16;
export const STOP_PENDING = ["queued", "running"];
export const STOP_FAILED = ["failed", "timeout", "lost"];

// R3: why a name, URL or note is refused, or null when all three are fine. Only http(s) URLs with a
// host and no user or password part pass, so no secret lands on a board the tailnet can read.
export function badInput(name: string, url?: string, note?: string): string | null {
  if (!NAME_RE.test(name)) return `bad name '${name}': 1-40 of letters, digits, space, '.', '_' or '-', starting with a letter or digit`;
  if (url !== undefined) {
    if (!/^https?:\/\/\S+$/i.test(url)) return `bad url '${url}': only http:// or https:// URLs, without spaces`;
    if (!/^https?:\/\/[^/?#\\]/i.test(url)) return `bad url '${url}': no host`;
    let u: URL;
    try { u = new URL(url); } catch { return `bad url '${url}': not a URL`; }
    if (!u.hostname) return `bad url '${url}': no host`;
    if (u.username || u.password) return "bad url: no user or password part (the board is readable on the tailnet)";
  }
  if (note !== undefined && note.length > NOTE_MAX) return `note is ${note.length} characters; at most ${NOTE_MAX}`;
  return null;
}

// --stop: one line, at most STOP_MAX characters, no control characters ('' clears the stored one).
export function badStop(cmd: string): string | null {
  if (cmd.length > STOP_MAX) return `--stop is ${cmd.length} characters; at most ${STOP_MAX}`;
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f]/.test(cmd)) return "--stop must be one line without control characters";
  return null;
}

// --ports: a comma list of 1-PORTS_MAX port numbers (1-65535), as numbers ('' clears: []), or why not.
export function parsePorts(v: string): number[] | string {
  if (v === "") return [];
  const parts = v.split(",").map((x) => x.trim());
  if (parts.length > PORTS_MAX) return `--ports names ${parts.length} ports; at most ${PORTS_MAX}`;
  const out: number[] = [];
  for (const x of parts) {
    if (!/^\d{1,5}$/.test(x) || Number(x) < 1 || Number(x) > 65535) return `bad port '${x}' in --ports: a number 1-65535`;
    if (!out.includes(Number(x))) out.push(Number(x));
  }
  return out;
}

/** Whether this process runs a call a side host forwarded (link/channels/ds-call.ts sets DS_LINK_FORWARDED). */
const forwarded = (): boolean => process.env.DS_LINK_FORWARDED === "1";

// The git toplevel of a directory (the caller's worktree), or null outside a repository.
export function toplevel(cwd?: string): string | null {
  // A call a side host forwarded runs on main, in main's state root: the caller is the member row's worktree id,
  // and without one there is no caller (u7b): main's own folder is never the side member's.
  if (cwd === undefined && forwarded()) return linkWt();
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: cwd ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

// Who writes: a squad member (its worktree), or the squad itself from outside a role worktree.
export type Caller = { project: string; squad: string; owner_wt: string; role: string; suffix: string; lead: boolean; squadOwned: boolean };
export type Refusal = { error: string; code: number };

// KTD2: the owner comes from the worktree, not a flag. The open members row whose wt is `<repo>::<top>`
// (or the squad whose lead_wt it is) gives project, squad, role and suffix. Outside a role worktree
// --topic is needed and --project too, unless the worktree's name gives it (the Studio's); the entry
// is then the squad's (role studio in the Studio worktree, else operator).
export function caller(s: Store, top: string | null, opt: { project?: string; topic?: string }): Caller | Refusal {
  if (top) {
    const tail = `::${top}`;
    const m = (s.db.query("SELECT * FROM members WHERE wt LIKE ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC").all(`%${top}`) as Row[])
      .find((r) => r.wt === top || String(r.wt).endsWith(tail));
    const lead = m ? null : (s.db.query("SELECT project, topic, lead_wt FROM squads WHERE lead_wt LIKE ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC").all(`%${top}`) as Row[])
      .find((r) => r.lead_wt === top || String(r.lead_wt).endsWith(tail));
    const hit: Caller | null = m
      ? { project: String(m.project), squad: String(m.squad), owner_wt: String(m.wt), role: String(m.role), suffix: String(m.suffix ?? ""), lead: m.role === "lead", squadOwned: false }
      : lead ? { project: String(lead.project), squad: String(lead.topic), owner_wt: String(lead.lead_wt), role: "lead", suffix: "", lead: true, squadOwned: false } : null;
    if (hit) {
      if ((opt.project && opt.project !== hit.project) || (opt.topic && opt.topic !== hit.squad))
        return { error: `this worktree is the ${hit.role} of ${hit.project}/${hit.squad}; --project/--topic name another squad`, code: 2 };
      return hit;
    }
  }
  // u7b: a call a side host forwarded is the member row's own, never the squad's: an entry with no owner worktree is
  // main's (its stop would run on main), so a forwarded call whose worktree names no open member is refused.
  if (forwarded()) return { error: "a call from a side host needs its member's worktree on main; this member has none (suspended or gone)", code: 77 };
  const projects = (s.db.query("SELECT DISTINCT project FROM squads").all() as { project: string }[]).map((r) => r.project);
  const dir = top ? roleOf(top, projects) : null;
  const project = opt.project ?? dir?.project;
  if (!opt.topic || !project) return { error: "not in a role worktree: pass --project <label> --topic <slug>", code: 2 };
  const sq = s.get("squads", { project, topic: opt.topic });
  if (!sq || sq.status === "gone" || sq.status === "closed") return { error: `no open squad '${opt.topic}' in project '${project}'`, code: 1 };
  return { project, squad: opt.topic, owner_wt: "", role: dir?.role === "studio" ? "studio" : "operator", suffix: "", lead: false, squadOwned: true };
}

// Why a squad's entries end now, or null while it runs: closing (no row, closed, gone, or wished gone)
// or done. A done or closing squad takes no new entry (`ds expose` refuses it).
export function squadEnd(s: Store, project: string, squad: string): "squad-closed" | "squad-done" | null {
  const sq = s.db.query("SELECT status, want FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Row | null;
  if (!sq || sq.status === "closed" || sq.status === "gone" || sq.want === "gone") return "squad-closed";
  return sq.status === "done" ? "squad-done" : null;
}

// `ds expose` refuses a squad that is done or closing: the next tick would end the entry and run its stop.
export function closingRefusal(s: Store, c: Caller): Refusal | null {
  return squadEnd(s, c.project, c.squad) ? { error: `squad '${c.squad}' is done or closing; set it back to running to expose`, code: 1 } : null;
}

const ctx = (c: { project: unknown; squad: unknown; owner_wt: unknown }, payload: Row) =>
  ({ project: String(c.project), squad: String(c.squad), member: c.owner_wt ? String(c.owner_wt) : null, payload });

// R1: record (or update in place) the caller's open entry of this name. The key carries gone_at NULL
// so a re-expose after an unexpose adds a new row instead of touching the ended one (KTD1).
// U2: `stop` and `ports` keep the stored value when undefined and clear it when '' / []; `self` sets the
// audience on every call.
export function expose(s: Store, c: Caller, e: { name: string; url: string; note?: string | null; squad?: boolean; stop?: string; self?: boolean; ports?: number[] }): Row {
  const scope = c.squadOwned || e.squad ? "squad" : "member";
  const audience = e.self ? "self" : "operator";
  const key = { project: c.project, squad: c.squad, owner_wt: c.owner_wt, name: e.name, gone_at: null };
  const set: Row = { role: c.role, suffix: c.suffix, url: e.url, note: e.note ?? null, scope, audience, updated_at: now() };
  if (e.stop !== undefined) set.stop_cmd = e.stop || null;
  if (e.ports !== undefined) set.ports = e.ports.length ? JSON.stringify(e.ports) : null;
  s.fact("exposed", [{ table: "exposed", key, set }],
    ctx(c, { name: e.name, url: e.url, scope, role: c.role, suffix: c.suffix, audience, ...(e.stop !== undefined ? { stop: !!e.stop } : {}), ...(e.ports !== undefined ? { ports: e.ports } : {}) }));
  return plain(s.get("exposed", key)!);
}

// End an open entry (KTD1): gone_at, then gone_why, only while still open, with one `unexposed` event,
// in one transaction. False when it had already ended. The loop's reconciler (U2) ends entries here too.
// exposed-cleanup U2: a stop trigger queues the entry's stop command in the same transaction. The loop
// passes its tick time as `at`, the clock stopsPending later compares stop_at with.
export function endExposed(s: Store, row: Row, why: GoneWhy, by?: string, at = now()): boolean {
  return s.tx(() => {
    const id = Number(row.id);
    if (!s.setIf("exposed", id, "gone_at", at, null)) return false;
    s.setIf("exposed", id, "gone_why", why, null);
    const queued = STOP_TRIGGERS.includes(why) && queueStop(s, id, at);
    s.event("unexposed", ctx(row, { id, name: row.name, url: row.url, why, ...(by ? { by } : {}), ...(queued ? { stop: "queued" } : {}) }));
    return true;
  });
}

// Queue an ended entry's stop: only when it has a stop command and no stop was ever asked.
function queueStop(s: Store, id: number, at: number): boolean {
  return s.db.run("UPDATE exposed SET stop_state = 'queued', stop_at = ? WHERE id = ? AND stop_cmd IS NOT NULL AND stop_state IS NULL", [at, id]).changes > 0;
}

// The late stop of a row that ended `down` with a stop command and never had one queued (its web part
// died but the rest of the stack may still run): queued once its squad or owner ends. Returns the count.
export function queueLateStops(s: Store, rows: Row[], at = now()): number {
  let n = 0;
  for (const r of rows) if (r.gone_why === "down" && queueStop(s, Number(r.id), at)) n++;
  return n;
}

// Before a worktree is removed (close.ts remove, worktree.ts): end its member-scope entries with `why`
// (owner-gone, or worktree-removed for a suspended member), its squad-scope entries only when the squad
// is ending (squadEnd), and queue the late stop of its rows that ended down. Their stops run before the
// removal goes on (stopsPending).
export function endForRemoval(s: Store, project: string, wt: string, why: "owner-gone" | "worktree-removed", at = now()): void {
  if (!wt) return;
  const open = s.db.query("SELECT * FROM exposed WHERE project = ? AND owner_wt = ? AND gone_at IS NULL ORDER BY id").all(project, wt) as Row[];
  for (const r of open) {
    const end = squadEnd(s, project, String(r.squad));
    if (r.scope === "member") endExposed(s, r, end ?? why, "loop", at);
    else if (end) endExposed(s, r, end, "loop", at);
  }
  queueLateStops(s, s.db.query("SELECT * FROM exposed WHERE project = ? AND owner_wt = ? AND gone_why = 'down' AND stop_cmd IS NOT NULL AND stop_state IS NULL").all(project, wt) as Row[], at);
}

// End every open entry of a squad that is ending (archive): its stops queue with them.
export function endSquad(s: Store, project: string, squad: string, at = now()): void {
  const why = squadEnd(s, project, squad) ?? "squad-closed";
  for (const r of s.db.query("SELECT * FROM exposed WHERE project = ? AND squad = ? AND gone_at IS NULL ORDER BY id").all(project, squad) as Row[]) endExposed(s, r, why, "loop", at);
  queueLateStops(s, s.db.query("SELECT * FROM exposed WHERE project = ? AND squad = ? AND gone_why = 'down' AND stop_cmd IS NOT NULL AND stop_state IS NULL").all(project, squad) as Row[], at);
}

// The names of a worktree's (or a squad's) entries whose stop is queued or running, so a removal waits.
// A stop asked more than expose_stop_s + 180 s ago no longer holds anything up: one
// `expose_stop_wait_over` event per row, and the close goes on (a close never hangs on a stop).
export function stopsPending(s: Store, f: { project: string; wt?: string; squad?: string }, at: number, stopS: number): string[] {
  const by = f.wt !== undefined ? "owner_wt = ?" : "squad = ?";
  const rows = s.db.query(`SELECT * FROM exposed WHERE project = ? AND ${by} AND stop_state IN ('queued', 'running') ORDER BY id`)
    .all(f.project, String(f.wt ?? f.squad ?? "")) as Row[];
  const names: string[] = [];
  for (const r of rows) {
    if (Number(r.stop_at ?? 0) >= at - (stopS + 180)) { names.push(String(r.name)); continue; }
    const key = { project: f.project, subject: `expose-stop-wait:${r.id}`, kind: "expose-stop-wait" };
    if (s.get("episodes", key)) continue;
    s.upsert("episodes", key, { squad: String(r.squad), state: "over", source: "loop", observed_at: at });
    s.event("expose_stop_wait_over", { project: f.project, squad: String(r.squad), member: r.owner_wt ? String(r.owner_wt) : null,
      payload: { id: Number(r.id), name: r.name, stop_state: r.stop_state, stop_at: r.stop_at } });
  }
  return names;
}

// The removal of worktree `wt` (close.ts remove, worktree.ts) asks this first: its entries end
// (endForRemoval) and, while their stops are queued or running, a wait naming them; null to go on.
export function removalHold(s: Store, project: string, wt: string, why: "owner-gone" | "worktree-removed", at: number): string | null {
  endForRemoval(s, project, wt, why, at);
  const names = stopsPending(s, { project, wt }, at, limitInt(s, project, "expose_stop_s", 90));
  return names.length ? `stop commands: ${names.join(", ")}` : null;
}

// U2 grouping: the queued stops, one group per project, squad, owner worktree and command. A row whose
// stack is still exposed by another open entry with the same owner and command is skipped (named), and
// so is a row whose group already stopped (`done`) after the row was registered. The rest run, one
// action per group.
export type StopGroup = { project: string; squad: string; owner_wt: string; cmd: string; ids: number[] };
export function stopGroups(s: Store, project: string): { run: StopGroup[]; skip: { ids: number[]; why: string }[] } {
  const rows = s.db.query("SELECT * FROM exposed WHERE project = ? AND stop_state = 'queued' ORDER BY id").all(project) as Row[];
  const groups = new Map<string, StopGroup>(), skip: { ids: number[]; why: string }[] = [];
  for (const r of rows) {
    const g = { squad: String(r.squad), owner_wt: String(r.owner_wt ?? ""), cmd: String(r.stop_cmd ?? "") };
    if (!g.cmd) { skip.push({ ids: [Number(r.id)], why: "no stop command" }); continue; }
    const open = s.db.query("SELECT name FROM exposed WHERE project = ? AND squad = ? AND owner_wt = ? AND stop_cmd = ? AND gone_at IS NULL LIMIT 1")
      .get(project, g.squad, g.owner_wt, g.cmd) as Row | null;
    if (open) { skip.push({ ids: [Number(r.id)], why: `still exposed by '${open.name}'` }); continue; }
    const stopped = s.db.query(`SELECT id FROM exposed WHERE project = ? AND squad = ? AND owner_wt = ? AND stop_cmd = ? AND stop_state = 'done'
      AND stop_at > ? LIMIT 1`).get(project, g.squad, g.owner_wt, g.cmd, Number(r.created_at ?? 0)) as Row | null;
    if (stopped) { skip.push({ ids: [Number(r.id)], why: `already stopped with entry ${stopped.id}` }); continue; }
    const k = JSON.stringify([g.squad, g.owner_wt, g.cmd]);
    const have = groups.get(k);
    if (have) have.ids.push(Number(r.id)); else groups.set(k, { project, ...g, ids: [Number(r.id)] });
  }
  return { run: [...groups.values()], skip };
}

// side-loop-host u8b: an entry's stop runs on its owner's host. The owner's host is its newest members row's host
// (that row stays after the member ends), else the host a `<host>::<path>` worktree id names (squad/backend.ts wtHost).
export function ownerHost(s: Store, project: string, ownerWt: unknown): string {
  const wt = String(ownerWt ?? "");
  if (!wt) return LOCAL_HOST;
  const m = s.db.query("SELECT host FROM members WHERE project = ? AND wt = ? ORDER BY id DESC LIMIT 1").get(project, wt) as { host: unknown } | null;
  return onSide(m?.host) ? String(m!.host) : wtHost(s, wt);
}

/** Whether the queued stop of a side owner runs now (`run`), waits for its host's link (`hold`), or is settled
 *  `lost` (its host is gone, removed or fenced, or the owner was moved off it by a fence): never run on main. */
export type StopGate = { run: true } | { hold: string } | { lost: string };
export function sideStopGate(s: Store, project: string, ownerWt: unknown, host: string): StopGate {
  const h = s.get("hosts", { name: host });
  if (!h || h.status !== "accepted") return { lost: `host ${host} is no longer an accepted host` };
  const m = s.db.query("SELECT fenced_at FROM members WHERE project = ? AND wt = ? ORDER BY id DESC LIMIT 1").get(project, String(ownerWt ?? "")) as { fenced_at: unknown } | null;
  if (h.fenced_at != null || m?.fenced_at != null) return { lost: `host ${host} was fenced` };
  if (hostLink(s, host).state !== "online") return { hold: `host ${host} is unreachable` };
  return { run: true };
}

/** A side worktree main has recorded as removed (`worktrees (host, path)` with gone_at); main cannot look at the folder. */
export function sideTreeGone(s: Store, host: string, path: string): boolean {
  return s.get("worktrees", { host, path })?.gone_at != null;
}

// Settle rows (only those still in `from`) with a stop state and result, in one transaction.
export function settleStops(s: Store, ids: number[], from: string, state: string, result: Row, at?: number): number[] {
  const sql = `UPDATE exposed SET stop_state = ?, stop_result = ?${at === undefined ? "" : ", stop_at = ?"} WHERE id = ? AND stop_state = ?`;
  const head = [state, JSON.stringify(result), ...(at === undefined ? [] : [at])];
  return s.tx(() => ids.filter((id) => s.db.run(sql, [...head, id, from]).changes > 0));
}

// A row as JSON readers want it: no rowid, `ports` and `stop_result` parsed.
export function plain(r: Row): Row {
  const { _rowid: _, ...o } = r;
  for (const k of ["ports", "stop_result"]) if (typeof o[k] === "string") { try { o[k] = JSON.parse(String(o[k])); } catch { /* plain text */ } }
  return o;
}

export const ownerOf = (r: Row): string => `${r.role}${r.suffix ? `/${r.suffix}` : ""}`;

// R4: the open entries `ds unexpose` would end. A member ends its own; the Lead, the squad (outside a
// role worktree) or squadWide (--project/--topic given) match any owner in the squad, narrowed by
// `owner` (role or role/suffix) when given.
export function unexposeMatches(s: Store, c: Caller, name: string, opt: { squadWide?: boolean; owner?: string } = {}): Row[] {
  const wide = c.lead || c.squadOwned || !!opt.squadWide;
  const rows = s.db.query(`SELECT * FROM exposed WHERE project = ? AND squad = ? AND name = ? AND gone_at IS NULL ${wide ? "" : "AND owner_wt = ?"} ORDER BY id`)
    .all(...[c.project, c.squad, name, ...(wide ? [] : [c.owner_wt])]) as Row[];
  return opt.owner ? rows.filter((r) => r.role === opt.owner || ownerOf(r) === opt.owner) : rows;
}

// R5: entries with their latest probe, newest first; gone ones only with `all`.
export function listExposed(s: Store, f: { project?: string; topic?: string; all?: boolean } = {}): Row[] {
  const where: string[] = [], args: string[] = [];
  if (!f.all) where.push("e.gone_at IS NULL");
  if (f.project) { where.push("e.project = ?"); args.push(f.project); }
  if (f.topic) { where.push("e.squad = ?"); args.push(f.topic); }
  return (s.db.query(`SELECT e.*, o.status, o.reach, o.probed_at, o.down_since FROM exposed e LEFT JOIN observed_exposed o ON o.exposed_id = e.id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.created_at DESC, e.id DESC`).all(...args) as Row[]).map(plain);
}
