// doc-paths.ts — the scanner behind tests/doc-paths.sh: every `bin/` or `docs/` path a living doc names,
// and every relative markdown link, must exist. `bun tests/lib/doc-paths.ts` scans DOC_PATHS_ROOT (default:
// the repo) and prints one `FAIL <file>:<line>: <path> — <why>` per miss, then `doc-paths-scan: <n> ok, <m> bad`;
// it exits 1 when anything is bad. DOC_PATHS_EXCLUDE and DOC_PATHS_REMOVED hold the test's lists, one entry
// per line (formats below); tests/doc-paths.sh sets both.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const ROOT = process.env.DOC_PATHS_ROOT || join(import.meta.dir, "..", "..");

// `<path> — <reason>`: a doc file, or a folder ending in `/`, that is not scanned.
const excludes = lines(process.env.DOC_PATHS_EXCLUDE).map((l) => l.split(" — ")[0].trim());
// `<file>: <path> — <reason>`: a path <file> names on purpose although it is gone. It must stay gone and
// <file> must still name it.
const removed = lines(process.env.DOC_PATHS_REMOVED).map((l) => {
  const m = /^(\S+): (\S+) — .+$/.exec(l);
  if (!m) throw new Error(`doc-paths: bad DOC_PATHS_REMOVED line: ${l}`);
  return { file: m[1], path: m[2] };
});

function lines(s: string | undefined): string[] {
  return (s ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

// The living docs: a few named files, every docs/**/*.md, and the instruction folders.
function docFiles(): string[] {
  const out: string[] = [];
  for (const f of ["README.md", "AGENTS.md", "bin/README.md", "studio/studio.md"]) if (isFile(f)) out.push(f);
  out.push(...walk("docs", true), ...walk("conventions", false), ...walk("roles", false));
  out.push(...walk(".claude/commands", false), ...walk("skills", true));
  return out.filter((f) => !excludes.some((e) => (e.endsWith("/") ? f.startsWith(e) : f === e)));
}

function walk(dir: string, deep: boolean): string[] {
  if (!isDir(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory() && deep) out.push(...walk(rel, true));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

const isFile = (rel: string) => { try { return statSync(join(ROOT, rel)).isFile(); } catch { return false; } };
const isDir = (rel: string) => { try { return statSync(join(ROOT, rel)).isDirectory(); } catch { return false; } };

// A repo path starts with `bin/` or `docs/`, optionally after `~/.dev-studio/`, `../` or `./`. One that
// follows any other path segment or word character (`/usr/bin/env`, `state/<label>/bin`, `$ROOT/bin`) is skipped.
const PATH_RE = /(?<![A-Za-z0-9_.\/~$>@-])(?:~\/\.dev-studio\/|(?:\.\.\/)+|\.\/)?((?:bin|docs)\/[A-Za-z0-9_.\/*?{},<>…$@+-]*)/g;
const LINK_RE = /\]\(([^)\s]+)/g;

// Trailing prose punctuation and a `:<line>` suffix are not part of the path.
function trim(tok: string): string {
  let t = tok;
  for (;;) {
    const before = t;
    t = t.replace(/:\d+(?:[-,]\d+)*$/, "").replace(/[.,:;)?!]+$/, "");
    if (t === before) return t;
  }
}

function expandBraces(s: string): string[] {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(s);
  if (!m) return [s];
  return m[2].split(",").flatMap((alt) => expandBraces(m[1] + alt + m[3]));
}

const PLACEHOLDER = /[<>…$]/;
const GLOB = /[*?]/;

// Why `p` (repo-relative, no braces) does not resolve, or null when it does.
function problem(p: string): string | null {
  const wantDir = p.endsWith("/");
  const clean = p.replace(/\/+$/, "");
  const segs = clean.split("/");
  const ph = segs.findIndex((s) => PLACEHOLDER.test(s));
  if (ph >= 0) {
    const parent = segs.slice(0, ph).join("/");
    return isDir(parent) ? null : `folder ${parent}/ does not exist`;
  }
  if (GLOB.test(clean)) {
    const glob = new Bun.Glob(clean);
    for (const hit of glob.scanSync({ cwd: ROOT, onlyFiles: !wantDir, dot: true })) {
      if (!wantDir || isDir(hit)) return null;
    }
    return wantDir ? "no folder matches" : "no file matches";
  }
  if (wantDir) return isDir(clean) ? null : "no such folder";
  return existsSync(join(ROOT, clean)) ? null : "no such file";
}

// The line with each `code span` blanked to spaces of the same length, so match offsets still line up.
const withoutCodeSpans = (s: string) => s.replace(/(`+)(.+?)\1/g, (all) => " ".repeat(all.length));

function decoded(target: string): string {
  try { return decodeURIComponent(target); } catch { return target; }
}

type Hit ={ file: string; line: number; path: string; why: string | null };

function scan(file: string): Hit[] {
  const hits: Hit[] = [];
  const text = readFileSync(join(ROOT, file), "utf8").split("\n");
  let fenced = false;
  text.forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced;
    for (const m of raw.matchAll(PATH_RE)) {
      const checkedAsLink = !fenced && withoutCodeSpans(raw).slice(0, m.index).endsWith("](");
      if (checkedAsLink) continue;
      const tok = trim(m[1]);
      const removedHere = removed.find((r) => r.file === file && r.path === tok);
      if (removedHere) continue;
      const bad = expandBraces(tok).map((p) => [p, problem(p)] as const).find(([, why]) => why);
      hits.push({ file, line, path: tok, why: bad ? (bad[0] === tok ? bad[1] : `${bad[0]}: ${bad[1]}`) : null });
    }
    if (fenced) return; // a link inside a code block or code span is not rendered
    for (const m of withoutCodeSpans(raw).matchAll(LINK_RE)) {
      const target = m[1].replace(/#.*$/, "");
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("~")) continue;
      const rel = posix.normalize(posix.join(posix.dirname(file), decoded(target)));
      const ok = !rel.startsWith("../") && existsSync(join(ROOT, rel));
      hits.push({ file, line, path: `](${m[1]})`, why: ok ? null : `link target ${rel} does not exist` });
    }
  });
  return hits;
}

let good = 0;
let bad = 0;
const files = docFiles();
for (const f of files) {
  for (const h of scan(f)) {
    if (h.why) { bad++; console.log(`FAIL ${h.file}:${h.line}: ${h.path} — ${h.why}`); } else good++;
  }
}
for (const e of excludes) {
  if (!(e.endsWith("/") ? isDir(e) : isFile(e))) { bad++; console.log(`FAIL exclude list: ${e} does not exist; drop the entry`); }
}
for (const r of removed) {
  if (problem(r.path) === null) { bad++; console.log(`FAIL removed list: ${r.path} exists again (${r.file})`); continue; }
  if (!isFile(r.file) || !readFileSync(join(ROOT, r.file), "utf8").includes(r.path)) {
    bad++; console.log(`FAIL removed list: ${r.file} no longer names ${r.path}; drop the entry`); continue;
  }
  good++;
}
console.log(`doc-paths-scan: ${good} ok, ${bad} bad (${files.length} files)`);
process.exit(bad ? 1 : 0);
