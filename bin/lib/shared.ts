// shared.ts — helpers the ported read scripts share (U222): what the old shell lib gave the shell
// versions (ds_label, ds_prefix), the repo root, the state root and the backend adapter.
// Only bun/node built-ins; no package.
import { readFileSync, existsSync, readdirSync, writeSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { filerIdentity, whoAmI } from "../loop/core/whoami.ts";
import { contractHere } from "./contract-here.ts";

/** The checkout root: DS_ROOT from the .sh wrapper (the path as the caller named it, symlinks kept, like the shell's `cd .. && pwd`), else two folders up. */
export const ROOT = process.env.DS_ROOT || join(import.meta.dir, "..", "..");

export function stateRoot(): string {
  return process.env.DS_STATE_ROOT || join(ROOT, "state");
}

/** Where a settings reader outside the loop looks (bin/loop/settings/settings.ts readGet/readRows/readRoster):
 *  this checkout's state root and shipped conventions, DS_ROOT honored as everywhere in bin/lib. */
export const settingsAt = () => ({ root: stateRoot(), conventions: join(ROOT, "conventions") });

/** The adapter a role script reaches its backend through: BACKEND (tests, a swap), else the contract
 *  adapter when this process runs in a squad off Orca (DS_BACKEND, else DS_MEMBER's squad row in loop.db;
 *  bin/lib/contract-here.ts contractHere, U11b), else Orca's. */
export function backendPath(): string {
  if (process.env.BACKEND) return process.env.BACKEND;
  return join(ROOT, "bin", "backend", contractHere(stateRoot()) ? "contract.sh" : "orca.sh");
}

/** The host's own adapter, whoever runs: accounts, skills and Orca settings belong to the host, not to a
 *  squad, so a caller in a squad off Orca still reaches them through Orca's adapter. */
export function hostBackendPath(): string {
  return process.env.BACKEND || join(ROOT, "bin", "backend", "orca.sh");
}

/** ds_label: a short, filesystem-safe project label (the old shell lib). Byte-wise like `tr -c`. */
export function dsLabel(input: string | undefined): string {
  let s = input ?? "";
  for (const p of ["path:", "id:", "name:", "runtime:"]) if (s.startsWith(p)) { s = s.slice(p.length); break; }
  s = s.replace(/\/$/, "");
  s = s.slice(s.lastIndexOf("/") + 1);
  if (s.endsWith(".git")) s = s.slice(0, -4);
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9._-]/.test(c) ? c : "-";
  }
  out = out.replace(/-*$/, "");
  return out || "home";
}

export function dsPrefix(): string {
  return process.env.DS_PREFIX ?? "ds-";
}

/** `$(cmd)`: stdout without trailing newlines. */
export function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

/** Parsed JSON of a file, or undefined when missing or invalid (jq ... 2>/dev/null). */
export function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** Sorted `*.json` paths in a directory (a shell glob), [] when it is not there. */
export function globJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort().map((f) => join(dir, f));
  } catch { return []; }
}

export type Ran = { out: string; err: string; rc: number };

/** Run a command to completion without a shell. A missing binary is rc 127. */
export async function run(cmd: string[], opts: { env?: Record<string, string | undefined>; stdin?: string; cwd?: string } = {}): Promise<Ran> {
  try {
    const p = Bun.spawn(cmd, {
      stdout: "pipe", stderr: "pipe",
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
      cwd: opts.cwd,
    });
    const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, rc };
  } catch {
    return { out: "", err: "", rc: 127 };
  }
}

export function backend(args: string[]): Promise<Ran> {
  return run([backendPath(), ...args]);
}

/** Write all of `s` to fd 1 or 2 before returning. process.stdout.write is async on a pipe, so a
 *  command that returns and lets ds exit would lose output past the pipe buffer (8 KB). */
function writeAll(fd: number, s: string): void {
  const buf = Buffer.from(s, "utf8");
  let off = 0;
  while (off < buf.length) {
    try { off += writeSync(fd, buf, off, buf.length - off); }
    catch (e: any) { if (e?.code === "EAGAIN") { Bun.sleepSync(2); continue; } if (e?.code === "EPIPE") return; throw e; }
  }
}
export const writeOut = (s: string): void => writeAll(1, s);
export const writeErr = (s: string): void => writeAll(2, s);

// ---- U192: what the role tools took from the old shell lib (the loop front and a few lib functions) ----

/** ds_loop_on: the loop owns the state root and this is not its child. */
export function dsLoopOn(): boolean {
  return !process.env.DS_LOOP_CHILD && existsSync(join(stateRoot(), ".loop-migrated"));
}

/** ds_loop_args: the front's `--wait <s>` (before any `--`) apart from the script's own arguments. A bad `--wait` exits 2. */
export function dsLoopArgs(script: string, argv: string[]): { wait: string; argv: string[]; error?: string } {
  let wait = ""; const rest: string[] = [];
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--wait") {
      if (argv.length - i < 2) return { wait, argv: rest, error: `${script}: --wait needs seconds` };
      wait = argv[i + 1]; i += 2;
    } else if (a === "--") { rest.push(...argv.slice(i)); break; }
    else { rest.push(a); i++; }
  }
  return { wait, argv: rest };
}

/** ds_loop_key: a short hash of the arguments and the 5-minute window (DS_NOW pins the window). */
export function dsLoopKey(args: string[]): string {
  const now = process.env.DS_NOW ? Number(process.env.DS_NOW) : Math.floor(Date.now() / 1000);
  const h = new Bun.CryptoHasher("sha1");
  h.update(args.length ? args.map((a) => a + "\0").join("") : "\0");
  h.update(String(Math.floor(now / 300)));
  return h.digest("hex").slice(0, 12);
}

/** ds_loop_check: refuse an unknown squad or role (directory.sh exit 2) before a message is queued. Returns the exit code to stop with, or undefined to go on. */
export async function dsLoopCheck(usage: () => number, directory: string, checkArgs: string[]): Promise<number | undefined> {
  const r = await run([directory, "check", ...checkArgs]);
  if (r.rc !== 2) return undefined;
  writeErr(r.err.replace(/\n*$/, "\n"));
  return usage();
}

/** ds_loop_front: write this script's request through `ds nudge` and return its exit code. `script` is the .sh path as called. */
export async function dsLoopFront(o: { label: string; kind: string; subject: string; id: string; key: string; script: string; argv: string[]; wait: string }): Promise<number> {
  const self = join(ROOT, "bin", basename(dirname(o.script)), basename(o.script));
  const from = whoAmI().handle ?? "";
  const replay = JSON.stringify({ kind: o.kind, key: o.key, argv: [self, ...o.argv], cwd: process.env.PWD || process.cwd(), ...(from === "" ? {} : { from }), ...filerIdentity() });
  const about: string[] = [];
  if (o.label) about.push("--project", o.label);
  if (o.subject) about.push("--squad", o.subject);
  if (o.id) about.push("--member", o.id);
  const args = [join(ROOT, "bin", "ds"), "--state", process.env.DS_STATE_ROOT || join(ROOT, "state"), "nudge", o.kind, "--json", replay, "--key", o.key, "--by", process.env.DS_WHO || o.kind, ...about, ...(o.wait ? ["--wait", o.wait] : [])];
  const p = Bun.spawn(args, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await p.exited;
}

/** The .sh path the wrapper was called as (DS_SCRIPT), for the loop front's replay and `$(basename "$0")` messages. */
export const callerScript = (fallback: string): string => process.env.DS_SCRIPT || join(ROOT, "bin", "role", fallback);

/** bash `printf %q`. */
export function shq(s: string): string {
  if (s === "") return "''";
  if (/[\x00-\x1f\x7f]/.test(s)) {
    const esc: Record<string, string> = { "\t": "\\t", "\n": "\\n", "\r": "\\r", "\x1b": "\\E", "\x07": "\\a", "\b": "\\b", "\f": "\\f", "\v": "\\v", "\\": "\\\\", "'": "\\'" };
    return "$'" + [...s].map((c) => esc[c] ?? (c < " " || c === "\x7f" ? "\\" + c.charCodeAt(0).toString(8).padStart(3, "0") : c)).join("") + "'";
  }
  let o = "";
  [...s].forEach((c, i) => {
    if (" !\"$&'()*,;<>?[\\]^`{|}".includes(c) || ((c === "~" || c === "#") && i === 0)) o += "\\" + c;
    else o += c;
  });
  return o;
}

/** `IFS=<ifs> read -r v1 … vn` where every IFS character is whitespace (space, tab, newline): runs collapse,
 *  edge whitespace goes, the last variable takes the rest of the line. */
export function readIfs(line: string, n: number, ifs = " \t\n"): string[] {
  const out: string[] = [];
  const lead = new RegExp(`^[${ifs}]+`), word = new RegExp(`^([^${ifs}]*)[${ifs}]*`), trail = new RegExp(`[${ifs}]+$`);
  let rest = line.replace(lead, "");
  for (let i = 0; i < n - 1; i++) {
    const m = word.exec(rest)!;
    out.push(m[1]); rest = rest.slice(m[0].length);
  }
  out.push(rest.replace(trail, ""));
  return out;
}
