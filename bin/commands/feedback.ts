// ds feedback — the ds-feedback notes in loop.db (ds-feedback-github-issues U1, bin/loop/feedback/notes.ts).
// `list` shows them, newest first (`--status`, since `ds --state` is the state root); `import` reads the old host-local file (state/dev-studio-feedback, or
// DS_FEEDBACK_LOG, or --file) into rows once and renames it `<file>.imported-<date>`. Host scope: one
// table for every project on this host. U3: `dismiss <note> [--why t]` (`--draft` for a draft and its
// notes) and `restore <note>` file the same `feedback-dismiss`/`feedback-restore` requests the board does;
// the loop's fulfiller (bin/loop/fulfil/feedback.ts) does them on its next tick.
import { join } from "node:path";
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel } from "../lib/shared";
import { FEEDBACK_NOTE_STATES } from "../loop/core/kinds.ts";
import { importFile, isNoteState, listNotes, noteCounts, noteLine } from "../loop/feedback/notes.ts";

export const help = "list [--status s] [--project p] [--limit n] [--json] | import [--file path] [--json] | dismiss <id> [--draft] [--why t] | restore <id> — the ds-feedback notes in loop.db (feedback_notes rows)";

const USAGE = `usage: ds feedback list [--status ${FEEDBACK_NOTE_STATES.join("|")}] [--project <label>] [--limit n] [--json]
       ds feedback import [--file <path>] [--json]
       ds feedback dismiss <note id> [--why <text>]   (--draft: <id> is a draft, dismissed with its notes)
       ds feedback restore <note id>`;

export async function run(args: string[]): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(USAGE); return args.length ? 0 : 2; }
  const usage = (why: string) => { console.error(`ds feedback: ${why}\n${USAGE}`); return 2; };
  let p: ReturnType<typeof parse>;
  try { p = parse(args, ["status", "project", "limit", "file", "why"], ["json", "draft"]); } catch (e) { return usage((e as Error).message); }
  const { pos, opt, flag } = p;
  if (pos[0] === "dismiss" || pos[0] === "restore") return review(pos, opt, flag, usage);
  if (pos.length !== 1) return usage("name one of list, import, dismiss, restore");
  if (pos[0] === "list") {
    if (opt.file !== undefined) return usage("--file is for import");
    if (opt.why !== undefined || flag.has("draft")) return usage("--why and --draft are for dismiss");
    if (opt.status !== undefined && !isNoteState(opt.status)) return usage(`--status is one of ${FEEDBACK_NOTE_STATES.join(", ")}, not '${opt.status}'`);
    const limit = opt.limit === undefined ? 50 : Number(opt.limit);
    if (!Number.isInteger(limit) || limit < 1) return usage(`--limit is a positive whole number, not '${opt.limit}'`);
    const project = opt.project === undefined ? undefined : ["-", "?"].includes(opt.project) ? opt.project : dsLabel(opt.project);
    const s = open();
    try {
      const rows = listNotes(s, { state: opt.status, project, limit });
      if (flag.has("json")) { print(rows); return 0; }
      if (!rows.length) { console.log("no feedback notes"); return 0; }
      for (const r of rows) console.log(noteLine(r));
      const counts = noteCounts(s);
      console.log(`notes: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}`);
      return 0;
    } finally { s.close(); }
  }
  if (pos[0] === "import") {
    if (opt.status !== undefined || opt.project !== undefined || opt.limit !== undefined || opt.why !== undefined || flag.has("draft")) return usage("import takes only --file and --json");
    const s = open();
    try {
      const file = opt.file || process.env.DS_FEEDBACK_LOG || join(s.root, "dev-studio-feedback");
      const r = importFile(s, file);
      if (flag.has("json")) print(r);
      else if (r.missing) console.log(`ds feedback import: no file at ${file}: nothing to import`);
      else console.log(`ds feedback import: ${r.lines} notes read, ${r.added} added, ${r.known} already rows${r.skipped ? `, ${r.skipped} lines that are no note left out` : ""}; ${file} → ${r.renamed}`);
      return 0;
    } finally { s.close(); }
  }
  return usage(`unknown subcommand '${pos[0]}'`);
}

/** `dismiss` and `restore`: one request each, as the board files it (by `ds`, or DS_WHO). */
function review(pos: string[], opt: Record<string, string | undefined>, flag: Set<string>, usage: (why: string) => number): number {
  const verb = pos[0];
  if (pos.length !== 2) return usage(`${verb} takes one id`);
  const id = Number(pos[1].replace(/^#/, ""));
  if (!Number.isInteger(id) || id < 1) return usage(`'${pos[1]}' is not an id`);
  if (opt.status !== undefined || opt.project !== undefined || opt.limit !== undefined || opt.file !== undefined) return usage(`${verb} takes only an id${verb === "dismiss" ? ", --draft and --why" : ""}`);
  if (verb === "restore" && (opt.why !== undefined || flag.has("draft"))) return usage("restore takes a note id only");
  const s = open();
  try {
    const draft = flag.has("draft");
    const what = draft ? "draft" : "note";
    const found = s.get(draft ? "feedback_drafts" : "feedback_notes", { id }) as { state?: string } | null | undefined;
    if (!found) { console.error(`ds feedback: no feedback ${what} ${id}`); return 1; }
    // Refuse early as the board does (board-server.ts), so a doomed request is never filed.
    const st = String(found.state);
    if (draft && verb === "dismiss" && st !== "review") { console.error(`ds feedback: draft ${id} is ${st}, not in review`); return 1; }
    if (!draft && verb === "restore" && st !== "dismissed") { console.error(`ds feedback: note ${id} is ${st}, not dismissed`); return 1; }
    if (!draft && verb === "dismiss" && ["filed", "fixed", "closed", "dismissed"].includes(st)) { console.error(`ds feedback: note ${id} is ${st}`); return 1; }
    const by = process.env.DS_WHO || "ds";
    const { row, created } = verb === "dismiss"
      ? s.request("feedback-dismiss", { ...(draft ? { draft: id } : { note: id }), ...(opt.why?.trim() ? { why: opt.why.trim() } : {}) }, { by })
      : s.request("feedback-restore", { note: id }, { by });
    if (flag.has("json")) print(row);
    else console.log(`ds feedback ${verb}: request ${row.id}${created ? "" : " (already filed)"} for ${what} ${id}; the loop does it on its next tick`);
    return 0;
  } finally { s.close(); }
}
