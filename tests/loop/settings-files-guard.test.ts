// settings-files-guard.test.ts (U257) — no code under bin/ reads a project's settings file. A project's
// limits, roster, models and ship mode are `config` rows (bin/loop/settings/settings.ts); the files
// state/<label>/{limits,roles,models}.conf and state/<label>/ship-mode are read only by the config
// importer and observer, by settings.ts, and by the cut-over (U256), which turns them into rows once and
// renames them. A path built from a
// state root (a variable, not conventions/) plus one of those names, anywhere else, fails this test.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const NAMES = "limits\\.conf|roles\\.conf|models\\.conf|ship-mode";

// The readers allowed to name a project's settings file.
const ALLOWED = new Set(["bin/loop/db/import-config.ts", "bin/loop/observers/config.ts", "bin/loop/settings/settings.ts",
  // The cut-over (U256): the migration reads each file once; settings-rows.ts reads the file only on a root
  // that has not cut over yet (a test fixture, a host the loop has not ticked on the new code).
  "bin/loop/settings/settings-migrate.ts", "bin/lib/settings-rows.ts"]);

/** The text of each balanced `join(...)` call on a line, nested calls included. */
function joinCalls(line: string): string[] {
  const out: string[] = [];
  for (let i = line.indexOf("join("); i >= 0; i = line.indexOf("join(", i + 1)) {
    let depth = 0, j = i + 4;
    for (; j < line.length; j++) {
      if (line[j] === "(") depth++;
      else if (line[j] === ")" && --depth === 0) break;
    }
    out.push(line.slice(i, j + 1));
  }
  return out;
}

const LAST_LITERAL = new RegExp(`,\\s*["'\`](${NAMES})["'\`]\\s*\\)$`);
const VAR_PATH = new RegExp(`(?:^|[\\s"'\`(=,])(\\$[^\\s"'\`]*/(?:${NAMES}))(?![\\w.-])`, "g");
const SLASH_LITERAL = new RegExp(`["'\`]/(${NAMES})["'\`]`);

/** Why `line` builds a project settings-file path, or null. */
export function settingsPathIn(line: string): string | null {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*")) return null;
  // join(<state root>, …, "limits.conf"): a join whose last argument is the name and that never says conventions.
  for (const c of joinCalls(line)) if (LAST_LITERAL.test(c) && !/conventions/.test(c)) return c;
  // `${dir}/limits.conf`, "$STATE/$label/limits.conf": a path token that starts at a variable.
  for (const m of line.matchAll(VAR_PATH)) if (!m[1].includes("/conventions/")) return m[1];
  // dir + "/limits.conf"
  if (SLASH_LITERAL.test(line) && !/conventions/.test(line)) return line.trim();
  return null;
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "migrations") out.push(...files(p)); }
    else if (/\.(ts|sh)$/.test(n) || n === "ds") out.push(p);
  }
  return out;
}

/** Every `<file>:<line>: <hit>` under `root`/bin outside ALLOWED. */
export function hits(root = ROOT): string[] {
  const out: string[] = [];
  for (const f of files(join(root, "bin")).sort()) {
    const rel = relative(root, f);
    if (ALLOWED.has(rel)) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const h = settingsPathIn(line);
      if (h) out.push(`${rel}:${i + 1}: ${h}`);
    });
  }
  return out;
}

describe("settings files guard", () => {
  test("no code outside the importer, the observer and settings.ts reads a project settings file", () => {
    const found = hits();
    expect(found).toEqual([]);
  });


  test("the scanner sees a state path and leaves the shipped defaults alone", () => {
    const yes = [
      `const own = join(stateRoot(), label, "roles.conf");`,
      `["override", join(process.env.DS_STATE_ROOT || join(ROOT, "state"), label, "limits.conf")],`,
      `const ovr = join(stateRoot(), label, "ship-mode");`,
      `for (const conf of [join(stateDir, "roles.conf"), join(ROOT, "conventions", "roles.conf")]) {`,
      `cat "$STATE/$label/limits.conf"`,
      'readFileSync(`${dir}/${label}/models.conf`, "utf8")',
      `readFileSync(dir + "/roles.conf")`,
    ];
    const no = [
      `const dflt = join(ROOT, "conventions", "limits.conf");`,
      `store.get("config", { project: p, file: "limits.conf", key });`,
      `db.query("SELECT value FROM config WHERE project = ? AND file = 'ship-mode' AND key = 'mode'")`,
      `// join(stateRoot(), label, "limits.conf") in a comment`,
      'json(400, { error: `${key} is set in state/${project}/limits.conf, not here` })',
      `exec "$ROOT/bin/ds" ship-mode-ts "$@"`,
      `cat "$ROOT/conventions/roles.conf"`,
    ];
    expect(yes.filter((l) => settingsPathIn(l) === null)).toEqual([]);
    expect(no.filter((l) => settingsPathIn(l) !== null)).toEqual([]);
  });
});
