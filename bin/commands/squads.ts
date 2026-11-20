// ds squads — squad rows (columns, wish and observed status). The squad's lifecycle
// state (U158) is said the board's way: a stored `gone` reads archived.
import { open } from "../loop/core/store.ts";
import { parse, print, shape } from "../loop/core/cli.ts";

const say = (v: unknown) => (v === "gone" || v === "closed" ? "archived" : v ?? null);

export const help = "[<project>] [--doc] — squad rows";
export async function run(args: string[]): Promise<number> {
  const { pos, flag } = parse(args, [], ["doc"]);
  const s = open();
  const rows = s.db.query("SELECT * FROM squads WHERE ?1 IS NULL OR project = ?1 ORDER BY project, topic").all(pos[0] ?? null) as Record<string, unknown>[];
  s.close();
  print(rows.map((r) => ({ ...shape(r, flag.has("doc")), state: say(r.want ?? r.status) })));
  return 0;
}
