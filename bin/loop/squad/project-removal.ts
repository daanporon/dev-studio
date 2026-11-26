// project-removal.ts — can a project be removed, and what would a removal touch (remove-project U2).
// `removalBlockers` is the one check the command, the board and the loop share. It reads rows and looks at
// the disk, and writes nothing. It does not use studio.ts openSquads, which leaves out `done` and `failed`
// squads that can still have live members.
//
// Blocks: a squad not `closed` or `gone`, unless it never started (no status, doc, Lead worktree, state
// file, live member or open wish); a worktree folder the project's rows name, the Studio's excepted, still
// on disk; a member outside the Studio with a live worker; a paused project. A member row with none of
// these is history, whatever its status or wish says: it goes with the project.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Row, Store } from "../core/store.ts";
import { wtPath } from "../observers/orca.ts";
import { intents } from "../pause/pause.ts";
import { discoverProjects } from "../settings/projects.ts";

const STUDIO = "_studio";

export type Blocker = {
  kind: "invalid-label" | "unknown-project" | "open-squad" | "worktree" | "live-member" | "paused";
  text: string; // one plain sentence naming the item
  clear: string | null; // the command or action that clears it
  squad?: string;
  path?: string;
};

// The name rule `ds up --label` uses, without the dot names: a label goes into paths under the state root.
export function validLabel(label: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(label) && !label.startsWith(".") && !label.startsWith("-");
}

// A label the loop knows: a project row, a project folder, or rows left behind after the folder went.
function known(store: Store, label: string): boolean {
  return !!store.get("projects", { label }) || discoverProjects(store.root).includes(label)
    || !!store.db.query("SELECT 1 FROM squads WHERE project = ?1 UNION ALL SELECT 1 FROM members WHERE project = ?1 LIMIT 1").get(label);
}

/** Why `label` names no project (an invalid name, or an unknown one), or null. */
export function labelProblem(store: Store, label: string): Blocker | null {
  if (!validLabel(label)) return invalidLabel(label);
  return known(store, label) ? null : { kind: "unknown-project", text: `there is no project '${label}'`, clear: null };
}
export const invalidLabel = (label: string): Blocker =>
  ({ kind: "invalid-label", text: `'${label}' is not a project name (letters, digits, '.', '_' and '-', not starting with '.' or '-')`, clear: null });

// The folder behind a worktree id (`<uuid>::<path>`, `local::<path>`) or a bare path.
function folder(x: unknown): string | null {
  if (typeof x !== "string" || !x) return null;
  const p = wtPath(x) ?? x;
  return p.startsWith("/") ? resolve(p) : null;
}

const rows = (store: Store, sql: string, label: string) => store.db.query(sql).all(label) as Row[];
const json = (s: unknown): unknown => { try { return JSON.parse(String(s ?? "null")); } catch { return null; } };

function leftovers(squad: Row): { wt?: string; path?: string }[] {
  const l = (json(squad.doc) as { leftovers?: unknown } | null)?.leftovers;
  return Array.isArray(l) ? l.filter((r) => r && typeof r === "object") : [];
}

type Named = { squads: Set<string>; leftoverOf: string | null; recorded: boolean };

// Every worktree folder the project's rows name that is on disk, the Studio's left out: the sources of
// cleanup.ts keepSet (every member row, not only the live ones) plus the live worktrees rows.
function onDisk(store: Store, label: string): Map<string, Named> {
  const studio = new Set<string>();
  const addStudio = (...xs: unknown[]) => { for (const x of xs) { const p = folder(x); if (p) studio.add(p); } };
  const project = store.get("projects", { label });
  addStudio(project?.studio_wt, project?.studio_path);
  // Never a blocker: the project's own repo clone, which stays.
  addStudio(String(project?.home_repo ?? "").replace(/^path:/, ""));
  for (const r of rows(store, `SELECT wt, wt_path FROM members WHERE project = ? AND (squad = '${STUDIO}' OR role = 'studio')`, label)) addStudio(r.wt, r.wt_path);
  for (const r of rows(store, `SELECT path FROM worktrees WHERE project = ? AND (squad = '${STUDIO}' OR role = 'studio')`, label)) addStudio(r.path);

  const found = new Map<string, Named>();
  const add = (squad: unknown, ...xs: unknown[]): Named | null => {
    let last: Named | null = null;
    for (const x of xs) {
      const p = folder(x);
      if (!p || studio.has(p) || !existsSync(p)) continue;
      last = found.get(p) ?? { squads: new Set<string>(), leftoverOf: null, recorded: false };
      if (typeof squad === "string" && squad && squad !== STUDIO) last.squads.add(squad);
      found.set(p, last);
    }
    return last;
  };
  for (const s of rows(store, "SELECT * FROM squads WHERE project = ? ORDER BY topic", label)) {
    for (const l of leftovers(s)) for (const x of [l.wt, l.path]) { const n = add(s.topic, x); if (n) n.leftoverOf ??= String(s.topic); }
    add(s.topic, s.lead_wt, s.lead_path);
  }
  for (const r of rows(store, "SELECT squad, wt, wt_path FROM members WHERE project = ? ORDER BY id", label)) add(r.squad, r.wt, r.wt_path);
  for (const r of rows(store, "SELECT squad, path, repo FROM worktrees WHERE project = ? AND gone_at IS NULL AND host = 'local'", label)) {
    const n = add(r.squad, r.path);
    // A provider refuses to remove a row with no repo (the sync observer's Orca rows have none).
    if (n && r.repo) n.recorded = true;
  }
  for (const r of rows(store, "SELECT squad, wt, wt_path FROM coordinators WHERE project = ?", label)) add(r.squad, r.wt, r.wt_path);
  for (const r of rows(store, "SELECT squad, builder_wt, builder_path FROM units WHERE project = ?", label)) add(r.squad, r.builder_wt, r.builder_path);
  // Only a worker not gone: a gone row keeps its last presence.
  for (const r of rows(store, "SELECT wt, wt_path FROM observed_workers WHERE project = ? AND gone_at IS NULL", label)) add(null, r.wt, r.wt_path);
  // A pending action's worktree ids (never its bare paths or repo selectors, which name no worktree).
  for (const r of rows(store, "SELECT squad, action FROM episodes WHERE project = ? AND kind LIKE 'action:%' AND kind NOT LIKE 'action:cleanup.%' AND state IN ('acted', 'running', 'pending')", label)) {
    const walk = (v: unknown): void => {
      if (typeof v === "string") { if (v.includes("::/") && !v.startsWith("id:")) add(r.squad, v); }
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(json(r.action));
  }
  return found;
}

function liveWorker(store: Store, label: string, wt: unknown): boolean {
  return typeof wt === "string" && !!wt
    && !!store.db.query("SELECT 1 FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(label, wt);
}

const stateFile = (store: Store, label: string, topic: string) => join(store.root, label, "squads", `${topic}.json`);

// A squad row nothing ever started: `ds close-squad` cannot close it (it needs the state file).
function neverStarted(store: Store, label: string, s: Row, disk: Map<string, Named>): boolean {
  if (s.status != null || s.doc != null || s.lead_wt != null) return false;
  if (s.want != null && s.want_result == null) return false;
  if (existsSync(stateFile(store, label, String(s.topic)))) return false;
  return !(store.db.query("SELECT wt, wt_path FROM members WHERE project = ? AND squad = ?").all(label, String(s.topic)) as Row[])
    .some((m) => liveWorker(store, label, m.wt) || [m.wt, m.wt_path].some((x) => disk.has(folder(x) ?? "")));
}

function squadsByState(store: Store, label: string, disk: Map<string, Named>): { open: Row[]; never: string[]; closed: string[] } {
  const open: Row[] = [], never: string[] = [], closed: string[] = [];
  for (const s of rows(store, "SELECT * FROM squads WHERE project = ? ORDER BY topic", label)) {
    if (s.status === "closed" || s.status === "gone") closed.push(String(s.topic));
    else if (neverStarted(store, label, s, disk)) never.push(String(s.topic));
    else open.push(s);
  }
  return { open, never, closed };
}

const byHand = (path: string, n: Named) => n.recorded ? `ds worktree rm ${path}`
  : `git worktree remove ${path}   (\`ds worktree rm\` cannot: the loop has no record of its repo; check it for unsaved work first)`;

// The member rows the decider still acts on (decide.ts members): the newest of its slot, on the roster.
const actedOn = (store: Store, m: Row) => !["gone", "closed"].includes(String(m.status ?? ""))
  && !store.db.query("SELECT 1 FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix IS ? AND id > ?")
    .get(String(m.project), String(m.squad), String(m.role), m.suffix as string | null, Number(m.id));

/** Everything that stops a removal of `label` now; empty when it can go on. Writes nothing. */
export function removalBlockers(store: Store, label: string): Blocker[] {
  const bad = labelProblem(store, label);
  if (bad) return [bad];
  const out: Blocker[] = [];
  if (intents(store, { project: label }).length)
    out.push({ kind: "paused", text: "the project is paused: resume it first", clear: `ds resume project ${label}` });

  const disk = onDisk(store, label);
  const { open } = squadsByState(store, label, disk);
  const openTopics = new Set(open.map((s) => String(s.topic)));
  for (const s of open) {
    const topic = String(s.topic);
    // close-squad needs the state file; without one the wish itself archives the row.
    const clear = existsSync(stateFile(store, label, topic)) ? `ds close-squad ${label} ${topic}` : `ds want squad ${label}/${topic} gone`;
    out.push({ kind: "open-squad", squad: topic, text: `squad '${topic}' is not closed (status: ${s.status ?? "none yet"})`, clear });
  }

  for (const [path, n] of [...disk].sort(([a], [b]) => a.localeCompare(b))) {
    const squads = [...n.squads];
    const squad = n.leftoverOf ?? squads.find((t) => openTopics.has(t)) ?? squads[0];
    const clear = n.leftoverOf ? `the board's leftover Remove on squad '${n.leftoverOf}' (it saves the changes first)`
      : squad && openTopics.has(squad) ? `closing squad '${squad}' removes it; if it stays: ${byHand(path, n)}`
      : byHand(path, n);
    out.push({ kind: "worktree", path, ...(squad ? { squad } : {}),
      text: `worktree folder still on disk${squad ? ` (squad '${squad}')` : ""}: ${path}`, clear });
  }

  // A live worker whose folder is on disk is named above; an open squad's members, by their squad.
  const named = new Set<string>(), studioWt = store.get("projects", { label })?.studio_wt;
  for (const m of rows(store, `SELECT * FROM members WHERE project = ? AND squad != '${STUDIO}' AND role != 'studio' AND wt IS NOT NULL ORDER BY id`, label)) {
    const wt = String(m.wt), squad = String(m.squad), path = folder(wt);
    if (named.has(wt) || openTopics.has(squad) || (path && disk.has(path)) || !liveWorker(store, label, wt)) continue;
    // The Studio's own worktree never blocks, whatever other row names it.
    if (wt === studioWt) continue;
    named.add(wt);
    const who = [m.role, m.suffix].filter(Boolean).join("/");
    out.push({ kind: "live-member", squad, ...(path ? { path } : {}), text: `member ${who} of squad '${squad}' still has a live worker (${wt})`,
      // By row id: the slot form does not find a row whose status is `gone`.
      clear: actedOn(store, m) ? `ds want member ${m.id} archived`
        : `stop its agent, close that worktree's terminals and remove its entry from the backend (${wt}); the loop no longer acts on this member row` });
  }
  return out;
}

export type RemovalSummary = {
  studioWorktree: string | null;
  services: { name: string; topic: string; port: number | null; status: string | null }[];
  exposed: { name: string; squad: string; url: string | null; stop: string | null }[];
  neverStarted: string[];
  closedSquads: number;
  memberRows: number; // member rows outside the Studio of squads that do not block
  moves: string[];
  keeps: string[];
};

/** What a removal of a known `label` would stop, move and keep. Writes nothing. */
export function removalSummary(store: Store, label: string): RemovalSummary {
  const { open, never, closed } = squadsByState(store, label, onDisk(store, label));
  const openTopics = new Set(open.map((s) => String(s.topic)));
  const studio = store.get("projects", { label })?.studio_wt;
  return {
    studioWorktree: studio ? String(studio) : null,
    services: rows(store, "SELECT name, topic, port, status FROM services WHERE project = ? ORDER BY name, topic", label) as RemovalSummary["services"],
    exposed: rows(store, "SELECT name, squad, url, stop_cmd AS stop FROM exposed WHERE project = ? AND gone_at IS NULL ORDER BY id", label) as RemovalSummary["exposed"],
    neverStarted: never,
    closedSquads: closed.length,
    memberRows: rows(store, `SELECT squad FROM members WHERE project = ? AND squad != '${STUDIO}'`, label).filter((m) => !openTopics.has(String(m.squad))).length,
    moves: [
      `${join(store.root, label)}/ to ${join(store.root, ".removed", `${label}-<YYYY-MM-DD>`)}/`,
      "the project's loop.db rows into loop-rows.db in that folder",
    ],
    keeps: [
      `the repo clone repos/${label} and the Orca repo registration`,
      "the Studio's branch, under an archived name",
      "feedback notes and drafts, and the tables with no project column (except the health rows of its exposed services; open model or account pins on it are closed)",
    ],
  };
}
