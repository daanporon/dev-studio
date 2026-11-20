// mcp-per-role.test.ts — U283: `mcp:<server>` rows of conventions/skills.conf, the resolver's MCP choice and the
// deniedMcpServers a session starts with; and `plugin:<id>` rows (review-unit-no-receipt U1), the enabledPlugins a
// session starts with. Uses the shipped file, so a change to its rows shows here.
import { expect, test } from "bun:test";
import { deniedMcpServers, disabledPlugins, mcpLevels, mcpServers, parseRules, pluginIds, pluginLevels, shippedRules } from "../../bin/loop/settings/skills.ts";
import { run } from "../../bin/commands/skills.ts";

const shipped = shippedRules();
const lv = (role: string, project = "") => mcpLevels(role, shipped, parseRules(project, true));

test("builder loads context-mode only; linear, claude-docs and easel are off", () => {
  expect(lv("builder")).toEqual({ "claude-docs": "off", "context-mode": "on", easel: "off", "linear-server": "off" });
});
test("thinker and studio keep linear; studio's own `*  on` does not bring the connectors back", () => {
  expect(lv("thinker")["linear-server"]).toBe("on");
  expect(lv("thinker")["claude-docs"]).toBe("off");
  expect(lv("studio")).toEqual({ "claude-docs": "off", "context-mode": "on", easel: "off", "linear-server": "on" });
});
test("review (`*  off`) loads no server: context-mode is off with its whole plugin", () => {
  expect(lv("review")["context-mode"]).toBe("off");
  expect(lv("review")["linear-server"]).toBe("off");
});
test("a project rule turning linear on for lead wins over the shipped `*` off", () => {
  expect(lv("lead")["linear-server"]).toBe("off");
  expect(lv("lead", "lead mcp:linear-server on")["linear-server"]).toBe("on");
  expect(lv("builder", "lead mcp:linear-server on")["linear-server"]).toBe("off");
});
test("a project can't turn the required context-mode off", () => {
  expect(lv("builder", "builder mcp:context-mode off")["context-mode"]).toBe("on");
});
test("a server only a rule names is listed, and denied under its own and its plugin name", () => {
  const mine = parseRules("builder mcp:newsrv off", true);
  expect(mcpServers(shipped, mine)).toContain("newsrv");
  expect(deniedMcpServers(mcpLevels("builder", shipped, mine)).map((d) => d.serverName)).toEqual(expect.arrayContaining(["newsrv", "plugin:newsrv:newsrv"]));
});
test("deniedMcpServers names each server as the session lists it (probed on 2.1.326)", () => {
  const names = deniedMcpServers(lv("builder")).map((d) => d.serverName);
  expect(names).toContain("linear-server");
  expect(names).toContain("claude.ai Claude Docs");
  expect(names).not.toContain("plugin:context-mode:context-mode");
  expect(deniedMcpServers(lv("thinker")).map((d) => d.serverName)).not.toContain("linear-server");
});
test("ds skills resolve --all prints skillOverrides, mcp and deniedMcpServers; without --all the bare object stays", async () => {
  const out: string[] = [], log = console.log;
  console.log = (s: string) => out.push(String(s));
  try {
    expect(await run(["resolve", "nosuchproject", "builder", "--all"])).toBe(0);
    expect(await run(["resolve", "nosuchproject", "builder"])).toBe(0);
  } finally { console.log = log; }
  const full = JSON.parse(out[0]);
  expect(Object.keys(full).sort()).toEqual(["deniedMcpServers", "enabledPlugins", "mcp", "plugins", "skillOverrides"]);
  expect(full.plugins["context-mode@context-mode"]).toBe("on");
  expect(full.enabledPlugins).toEqual({});
  expect(full.mcp["linear-server"]).toBe("off");
  expect(full.deniedMcpServers.length).toBeGreaterThan(0);
  expect(JSON.parse(out[1]).mcp).toBeUndefined();
  expect(JSON.parse(out[1])).toEqual(full.skillOverrides);
});

// --- plugins (review-unit-no-receipt U1) ---
const pl = (role: string, project = "") => pluginLevels(role, shipped, parseRules(project, true));
test("review resolves the context-mode plugin off; builder, lead and every other role keep it on", () => {
  expect(pluginIds(shipped)).toContain("context-mode@context-mode");
  expect(pl("review")["context-mode@context-mode"]).toBe("off");
  expect(disabledPlugins(pl("review"))).toEqual({ "context-mode@context-mode": false });
  for (const role of ["builder", "lead", "thinker", "tester", "researcher", "reviewer", "studio"]) {
    expect(pl(role)["context-mode@context-mode"]).toBe("on");
    expect(disabledPlugins(pl(role))).toEqual({});
  }
});
test("a project row can't turn a required plugin rule around", () => {
  expect(pl("review", "review plugin:context-mode@context-mode on")["context-mode@context-mode"]).toBe("off");
  const ship = parseRules("builder  plugin:keep@mk  on  required\nbuilder  *  off");
  expect(pluginLevels("builder", ship, parseRules("builder plugin:keep@mk off", true))["keep@mk"]).toBe("on");
});
test("a plugin no rule names is never set, even under a role's `*  off`; a project rule may name a new one", () => {
  const ship = parseRules("review  *  off\nreview  plugin:a@m  off");
  expect(pluginLevels("review", ship, [])).toEqual({ "a@m": "off" });
  expect(pluginIds(parseRules("builder plugin:x* off"))).toEqual([]);
  expect(pluginLevels("builder", ship, parseRules("builder plugin:b@m off", true))).toEqual({ "a@m": "on", "b@m": "off" });
});
test("a role's own `*  off` row (the board's \"other skills\") never turns a named plugin off", () => {
  expect(pl("tester", "tester * off")["context-mode@context-mode"]).toBe("on");
  expect(pl("studio", "studio * off")["context-mode@context-mode"]).toBe("on");
  expect(pluginLevels("builder", parseRules("review  plugin:a@m  off\nbuilder  *  off"), [])).toEqual({ "a@m": "on" });
});
