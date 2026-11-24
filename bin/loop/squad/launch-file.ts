// orca-backend-alternatives U20a — the launch line a contract backend types into a new terminal.
// The full line (the --settings skill list and the brief) is about 9,500 bytes. A shell that has no
// prompt up yet is still in line mode, which keeps at most 4,095 bytes of one line, so a long line is
// cut and the next typed text runs as a second command. So the loop writes the line to a file (one per
// generation, mode 0600, under the project's state folder) and types only `exec bash <file>`.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "member";
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// <state root>/<project>/loop/launch/<member>/<generation>.sh
export const launchDir = (root: string, project: string, member: string): string => join(root, project, "loop", "launch", safe(member));
export const launchPath = (root: string, project: string, member: string, gen: string): string => join(launchDir(root, project, member), `${safe(gen)}.sh`);

// Write the file (a replay writes the same bytes again), drop the member's files of other generations,
// and give back the short line to type.
export function writeLaunch(root: string, project: string, member: string, gen: string, line: string): string {
  const dir = launchDir(root, project, member), path = launchPath(root, project, member, gen);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${line}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  for (const f of readdirSync(dir)) if (join(dir, f) !== path) rmSync(join(dir, f), { force: true });
  return `exec bash ${sq(path)}`;
}

// The member's terminal closed: its launch files go.
export function removeLaunch(root: string, project: string, member: string): void {
  const dir = launchDir(root, project, member);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
