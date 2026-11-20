// A project with no squads still links its name to its repo: board-data falls back to the `projects` row's
// owner/name, then to the config row the GitHub observer wrote for the project's home_repo.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoard } from "../../bin/board/board-data.ts";
import { open } from "../../bin/loop/core/store.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function board(row: Record<string, unknown>, cfg?: string) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardurl-")); roots.push(root);
  mkdirSync(join(root, "p"), { recursive: true });
  writeFileSync(join(root, "p", "dispatcher.json"), "{}");
  const s = open(root);
  s.upsert("projects", { label: "p" }, { observed_at: 1, ...row });
  if (cfg) s.upsert("config", { project: "p", file: "github", key: "repo:path:/r/p" }, { value: cfg, observed_at: 1 });
  s.close();
  return buildBoard("p", "", root) as any;
}

test("no squads: project_url comes from the projects row's owner/name", () => {
  expect(board({ home_repo: "path:/r/p", owner: "example-owner", name: "example-repo" }).project_url).toBe("https://github.com/example-owner/example-repo");
});
test("no squads, no owner/name: it comes from the observer's config row", () => {
  expect(board({ home_repo: "path:/r/p" }, "example-owner/example-repo").project_url).toBe("https://github.com/example-owner/example-repo");
});
test("nothing known: no link", () => {
  expect(board({ home_repo: "path:/r/p" }).project_url).toBeNull();
});
