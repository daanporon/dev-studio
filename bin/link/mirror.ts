// mirror.ts — side-loop-host U9 (issue #127, KTD14): a side host's read-only copy of main's plans and notes:
// `<label>/squads/*.md` and everything under `<label>/notes/`, at the same path under the side state root, mode
// 0444, for the projects that have a member on that host. Files only travel down: the channel
// (channels/mirror.ts) answers `list` and `read` and writes nothing on main. The side drives it with
// `MirrorSync.tick()`: a copy whose bytes differ from main's is overwritten and logged, and a file the mirror
// wrote that main no longer has is removed. Other files on the side are left alone. Both ends check every path
// with `mirrorable()` and never follow a symlink.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../loop/core/store.ts";

export const CHANNEL = "mirror";
export const MIRROR_MODE = 0o444;
/** The largest file mirrored: base64 of it must fit one link frame (protocol.ts MAX_FRAME_BYTES). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type MirrorList = { files: { path: string; sha: string }[]; skipped: string[] };
export type MirrorFile = { path: string; sha: string; data: string };

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const segment = (s: string) => s !== "" && !s.startsWith(".") && !/[\\\0]/.test(s);

/** Whether `rel` is a mirrored path: `<label>/squads/<name>.md` or `<label>/notes/…`, no hidden or `..` part. */
export function mirrorable(rel: unknown): rel is string {
  if (typeof rel !== "string") return false;
  const p = rel.split("/");
  if (p.length < 3 || !p.every(segment)) return false;
  return p[1] === "notes" || (p[1] === "squads" && p.length === 3 && p[2].endsWith(".md"));
}

const statOf = (path: string): Stats | null => { try { return lstatSync(path); } catch { return null; } };

/** Whether every folder between `root` and `rel` that exists is a real folder (not a symlink or a file). */
function realFolders(root: string, rel: string): boolean {
  let at = root;
  for (const part of rel.split("/").slice(0, -1)) {
    at = join(at, part);
    const s = statOf(at);
    if (!s) return true;                       // nothing below it exists either
    if (!s.isDirectory()) return false;
  }
  return true;
}

// ---------------------------------------------------------------- main

/** The labels whose files `host` gets: the projects with a member there (the same set as the down rows). */
function hostLabels(store: Store, host: string): string[] {
  return (store.db.query("SELECT DISTINCT project FROM members WHERE host = ? ORDER BY project").all(host) as { project: string }[])
    .map((r) => r.project);
}

/** Main's bytes of `rel`: null unless it is a regular file of a mirrorable size behind real folders. */
function mainBytes(root: string, rel: string): Buffer | "too big" | null {
  const path = join(root, rel);
  const s = realFolders(root, rel) ? statOf(path) : null;
  if (!s?.isFile()) return null;
  if (s.size > MAX_FILE_BYTES) return "too big";
  try {
    const b = readFileSync(path);
    return b.length > MAX_FILE_BYTES ? "too big" : b;
  } catch { return null; }
}

function walk(root: string, dir: string, deep: boolean, out: string[]): void {
  let entries;
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;                                   // an unreadable folder must not read as "all gone"
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (deep && segment(e.name)) walk(root, rel, deep, out); }
    else if (e.isFile() && mirrorable(rel)) out.push(rel);
  }
}

export function mirrorList(root: string, store: Store, host: string): MirrorList {
  const found: string[] = [];
  for (const label of hostLabels(store, host)) {
    for (const [sub, deep] of [["squads", false], ["notes", true]] as const) {
      if (realFolders(root, `${label}/${sub}/_`)) walk(root, `${label}/${sub}`, deep, found);
    }
  }
  const out: MirrorList = { files: [], skipped: [] };
  for (const path of found.sort()) {
    const b = mainBytes(root, path);
    if (b === "too big") out.skipped.push(path);
    else if (b) out.files.push({ path, sha: sha(b) });
  }
  return out;
}

export function mirrorRead(root: string, store: Store, host: string, rel: unknown): MirrorFile {
  if (!mirrorable(rel) || !hostLabels(store, host).includes(rel.split("/")[0])) throw new Error(`mirror: not a file this host mirrors: ${String(rel)}`);
  const b = mainBytes(root, rel);
  if (!Buffer.isBuffer(b)) throw new Error(`mirror: ${rel} is ${b ?? "gone"}`);
  return { path: rel, sha: sha(b), data: b.toString("base64") };
}

// ---------------------------------------------------------------- the side's driver

type Request = (ch: string, body: unknown, timeoutMs?: number) => Promise<unknown>;
export type MirrorResult = { written: number; removed: number; failed: number };

/** The side's sync over the link. `<root>/loop/mirror.json` holds the hash of each file as last written, so a
 *  loop restart still tells an edit on this host from a change on main, and knows which files are its own. */
export class MirrorSync {
  private logged = new Set<string>();
  constructor(private root: string, private request: Request, private log: (line: string) => void = (l) => console.error(l)) {}

  private get record(): string { return join(this.root, "loop", "mirror.json"); }

  private load(): Map<string, string> {
    try { return new Map(Object.entries(JSON.parse(readFileSync(this.record, "utf8")) as Record<string, string>)); } catch { return new Map(); }
  }

  private save(wrote: Map<string, string>): void {
    mkdirSync(dirname(this.record), { recursive: true });
    const tmp = `${this.record}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(wrote)));
    renameSync(tmp, this.record);
  }

  /** A line about a state that lasts across ticks, logged once while this process runs. */
  private once(line: string): void {
    if (!this.logged.has(line)) { this.logged.add(line); this.log(line); }
  }

  async tick(): Promise<MirrorResult> {
    const list = await this.request(CHANNEL, { op: "list" }) as MirrorList;
    if (!Array.isArray(list?.files)) throw new Error("mirror: main sent no file list");
    const wrote = this.load(), res: MirrorResult = { written: 0, removed: 0, failed: 0 };
    for (const p of list.skipped ?? []) this.once(`mirror: ${p} is over ${MAX_FILE_BYTES} bytes and is not mirrored`);
    const listed = new Set<string>();
    try {
      for (const f of list.files) {
        if (!mirrorable(f?.path)) { this.once(`mirror: refused the path ${JSON.stringify(f?.path)} from main`); continue; }
        listed.add(f.path);
        try { if (await this.sync(f.path, f.sha, wrote)) res.written++; }
        catch (e) { res.failed++; this.log(`mirror: ${f.path}: ${(e as Error).message}`); }
      }
      for (const [path, was] of [...wrote]) {
        if (listed.has(path)) continue;
        try {
          if (mirrorable(path) && this.remove(path, was)) res.removed++;
          wrote.delete(path);
        } catch (e) { res.failed++; this.log(`mirror: ${path}: ${(e as Error).message}`); }
      }
    } finally { this.save(wrote); }
    return res;
  }

  /** Make the copy of `path` match main's `want`. True when its bytes were written. */
  private async sync(path: string, want: string, wrote: Map<string, string>): Promise<boolean> {
    if (!realFolders(this.root, path)) throw new Error("a folder above it is a link or a file here; not written");
    const at = join(this.root, path), s = statOf(at);
    if (s?.isDirectory()) throw new Error("a folder is in its place here; not written");
    const have = s?.isFile() ? sha(readFileSync(at)) : null;
    if (have === want) {
      if ((s!.mode & 0o777) !== MIRROR_MODE) { chmodSync(at, MIRROR_MODE); this.log(`mirror: ${path}: mode changed on this host; set back to 0444`); }
      wrote.set(path, want);
      return false;
    }
    const got = await this.request(CHANNEL, { op: "read", path }) as MirrorFile;
    const data = Buffer.from(String(got?.data ?? ""), "base64");
    if (sha(data) !== got?.sha) throw new Error("the bytes from main do not match their hash");
    mkdirSync(dirname(at), { recursive: true });
    const tmp = join(dirname(at), `.mirror-${randomBytes(6).toString("hex")}`);
    try {
      writeFileSync(tmp, data, { flag: "wx", mode: MIRROR_MODE });
      chmodSync(tmp, MIRROR_MODE);             // the umask may have narrowed it
      renameSync(tmp, at);                     // replaces a read-only file, and a link rather than its target
    } finally { rmSync(tmp, { force: true }); }
    const was = wrote.get(path);
    if (s && (!was || have !== was)) this.log(`mirror: ${path} was changed on this host; overwritten with main's copy`);
    wrote.set(path, got.sha);
    return true;
  }

  /** Remove a copy main no longer has. True when a file was there. */
  private remove(path: string, was: string): boolean {
    if (!realFolders(this.root, path)) return false;
    const at = join(this.root, path), s = statOf(at);
    if (!s || s.isDirectory()) return false;
    const edited = !s.isFile() || sha(readFileSync(at)) !== was;
    rmSync(at, { force: true });
    this.log(`mirror: ${path} is no longer mirrored from main; removed${edited ? " (it was changed on this host)" : ""}`);
    return true;
  }
}
