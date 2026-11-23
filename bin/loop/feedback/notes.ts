// notes.ts — ds-feedback notes as loop.db rows (ds-feedback-github-issues U1, migration 0055). A role's
// bin/role/ds-feedback.sh writes one `feedback_notes` row with the writer's member (project, squad, role)
// as the loop knows it, not as the note's free-text prefix says; `ds feedback import` reads the old
// host-local file `state/dev-studio-feedback` once into rows and renames it. Host scope: every project's
// notes are in the same table, `project` is for display. The raw text never leaves this host.
//
// A note's key is sha1 of its second stamp and its text, so a note written here and the same line read
// from the file (a note the fallback appended while loop.db could not be opened) are one row, and an
// import run twice adds nothing.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { now, type Row, type Store } from "../core/store.ts";
import { redact } from "../core/redact.ts";
import { FEEDBACK_NOTE_STATES, type FeedbackNoteState } from "../core/kinds.ts";
import { roleName, senderAt } from "../messages/messages.ts";
import { parseMember, memberName } from "../squad/finish.ts";
import { discoverProjects } from "../settings/projects.ts";

/** Who jotted a note. `project` is `-` outside a member and `?` for an imported line naming no known project. */
export type Who = { project: string; squad: string | null; role: string | null; member: string | null; wt: string | null };
export const NOBODY: Who = { project: "-", squad: null, role: null, member: null, wt: null };

export const isNoteState = (v: string): v is FeedbackNoteState => (FEEDBACK_NOTE_STATES as readonly string[]).includes(v);

/** A second stamp in the old file's form: 2026-11-23T10:04:05Z. */
export const stamp = (at: number): string => new Date(at * 1000).toISOString().replace(/\.\d+Z$/, "Z");

/** The note key: sha1 of its stamp and text, the same for the row and the file line. */
export function noteKey(ts: string, text: string): string {
  return `fb:${createHash("sha1").update(`${ts}\0${text}`).digest("hex").slice(0, 16)}`;
}

/** The old file's line for a note: what the fallback appends and what an import reads. */
export const fileLine = (ts: string, text: string): string => `- ${ts} — ${text}\n`;

/** The writer: DS_MEMBER (the identity the loop gave the terminal), else the member whose session or
 *  worktree this is (`senderAt`), the Studio as `<project>/_studio/studio`; nobody found → project `-`. */
export function whoOf(s: Store, top: string | null, env: Record<string, string | undefined> = process.env): Who {
  const m = env.DS_MEMBER ? parseMember(env.DS_MEMBER) : null;
  if (m) return { project: m.project, squad: m.squad, role: roleName(m.role, m.suffix), member: memberName(m), wt: env.DS_WT || top };
  const w = senderAt(s, top, env);
  if (w.project && w.squad) {
    const role = roleName(w.role, w.suffix);
    return { project: w.project, squad: w.squad, role, member: `${w.project}/${w.squad}/${role}`, wt: w.member };
  }
  if (w.project && w.role === "studio") return { project: w.project, squad: "_studio", role: "studio", member: `${w.project}/_studio/studio`, wt: top };
  return { ...NOBODY, wt: top };
}

type Add = { who: Who; text: string; ts: string; at: number; source: "cli" | "import" };
const noteRow = (a: Add, t: number) => ({ table: "feedback_notes", key: { key: noteKey(a.ts, a.text) }, set: {
  project: a.who.project, squad: a.who.squad, role: a.who.role, member: a.who.member, wt: a.who.wt,
  text: redact(a.text), source: a.source, state: "new", at: a.at, updated_at: t,
} });
const realProject = (p: string) => (p === "-" || p === "?" ? undefined : p);

/** Write one note (state `new`) and a `feedback_noted` event; the same stamp and text again returns the row, created false. */
export function addNote(s: Store, who: Who, text: string, at = now()): { created: boolean; row: Row } {
  if (!text.trim()) throw new Error("feedback: the note is empty");
  const ts = stamp(at), key = noteKey(ts, text);
  const had = s.get("feedback_notes", { key });
  if (had) return { created: false, row: had };
  s.fact("feedback_noted", [noteRow({ who, text, ts, at, source: "cli" }, now())], {
    project: realProject(who.project), squad: who.squad ?? undefined, member: who.wt ?? undefined,
    payload: { key, project: who.project, source: "cli", ...(who.member ? { member: who.member } : {}) },
  });
  return { created: true, row: s.get("feedback_notes", { key }) as Row };
}

// ---- the old file ---------------------------------------------------------------------------------
const LINE = /^- (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) — (.*)$/;
// `<Role>[ <word>] on <project>[/<squad>]: …`, the prefix AGENTS.md asked for before U1.
const PREFIX = /^([A-Za-z][\w-]*)(?: [\w-]+)? on ([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?/;

export type Parsed = { ts: string; at: number; text: string };

/** The file's notes: each `- <stamp> — <text>` line, with any following line that is not one joined to it. */
export function parseFile(body: string): { notes: Parsed[]; skipped: number } {
  const notes: Parsed[] = [];
  let skipped = 0;
  for (const line of body.split("\n")) {
    const m = LINE.exec(line);
    if (m) { notes.push({ ts: m[1], at: Math.floor(Date.parse(m[1]) / 1000), text: m[2] }); continue; }
    if (notes.length) notes[notes.length - 1].text += `\n${line}`;
    else if (line.trim()) skipped++;
  }
  for (const n of notes) n.text = n.text.replace(/\s+$/, "");
  return { notes: notes.filter((n) => n.text.trim()), skipped };
}

/** An imported note's writer, from its prefix: the role, and the project when it is one this host knows, else `?`. */
export function whoFromPrefix(text: string, known: readonly string[]): Who {
  const m = PREFIX.exec(text);
  if (!m) return { ...NOBODY, project: "?" };
  const project = known.includes(m[2]) ? m[2] : "?";
  return { project, squad: project === "?" ? null : (m[3] ?? null), role: m[1].toLowerCase(), member: null, wt: null };
}

/** Where the file goes after an import: `<file>.imported-<date>`, `-2`, `-3`… when that is taken. */
function importedName(file: string, at: number): string {
  const base = `${file}.imported-${stamp(at).slice(0, 10)}`;
  let name = base;
  for (let n = 2; existsSync(name); n++) name = `${base}-${n}`;
  return name;
}

export type ImportResult = { file: string; missing: boolean; lines: number; added: number; known: number; skipped: number; renamed: string | null };

/** Read the old file into rows once (a line already a row is skipped, the same line twice is one row) and rename it. */
export function importFile(s: Store, file: string, at = now()): ImportResult {
  if (!existsSync(file)) return { file, missing: true, lines: 0, added: 0, known: 0, skipped: 0, renamed: null };
  const { notes, skipped } = parseFile(readFileSync(file, "utf8"));
  const projects = discoverProjects(s.root);
  const seen = new Set<string>(), rows: ReturnType<typeof noteRow>[] = [];
  let known = 0;
  const t = now();
  for (const n of notes) {
    const key = noteKey(n.ts, n.text);
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.get("feedback_notes", { key })) { known++; continue; }
    rows.push(noteRow({ who: whoFromPrefix(n.text, projects), text: n.text, ts: n.ts, at: n.at, source: "import" }, t));
  }
  const renamed = importedName(file, at);
  s.fact("feedback_imported", rows, { payload: { file, lines: notes.length, added: rows.length, renamed } });
  renameSync(file, renamed);
  return { file, missing: false, lines: notes.length, added: rows.length, known, skipped, renamed };
}

// ---- reading --------------------------------------------------------------------------------------
/** The notes, newest first, narrowed by state or project. */
export function listNotes(s: Store, o: { state?: string; project?: string; limit?: number } = {}): Row[] {
  const where: string[] = [], args: (string | number)[] = [];
  if (o.state) { where.push("state = ?"); args.push(o.state); }
  if (o.project) { where.push("project = ?"); args.push(o.project); }
  args.push(o.limit ?? 50);
  return s.db.query(`SELECT * FROM feedback_notes${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ?`).all(...args) as Row[];
}

/** How many notes are in each state. */
export function noteCounts(s: Store): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of s.db.query("SELECT state, COUNT(*) AS n FROM feedback_notes GROUP BY state").all() as { state: string; n: number }[]) out[r.state] = r.n;
  return out;
}

/** One line per row for `ds feedback list`. */
export function noteLine(r: Row): string {
  const who = r.squad ? `${r.squad}/${r.role ?? "?"}` : String(r.role ?? "-");
  const text = String(r.text).split("\n")[0].slice(0, 100);
  return `#${r.id}  ${stamp(Number(r.at))}  ${r.project}  ${who}  ${r.state}  ${text}`;
}
