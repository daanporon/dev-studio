// ds remove-project — remove-project U2: the dry run. It prints what blocks removing a project, each with
// the command that clears it (squad/project-removal.ts removalBlockers), or what a removal would stop, move
// and keep. It reads loop.db read-only and writes nothing. Removal itself is not built yet.
// Exit 0: nothing blocks. 1: blocked, or asked to remove. 2: usage, an invalid or an unknown label.
import { existsSync } from "node:fs";
import { parse } from "../loop/core/cli.ts";
import { dbPath, openReadOnly, stateRoot } from "../loop/core/store.ts";
import { invalidLabel, labelProblem, removalBlockers, removalSummary, validLabel, type RemovalSummary } from "../loop/squad/project-removal.ts";

export const help = "<label> --dry-run — what blocks removing a project, or what a removal would stop, move and keep; changes nothing (removal itself is not available yet)";

const USAGE = "usage: ds remove-project <label> --dry-run\n";

function goesWith(s: RemovalSummary): string[] {
  return [
    ...(s.neverStarted.length ? [`  never-started squads: ${s.neverStarted.join(", ")}`] : []),
    `  the rows of ${s.closedSquads} closed squad(s), and ${s.memberRows} member row(s) of squads that do not block`,
  ];
}

function plan(s: RemovalSummary): string[] {
  return [
    "A removal would stop:",
    `  the Studio, and remove its worktree: ${s.studioWorktree ?? "none recorded"}`,
    ...s.services.map((v) => `  service ${v.name}${v.topic ? `/${v.topic}` : ""} (${v.status ?? "not running"}${v.port ? `, port ${v.port}` : ""})`),
    ...s.exposed.map((e) => `  exposed ${e.name} of squad ${e.squad}${e.url ? ` (${e.url})` : ""}${e.stop ? `, with: ${e.stop}` : ", no stop command"}`),
    "It would move:",
    ...s.moves.map((m) => `  ${m}`),
    "These rows go with the project:",
    ...goesWith(s),
    "It would keep:",
    ...s.keeps.map((k) => `  ${k}`),
  ];
}

export async function run(args: string[]): Promise<number> {
  const { pos, flag } = parse(args, [], ["dry-run"]);
  const [label] = pos;
  if (pos.length !== 1) { process.stderr.write(USAGE); return 2; }
  const refuse = (why: string) => { process.stderr.write(`ds remove-project: ${why}. Nothing changed.\n`); return 2; };
  // The name is checked before it is used in any path.
  if (!validLabel(label)) return refuse(invalidLabel(label).text);
  if (!existsSync(dbPath(stateRoot()))) return refuse(`no loop.db under ${stateRoot()}`);
  const s = openReadOnly();
  try {
    const bad = labelProblem(s, label);
    if (bad) return refuse(bad.text);
    if (!flag.has("dry-run")) {
      process.stderr.write(`ds remove-project: removal itself is not available yet. See what it would take: ds remove-project ${label} --dry-run. Nothing changed.\n`);
      return 1;
    }
    const blockers = removalBlockers(s, label), summary = removalSummary(s, label);
    const lines = blockers.length
      ? [`'${label}' cannot be removed yet. ${blockers.length} thing(s) block it:`,
        ...blockers.flatMap((b) => [`- ${b.text}`, ...(b.clear ? [`    clear: ${b.clear}`] : [])]),
        "Once clear, these rows go with the project:", ...goesWith(summary)]
      : [`Nothing blocks removing '${label}'.`, ...plan(summary)];
    process.stdout.write([...lines, "Dry run: nothing changed.", ""].join("\n"));
    return blockers.length ? 1 : 0;
  } finally { s.close(); }
}
