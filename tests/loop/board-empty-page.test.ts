// The board of a project with no squads yet: a clean header (no doubled or trailing separator), a Squads
// empty state with a Start squad button and no legend, a one-line Flow empty state, and the project name
// linking to its repo. The page is the real web/board.html in happy-dom (board-mount.ts).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const root = join(import.meta.dir, "../..");
const empty = JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8"));
const board = { ...empty, project: "fixture", project_url: "https://github.com/example-owner/example-repo", page_version: "v1", squads: [], archived: [],
  flow: { ...empty.flow, cards: [], merged: [] }, gh: { ...(empty.gh || {}), ok: false } };

test("a project with no squads shows a tidy empty board", async () => {
  const r = await mount(board, false);
  const doc = r.window.document;
  try {
    const meta = doc.querySelector(".hdr .meta")!;
    expect(meta.textContent).not.toContain("· ·");
    expect(meta.textContent!.trim()).not.toMatch(/·$/);
    expect(meta.textContent).toContain("no PR status yet");
    expect(meta.querySelector("a.plink")?.getAttribute("href")).toBe("https://github.com/example-owner/example-repo");
    expect(doc.querySelector(".statelegend")).toBeNull();
    const sq = doc.getElementById("squads")!;
    expect(sq.querySelector(".empty")?.textContent).toContain("no squads yet");
    expect([...sq.querySelectorAll(".empty button")].map((b: any) => b.textContent)).toEqual(["Start squad"]);
    const flow = doc.getElementById("flow")!;
    expect(flow.querySelector(".empty")?.textContent).toContain("nothing in flight");
    expect(flow.querySelector(".flow-cols")).toBeNull();
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});

test("a filtered empty list keeps the filter wording and the legend shows only for a paused squad", async () => {
  const sq = { label: "fixture", topic: "p", status: "suspended", members: [], display_status: "suspended", display_key: "suspended", units: [] };
  const r = await mount({ ...board, squads: [sq] }, false);
  try {
    expect(r.window.document.querySelector(".statelegend")?.textContent).toContain("suspended:");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});
