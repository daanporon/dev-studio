// contract-guards.test.ts — orca-backend-alternatives U12b: pause, Lead health and the stray and duplicate
// guards for a squad off Orca, on the rig of contract-rig.ts (the contract fake, no Run, no dispatch):
// a member pauses (the checkpoint typed with `terminal.send`, its terminal closed with `terminal.close`) and
// resumes; a Lead idle with unread `messages` rows is restarted as "not responding", as on Orca; a plain
// shell and a second agent in a member's folder (`terminal.list`) are found and closed, or carded.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acknowledge, journalPath } from "../../bin/loop/pause/pause.ts";
import { sendMessage } from "../../bin/loop/messages/messages.ts";
import type { Row } from "../../bin/loop/core/store.ts";
import { live, LONG, pathOf, rig, sends, SQ, startLead, startMember, term, unit, type Rig } from "./contract-rig.ts";

// A backend that says each agent's state (the test sets it) and never confirms a turn, so a typed line
// leaves the state alone.
const NATIVE = { state: "native", turn_confirm: "none" } as const;
const events = (r: Rig, kind: string) => r.s.db.query("SELECT payload FROM events WHERE kind = ? AND project = 'fx'").all(kind) as Row[];
const alerts = (r: Rig) => {
  const f = join(r.s.root, "fx", "alerts.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { alerts: Row[] }).alerts : [];
};
async function until(r: Rig, ok: () => boolean, n = 12, step = 5) {
  for (let i = 0; i < n && !ok(); i++) await r.tick(1, step);
  expect(ok()).toBe(true);
}

describe("pause off Orca", () => {
  test("a member pauses from its member row and the contract, and resumes in a new terminal", async () => {
    const r = await rig(NATIVE);
    await startLead(r);
    const b = await startMember(r, "builder", "u1"), bp = pathOf(b), first = term(r, b).t.id;
    unit(r, b, "u1", "dispatched");
    r.fake.setState(first, "idle");
    const target = { project: "fx", squad: SQ, role: "builder", suffix: "u1" };
    r.s.pause({ scope: "member", ...target }, { by: "test" });
    const row = () => r.s.get("pause_members", target)!;
    await until(r, () => row().delivered_at != null);
    expect(row()).toMatchObject({ session: first, dispatch: "-" });   // no dispatch off Orca
    expect(sends(r.fake, first).some((t) => t.startsWith("dev-studio pause control:") && t.includes("dispatch -"))).toBe(true);
    // The agent writes its checkpoint and acknowledges from its own terminal.
    const file = journalPath(r.s, target);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `- checkpoint ${row().generation}: tests green; continue u1\n`);
    acknowledge(r.s, target, String(row().generation), first, "-", file, r.now());
    await until(r, () => row().state === "paused");
    expect(live(r.fake, bp)).toHaveLength(0);
    expect(r.fake.calls.some((c) => c.op === "terminal.close" && (c.req as { id: string }).id === first)).toBe(true);
    await r.tick(3);
    expect(live(r.fake, bp)).toHaveLength(0);         // paused: never started again
    r.s.resume({ scope: "member", ...target });
    await until(r, () => live(r.fake, bp).length === 1);
    expect(live(r.fake, bp)[0].t.id).not.toBe(first);
  }, LONG);
});

describe("Lead health off Orca", () => {
  test("a Lead idle with unread messages rows is restarted as not responding, as on Orca", async () => {
    const r = await rig(NATIVE);
    const l = await startLead(r);
    r.fake.setState(term(r, l).t.id, "idle");
    await r.tick();
    sendMessage(r.s, { to: { project: "fx", squad: SQ, role: "lead", suffix: "" },
      from: { project: "fx", squad: SQ, role: "builder", suffix: "u1", member: null }, subject: "stuck", body: "which base?", needsReply: true }, r.now());
    // As on Orca: SILENT_MIN (10) of unread mail at the prompt, POKES (2) pokes, then the agent_broken card
    // (the fixture's Studio is not running, so the card goes to the operator: nobody above can restart it).
    const card = () => r.acted.find((a) => a.kind === "alert" && a.subject === `${SQ}.lead` && (a.payload as Row).card === "agent_broken");
    await until(r, () => !!card(), 30, 60);
    expect(String((card()!.payload as Row).text)).toStartWith(`lead of ${SQ} (not responding since`);
    expect(String(card()!.episode)).toStartWith("silent|local::");
    expect(r.acted.filter((a) => a.kind === "poke" && String(a.episode ?? "").startsWith("silent:")).length).toBe(2);
  }, LONG);

  test("a Lead that reads its messages is left alone", async () => {
    const r = await rig(NATIVE);
    const l = await startLead(r);
    r.fake.setState(term(r, l).t.id, "idle");
    const m = sendMessage(r.s, { to: { project: "fx", squad: SQ, role: "lead", suffix: "" },
      from: { project: "fx", squad: SQ, role: "builder", suffix: "u1", member: null }, subject: "fyi", body: "merged" }, r.now());
    await r.tick(2, 60);
    r.s.db.run("UPDATE messages SET read_at = ? WHERE id = ?", [r.now(), m.message.id]);
    await r.tick(28, 60);
    expect(r.acted.some((a) => String(a.episode ?? "").includes("silent|local::"))).toBe(false);
  }, LONG);
});

describe("strays and duplicates off Orca", () => {
  test("a quiet plain shell in a member's folder is closed once the backend says it is idle", async () => {
    const r = await rig(NATIVE);
    const l = await startLead(r), lp = pathOf(l);
    const sh = await r.fake.call("terminal.create", { cwd: lp, env: {}, label: "shell", group: SQ });
    if (!sh.ok) throw new Error("create refused");
    r.fake.setState(sh.terminal.id, "idle");
    await r.tick();
    expect(JSON.parse(String(r.s.get("observed_terminals", { project: "fx", handle: sh.terminal.id })?.doc))).toMatchObject({ agent: false, extra: true, gen: null });
    await until(r, () => events(r, "stray_terminal_closed").length === 1, 16, 60);
    expect(live(r.fake, lp).map((x) => x.t.id)).toEqual([term(r, l).t.id]);   // the Lead's own terminal stays
  }, LONG);

  test("with no native state the loop cannot see into the shell: one card, the shell left open", async () => {
    const r = await rig({ state: "none" });
    const l = await startLead(r), lp = pathOf(l);
    const sh = await r.fake.call("terminal.create", { cwd: lp, env: {}, label: "shell", group: SQ });
    if (!sh.ok) throw new Error("create refused");
    await until(r, () => alerts(r).some((a) => a.handle === sh.terminal.id), 16, 60);
    expect(alerts(r).find((a) => a.handle === sh.terminal.id)?.question).toContain("cannot say whether something runs in it");
    expect(live(r.fake, lp)).toHaveLength(2);
    expect(events(r, "stray_terminal_closed")).toHaveLength(0);
  }, LONG);

  test("a second agent the loop started in a member's folder is closed once it is idle", async () => {
    const r = await rig(NATIVE);
    const l = await startLead(r), lp = pathOf(l), own = term(r, l).t.id;
    const dup = await r.fake.call("terminal.create", { cwd: lp, env: { DS_GEN: "an-older-start" }, label: "lead", group: SQ });
    if (!dup.ok) throw new Error("create refused");
    r.fake.setState(dup.terminal.id, "working");
    await r.tick(3);
    const doc = JSON.parse(String(r.s.get("observed_terminals", { project: "fx", handle: dup.terminal.id })?.doc));
    expect(doc).toMatchObject({ agent: true, extra: true, gen: "an-older-start" });
    expect(live(r.fake, lp)).toHaveLength(2);         // mid-turn: the loop waits
    r.fake.setState(dup.terminal.id, "idle");
    await until(r, () => events(r, "duplicate_agent_closed").length === 1, 16, 60);
    expect(live(r.fake, lp).map((x) => x.t.id)).toEqual([own]);
  }, LONG);
});
