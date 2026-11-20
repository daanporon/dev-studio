// ds done-request-ts — clear one handled request and list what still waits (U192): what bin/role/done-request.sh runs.
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { ROOT, writeErr, writeOut } from "../lib/shared";

export const help = `<state/<label>/requests/<topic|_studio>/<name>.txt> — clear a handled request, print the ones still waiting (done-request.sh)`;

export async function run(argv: string[]): Promise<number> {
  if (!(argv[0] === "--help" || argv.length === 1)) {
    writeErr("usage: done-request.sh <state/<label>/requests/<topic|_studio>/<name>.txt>\n"); return 2;
  }
  const f = argv[0];
  if (!/^.*\/state\/.*\/requests\/.*\/.*\.txt$/s.test(f)) {
    writeErr(`done-request: refusing '${f}': not a state/<label>/requests/<topic|_studio>/*.txt file\n`); return 1;
  }
  if (f.includes("..")) { writeErr(`done-request: refusing '${f}': no '..' in a request path\n`); return 1; }
  rmSync(f, { force: true });
  const dir = f.slice(0, f.lastIndexOf("/"));
  let any = false;
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".txt") && !n.startsWith(".")).sort() : [];
  for (const n of names) {
    const g = `${dir}/${n}`;
    let isFile = false; try { isFile = statSync(g).isFile(); } catch { /* gone */ }
    if (!isFile) continue;
    any = true;
    const first = readFileSync(g, "utf8").split("\n")[0];
    writeOut(`  ↻ request\t${first}\n      ↳ handle it, then: ${ROOT}/bin/role/done-request.sh ${g}\n`);
  }
  if (!any) writeOut("none left\n");
  return 0;
}
