// saved-pages.ts — a squad's review pages that outlive their worktree (debrief-in-needs-you pages U2).
//
// Closing a member copies its Lavish pages to `<state root>/<label>/pages/<topic>/rescued/<role>/<path in
// the worktree>` (bin/loop/io/rescue.ts). board-data.ts `lavish()` asks this module for the saved copy of a
// session whose file is gone and for the pages in that folder no session stands for; board-server.ts serves
// them through `GET /page/<label>/pages/<topic>/<path>` (`servePage`). Both stay inside
// `<state root>/<label>/pages/<topic>/`: a canonical path under it, no symlink, no `..`.
import { closeSync, constants as fsc, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

/** `<name>.<n>.<ext>` is a copy the rescue wrote beside a different `<name>.<ext>`; both stand for one page. */
const VARIANT = /^(.*)\.(\d+)(\.[^./]+)$/;
const stem = (name: string): string => { const m = VARIANT.exec(name); return m ? m[1] + m[3] : name; };
/** The page this file stands for: its folder and its name without a rescue's `.<n>`. */
export const familyOf = (file: string): string => join(dirname(file), stem(basename(file)));

/** A relative path without a rescue's `.<n>` before the extension. */
export const familyRel = (rel: string): string => { const i = rel.lastIndexOf("/"); return rel.slice(0, i + 1) + stem(rel.slice(i + 1)); };

const mtimeOf = (p: string): number | null => {
  try { const s = lstatSync(p); return s.isFile() ? Math.floor(s.mtimeMs / 1000) : null; } catch { return null; }
};

/** `<label>/pages/<topic>/` under the state root. */
export const pagesDir = (root: string, label: string, topic: string): string => join(root, label, "pages", topic);

const inside = (dir: string, p: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * The saved copy of `rel` (a path inside a removed worktree) in rescue folder `dest`: the file itself, or
 * its newest `<name>.<n>.<ext>`. Null when there is none or `dest` is outside the squad's pages folder.
 */
export function savedCopy(root: string, label: string, topic: string, dest: string, rel: string): { file: string; mtime: number } | null {
  const base = pagesDir(root, label, topic);
  if (!dest || !inside(base, dest) || rel.split("/").includes("..")) return null;
  const want = join(dest, rel), dir = dirname(want), name = basename(want);
  let best: { file: string; mtime: number } | null = null;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (n !== name && !(VARIANT.test(n) && stem(n) === name)) continue;
    const file = join(dir, n), m = mtimeOf(file);
    if (m != null && (!best || m > best.mtime)) best = { file, mtime: m };
  }
  return best;
}

/** Every `*.html` under the squad's pages folder (no symlink, bounded), as absolute paths. */
export function pageFiles(root: string, label: string, topic: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length >= 500) return;
    let ents: import("node:fs").Dirent[] = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && /\.html$/i.test(e.name)) out.push(p);
    }
  };
  walk(pagesDir(root, label, topic), 0);
  return out;
}

/** Is `p` there as a plain file? */
export const isFile = (p: string): boolean => mtimeOf(p) != null;

/** A saved page's mtime (seconds), 0 when it cannot be read. */
export const fileMtime = (p: string): number => mtimeOf(p) ?? 0;

/** Path under the state root, `/`-separated. */
export const underRoot = (root: string, p: string): string => relative(root, p).split(sep).join("/");

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};
const PAGE_MAX = 20 * 1024 * 1024;

/**
 * One saved file for `GET /page/<label>/pages/<topic>/<path>`: `rest` is the path after `<topic>/`, already
 * split and decoded. Null when it is not a plain file of an allowed type inside the squad's pages folder.
 */
export function servePage(root: string, label: string, topic: string, rest: string[]): { bytes: Uint8Array; type: string } | null {
  if (!rest.length || rest.some((s) => !s || s === "." || s === ".." || /[\0\\/]/.test(s))) return null;
  const type = TYPES[(rest[rest.length - 1].split(".").pop() ?? "").toLowerCase()];
  if (!type) return null;
  let fd = -1;
  try {
    const base = realpathSync(pagesDir(root, label, topic)), target = join(base, ...rest);
    if (!inside(base, target) || realpathSync(target) !== target) return null; // outside, or a symlink anywhere on the way
    fd = openSync(target, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > PAGE_MAX) return null;
    return { bytes: readFileSync(fd), type };
  } catch { return null; }
  finally { if (fd >= 0) closeSync(fd); }
}
