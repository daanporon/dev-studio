// ds feedback — the ds-feedback notes in loop.db (ds-feedback-github-issues U1, bin/loop/feedback/notes.ts).
// `list` shows them, newest first (`--status`, since `ds --state` is the state root); `import` reads the old host-local file (state/dev-studio-feedback, or
// DS_FEEDBACK_LOG, or --file) into rows once and renames it `<file>.imported-<date>`. Host scope: one
// table for every project on this host.
import { join } from "node:path";
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel } from "../lib/shared";
import { FEEDBACK_NOTE_STATES } from "../loop/core/kinds.ts";
import { importFile, isNoteState, listNotes, noteCounts, noteLine } from "../loop/feedback/notes.ts";

export const help = "list [--status s] [--project p] [--limit n] [--json] | import [--file path] [--json] — the ds-feedback notes in loop.db (feedback_notes rows)";

const USAGE = `usage: ds feedback list [--status ${FEEDBACK_NOTE_STATES.join("|")}] [--project <label>] [--limit n] [--json]
       ds feedback import [--file <path>] [--json]`;

export async function run(args: string[]): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(USAGE); return args.length ? 0 : 2; }
  const usage = (why: string) => { console.error(`ds feedback: ${why}\n${USAGE}`); return 2; };
  let p: ReturnType<typeof parse>;
  try { p = parse(args, ["status", "project", "limit", "file"], ["json"]); } catch (e) { return usage((e as Error).message); }
  const { pos, opt, flag } = p;
  if (pos.length !== 1) return usage("name one of list, import");
  if (pos[0] === "list") {
    if (opt.file !== undefined) return usage("--file is for import");
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
    if (opt.status !== undefined || opt.project !== undefined || opt.limit !== undefined) return usage("import takes only --file and --json");
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
