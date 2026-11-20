// ds observed <source> — the rows of one observed_<source> table (any table a migration adds).
import { open } from "../loop/core/store.ts";
import { parse, print, shape } from "../loop/core/cli.ts";

export const help = "<source> [--project <label>] — observed_<source> rows (ds observed with no source lists them)";
export async function run(args: string[]): Promise<number> {
  const { pos, opt } = parse(args, ["project"]);
  const s = open();
  try {
    const sources = (s.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'observed\\_%' ESCAPE '\\' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name.slice("observed_".length));
    if (!pos[0]) { print(sources); return 0; }
    if (!sources.includes(pos[0])) { console.error(`ds observed: no source '${pos[0]}' (one of ${sources.join(", ")})`); return 2; }
    const table = `observed_${pos[0]}`;
    const where = opt.project !== undefined && s.columns(table).has("project") ? "WHERE project = ?" : "";
    const rows = s.db.query(`SELECT * FROM ${table} ${where} ORDER BY rowid`).all(...(where ? [opt.project] : [])) as Record<string, unknown>[];
    print(rows.map((r) => shape(r, true)));
    return 0;
  } finally { s.close(); }
}
