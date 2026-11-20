import { parse, print } from "../loop/core/cli.ts";
import { open } from "../loop/core/store.ts";
import { target } from "./pause.ts";

export const help = "<project|squad|member> <project> [squad] [role] [suffix] — clear pause intent; the loop restores eligible roles fresh; or --suspended <project> <topic> — resume a suspended squad (U158)";
export async function run(args: string[]): Promise<void> {
  const s = open();
  try {
    // A suspended squad is not a pause: its resume is the squad's running wish, and the
    // loop starts its members fresh from their journals (bin/loop/fulfil/squad.ts).
    if (args[0] === "--suspended") {
      const [project, topic] = args.slice(1);
      if (!project || !topic) throw new Error("ds resume --suspended needs <project> <topic>");
      print(s.want("squad", `${project}/${topic}`, "running", { by: "ds resume --suspended" }).row);
      return;
    }
    const { pos } = parse(args, []), t = target(pos);
    print(s.resume(t));
  } finally { s.close(); }
}
