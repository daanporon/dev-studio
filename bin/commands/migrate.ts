// ds migrate — apply every migration in bin/loop/migrations/ not yet recorded (filename order, KTD14).
import { open } from "../loop/core/store.ts";
import { print } from "../loop/core/cli.ts";

export const help = "— apply unapplied migrations; prints {applied, all}";
export async function run(): Promise<number> {
  const s = open();
  print(s.migrated);
  s.close();
  return 0;
}
