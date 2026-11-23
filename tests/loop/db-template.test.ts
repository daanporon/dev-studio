// squad-cpu-usage U3: a fresh test store copies the migrated template (tests/loop/preload-db-template.ts,
// store.ts seed()); without the hook, or with its own migrations, a new loop.db migrates file by file.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, open, type Store } from "../../bin/loop/core/store.ts";
import { buildTemplate, templateKey } from "./preload-db-template.ts";
import { onTestEnd, tempRoot } from "./temp-roots.ts";

const FILES = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const ENV = ["DS_LOOP_DB_TEMPLATE", "DS_LOOP_MIGRATIONS", "DS_NOW"] as const;
const env0 = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (env0[k] === undefined) delete process.env[k]; else process.env[k] = env0[k]; } });

const opened = (s: Store): Store => { onTestEnd(() => s.close()); return s; };
const rows = (s: Store) => s.db.query("SELECT filename, applied_at FROM schema_migrations ORDER BY rowid").all() as { filename: string; applied_at: number }[];
const schema = (s: Store) => (s.db.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all());

describe("squad-cpu-usage U3: the migrated template", () => {
  test("without the hook a new store applies every migration file, in order", () => {
    delete process.env.DS_LOOP_DB_TEMPLATE;
    process.env.DS_NOW = "1700000000";
    const s = opened(open(tempRoot("dbt-plain-")));
    expect(s.migrated.applied).toEqual(FILES);
    expect(rows(s).map((r) => r.filename)).toEqual(FILES);
    expect(rows(s).every((r) => r.applied_at === 1700000000)).toBe(true);
  });

  test("the preload gave this process a template, and a new store copies it instead of migrating", () => {
    expect(process.env.DS_LOOP_DB_TEMPLATE).toEndWith(`loop-${templateKey()}.db`);
    expect(existsSync(process.env.DS_LOOP_DB_TEMPLATE as string)).toBe(true);
    process.env.DS_NOW = "1700000000";
    const s = opened(open(tempRoot("dbt-seeded-")));
    // Every row is the template's own: none was applied now.
    expect(rows(s).map((r) => r.filename)).toEqual(FILES);
    expect(rows(s).some((r) => r.applied_at === 1700000000)).toBe(false);
    expect(s.migrated).toEqual({ applied: FILES, all: FILES });
    expect((s.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    // The same schema as a store migrated from scratch.
    delete process.env.DS_LOOP_DB_TEMPLATE;
    const plain = opened(open(tempRoot("dbt-plain-")));
    expect(schema(s)).toEqual(schema(plain));
  });

  test("an existing loop.db is opened as it is, never replaced by the template", () => {
    const d = tempRoot("dbt-existing-");
    const a = open(d);
    a.upsert("squads", { project: "p", topic: "t" }, { status: "running", observed_at: 1, updated_at: 1 });
    a.close();
    const b = opened(open(d));
    expect(b.get("squads", { project: "p", topic: "t" })).not.toBeNull();
    expect(b.migrated.applied).toEqual([]);
  });

  test("a store with its own migrations, DS_LOOP_MIGRATIONS, a missing template or '0' migrates from scratch", () => {
    process.env.DS_NOW = "1700000000";
    const fresh = (s: Store) => rows(s).every((r) => r.applied_at === 1700000000) && rows(s).length > 0;
    const dir = tempRoot("dbt-migs-");
    for (const f of FILES.slice(0, 3)) copyFileSync(join(MIGRATIONS, f), join(dir, f));
    const own = opened(open(tempRoot("dbt-own-"), { migrations: dir }));
    expect(own.migrated.applied).toEqual(FILES.slice(0, 3));
    expect(fresh(own)).toBe(true);
    process.env.DS_LOOP_MIGRATIONS = dir;
    expect(fresh(opened(open(tempRoot("dbt-env-"))))).toBe(true);
    delete process.env.DS_LOOP_MIGRATIONS;
    process.env.DS_LOOP_DB_TEMPLATE = join(tempRoot("dbt-gone-"), "missing.db");
    const missing = opened(open(tempRoot("dbt-missing-")));
    expect(fresh(missing)).toBe(true);
    expect(missing.migrated.applied).toEqual(FILES);
    process.env.DS_LOOP_DB_TEMPLATE = "0";
    expect(fresh(opened(open(tempRoot("dbt-off-"))))).toBe(true);
  });

  test("the key follows the migration files' names and contents; a build leaves only the template", () => {
    const dir = tempRoot("dbt-key-");
    for (const f of FILES) copyFileSync(join(MIGRATIONS, f), join(dir, f));
    expect(templateKey(dir)).toBe(templateKey());
    writeFileSync(join(dir, FILES[FILES.length - 1]), "-- edited\n", { flag: "a" });
    expect(templateKey(dir)).not.toBe(templateKey());
    const base = join(tempRoot("dbt-build-"), "tpl");
    mkdirSync(base);
    const p = buildTemplate(base);
    expect(readdirSync(base)).toEqual([`loop-${templateKey()}.db`]);
    expect(buildTemplate(base)).toBe(p);
  });
});
