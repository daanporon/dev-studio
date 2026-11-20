// board-skills-page.test.ts — U230: the Skills tab of Settings, tested the way the Roles tab is: the page's
// own helpers cut out of web/board.html, and the markup it must carry.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
const lib = new Function(`${cut("tokensOf")} ${cut("skillSummary")} ${cut("skillSetOf")} async ${cut("saveRoleRows")} return { tokensOf, skillSummary, skillSetOf, saveRoleRows };`)();

test("a role's collapsed line reads required, on, name-only, off and the tokens saved", () => {
  expect(lib.skillSummary({ required: 11, on: 6, name_only: 40, off: 29, user_invocable_only: 0, saved_tokens: 6200 })).toBe("11 required · 6 on · 40 name-only · 29 off · ≈6k tokens saved");
  expect(lib.tokensOf(480)).toBe("≈480");
});
test("Skills is the third tab, grouped by the same kind of role groups, one collapsed line per role", () => {
  expect(page).toContain('["skills", "Skills"]');
  expect(page).toContain("SKILL_ROLE_GROUPS");
  expect(page).toContain('aria-expanded=${isOpen}');
  for (const t of ["How this works", "name-only", "applies at the next start", "🔒", ">new<", "Restart ${running} running"]) expect(page).toContain(t);
});
test("an edit marks the role, a required skill has no picker, and the page posts to api/skills", () => {
  expect(page).toContain('post("api/skills", { project, role, ...body })');
  expect(page).toContain('it.required ? html`<span class="lock" title=${it.reason}>');
  expect(page).toContain('<span class="tag dirty">edited</span>');
  expect(page).toContain("if (level === shown) delete mine[name]");
});
test("Save posts only the edited roles, each once", async () => {
  const draft: Record<string, Record<string, string>> = { builder: { run: "off" }, thinker: {} };
  const dirty = ["builder", "thinker", "lead"].filter((r) => draft[r] && Object.keys(draft[r]).length);
  const filed: any[] = [];
  const r = await lib.saveRoleRows(dirty.map((role) => ({ role, body: { set: lib.skillSetOf(role, draft[role]) } })), async (role: string, body: any) => { filed.push({ role, body }); return {}; }, async () => null, () => {});
  expect(filed).toEqual([{ role: "builder", body: { set: { run: "off" } } }]);
  expect(r).toEqual({ ok: 1, failed: [] });
});

test("the Skills tab shows an MCP servers group with on/off toggles only (U283)", () => {
  expect(page).toContain('>MCP servers</div>');
  expect(page).toContain("x.mcp.map((it) => row(x, it, true))");
  expect(page).toContain('/^(hook|mcp):/.test(name) ? ["on", "off"] : SKILL_PICK');
});
