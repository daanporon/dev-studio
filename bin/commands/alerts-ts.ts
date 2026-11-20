// ds alerts-ts — a project's Studio alerts file (U222): what bin/lib/alerts.sh runs.
import { writeOut, writeErr } from "../lib/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const help = `<file> add <id> <title> <text> <option> <why> [<fields JSON>] | resolve <id> | resolve-prefix <id-prefix> | list — a project's Studio alerts (alerts.sh)`;

const HEADER = `# alerts.sh — a project's Studio alerts: state/<label>/alerts.json, {"alerts":[…]}, each entry the
# shape of a squad's waiting_on_you entry. They belong to the project, not to any squad; the board
# shows them at the top of the project's Needs-you list and answering one dismisses it.
#   alerts.sh <file> add <id> <title> <text> <option> <why> [<fields JSON object>]
#   alerts.sh <file> resolve <id>
#   alerts.sh <file> resolve-prefix <id-prefix>
#   alerts.sh <file> list
# A card shows its options as answers only when the answer acts: 2+ options, or the field
# "acts_on_answer": true (the studio_move "move it" card). A lone option that does nothing is the
# board's "When done: <option>" line (field "when"), and the card shows only Dismiss.
set -euo pipefail
`; // the shell's `sed -n 2,9p` ran one line past the comments; kept byte for byte

class Fail extends Error { constructor(public code: number) { super("fail"); } }

const tsv = (v: unknown) => (v === null || v === undefined ? "" : String(v)).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");

export async function run(argv: string[]): Promise<number> {
  if (argv.length < 2) { writeErr(HEADER.split("\n").map((l) => l.replace(/^# alerts\.sh —/, "# alerts.sh —")).join("\n")); return 2; }
  const [file, cmd, ...a] = argv;
  const err = (s: string) => writeErr(s + "\n");

  const nonEmpty = () => existsSync(file) && statSync(file).size > 0;
  const load = (): any => {
    if (!nonEmpty()) return { alerts: [] };
    let d: any;
    try { d = JSON.parse(readFileSync(file, "utf8")); } catch { d = null; }
    if (d === null || d === false) { err(`alerts: ${file} is not valid JSON`); throw new Fail(1); }
    return d;
  };
  const save = (d: any) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n");
    renameSync(tmp, file);
  };
  const alertsOf = (d: any): any[] => (d && d.alerts !== null && d.alerts !== undefined && d.alerts !== false ? d.alerts : []);

  try {
    switch (cmd) {
      case "add": {
        if (a.length < 5) { err("alerts: add <id> <title> <text> <option> <why> [<fields JSON>]"); return 2; }
        const [id, title, q, opt, why] = a;
        const fieldsRaw = a[5] || "{}";
        let f: any;
        try { f = JSON.parse(fieldsRaw); } catch { f = null; }
        if (!f || typeof f !== "object" || Array.isArray(f)) { err("alerts: fields must be a JSON object"); return 2; }
        const d = load();
        const entry = {
          ...f, id, asker: "sweep", blocking: false, question: q,
          since: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
          ...(title === "" ? {} : { title }),
          ...(opt === "" ? {} : { suggestion: opt, options: [opt] }),
          ...(why === "" ? {} : { why }),
        };
        d.alerts = [...alertsOf(d).filter((x: any) => x?.id !== id), entry];
        save(d);
        return 0;
      }
      case "resolve": {
        if (a.length < 1) return 2;
        if (!nonEmpty()) return 0;
        const d = load();
        d.alerts = alertsOf(d).filter((x: any) => x?.id !== a[0]);
        save(d);
        return 0;
      }
      case "resolve-prefix": {
        if (a.length < 1) return 2;
        if (!nonEmpty()) return 0;
        const d = load();
        d.alerts = alertsOf(d).filter((x: any) => !String(x?.id ?? "").startsWith(a[0]));
        save(d);
        return 0;
      }
      case "list": {
        const d = load();
        let out = "";
        for (const x of Array.isArray(d.alerts) ? d.alerts : []) out += `${tsv(x?.id)}\t${tsv(x?.question)}\n`;
        writeOut(out);
        return 0;
      }
      default:
        err(`alerts: unknown command ${cmd}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof Fail) return e.code;
    throw e;
  }
}
