// The squads table without a Lead column: Lead trouble is a flag under the Phase pill, and the page count
// column is "Exposed". The page is the real web/board.html in happy-dom (board-mount.ts).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const root = join(import.meta.dir, "../..");
const empty = JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8"));
const quiet = { verdict: null, since_s: null };
const squad = (topic: string, over: any = {}) => ({ label: "fixture", topic, status: "running", display_status: "implementing",
  members: [{ role: "lead", label: "lead", state: "done" }], units: [], lead: quiet, ...over });
const pausedLead = [{ role: "lead", label: "lead", state: "done", pause: { state: "paused", reason: "paused by hand" } }];
const squads = [
  squad("healthy"),
  squad("hung", { lead: { verdict: "hung", since_s: 2040 } }),
  squad("deaf", { lead: { verdict: "unreachable", since_s: null } }),
  squad("lost", { members: [{ role: "lead", label: "lead", state: "gone" }] }),
  squad("asking", { status: "waiting-on-you", display_status: "waiting-on-you" }),
  squad("all-paused", { display_status: "paused", members: pausedLead }),
  squad("lead-paused", { members: pausedLead }),
  squad("capped", { limited: ["lead"], lead: { verdict: "hung", since_s: 2040 },
    members: [{ role: "lead", label: "lead", state: "done", limited: { line: "limit reached" } }] }),
];
const archived = [{ topic: "old", framing: "", closed_at: "2026-01-02T03:04:05Z", progress: { total: 1, done: 1 }, prs: [] }];
const board = { ...empty, project: "fixture", page_version: "v1", squads, archived,
  flow: { ...empty.flow, cards: [], merged: [] }, gh: { ...(empty.gh || {}), ok: false } };

test("Lead trouble flags under the Phase pill; there is no Lead column", async () => {
  const r = await mount(board, false);
  try {
    const doc = r.window.document;
    const row = (topic: string) => doc.getElementById("sq-fixture/" + topic)!;
    const flags = (topic: string) => [...row(topic).querySelectorAll(".leadflag")] as any[];
    const heads = [...doc.querySelectorAll(".row.head")].map((h: any) => [...h.children].map((c: any) => c.textContent).filter(Boolean));
    expect(heads[0]).toEqual(["Squad", "Phase", "Units", "Open PRs", "Exposed", "Spent"]);
    expect(doc.querySelector(".row.head .c-open")!.getAttribute("title")).toBe("pages this squad runs for you (ds expose)");
    // Every row has one cell per header cell.
    expect(row("healthy").children.length).toBe(doc.querySelector(".row.head")!.children.length);
    expect(flags("healthy")).toEqual([]);
    const [hung] = flags("hung");
    expect(hung.textContent).toBe("Lead hung 34m");
    expect(hung.className).toBe("flag leadflag");
    expect(hung.getAttribute("title")).toContain("past the hung limit");
    expect(hung.closest("span:not(.leadflag)").querySelector(".pill")).not.toBeNull();
    expect(flags("deaf").map((f) => f.textContent)).toEqual(["Lead unreachable"]);
    expect(flags("lost").map((f) => f.textContent)).toEqual(["Lead gone"]);
    expect(row("asking").textContent!.split("waiting on you").length - 1).toBe(1);
    expect(flags("all-paused")).toEqual([]);
    const [paused] = flags("lead-paused");
    expect(paused.textContent).toBe("Lead paused");
    expect(paused.className).toBe("flag leadflag warn");
    expect(paused.getAttribute("title")).toBe("paused by hand");
    expect(flags("capped")).toEqual([]);
    expect(row("capped").textContent).toContain("usage limit");

    const arch = doc.getElementById("archived")!;
    arch.open = true; arch.dispatchEvent(new r.window.Event("toggle"));
    await new Promise((res) => setTimeout(res, 30));
    const [head, old] = [...arch.querySelectorAll(".row")] as any[];
    expect([...head.children].map((c: any) => c.textContent).filter(Boolean)).toEqual(["Squad", "Phase", "Units", "PRs", "Exposed", "Spent"]);
    expect(old.children.length).toBe(head.children.length);
    expect(old.children[2].textContent).toBe("archivedclosed 2026-01-02");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});
