import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "..", "..", "web", "board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
const STOP_WHY = { restart: "restart asked for" };
const pauseLabel = (s: string) => ({ pausing: "Pausing", paused: "Paused", resuming: "Resuming" } as Record<string, string>)[s] ?? s;
const crewDot: (s: any, m: any) => { cls: string; why: string } = new Function("STOP_WHY", "pauseLabel", `${cut("crewDot")} return crewDot;`)(STOP_WHY, pauseLabel);
const squad = { lead: { verdict: null } };
const member = { role: "builder", state: "working" };

test("a healthy working, waiting or done member keeps its run-state dot", () => {
  expect(crewDot(squad, member)).toEqual({ cls: "working spin", why: "" });
  expect(crewDot(squad, { ...member, state: "waiting" }).cls).toBe("waiting");
  expect(crewDot(squad, { ...member, state: "done" }).cls).toBe("done");
});

test("red: usage limit, a stuck Lead and a gone member name their reason", () => {
  expect(crewDot(squad, { ...member, limited: { line: "100% session", switching: false } })).toEqual({ cls: "bad", why: "usage limit: 100% session" });
  const lead = { role: "lead", state: "done" };
  for (const verdict of ["hung", "unreachable", "idle with mail"]) {
    const d = crewDot({ lead: { verdict } }, lead);
    expect(d.cls).toBe("bad");
    expect(d.why).toContain(verdict === "idle with mail" ? "idle with Run mail" : verdict);
  }
  expect(crewDot({ lead: { verdict: "hung" } }, { role: "thinker", state: "done" }).cls).toBe("done"); // the verdict is the Lead's
  expect(crewDot(squad, { ...member, state: "gone" })).toEqual({ cls: "bad", why: "gone: no live session" });
});

test("amber: switching accounts, pause, restart pending, settled, duplicate sessions, unplaced", () => {
  expect(crewDot(squad, { ...member, limited: { line: "x", switching: true } })).toEqual({ cls: "warnd", why: "usage limit: moving to another account" });
  expect(crewDot(squad, { ...member, pause: { state: "paused", reason: "operator" } })).toEqual({ cls: "warnd", why: "Paused: operator" });
  expect(crewDot(squad, { ...member, stop_checkpoint: { why: "restart" } }).why).toBe("restart pending: restart asked for");
  expect(crewDot(squad, { ...member, state: "⚠ settled" }).why).toBe("dispatch settled: waiting on the Lead");
  expect(crewDot(squad, { ...member, terminals: 2 }).why).toBe("2 live sessions in one worktree");
  expect(crewDot(squad, { ...member, state: "unplaced" }).why).toBe("no worktree yet");
  expect(crewDot(squad, { ...member, pause: { state: "active" } }).cls).toBe("working spin");
});

test("precedence: a limit beats a pause; red never spins", () => {
  const d = crewDot(squad, { ...member, limited: { line: "L", switching: false }, pause: { state: "paused" }, state: "working" });
  expect(d.cls).toBe("bad");
  expect(d.cls).not.toContain("spin");
});
