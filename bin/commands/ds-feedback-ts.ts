// ds ds-feedback-ts — jot a dev-studio snag or idea (U192): what bin/role/ds-feedback.sh runs. Since
// ds-feedback-github-issues U1 the note is one `feedback_notes` row in loop.db with the writer's member
// (bin/loop/feedback/notes.ts); when loop.db cannot be opened it is appended to the old host-local file
// as before (`ds feedback import` reads that file in later) and stderr says why.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, writeErr, writeOut } from "../lib/shared";
import { now, open, type Store } from "../loop/core/store.ts";
import { toplevel } from "../loop/squad/exposed.ts";
import { addNote, fileLine, stamp, whoOf } from "../loop/feedback/notes.ts";

export const help = `"<note>" — record a dev-studio (orchestrator) snag or idea as a loop.db feedback note the operator reviews (ds-feedback.sh); the host-local file when loop.db can't be opened`;

const TAIL = "for the next dev-studio session — this does not reach the operator. If it blocks you, tell your Lead.";

export async function run(argv: string[]): Promise<number> {
  const sr = process.env.DS_STATE_ROOT || join(ROOT, "state");
  const LOG = process.env.DS_FEEDBACK_LOG || join(sr, "dev-studio-feedback");
  if (argv.length < 1 || argv[0] === "") {
    writeErr('usage: ds-feedback.sh "<the dev-studio snag or idea; prefix with your role + project>"\n'); return 2;
  }
  const text = argv.join(" "), at = now();
  let s: Store | null = null, why = "";
  try { s = open(sr); } catch (e) { why = (e as Error).message; }
  if (s) {
    try {
      const r = addNote(s, whoOf(s, toplevel()), text, at);
      writeOut(`ds-feedback: noted as feedback note #${r.row.id} (${r.row.member ?? `project ${r.row.project}`}) in loop.db ${TAIL}\n`);
      return 0;
    } catch (e) { why = (e as Error).message; } finally { s.close(); }
  }
  // loop.db could not be opened or written: the old file, in the old line form.
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, fileLine(stamp(at), text));
  writeErr(`ds-feedback: loop.db could not be opened or written (${why.split("\n")[0]}): the note went to the file instead\n`);
  writeOut(`ds-feedback: noted → ${LOG} ${TAIL}\n`);
  return 0;
}
