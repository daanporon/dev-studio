// ds health — the loop's health row (null until a loop has ticked).
import { open } from "../loop/core/store.ts";
import { print } from "../loop/core/cli.ts";

export const help = "— the health row (pid, tick_at, tick_no), or null";
export async function run(): Promise<number> {
  const s = open();
  const row = s.db.query("SELECT * FROM health WHERE id = 1").get();
  s.close();
  print(row ?? null);
  return 0;
}
