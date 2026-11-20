// ds events — the append-only event log, oldest first.
import { open } from "../loop/core/store.ts";
import { parse, print, shape } from "../loop/core/cli.ts";

export const help = "[--since <event id>] [--project <label>] [--squad <topic>] [--kind <kind>] [--last] [--limit <n>] — events after an id (--last: only the newest)";
export async function run(args: string[]): Promise<number> {
  const { opt, flag } = parse(args, ["since", "project", "squad", "kind", "limit"], ["last"]);
  const s = open();
  const rows = s.db.query(`SELECT * FROM events WHERE id > ?1 AND (?2 IS NULL OR project = ?2) AND (?3 IS NULL OR squad = ?3) AND (?5 IS NULL OR kind = ?5)
    ORDER BY id ${flag.has("last") ? "DESC" : ""} LIMIT ?4`).all(Number(opt.since ?? 0), opt.project ?? null, opt.squad ?? null, flag.has("last") ? 1 : Number(opt.limit ?? -1), opt.kind ?? null) as Record<string, unknown>[];
  s.close();
  print(rows.map((r) => shape(r)));
  return 0;
}
