// fulfil-skills.test.ts — U230: the board's Skills tab. skillsJson (GET /api/skills) lists every role's
// skills with their level, lock and savings; the `skills` request (fulfil/skills.ts) writes one project
// config row, a reset drops it, and `ds skills resolve`'s overrides show the change.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsJson } from "../../bin/board/skills-data.ts";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { projectRules, shippedRules, skillOverrides } from "../../bin/loop/settings/skills.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const SK = [
  { name: "compound-engineering:ce-work", source: "plugin compound-engineering", description: "x".repeat(400) },
  { name: "compound-engineering:ce-plan", source: "plugin compound-engineering", description: "y".repeat(800) },
  { name: "run", source: "session listing", description: "z".repeat(120) },
  { name: "brand-new-skill", source: "user", description: "w".repeat(40) },
  { name: "anthropic-skills:pdf", source: "session listing", description: "p".repeat(200) },
];

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzsk-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}
const fulfillers = (await load<Fulfiller & Reconciler>(DIRS.fulfil)).filter((f) => f.kinds);
function rig(s: Store) {
  const act = new LoopActuator({ orca: new FakeOrca(), fulfillers });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  return async (at = T) => { await loop.tick(at); await act.drain(); };
}
const file = (s: Store, kind: string, payload: unknown) => Number(s.request(kind, payload, { project: "fx", by: "board" }).row.id);
const result = (s: Store, id: number) => {
  const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) };
};
const rows = (s: Store) => s.db.query("SELECT key, value FROM config WHERE project = 'fx' AND file = 'skills.conf' ORDER BY key").all() as Row[];
const view = (s: Store, role: string) => skillsJson("fx", s.root, { skills: SK })!.roles.find((r) => r.role === role)!;
const skill = (s: Store, role: string, name: string) => view(s, role).skills.find((x) => x.name === name)!;

test("a required skill shows locked with its reason, and the summary counts the levels and the savings", () => {
  const s = imported();
  const b = view(s, "builder");
  expect(skill(s, "builder", "compound-engineering:ce-work")).toMatchObject({ level: "on", required: true, group: "Compound Engineering" });
  expect(skill(s, "builder", "compound-engineering:ce-work").reason).toMatch(/^named in |^required by conventions\/skills\.conf/);
  expect(skill(s, "builder", "compound-engineering:ce-plan")).toMatchObject({ level: "name-only", required: false });
  expect(skill(s, "builder", "run")).toMatchObject({ level: "on" });
  expect(skill(s, "builder", "anthropic-skills:pdf")).toMatchObject({ level: "off", group: "claude.ai" });
  expect(skill(s, "builder", "brand-new-skill")).toMatchObject({ is_new: true, level: "on" });
  expect(skill(s, "builder", "run").is_new).toBe(false);
  expect(b.summary).toMatchObject({ on: 3, name_only: 1, off: 1 });
  expect(b.summary.saved_tokens).toBe(Math.round((800 + 200) / 4));
  expect(b.hooks.find((h) => h.name === "hook:gh-axi")).toMatchObject({ level: "on" });
  expect(view(s, "tester").hooks.find((h) => h.name === "hook:chrome-devtools-axi")).toMatchObject({ level: "on", required: true });
  expect(view(s, "builder").other).toMatchObject({ level: "on" });
  expect(view(s, "review").other).toMatchObject({ level: "off" });
});

test("a save writes one project row, ds skills resolve shows it, and a reset drops it", async () => {
  const s = imported(), tick = rig(s);
  const id = file(s, "skills", { role: "builder", set: { "brand-new-skill": "off" } });
  await tick();
  expect(result(s, id)).toMatchObject({ done: true, ok: true });
  expect(rows(s)).toEqual([{ key: "builder brand-new-skill", value: "off" }]);
  expect(skill(s, "builder", "brand-new-skill")).toMatchObject({ level: "off", edited: true });
  expect(view(s, "builder").override).toBe(true);
  const names = SK.map((x) => x.name);
  expect(skillOverrides(names, "builder", shippedRules(), projectRules(s.db, "fx"))["brand-new-skill"]).toBe("off");
  expect(skillOverrides(names, "thinker", shippedRules(), projectRules(s.db, "fx"))["brand-new-skill"]).toBeUndefined();
  const reset = file(s, "skills", { role: "builder", reset: true });
  await tick(T + 1);
  expect(result(s, reset)).toMatchObject({ done: true, ok: true });
  expect(rows(s)).toEqual([]);
  expect(skill(s, "builder", "brand-new-skill")).toMatchObject({ level: "on", edited: false });
  expect(skillOverrides(names, "builder", shippedRules(), projectRules(s.db, "fx"))["brand-new-skill"]).toBeUndefined();
});

test("a save of a lower level for a required skill is refused and writes nothing", async () => {
  const s = imported(), tick = rig(s);
  const id = file(s, "skills", { role: "builder", set: { "compound-engineering:ce-work": "off" } });
  await tick();
  expect(result(s, id)).toMatchObject({ done: true, ok: false });
  expect(rows(s)).toEqual([]);
});

test("a level equal to the shipped one drops the row, and the role's other-skills level saves under '*'", async () => {
  const s = imported(), tick = rig(s);
  file(s, "skills", { role: "builder", set: { run: "off", "*": "name-only" } });
  await tick();
  expect(rows(s)).toEqual([{ key: "builder *", value: "name-only" }, { key: "builder run", value: "off" }]);
  expect(view(s, "builder").other).toMatchObject({ level: "name-only", default: "on" });
  file(s, "skills", { role: "builder", set: { run: "on" } });
  await tick(T + 1);
  expect(rows(s)).toEqual([{ key: "builder *", value: "name-only" }]);
});

test("the project repo's skills form their own group with the project:* default; a project with none has no group (U236)", async () => {
  const s = imported();
  const PS = [...SK, { name: "e2e", source: "project fx", description: "run e2e" }, { name: "verify", source: "project fx", description: "verify" }];
  const v = (role: string) => skillsJson("fx", s.root, { skills: PS })!.roles.find((r) => r.role === role)!;
  expect(v("lead").skills.find((x) => x.name === "e2e")).toMatchObject({ group: "Project repo", level: "name-only", required: false, is_new: false });
  expect(v("builder").skills.find((x) => x.name === "e2e")).toMatchObject({ group: "Project repo", level: "on" });
  expect(skillsJson("fx", s.root, { skills: SK })!.roles[0].skills.some((x) => x.group === "Project repo")).toBe(false);
  expect(skill(s, "builder", "run").group).not.toBe("Project repo");
});

test("a save and a reset rewrite the backup's skills.conf section (settings-export-import U1)", async () => {
  const s = imported(), tick = rig(s), backup = join(s.root, "fx", "settings.export");
  file(s, "skills", { role: "builder", set: { run: "off" } });
  await tick();
  expect(readFileSync(backup, "utf8")).toContain("\n#== skills.conf\nbuilder run off\n");
  file(s, "skills", { role: "builder", reset: true });
  await tick(T + 1);
  expect(readFileSync(backup, "utf8")).not.toContain("#== skills.conf");
});
