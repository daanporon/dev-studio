// bun test preload (squad-cpu-usage U3): one migrated empty loop.db per set of migrations, so a test's fresh
// store copies it (store.ts seed()) instead of replaying every migration (~190 ms each time).
//
// The template is keyed by a hash of the migration files' names and contents, so a new or edited migration
// makes a new one. It lives in $DS_LOOP_DB_TEMPLATE_DIR (tests/ci.sh points it under its own output dir, which
// it removes) or else <tempBase>/ds-loop-db-template, where it stays for the next run: one file per migration
// set, older than a day pruned when a new one is built. Test processes share it; each builds in its own temp
// dir and renames the finished file into place, so a reader never sees half of one.
// An explicit DS_LOOP_DB_TEMPLATE (a path, or "0" for off) is kept; a run with DS_LOOP_MIGRATIONS set builds none.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, Store } from "../../bin/loop/core/store.ts";
import { tempBase } from "./temp-roots.ts";

const DAY_MS = 86_400_000;

export function templateKey(dir = MIGRATIONS): string {
  const h = createHash("sha256");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) h.update(`${f}\0${readFileSync(join(dir, f), "utf8")}\0`);
  return h.digest("hex").slice(0, 16);
}

export function buildTemplate(base: string): string {
  const path = join(base, `loop-${templateKey()}.db`);
  if (existsSync(path)) return path;
  mkdirSync(base, { recursive: true });
  const tmp = mkdtempSync(join(base, "build-"));
  try {
    const s = new Store(tmp, { migrations: MIGRATIONS });
    // Fold the WAL into the main file: the template is that one file.
    s.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    s.close();
    renameSync(join(tmp, "loop.db"), path);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const f of readdirSync(base)) {
    const p = join(base, f);
    try {
      if (p !== path && /^(loop-[0-9a-f]+\.db|build-.+)$/.test(f) && Date.now() - statSync(p).mtimeMs > DAY_MS) rmSync(p, { recursive: true, force: true });
    } catch { /* another run removed it */ }
  }
  return path;
}

// A migration that fails to apply fails the tests that migrate it (store.test.ts), not every file at load.
if (!process.env.DS_LOOP_DB_TEMPLATE && !process.env.DS_LOOP_MIGRATIONS) {
  try {
    process.env.DS_LOOP_DB_TEMPLATE = buildTemplate(process.env.DS_LOOP_DB_TEMPLATE_DIR || join(tempBase(), "ds-loop-db-template"));
  } catch (e) {
    console.error(`preload-db-template: no template, every store migrates: ${(e as Error).message}`);
  }
}
