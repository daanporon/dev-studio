// ds ds-feedback-ts — jot a dev-studio snag or idea to the host-local log (U192): what bin/role/ds-feedback.sh runs.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, writeErr, writeOut } from "../lib/shared";

export const help = `"<note>" — append a dev-studio (orchestrator) snag or idea to the host-local log the operator reviews (ds-feedback.sh)`;

export async function run(argv: string[]): Promise<number> {
  const sr = process.env.DS_STATE_ROOT || join(ROOT, "state");
  const LOG = process.env.DS_FEEDBACK_LOG || join(sr, "dev-studio-feedback");
  if (argv.length < 1 || argv[0] === "") {
    writeErr('usage: ds-feedback.sh "<the dev-studio snag or idea; prefix with your role + project>"\n'); return 2;
  }
  mkdirSync(sr, { recursive: true }); mkdirSync(dirname(LOG), { recursive: true });
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  appendFileSync(LOG, `- ${ts} — ${argv.join(" ")}\n`);
  writeOut(`ds-feedback: noted → ${LOG} for the next dev-studio session — this does not reach the operator. If it blocks you, tell your Lead.\n`);
  return 0;
}
