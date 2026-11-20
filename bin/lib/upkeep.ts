// upkeep.ts — helpers the ported install/upkeep commands share (U191): a child that keeps this
// process's stdio, the squad-file member walk and ds_is_url.
import { readJson } from "./shared";
import { ROOT } from "./shared";
import { join } from "node:path";

/** Run a command with this process's stdin/stdout/stderr (like a bare command in a script); returns its exit code, 127 when missing. */
export async function inherit(cmd: string[], opts: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<number> {
  try {
    const p = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: (opts.env ?? process.env) as Record<string, string>, cwd: opts.cwd });
    return await p.exited;
  } catch {
    return 127;
  }
}

/** `jq -r '(.members // [])[] | [.role, (.suffix // "")] | @tsv'` of a squad file: [role, suffix] pairs ([] when unreadable). */
export function squadMembers(file: string): Array<[string, string]> {
  const d = readJson(file);
  const m = d?.members;
  if (!Array.isArray(m)) return [];
  const s = (v: unknown) => (v === null || v === undefined || v === false ? "" : String(v));
  return m.map((x: any): [string, string] => [s(x?.role), s(x?.suffix)]);
}

/** A squad file's `.status // ""`. */
export function squadStatus(file: string): string {
  const v = readJson(file)?.status;
  return v === null || v === undefined || v === false ? "" : String(v);
}

/** ds_is_url (the old shell lib). */
export function isUrl(s: string): boolean {
  return s.includes("://") || (s.startsWith("git@") && s.slice(4).includes(":")) || s.endsWith(".git");
}

export const dsBin = () => join(ROOT, "bin", "ds");
