// ds update-run — the job behind an `update` request (board-actions-as-wishes U1): runs bin/host/update-host.sh,
// then, when it advanced or was already current, bin/commands/update-squads.sh <project> --auto. The loop's
// update fulfiller (bin/loop/fulfil/update.ts) starts it outside its own process tree (a transient systemd
// unit, else setsid), because update-host stops and restarts the loop that started it. Every step is written
// to <state root>/loop/update/<id>.json (tmp file + rename) and the scripts' output to <id>.log, so the loop
// that comes back after the restart finishes the request from the file. DS_UPDATE_HOST_SH and
// DS_UPDATE_SQUADS_SH name other scripts (the tests' fakes).
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, stateRoot, writeErr } from "../lib/shared";
import { updateFiles, type UpdateFile } from "../lib/update-job";

export const help = "<request id> <project> — the update job a board/ds update request starts (update-host, then update-squads --auto); the loop runs it";

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data) + "\n");
  renameSync(tmp, file);
}

const OUTCOME = /^DS-UPDATE: (advanced|already current|refused|failed)/;
const SQUADS = /^update-squads: \[[^\]]*\] (?:(restart|reload|none) — (.*?) — \d+ wish|squads already on )/;

/** What update-host printed: its last DS-UPDATE: line and outcome, and its warning and repair lines. */
export function parseHost(text: string): { line?: string; outcome?: string; warnings: string[] } {
  const lines = text.split("\n");
  const line = lines.filter((l) => OUTCOME.test(l)).pop();
  return { line, outcome: line ? OUTCOME.exec(line)![1] : undefined, warnings: lines.filter((l) => /^update: (WARNING|repair:)/.test(l)) };
}

/** What update-squads --auto printed: its summary line, the need and the classes (none when already current). */
export function parseSquads(text: string): { squads_line?: string; need?: string; classes?: string[] } {
  const line = text.split("\n").filter((l) => SQUADS.test(l)).pop();
  if (!line) return {};
  const m = SQUADS.exec(line)!;
  if (!m[1]) return { squads_line: line, need: "none", classes: [] };
  const classes = m[2].split(" — ")[0].split(",").map((c) => c.trim()).filter((c) => c !== "" && c !== "none");
  return { squads_line: line, need: m[1], classes };
}

const size = (f: string) => { try { return statSync(f).size; } catch { return 0; } };
function readFrom(f: string, from: number): string {
  try { return readFileSync(f).subarray(from).toString("utf8"); } catch { return ""; }
}

async function step(cmd: string[], log: string): Promise<{ rc: number; text: string }> {
  const from = size(log);
  const fd = openSync(log, "a");
  try {
    const p = Bun.spawn(cmd, { cwd: ROOT, stdin: "ignore", stdout: fd, stderr: fd, env: process.env as Record<string, string> });
    const rc = await p.exited;
    return { rc, text: readFrom(log, from) };
  } catch (e) {
    return { rc: 127, text: `${(e as Error)?.message ?? e}` };
  } finally { closeSync(fd); }
}

export async function run(argv: string[]): Promise<number> {
  const [rawId, project] = argv;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0 || !project) { writeErr(`usage: ds update-run ${help}\n`); return 2; }
  const root = stateRoot();
  const { out, log } = updateFiles(root, id);
  mkdirSync(dirname(out), { recursive: true });
  const started_at = Math.floor(Date.now() / 1000);
  let file: UpdateFile = { id, project, pid: process.pid, state: "pulling", started_at, at: started_at, log };
  const put = (more: Partial<UpdateFile>) => { file = { ...file, ...more, at: Math.floor(Date.now() / 1000) }; writeAtomic(out, file); };
  put({});

  const host = await step([process.env.DS_UPDATE_HOST_SH || join(ROOT, "bin", "host", "update-host.sh")], log);
  const h = parseHost(host.text);
  put({ line: h.line, outcome: h.outcome, warnings: h.warnings, host_rc: host.rc });
  if (h.outcome !== "advanced" && h.outcome !== "already current") {
    put({ state: "failed", error: h.line ?? `update-host exited ${host.rc} with no DS-UPDATE line; see ${log}` });
    return 1;
  }

  put({ state: "refreshing" });
  const squads = await step([process.env.DS_UPDATE_SQUADS_SH || join(ROOT, "bin", "commands", "update-squads.sh"), project, "--auto"], log);
  const sq = parseSquads(squads.text);
  if (squads.rc !== 0) {
    put({ ...sq, squads_rc: squads.rc, state: "failed", error: `update-squads exited ${squads.rc}${sq.squads_line ? `: ${sq.squads_line}` : ""}; see ${log}` });
    return 1;
  }
  put({ ...sq, squads_rc: 0, state: "done" });
  return 0;
}
