// projects.ts — which projects a state root holds, the way the removed sweep finds them (Bun).
//
// A project is every $DS_STATE_ROOT/<label>/ that has a squads/ dir or a dispatcher.json.
// conventions/projects.conf is a ship-mode file (no project list on this host): it is imported as
// config, never used to find projects. A repo's GitHub owner/name comes from a squad JSON's `repo`
// (`path:<repo dir>`) through `git -C <repo dir> remote get-url origin`.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function prUrl(s: string): { nwo: string; n: number } | null {
  const m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { nwo: `${m[1]}/${m[2]}`, n: Number(m[3]) } : null;
}

// U253: the names the tests give their throwaway projects (zz<name>_<pid>, sstate-jrnl-<pid>,
// pickseam-<pid>, _<name>). A project with one of these names is never ticked: a test that leaked into
// the live state costs the loop nothing. No row is deleted by code. `ds import` and the readers still
// see them (the tests' own projects live in temp roots and are imported there).
export const TEST_PROJECT_PREFIXES = ["zz", "sstate-", "pickseam-", "_"];
export function isTestProject(name: string): boolean {
  return TEST_PROJECT_PREFIXES.some((p) => name.startsWith(p));
}

// Every project dir under the root, test projects included.
function projectDirs(root: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter((n) => {
    if (n.startsWith(".")) return false; // a bash */ glob skips dot dirs
    const d = join(root, n);
    try { if (!statSync(d).isDirectory()) return false; } catch { return false; }
    return existsSync(join(d, "squads")) || existsSync(join(d, "dispatcher.json"));
  }).sort();
}

export function discoverProjects(root: string): string[] {
  return projectDirs(root);
}

// The projects a tick works on: every project but the test-named ones.
export function loopProjects(root: string): string[] {
  return projectDirs(root).filter((n) => !isTestProject(n));
}

// The projects the loop skips as test projects (for `loop.sh --status`).
export function skippedProjects(root: string): string[] {
  return projectDirs(root).filter(isTestProject);
}

// owner/name of a GitHub remote URL (https or ssh form), or null.
export function parseRemote(url: string): { owner: string; name: string } | null {
  const m = url.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

// The GitHub repo behind a repo selector (`path:<dir>`, `id:<uuid>::<dir>` or a bare dir), or null
// when it has none.
export function repoOf(selector: string | null | undefined): { owner: string; name: string } | null {
  if (!selector) return null;
  const dir = selector.replace(/^path:/, "").replace(/^id:[^:]*::/, "");
  if (!dir.startsWith("/") || !existsSync(dir)) return null;
  try {
    const p = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? parseRemote(p.stdout.toString()) : null;
  } catch { return null; }
}
