// contract-limited.test.ts — U35: the `limited` rows of squads off Orca, from their members' screen tails.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { contractLimited } from "../../bin/loop/capacity/contract-limited.ts";

const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function fixture(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzclim-"));
  temps.push(d);
  const s = open(d);
  stores.push(s);
  return s;
}
function seed(s: Store, backend: string, topic: string, wt: string, tail: string, agent = "claude", state = "idle"): void {
  s.upsert("squads", { project: "realp", topic }, { backend, observed_at: T, updated_at: T });
  s.upsert("members", { project: "realp", squad: topic, role: "builder", suffix: topic }, { wt, agent, status: "active", observed_at: T, updated_at: T });
  s.upsert("observed_workers", { project: "realp", wt }, { state, since: T - 3600, last_output_at: T - 3600, tail, observed_at: T });
}
const DIALOG = [
  "  ⎿  You've hit your session limit · resets 3pm (Europe/Berlin)", "",
  "  What do you want to do?", "  ❯ 1. Stop and wait for limit to reset", "    2. Wait here", "    3. Add funds", "",
  "  Enter to confirm · Esc to cancel", "",
].join("\n");
const LOGIN = "  ⎿  Not logged in · Please run /login\n";

test("a tmux member's usage-limit dialog gives a limited row; the same screen on Orca gives none", () => {
  const s = fixture();
  seed(s, "tmux", "t1", "local::/w/t1", DIALOG);
  seed(s, "orca", "o1", "s::/w/o1", DIALOG);
  const rows = contractLimited(s, T).split("\n").filter(Boolean);
  expect(rows.length).toBe(1);
  const f = rows[0].split("\t");
  expect(f[0]).toBe("local::/w/t1");
  expect(f[2]).toContain("hit your session limit");
  expect(f[3]).toBe("dialog");
});

test("an ended login on herdr is a login row; a quiet screen and a working recent one give none", () => {
  const s = fixture();
  seed(s, "herdr", "h1", "local::/w/h1", LOGIN);
  seed(s, "tmux", "t2", "local::/w/t2", "all quiet\n");
  const rows = contractLimited(s, T).split("\n").filter(Boolean);
  expect(rows.length).toBe(1);
  expect(rows[0].split("\t").slice(0, 1)).toEqual(["local::/w/h1"]);
  expect(rows[0]).toMatch(/\t-\tlogin$/);
});
