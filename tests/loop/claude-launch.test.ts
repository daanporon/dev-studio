// The Claude launch line (bin/loop/drivers/claude-launch.ts).
import { expect, test } from "bun:test";

test("the contract's launch line execs claude for every account form; Orca's lines do not exec", async () => {
  const { claudeLine } = await import("../../bin/loop/drivers/claude-launch.ts");
  const base = { gates: "/g", args: ["--model", "opus"], utf8: true, exec: true };
  expect(claudeLine({ ...base, config: { system: true } })).toStartWith("exec env -u CLAUDE_CONFIG_DIR PATH=");
  expect(claudeLine({ ...base, config: { home: "/h" } })).toStartWith("exec env CLAUDE_CONFIG_DIR=");
  expect(claudeLine({ ...base, config: null })).toStartWith("exec env PATH=");
  expect(claudeLine({ ...base, config: null, exec: false })).toStartWith("PATH=");
});
