// Every start brief names its role file; builder, tester and researcher also get the hosting check.
import { describe, expect, test } from "bun:test";
import { HOSTING_NOTE, RESTART_HOSTING_NOTE, handoff, withRoleNotes } from "../../bin/loop/squad/handoff.ts";
import { roleSpec } from "../../bin/loop/reconcilers/requests.ts";
import { ROOT } from "../../bin/loop/core/store.ts";

const m = (role: string) => ({ project: "fx", squad: "demo", role, suffix: "", model: "m", account: "a" }) as never;
const count = (s: string, t: string) => s.split(t).length - 1;

describe("withRoleNotes", () => {
  test("a Lead spec gets the role file and the hosting line once", () => {
    const s = withRoleNotes("tester", "Test the thing.");
    expect(s).toContain(`${ROOT}/roles/tester.md`);
    expect(count(s, HOSTING_NOTE)).toBe(1);
    expect(withRoleNotes("tester", s)).toBe(s);
  });
  test("a spec naming the role file already gets no second line", () => {
    const s = withRoleNotes("builder", "Read roles/builder.md first.");
    expect(count(s, "roles/builder.md")).toBe(1);
    expect(s).toContain(HOSTING_NOTE);
  });
  test("thinker and reviewer: role file only", () => {
    for (const r of ["thinker", "reviewer"]) {
      const s = withRoleNotes(r, "Go.");
      expect(s).toContain(`roles/${r}.md`);
      expect(s).not.toContain("ds expose");
    }
  });
  test("restart gets the short check, and not both", () => {
    const s = withRoleNotes("researcher", "Back.", { restart: true });
    expect(s).toContain(RESTART_HOSTING_NOTE);
    expect(s).not.toContain(HOSTING_NOTE);
    expect(withRoleNotes("researcher", s)).toBe(s);
  });
  test("a role with no role file names only AGENTS.md", () => {
    const s = withRoleNotes("nosuchrole", "Go.");
    expect(s).toContain(`${ROOT}/AGENTS.md`);
    expect(s).not.toContain("roles/nosuchrole.md");
  });
});

describe("briefs", () => {
  test("roleSpec with a Lead spec", () => {
    const s = roleSpec("fx", "tester", "demo", "run_1", "/s.json", "Do X.");
    expect(s).toContain("roles/tester.md");
    expect(count(s, HOSTING_NOTE)).toBe(1);
  });
  test("start and phase carry the hosting line; model and limit the restart line", () => {
    for (const why of ["start", "phase"] as const) expect(handoff(m("builder"), { why, run: "r" }).context).toContain(HOSTING_NOTE);
    const model = handoff(m("tester"), { why: "model", model: "x", run: "r" }).context;
    expect(model).toContain(RESTART_HOSTING_NOTE);
    const limit = handoff(m("researcher"), { why: "limit", account: "b", run: "r" }).context;
    expect(limit).toContain(RESTART_HOSTING_NOTE);
    expect(handoff(m("thinker"), { why: "start", run: "r" }).context).not.toContain("ds expose");
  });
});
