// ds journal-ts — a standing agent's journal (U222): what bin/role/journal.sh runs.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, dsLabel, writeOut } from "../lib/shared";

export const help = `<project> <topic|studio> <role[-suffix]> add <decision|keep> "<text>" "<why>" | briefing | path — a standing agent's journal (journal.sh)`;

const USAGE = `usage: journal.sh <project> <topic|studio> <role[-suffix]> add <decision|keep> "<text>" "<why>" | briefing | path`;

export async function run(argv: string[]): Promise<number> {
  const usage = (): number => { console.error(USAGE); return 2; };
  if (argv.length < 4) return usage();
  const [project, topic, role, op] = argv;
  const label = dsLabel(project);
  const tr = topic + role;
  if (tr === "" || tr.includes("/") || tr.includes("..")) return usage();
  const stateRoot = process.env.DS_STATE_ROOT || join(ROOT, "state");
  const F = topic === "studio" ? join(stateRoot, label, "journals", "studio.md") : join(stateRoot, label, "journals", `${topic}-${role}.md`);
  switch (op) {
    case "path": writeOut(F + "\n"); return 0;
    case "add": {
      if (argv.length !== 7) return usage();
      const kind = argv[4], text = argv[5], why = argv[6];
      if (kind !== "decision" && kind !== "keep") { console.error(`journal: kind must be decision or keep (got '${kind}')`); return 2; }
      if (text === "") { console.error("journal: empty text"); return 2; }
      mkdirSync(dirname(F), { recursive: true });
      const fold = (s: string) => s.replace(/[\n\r]/g, " ");
      const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      appendFileSync(F, `- ${ts} [${kind}] ${fold(text)} — ${fold(why)}\n`);
      writeOut(`journal: ${kind} added to ${F}\n`);
      return 0;
    }
    case "briefing": {
      if (!existsSync(F)) { writeOut(`(journal empty: ${F})\n`); return 0; }
      const lines = readFileSync(F, "utf8").split("\n");
      const keeps = lines.filter((l) => /^- [^ ]+ \[keep\] /.test(l));
      const decisions = lines.filter((l) => /^- [^ ]+ \[decision\] /.test(l)).slice(-30);
      // U266: the newest checkpoint (a pause's or a planned restart's) closes the briefing, however many
      // decisions came after it. A failed one has no next step; entries after a real one are newer.
      const at = lines.findLastIndex((l) => /^- [^ ]+ \[keep\] checkpoint (failed )?\S+: /.test(l));
      const trailer: string[] = [];
      if (at >= 0) {
        const line = lines[at], after = lines.slice(at + 1).filter((l) => /^- [^ ]+ \[(keep|decision)\] /.test(l)).length;
        trailer.push(/^- [^ ]+ \[keep\] checkpoint failed /.test(line)
          ? `newest checkpoint failed (read the work tree and the PR before you go on): ${line.slice(2)}`
          : `newest checkpoint (continue from its next step${after ? `; the ${after} newer entries above came after it` : ""}): ${line.slice(2)}`);
      }
      writeOut([...keeps, ...decisions, ...trailer].map((l) => l + "\n").join(""));
      return 0;
    }
    default: return usage();
  }
}
