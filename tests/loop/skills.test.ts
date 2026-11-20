// skills.test.ts — U229: the role skill rules (resolver), `ds skills`, `ds hook-gate`, and the skills.conf import.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { levelOf, parseRules, projectSkills, roleOf, shippedRules, skillOverrides } from "../../bin/loop/settings/skills.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzskills-")); temps.push(d); return d; };
const rules = (t: string, project = false) => parseRules(t, project);

describe("rule resolver", () => {
  const shipped = rules(`
    * anthropic-skills:* off
    * anthropic-skills:docx name-only
    * ds-* off
    * ds-up-* on
    * compound-engineering:* name-only
    builder compound-engineering:ce-work on required
    thinker compound-engineering:* on required
    * hook:lavish-axi off
    thinker hook:lavish-axi on required
    review * off
    review compound-engineering:ce-code-review on required
    studio * on
  `);
  test("an exact name beats a glob; a longer glob beats a shorter one", () => {
    expect(levelOf("anthropic-skills:docx", "builder", shipped, [])).toBe("name-only");
    expect(levelOf("anthropic-skills:pdf", "builder", shipped, [])).toBe("off");
    expect(levelOf("ds-up-x", "builder", shipped, [])).toBe("on");
    expect(levelOf("ds-board", "builder", shipped, [])).toBe("off");
  });
  test("a named role beats * at the same pattern", () => {
    expect(levelOf("compound-engineering:ce-plan", "builder", shipped, [])).toBe("name-only");
    expect(levelOf("compound-engineering:ce-plan", "thinker", shipped, [])).toBe("on");
    expect(levelOf("hook:lavish-axi", "thinker", shipped, [])).toBe("on");
    expect(levelOf("hook:lavish-axi", "builder", shipped, [])).toBe("off");
  });
  test("a role's own * is its blanket; its exact rule still wins", () => {
    expect(levelOf("compound-engineering:ce-plan", "review", shipped, [])).toBe("off");
    expect(levelOf("compound-engineering:ce-code-review", "review", shipped, [])).toBe("on");
    expect(levelOf("anything-new", "studio", shipped, [])).toBe("on");
  });
  test("a skill no rule names gets no level (it stays listed in full)", () => {
    expect(levelOf("brand-new", "builder", shipped, [])).toBeUndefined();
  });
  test("a new skill takes its role's matching default", () => {
    const o = skillOverrides(["ds-new", "anthropic-skills:newone", "compound-engineering:ce-new", "plain-new"], "builder", shipped, []);
    expect(o).toEqual({ "ds-new": "off", "anthropic-skills:newone": "off", "compound-engineering:ce-new": "name-only" });
  });
  test("a project edit changes a non-required skill, never a required one", () => {
    const mine = rules(`builder anthropic-skills:docx on
      builder compound-engineering:ce-work off
      thinker hook:lavish-axi off`, true);
    expect(levelOf("anthropic-skills:docx", "builder", shipped, mine)).toBe("on");
    expect(levelOf("compound-engineering:ce-work", "builder", shipped, mine)).toBe("on");
    expect(levelOf("hook:lavish-axi", "thinker", shipped, mine)).toBe("on");
  });
  test("a project edit wins a tie with the shipped rule", () => {
    expect(levelOf("ds-board", "builder", shipped, rules("* ds-* name-only", true))).toBe("name-only");
  });
  test("bad lines are skipped", () => {
    expect(rules("builder x\nbuilder x sideways\nbuilder x on maybe\n# c\nbuilder y off  # note")).toHaveLength(1);
  });
  test("no skills known gives no overrides", () => {
    expect(skillOverrides([], "builder", shipped, [])).toEqual({});
  });
});

describe("shipped skills.conf", () => {
  const s = shippedRules();
  test("parses with no bad line", () => {
    const lines = readFileSync(join(ROOT, "conventions", "skills.conf"), "utf8")
      .split("\n").filter((l) => l.replace(/\s+#.*$/, "").trim() && !l.trim().startsWith("#"));
    expect(s.length).toBe(lines.length);
  });
  test("Builder drops the Anthropic and operator skills and keeps its required ones", () => {
    expect(levelOf("anthropic-skills:docx", "builder", s, [])).toBe("off");
    expect(levelOf("ds-board", "builder", s, [])).toBe("off");
    expect(levelOf("compound-engineering:ce-work", "builder", s, [])).toBe("on");
    expect(levelOf("hook:lavish-axi", "builder", s, [])).toBe("off");
    expect(levelOf("hook:gh-axi", "builder", s, [])).toBe("on");
  });
  test("Thinker keeps Compound Engineering and Lavish, Studio everything", () => {
    expect(levelOf("compound-engineering:ce-ideate", "thinker", s, [])).toBe("on");
    expect(levelOf("lavish", "thinker", s, [])).toBe("on");
    expect(levelOf("hook:lavish-axi", "thinker", s, [])).toBe("on");
    expect(levelOf("ds-board", "studio", s, [])).toBe("on");
    expect(levelOf("anthropic-skills:docx", "studio", s, [])).toBe("on");
    expect(levelOf("hook:lavish-axi", "studio", s, [])).toBe("on");
  });
  test("review is off except ce-code-review, and has the context-mode plugin off", () => {
    expect(levelOf("dataviz", "review", s, [])).toBe("off");
    expect(levelOf("compound-engineering:ce-code-review", "review", s, [])).toBe("on");
    expect(levelOf("plugin:context-mode@context-mode", "review", s, [])).toBe("off");
    expect(levelOf("plugin:context-mode@context-mode", "builder", s, [])).toBeUndefined();
  });
});

describe("roleOf", () => {
  test("reads project and role from a worktree folder", () => {
    expect(roleOf("/w/ds-dev-studio-builder-u229-x", ["dev", "dev-studio"])).toEqual({ project: "dev-studio", role: "builder" });
    expect(roleOf("/w/ds-dev-studio-studio", ["dev-studio"])).toEqual({ project: "dev-studio", role: "studio" });
    expect(roleOf("/home/me/dev/tools/dev-studio", ["dev-studio"])).toBeNull();
    expect(roleOf("/w/ds-acme-thinker-deposit", ["dev-studio"])).toBeNull();
  });
});

function world() {
  const root = tmp(), home = tmp();
  mkdirSync(join(root, "proj", "squads"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills", "dataviz"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "dataviz", "SKILL.md"), "---\nname: dataviz\ndescription: charts\n---\n");
  mkdirSync(join(home, ".claude", "skills", "mine"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: x\n---\n");
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), DS_STATE_ROOT: root };
  const ds = (args: string[], cwd?: string) => {
    const p = Bun.spawnSync([DS, ...args], { env, cwd, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
  };
  return { root, home, ds };
}

describe("ds skills", () => {
  test("list shows a skill folder with its description; resolve applies the role's rules", () => {
    const w = world();
    const list = JSON.parse(w.ds(["skills", "list"]).out) as { name: string; source: string; description: string }[];
    expect(list.find((s) => s.name === "dataviz")).toMatchObject({ source: "user", description: "charts" });
    expect(JSON.parse(w.ds(["skills", "resolve", "proj", "builder"]).out)).toMatchObject({ dataviz: "off" });
    expect(JSON.parse(w.ds(["skills", "resolve", "proj", "studio"]).out)).toEqual({});
  });
  test("a project row in config changes a non-required skill", () => {
    const w = world();
    const s = open(w.root); stores.push(s);
    s.upsert("config", { project: "proj", file: "skills.conf", key: "builder dataviz" }, { value: "name-only", comment: null, observed_at: 1 });
    s.close();
    expect(JSON.parse(w.ds(["skills", "resolve", "proj", "builder"]).out).dataviz).toBe("name-only");
  });
  test("resolve --wt reads the role from the worktree name; a non-role path gives {}", () => {
    const w = world();
    expect(JSON.parse(w.ds(["skills", "resolve", "--wt", "repo::/x/ds-proj-builder-u1"]).out.replace(/^.*::/, "")).dataviz).toBe("off");
    expect(w.ds(["skills", "resolve", "--wt", "/x/elsewhere"]).out).toBe("{}");
  });
  test("a host with no skills at all gives no overrides", () => {
    const root = tmp(), home = tmp();
    const p = Bun.spawnSync([DS, "skills", "resolve", "proj", "builder"], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), DS_STATE_ROOT: root }, stdout: "pipe" });
    // only the dev-studio ds-* commands (scanned from this checkout) are known
    expect(Object.keys(JSON.parse(p.stdout.toString())).every((k) => k.startsWith("ds-"))).toBe(true);
  });
  test("resolve --hook prints on or off", () => {
    const w = world();
    expect(w.ds(["skills", "resolve", "proj", "builder", "--hook", "lavish-axi"]).out).toBe("off");
    expect(w.ds(["skills", "resolve", "proj", "thinker", "--hook", "lavish-axi"]).out).toBe("on");
  });
  test("resolve --all: review turns the context-mode plugin off, builder and lead keep it, a project row can't turn it back on", () => {
    const w = world();
    const all = (role: string) => JSON.parse(w.ds(["skills", "resolve", "proj", role, "--all"]).out);
    expect(all("review").enabledPlugins).toEqual({ "context-mode@context-mode": false });
    expect(all("builder").enabledPlugins).toEqual({});
    expect(all("lead").enabledPlugins).toEqual({});
    expect(Object.keys(all("review").skillOverrides).some((k) => k.startsWith("plugin:"))).toBe(false);
    const s = open(w.root); stores.push(s);
    s.upsert("config", { project: "proj", file: "skills.conf", key: "review plugin:context-mode@context-mode" }, { value: "on", comment: null, observed_at: 1 });
    s.upsert("config", { project: "proj", file: "skills.conf", key: "builder plugin:context-mode@context-mode" }, { value: "off", comment: null, observed_at: 1 });
    s.close();
    expect(all("review").enabledPlugins).toEqual({ "context-mode@context-mode": false });
    expect(all("builder").enabledPlugins).toEqual({ "context-mode@context-mode": false });   // not required for builder: a project may
    expect(all("lead").enabledPlugins).toEqual({});
  });
});

describe("project repo skills (U236)", () => {
  // a fake worktree whose .claude/skills is a link to .agents/skills holding 3 skills
  function repo(withSkills = true) {
    const wt = join(tmp(), "ds-proj-lead-x"); mkdirSync(wt, { recursive: true });
    if (withSkills) {
      for (const n of ["e2e", "verify", "dev-env"]) {
        mkdirSync(join(wt, ".agents", "skills", n), { recursive: true });
        writeFileSync(join(wt, ".agents", "skills", n, "SKILL.md"), `---\nname: ${n}\ndescription: the ${n} skill\n---\n`);
      }
      mkdirSync(join(wt, ".claude"), { recursive: true });
      symlinkSync("../.agents/skills", join(wt, ".claude", "skills"));
    }
    return wt;
  }
  test("projectSkills follows the link and marks the source", () => {
    expect(projectSkills(repo(), "acme").map((k) => [k.name, k.source]).sort()).toEqual([["dev-env", "project acme"], ["e2e", "project acme"], ["verify", "project acme"]]);
    expect(projectSkills(repo(false))).toEqual([]);
  });
  test("project:* gives a Lead name-only and a Builder on; an exact rule beats it", () => {
    const s = shippedRules(), names = new Set(["e2e", "verify"]);
    expect(skillOverrides(["e2e", "verify"], "lead", s, [], names)).toEqual({ e2e: "name-only", verify: "name-only" });
    expect(skillOverrides(["e2e", "verify"], "builder", s, [], names)).toEqual({});
    expect(skillOverrides(["e2e", "verify"], "lead", s, parseRules("lead e2e on", true), names)).toEqual({ verify: "name-only" });
    expect(levelOf("e2e", "lead", s, [])).toBeUndefined();   // not a project skill: the pattern doesn't apply
    for (const r of ["builder", "tester", "reviewer", "review", "studio"]) expect(levelOf("e2e", r, s, [], true)).toBe("on");
    for (const r of ["lead", "thinker", "researcher"]) expect(levelOf("e2e", r, s, [], true)).toBe("name-only");
  });
  test("resolve --wt adds the worktree's skills; a worktree with none resolves as before", () => {
    const w = world(), wt = repo();
    expect(JSON.parse(w.ds(["skills", "resolve", "--wt", wt]).out)).toMatchObject({ e2e: "name-only", verify: "name-only", "dev-env": "name-only", dataviz: "off" });
    const bare = repo(false);
    const o = JSON.parse(w.ds(["skills", "resolve", "--wt", bare]).out);
    expect(o.e2e).toBeUndefined();
    expect(o.dataviz).toBe("off");
  });
  test("list --wt shows them with their project source", () => {
    const w = world(), wt = repo();
    const list = JSON.parse(w.ds(["skills", "list", "--wt", wt]).out) as { name: string; source: string }[];
    expect(list.find((k) => k.name === "e2e")?.source).toMatch(/^project /);
  });
});

describe("ds hook-gate", () => {
  const run = (w: ReturnType<typeof world>, dir: string, name: string) => {
    const wt = join(tmp(), dir); mkdirSync(wt, { recursive: true });
    return w.ds(["hook-gate", name, "--", `echo ran-${name}`], wt).out;
  };
  test("a Builder worktree skips lavish-axi, a Thinker runs it, a non-role directory runs it", () => {
    const w = world();
    expect(run(w, "ds-proj-builder-u1", "lavish-axi")).toBe("");
    expect(run(w, "ds-proj-thinker-t", "lavish-axi")).toBe("ran-lavish-axi");
    expect(run(w, "somewhere-else", "lavish-axi")).toBe("ran-lavish-axi");
    expect(run(w, "ds-proj-builder-u1", "gh-axi")).toBe("ran-gh-axi");
  }, 60000);
  test("usage errors exit 2", () => {
    expect(world().ds(["hook-gate", "x"]).code).toBe(2);
  });
});

describe("skills.conf import", () => {
  test("shipped rows import by role + pattern; a project's edit rows survive a re-import", () => {
    const root = tmp(), conv = tmp();
    mkdirSync(join(root, "proj", "squads"), { recursive: true });
    writeFileSync(join(conv, "skills.conf"), "* ds-* off  # c\nbuilder ce-work on required\n");
    const s = open(root); stores.push(s);
    importConfig(s, root, conv);
    expect(s.get("config", { project: "", file: "skills.conf", key: "* ds-*" })?.value).toBe("off");
    expect(s.get("config", { project: "", file: "skills.conf", key: "builder ce-work" })?.value).toBe("on required");
    s.upsert("config", { project: "proj", file: "skills.conf", key: "builder ds-*" }, { value: "on", comment: null, observed_at: 1 });
    writeFileSync(join(conv, "skills.conf"), "* ds-* name-only\n");
    importConfig(s, root, conv);
    expect(s.get("config", { project: "", file: "skills.conf", key: "* ds-*" })?.value).toBe("name-only");
    expect(s.get("config", { project: "", file: "skills.conf", key: "builder ce-work" })).toBeFalsy();
    expect(s.get("config", { project: "proj", file: "skills.conf", key: "builder ds-*" })?.value).toBe("on");
  });
});
