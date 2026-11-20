// ds codex-skills-ts — wire the installed CE skills and dev-studio's ds skill into Codex's shared user
// skill directory (U191): what bin/host/codex-skills.sh runs. --check reads only; operator directories stay.
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT, writeOut, writeErr } from "../lib/shared";

export const help = `[--check] — wire the CE skills and the ds skill into Codex's skill directory (codex-skills.sh)`;

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export async function run(argv: string[]): Promise<number> {
  const a = argv[0] ?? "";
  if (a !== "" && a !== "--check") { writeErr("usage: codex-skills.sh [--check]\n"); return 2; }
  const check = a === "--check";
  const home = process.env.HOME ?? "";
  const dest = process.env.CODEX_SKILLS_DIR || join(home, ".agents", "skills");
  let src = process.env.CODEX_CE_SKILLS_DIR ?? "";
  if (src === "") {
    // Prefer the Codex plugin, otherwise reuse the installed Claude plugin.
    for (const cache of [join(process.env.CODEX_HOME || join(home, ".codex"), "plugins", "cache"), join(home, ".claude", "plugins", "cache")]) {
      const base = join(cache, "compound-engineering-plugin", "compound-engineering");
      if (!isDir(base)) continue;
      const versions = readdirSync(base).filter((n) => isDir(join(base, n))).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
      const version = versions[versions.length - 1] ?? "";
      if (!isFile(join(base, version, "skills", "ce-code-review", "SKILL.md"))) continue;
      src = join(base, version, "skills"); break;
    }
  }
  let rc = 0;
  const wire = (name: string, target: string) => {
    const link = join(dest, name);
    if (check) {
      if (!isFile(join(link, "SKILL.md"))) { writeErr(`codex: missing ${name} — run bin/host/install-skills.sh --codex-only\n`); rc = 1; }
      return;
    }
    let isLink = false; try { isLink = lstatSync(link).isSymbolicLink(); } catch { /* absent */ }
    if (existsSync(link) && !isLink) writeOut(`codex: keeping operator skill ${link}\n`);
    else { try { if (isLink) unlinkSync(link); } catch { /* replaced below */ } symlinkSync(target, link); }
  };
  if (!check) mkdirSync(dest, { recursive: true });
  wire("ds", join(ROOT, "skills", "ds"));
  if (src !== "" && isDir(src)) {
    for (const name of readdirSync(src).filter((n) => !n.startsWith(".")).sort()) {
      if (isFile(join(src, name, "SKILL.md"))) wire(name, join(src, name));
    }
  } else {
    writeErr("codex: CE plugin skills not found — install compound-engineering for Codex or Claude first\n");
    rc = 1;
  }
  if (rc === 0) writeOut(`codex: ds + CE skills ok (${dest})\n`);
  return rc;
}
