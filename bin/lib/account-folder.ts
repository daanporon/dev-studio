// account-folder.ts — the folder `ds account add` makes for a new login (issue #125, KTD7), and the line its
// login terminal runs (KTD9). Generic over the account kind (bin/lib/account-kinds/): the links, the folder env
// and the login command all come from the kind.
//
//   nameProblem(name, taken)                 why a name cannot be an account id, or null
//   makeAccountFolder(kind, name, id, env)   <accounts root>/<agent>/<name>, mode 0700, the kind's links, a marker
//   madeBy(folder, id)                       the marker says request `id` made this folder
//   removeMadeFolder(folder, id)             remove it, only when that marker says so (the duplicate add, R6)
//   loginLine(kind, folder)                  `exec env <ENV>=<folder> DS_LOGIN_DIR=<folder> BROWSER=true sh -c '<login>; echo $? > …'`
//   loginExit(folder)                        the login command's exit code once it ended, else null
//   copyAccountFolder(from, to, id, creds)   `ds account move`'s copy, links kept (U8)
//   removeMovedCopy(to, id)                  drop that copy, only when its marker names request id (a refusal after it)
//
// No other code path removes a folder: a failed add keeps its folder, and a folder an add did not make (a
// --dir folder, an Orca profile) is never touched. The move removes only its own staging folder and copy.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountsRoot } from "./account-dirs.ts";
import type { AccountKind, Env } from "./account-kinds/index.ts";

/** The file that records which request made a folder. */
export const MARKER = ".ds-account-add";
/** The file the login line writes the login command's exit code to. */
export const EXIT_FILE = ".ds-login-exit";

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Why `name` cannot be a new account id of an agent whose ids (removed ones included) are `taken`, or null. */
export function nameProblem(name: string, taken: Iterable<string>): string | null {
  if (!NAME_RE.test(name)) return `'${name}' is not a valid account name (a lowercase letter, then up to 31 of a-z, 0-9 and -)`;
  if (name === "system" || name === "default") return `'${name}' is the agent's own login and cannot be a new account`;
  for (const t of taken) if (t === name) return `the name '${name}' is taken (ds account list; a removed account keeps its name)`;
  return null;
}

/** The folder a new `agent` account `name` gets. */
export const accountDir = (agent: string, name: string, env: Env = process.env): string => join(accountsRoot(env), agent, name);

const markerOf = (folder: string): string | null => {
  try { return readFileSync(join(folder, MARKER), "utf8").trim(); } catch { return null; }
};
export const madeBy = (folder: string, id: number | string): boolean => markerOf(folder) === String(id);

/** Make (or, for the request that made it, reuse) the folder of a new account: mode 0700, the marker, and a
 *  link into the agent's system folder for each of the kind's links that is there (never the credentials file).
 *  Throws when the folder exists and this request did not make it. */
export function makeAccountFolder(kind: AccountKind, name: string, id: number | string, env: Env = process.env): string {
  const folder = accountDir(kind.agent, name, env);
  if (existsSync(folder) && !madeBy(folder, id)) throw new Error(`${folder} already exists; add it with --dir, or pick another name`);
  mkdirSync(join(accountsRoot(env), kind.agent), { recursive: true, mode: 0o700 });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  writeFileSync(join(folder, MARKER), `${id}\n`, { mode: 0o600 });
  const sys = kind.systemDir(env);
  for (const l of kind.links) {
    if (l === kind.credentialsFile || !existsSync(join(sys, l))) continue;
    const at = join(folder, l);
    try { lstatSync(at); continue; } catch { /* not there yet */ }
    symlinkSync(join(sys, l), at);
  }
  return folder;
}

/** Remove `folder` when request `id` made it; returns whether it did. */
export function removeMadeFolder(folder: string, id: number | string): boolean {
  if (!madeBy(folder, id)) return false;
  rmSync(folder, { recursive: true, force: true });
  return true;
}

const q = (s: string) => /^[A-Za-z0-9._\/:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** The line the login terminal runs: the kind's login command on `folder`, with no browser to open (the URL is
 *  read off the screen), writing its exit code to the folder's exit file so any backend can tell it ended. */
export function loginLine(kind: AccountKind, folder: string): string {
  if (!kind.login) throw new Error(`${kind.agent} has no login command yet`);
  const env = kind.envVar ? `${kind.envVar}=${q(folder)} ` : "";
  const inner = `${kind.login.command.map(q).join(" ")}; echo $? > "$DS_LOGIN_DIR/${EXIT_FILE}"`;
  return `exec env ${env}DS_LOGIN_DIR=${q(folder)} BROWSER=true sh -c ${q(inner)}`;
}

/** The login command's exit code once it ended, else null. */
export function loginExit(folder: string): number | null {
  try {
    const t = readFileSync(join(folder, EXIT_FILE), "utf8").trim();
    return t === "" ? null : Number(t);
  } catch { return null; }
}

/** A login folder's state: its credentials file there, its login id (once there), the login command's exit. */
export type FolderCheck = { creds: boolean; login_id: string | null; exit: number | null };
/** `folder`'s login as `kind` reads it; `after` runs the kind's afterLogin once the credentials are there. The
 *  account-add fulfiller reads main's folders with it and a side host answers `account.check` with it (U20). */
export function folderCheck(kind: AccountKind, folder: string, after: boolean, env: Env = process.env): FolderCheck {
  const creds = existsSync(join(folder, kind.credentialsFile));
  if (creds && after) kind.afterLogin?.(folder, env);
  return { creds, login_id: creds ? kind.loginId(folder, false, env) : null, exit: loginExit(folder) };
}

/** The file that records which `ds account move` request copied a folder in (U8). */
export const MOVE_MARKER = ".ds-account-move";
const movedBy = (folder: string, id: number | string): boolean => {
  try { return readFileSync(join(folder, MOVE_MARKER), "utf8").trim() === String(id); } catch { return false; }
};
const isFile = (f: string): boolean => { try { return lstatSync(f).isFile(); } catch { return false; } };

/** `ds account move`'s copy (U8, KTD14): `from` (an Orca profile folder) copied to `to` with its links kept as links
 *  (`cp -a`), through a staging folder `<to>.moving-<id>` renamed into place once `<credentialsFile>` arrived, so a
 *  folder at `to` is always a whole copy. `to` gets mode 0700 and a marker naming request `id`; a run after a loop
 *  restart finds its own copy there and keeps it. `from` is only read. The only folder this removes is its own
 *  staging folder. Resolves to null, or why it could not copy (`to` stays absent). */
export async function copyAccountFolder(from: string, to: string, id: number | string, credentialsFile: string): Promise<string | null> {
  if (existsSync(to)) return movedBy(to, id) ? null : `${to} already exists`;
  const stage = `${to}.moving-${id}`;
  rmSync(stage, { recursive: true, force: true });   // an earlier run's half copy (this request's own name)
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const p = Bun.spawn(["cp", "-a", "--", from, stage], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  const why = code !== 0 ? `copying ${from} failed: ${err.trim().split("\n").slice(-2).join("; ").slice(0, 300) || `cp exit ${code}`}`
    : !isFile(join(stage, credentialsFile)) ? `the copy has no ${credentialsFile}` : null;
  if (why) { rmSync(stage, { recursive: true, force: true }); return why; }
  chmodSync(stage, 0o700);
  writeFileSync(join(stage, MOVE_MARKER), `${id}\n`, { mode: 0o600 });
  renameSync(stage, to);
  return null;
}

/** Remove the copy at `to` when request `id` made it (its marker), so a move refused after copying leaves nothing
 *  that would block the next move. Any other folder is left alone. True when it removed it. */
export function removeMovedCopy(to: string, id: number | string): boolean {
  if (!movedBy(to, id)) return false;
  rmSync(to, { recursive: true, force: true });
  return true;
}
