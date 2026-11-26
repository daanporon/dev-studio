// ds remove-project — remove a project (remove-project U2, U3).
//   ds remove-project <label> --dry-run         what blocks it, each with the command that clears it
//                                               (squad/project-removal.ts removalBlockers), or what a removal
//                                               would stop, move and keep; reads loop.db read-only, writes nothing
//   ds remove-project <label> [--no-wait] [--by <who>]
//                                               files a `remove-project` request (project NULL) the loop carries
//                                               out (fulfil/remove-project.ts); an open one for the label is
//                                               joined, not filed twice. It waits, printing each step, and ends
//                                               with the archive path; --no-wait prints the request and returns.
// Refused, with nothing written, while something blocks it or the loop is not running.
// Exit 0: nothing blocks, or removed. 1: blocked, the loop down, or the removal failed. 2: usage, an invalid or an
// unknown label.
import { existsSync } from "node:fs";
import { parse } from "../loop/core/cli.ts";
import { dbPath, open, openReadOnly, stateRoot, type Row, type Store } from "../loop/core/store.ts";
import { blockedText, invalidLabel, labelProblem, openRemoval, removalBlockers, removalSummary, validLabel, type RemovalSummary } from "../loop/squad/project-removal.ts";

export const help = "<label> [--dry-run] [--no-wait] — remove a project: its Studio, board and services stopped, state/<label>/ and its rows archived under state/.removed/; --dry-run shows what blocks it or what it would do";

const USAGE = "usage: ds remove-project <label> [--dry-run | --no-wait] [--by <who>]\n";

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
  const { pos, flag, opt } = parse(args, ["by"], ["dry-run", "no-wait"]);
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
    if (!flag.has("dry-run")) return remove(s, label, opt.by ?? process.env.DS_WHO ?? "ds", !flag.has("no-wait"));
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

// The loop is running when its health row moved within board_stale_ticks ticks (the board's own test).
function loopDown(s: Store): string | null {
  const h = s.db.query("SELECT tick_at, started_at, progress_at FROM health WHERE id = 1").get() as Row | null;
  if (!h) return "the loop has never run here";
  const tickS = Number(process.env.DS_LOOP_TICK_S) > 0 ? Number(process.env.DS_LOOP_TICK_S) : 5;
  const ref = Math.max(Number(h.tick_at ?? 0), Number(h.started_at ?? 0), Number(h.progress_at ?? 0));
  const age = Math.floor(Date.now() / 1000) - ref;
  return age > 12 * tickS ? `the loop has not ticked for ${age}s (start it: ds loop start)` : null;
}

async function remove(ro: Store, label: string, by: string, wait: boolean): Promise<number> {
  const stop = (why: string) => { process.stderr.write(`ds remove-project: ${why}. Nothing changed.\n`); return 1; };
  let id = openRemoval(ro, label);
  if (id === null) {
    const bad = blockedText(ro, label);
    if (bad) return stop(bad);
    const down = loopDown(ro);
    if (down) return stop(`${down}; a removal is carried out by the loop`);
  }
  const s = open();
  try {
    // Joined or filed in one transaction, so two commands at once file one removal.
    let joined = true;
    id = s.tx(() => {
      const open = openRemoval(s, label);
      if (open !== null) return open;
      joined = false;
      return Number(s.requestAny("remove-project", { label, by }, { by }).row.id);
    });
    process.stdout.write(`${joined ? "Joined the open removal" : "Filed the removal"} of '${label}' (request ${id}).\n`);
    if (!wait) return 0;
    let last = "";
    for (;;) {
      const r = s.db.query("SELECT result, done_at FROM requests WHERE id = ?").get(id) as Row | null;
      let res: Record<string, unknown> = {};
      try { res = JSON.parse(String(r?.result ?? "{}")) ?? {}; } catch { /* no progress yet */ }
      const text = typeof res.text === "string" ? res.text : "";
      if (r?.done_at == null) {
        if (text && text !== last) { process.stdout.write(`  ${text}\n`); last = text; }
        const down = loopDown(s);
        if (down) { process.stderr.write(`ds remove-project: ${down}; the removal goes on when it runs again (request ${id})\n`); return 1; }
        await Bun.sleep(1000);
        continue;
      }
      if (res.ok === true) { process.stdout.write(`Removed '${label}'. Archive: ${String(res.archive)}\n`); return 0; }
      process.stderr.write(`ds remove-project: the removal stopped at "${text || res.step}": ${String(res.error ?? r?.result ?? "unknown")}\n`);
      return 1;
    }
  } finally { s.close(); }
}
