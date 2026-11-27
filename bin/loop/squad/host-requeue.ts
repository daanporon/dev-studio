// host-requeue.ts — main requeues the members of a host it lost (side-loop-host U15, issue #127, KTD11).
//
// A side host whose link has been down for the grace plus MAIN_MARGIN_S (reconcilers/side-fence.ts), or that said on
// reconnect that it fenced itself (link/server.ts), is fenced on main: `hosts.fenced_at` is set and placement refuses
// it (capacity/place.ts). Each member still live there is ended (wished gone, settled `gone`, `members.fenced_at`) and
// its slot is wished running again as a new row with no host, so placement puts it on another seat. A Builder's unit
// goes to the next attempt: its next Builder starts on `<worktree name>-r<attempt>` from the old branch as pushed to
// origin (startSpec), and its journal gets a `[keep]` line naming the lost host, the old branch and its last pushed
// commit. When the host comes back, the terminals of the moved members are closed there before it is used again.
//
//   liveOn(store, host)            the members main still counts on `host`
//   lookups(store, members)        each Builder's old branch and its last pushed commit (ls-remote origin), read
//                                  before anything is written; throws when origin cannot be read
//   requeue(store, host, m, l, at) end one member, move its unit to the next attempt, wish its slot again
//   startSpec(store, m)            the worktree name, branch and base a start uses (attempt 1: the plain name, HEAD)
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Row, Store } from "../core/store.ts";
import { wtName, type Member } from "../drivers/types.ts";
import { git } from "../io/worktrees.ts";
import { journalPath } from "../pause/pause.ts";

export type Lookup = { branch: string | null; sha: string | null };
export type Requeued = { id: number; role: string; suffix: string; unit: string | null; attempt: number | null; branch: string | null; sha: string | null };

const GONE = "('gone', 'closed')";

export function liveOn(store: Store, host: string): Row[] {
  return store.db.query(`SELECT * FROM members WHERE host = ? AND COALESCE(status, '') NOT IN ${GONE} ORDER BY id`).all(host) as Row[];
}

// The unit a builder row works: its wish's `unit`, else its suffix.
export function unitSlug(m: Row): string {
  try {
    const p = JSON.parse(String(m.want_payload ?? "{}"));
    if (p && typeof p.unit === "string" && p.unit) return p.unit;
  } catch { /* a torn payload names no unit */ }
  return String(m.suffix ?? "");
}
const unitOf = (store: Store, m: Row): Row | null =>
  m.role === "builder" ? store.get("units", { project: String(m.project), squad: String(m.squad), slug: unitSlug(m) }) : null;

// `<host>::<path>` → path (a member's wt on a side host).
export const pathOf = (m: Row): string => String(m.wt_path ?? "") || String(m.wt ?? "").replace(/^[^:]+::/, "");

function repoOf(store: Store, project: string, squad: string): string {
  const sq = store.get("squads", { project, topic: squad });
  return String(sq?.repo ?? store.get("projects", { label: project })?.home_repo ?? "").replace(/^path:/, "");
}

/** The old branch of each Builder (its worktree row) and that branch's commit on origin (null: never pushed). */
export async function lookups(store: Store, host: string, members: Row[]): Promise<Map<number, Lookup>> {
  const out = new Map<number, Lookup>();
  for (const m of members) {
    if (m.role !== "builder" || !m.wt) continue;
    const wt = store.get("worktrees", { host, path: pathOf(m) });
    const branch = wt?.branch ? String(wt.branch) : null;
    if (!branch) { out.set(Number(m.id), { branch: null, sha: null }); continue; }
    const repo = repoOf(store, String(m.project), String(m.squad));
    if (!repo) throw new Error(`host fence: squad ${m.squad} has no repo to read ${branch} from`);
    const g = await git(["-C", repo, "ls-remote", "origin", `refs/heads/${branch}`], 30_000);
    if (g.code !== 0) throw new Error(`host fence: ls-remote of ${branch} failed: ${(g.err || g.out).trim().slice(0, 300)}`);
    out.set(Number(m.id), { branch, sha: g.out.trim().split(/\s+/)[0] || null });
  }
  return out;
}

const iso = (at: number) => new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function keepLine(store: Store, m: Row, slug: string, host: string, attempt: number, l: Lookup, base: Lookup | null, at: number): void {
  // The unit's journal (`journal.sh <project> <squad> builder-<slug>`), which a fresh Builder on it reads first.
  const file = journalPath(store, { project: String(m.project), squad: String(m.squad), role: "builder", suffix: slug });
  mkdirSync(dirname(file), { recursive: true });
  const next = `${wtName({ ...(m as unknown as Member), suffix: String(m.suffix ?? "") })}-r${attempt}`;
  const lost = `host ${host} was lost; this unit moved to attempt ${attempt} on branch ${next}`;
  const what = l.branch && l.sha ? `${lost}, started from the old branch ${l.branch} at its last pushed commit ${l.sha}`
    : base?.branch && base.sha ? `${lost}, started from ${base.branch} at ${base.sha}: the old branch ${l.branch ?? "(none)"} was never pushed`
    : `${lost}, started from HEAD: the old branch ${l.branch ?? "(none)"} was never pushed`;
  appendFileSync(file, `- ${iso(at)} [keep] ${what} — work after that push stayed on ${host}; this journal may be behind it\n`);
}

/** End member `m` of lost host `host`, move its unit on, and wish its slot running again (when it was wished running). */
export function requeue(store: Store, host: string, m: Row, l: Lookup | undefined, at: number): Requeued {
  const project = String(m.project), squad = String(m.squad), role = String(m.role), suffix = String(m.suffix ?? "");
  const u = unitOf(store, m), slug = u ? String(u.slug) : null;
  let attempt: number | null = null, base: Lookup | null = null;
  const again = m.want === "running";
  let old: Record<string, unknown> = {};
  try { old = JSON.parse(String(m.want_payload ?? "{}")) ?? {}; } catch { /* a torn payload: start plain */ }
  store.tx(() => {
    store.want("member", String(m.id), "gone", { by: "loop", why: `host ${host} fenced` });
    store.fact("member_host_fenced", [{ table: "members", key: { id: m.id }, set: { status: "gone", fenced_at: at, updated_at: at } }],
      { project, squad, member: `${role}/${suffix}`, ...(slug ? { unit: slug } : {}), payload: { id: Number(m.id), host, role, suffix, unit: slug } });
    if (u && again) {
      attempt = Number(u.attempt ?? 1) + 1;
      // Nothing pushed this attempt: keep the base the attempt started from, so pushed work is never dropped.
      const pushed = l?.branch && l.sha ? l : u.retry_from && u.retry_sha ? { branch: String(u.retry_from), sha: String(u.retry_sha) } : null;
      base = pushed;
      store.db.run("UPDATE units SET attempt = ?, retry_from = ?, retry_sha = ?, retry_host = ?, retry_pr = COALESCE(pr, retry_pr) WHERE id = ?",
        [attempt, pushed?.branch ?? null, pushed?.sha ?? null, host, u.id as number]);
    }
    if (!again) return;
    const payload = { why: "start", request: true, ...pick(old, ["prompt", "spec", "agent", "model", "effort", "account", "ctx"]), ...(slug ? { unit: slug } : {}) };
    const wanted = store.want("member", `${project}/${squad}/${role}/${suffix}`, "running", { payload, by: "loop", why: `host ${host} fenced` }).row;
    store.db.run("DELETE FROM picks WHERE member = ?", [wanted.id as number]);
    store.fact("member_requested", [{ table: "members", key: { id: wanted.id }, set: {
      phase: m.phase ?? null, ...(m.tier ? { tier: m.tier } : {}), status: "wanted", updated_at: at,
    } }], { project, squad, member: `${role}/${suffix}`, payload: { id: Number(wanted.id), role, suffix, ...(slug ? { unit: slug } : {}), by: "loop" } });
  });
  if (u && again && attempt) keepLine(store, m, slug!, host, attempt, l ?? { branch: null, sha: null }, base, at);
  return { id: Number(m.id), role, suffix, unit: slug, attempt, branch: l?.branch ?? null, sha: l?.sha ?? null };
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));
}

export type StartSpec = { name: string; branch: string; base: string; fetch?: string };

/** The worktree a member's start makes: a Builder whose unit is past attempt 1 gets `<name>-r<attempt>`, from the
 *  old branch as on origin (fetched first) when it was pushed, else from HEAD. Everyone else: the plain name, HEAD. */
export function startSpec(store: Store, m: Member): StartSpec {
  const name = wtName(m), plain = { name, branch: name, base: "HEAD" };
  if (m.role !== "builder") return plain;
  const row = store.get("members", { id: m.id });
  const u = row ? unitOf(store, row) : null;
  const n = Number(u?.attempt ?? 1);
  if (!u || !(n > 1)) return plain;
  const next = `${name}-r${n}`, from = u.retry_from ? String(u.retry_from) : null;
  return from ? { name: next, branch: next, base: `refs/remotes/origin/${from}`, fetch: from } : { name: next, branch: next, base: "HEAD" };
}
