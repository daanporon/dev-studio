// ds documents — the plans, brainstorms, journals and cross-squad notes the loop keeps (U4's
// documents observer): path (relative to the state root) and mtime, the body with --body.
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";

export const help = "[--project <label>] [--body] — documents rows (path, mtime; the body with --body)";
export async function run(args: string[]): Promise<number> {
  const { opt, flag } = parse(args, ["project"], ["body"]);
  const s = open();
  try {
    const cols = flag.has("body") ? "project, path, mtime, body, observed_at" : "project, path, mtime, observed_at";
    print(s.db.query(`SELECT ${cols} FROM documents WHERE (? IS NULL OR project = ?) ORDER BY project, path`).all(opt.project ?? null, opt.project ?? null));
    return 0;
  } finally { s.close(); }
}
