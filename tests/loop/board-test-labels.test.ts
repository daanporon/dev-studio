// board-test-labels.test.ts — the live board never lists a project the loop treats as a test project
// (zz*, sstate-*, pickseam-*, _*); a temp state root (every test) keeps every label.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../../bin/loop/core/store.ts";
import { buildBoard, isLiveRoot } from "../../bin/board/board-data.ts";

const NOW = Math.floor(Date.now() / 1000);
const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardlabels-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const LABELS = ["realp", "zzx_1", "sstate-jrnl-1"];
for (const p of LABELS) mkdirSync(join(root, p, "squads"), { recursive: true });
const s = open(root);
for (const p of LABELS) {
  s.upsert("projects", { label: p }, { observed_at: NOW });
  const a = { id: `a-${p}`, title: `card ${p}`, kind: "note", options: [], squad: "" };
  s.upsert("observed_alerts", { project: p, id: a.id }, { doc: JSON.stringify(a), observed_at: NOW });
}
s.close();

const seen = (b: any) => new Set<string>(JSON.stringify(b).match(/a-(realp|zzx_1|sstate-jrnl-1)/g)?.map((x) => x.slice(2)));

test("a temp root keeps every project's cards", () => {
  expect(isLiveRoot(root)).toBe(false);
  expect([...seen(buildBoard("", "", root))].sort()).toEqual([...LABELS].sort());
});

test("the live root lists only non-test projects", () => {
  expect([...seen(buildBoard("", "", root, true))]).toEqual(["realp"]);
});

test("an explicit label is honored on the live root", () => {
  expect([...seen(buildBoard("zzx_1", "", root, true))]).toEqual(["zzx_1"]);
});
