// cardPlace (bin/board/card-place.ts): which Studio cards are Needs-you asks, loop notes, or held back.
import { describe, expect, test } from "bun:test";
import { cardPlace, debriefTopic } from "../../bin/board/card-place.ts";

const NOW = Date.parse("2026-11-13T12:00:00Z") / 1000;
const ago = (min: number) => new Date((NOW - min * 60) * 1000).toISOString().replace(/\.\d+Z$/, "Z");

describe("cardPlace", () => {
  test.each([
    ["studio.ctx by id", { id: "loop-studio.ctx-1abc", title: "studio.ctx", since: ago(500) }],
    ["old sweep studio.ctx", { id: "sweep-studio.ctx-1", title: "Studio context is high", since: ago(500) }],
    ["Restart failed by kind", { kind: "restart_failed", id: "x", title: "bank · lead: Restart failed" }],
    ["Reviews stopped by kind", { kind: "review_stopped", id: "x", title: "t" }],
    ["refusal by kind", { kind: "loop_refusal", id: "x", title: "Loop action refused" }],
    ["cancel failed by kind", { kind: "cancel_failed", id: "x", title: "Cancellation failed" }],
    ["account skills", { id: "sweep-account-skills.acct-12", title: "t" }],
    ["Agent broke again, past grace", { id: "loop-member_1-a", title: "sq · lead: Agent broke again", since: ago(30) }],
    ["Agent presence unknown, past grace", { id: "loop-member_1-a", title: "Agent presence unknown", since: ago(30) }],
    ["Agent broken kind, past grace", { kind: "agent_broken", id: "x", title: "t", since: ago(11) }],
    ["out of credits, past grace", { kind: "out_of_credits", id: "loop-studio.limit-x", title: "Studio out of credits", since: ago(60) }],
    ["Studio's account removed", { id: "loop-studio.limit-y", title: "Studio's account removed", since: ago(60) }],
    ["brief waits on the operator", { id: "brief-2026-11-16", title: "New morning brief" }],
    ["finished squad waits on Close squad", { kind: "poke_unanswered", reason: "all-done", id: "x", title: "Wrap-up stalled: Lead did not answer" }],
    ["a kept card with no since", { kind: "agent_broken", id: "x", title: "t" }],
  ])("needs: %s", (_n, a) => expect(cardPlace(a, NOW)).toBe("needs"));

  test.each([
    ["Red PR", { id: "loop-rca_wt-a", title: "sq · lead: Red PR still blocked" }],
    ["Poke unanswered, other reason", { kind: "poke_unanswered", reason: "compact", id: "x", title: "sq · lead: Poke unanswered" }],
    ["Poke unanswered, no reason", { kind: "poke_unanswered", id: "x", title: "sq · lead: Poke unanswered" }],
    ["Merge card from a rate limit", { kind: "merge_card", id: "x", title: "Auto-merge not armed", text: "GraphQL: API rate limit already exceeded" }],
    ["Unit spending a lot", { kind: "runaway_unit", id: "x", title: "Unit spending a lot" }],
    ["Host tidy", { kind: "host_tidy", id: "loop-cleanup_p-1", title: "Host tidy: p" }],
    ["Loop stalled", { id: "loop-stall-1", title: "Loop stalled" }],
  ])("note: %s", (_n, a) => expect(cardPlace(a, NOW)).toBe("note"));

  test("a debrief card is needs whatever its id, however old (never a loop note)", () => {
    for (const a of [{ reason: "debrief-x", id: "loop-debrief-x-abc", title: "Debrief: x" }, { id: "sweep-debrief-x-1", title: "Debrief: x" },
      { id: "sweep-debrief-x-1", title: "Debrief: x", since: ago(7 * 24 * 60) }, { reason: "debrief-x", id: "loop-debrief-x-abc", since: ago(7 * 24 * 60) }])
      expect(cardPlace(a, NOW)).toBe("needs");
  });
  test("debriefTopic: the reason, else a sweep id; a loop-debrief id alone is not parsed", () => {
    expect(debriefTopic({ reason: "debrief-a-b", id: "loop-debrief-a-b-1x" })).toBe("a-b");
    expect(debriefTopic({ id: "sweep-debrief-a-b-12" })).toBe("a-b");
    expect(debriefTopic({ id: "loop-debrief-a-b-1x" })).toBeNull();
    expect(debriefTopic({ id: "brief-2026-11-16" })).toBeNull();
  });

  test("U9: a squad's request refusal is a note for refusal_needs_min, then needs; any other refusal is needs", () => {
    const c = { kind: "loop_refusal", subject: "req:11246", squad: "sq", id: "x", title: "Loop action refused" };
    expect(cardPlace({ ...c, since: ago(5) }, NOW, 10, 240)).toBe("note");
    expect(cardPlace({ ...c, since: ago(239) }, NOW, 10, 240)).toBe("note");
    expect(cardPlace({ ...c, since: ago(241) }, NOW, 10, 240)).toBe("needs");
    expect(cardPlace({ ...c, subject: "start:sq", since: ago(5) }, NOW, 10, 240)).toBe("needs");
    expect(cardPlace({ ...c, squad: undefined, since: ago(5) }, NOW, 10, 240)).toBe("needs");
  });

  test("U2: a stopped review of a squad unit is a note for refusal_needs_min, then needs; with no squad it is needs", () => {
    const c = { kind: "review_stopped", squad: "sq", id: "x", title: "Reviews stopped: sq U1" };
    expect(cardPlace({ ...c, since: ago(5) }, NOW, 10, 240)).toBe("note");
    expect(cardPlace({ ...c, since: ago(241) }, NOW, 10, 240)).toBe("needs");
    expect(cardPlace({ ...c, squad: undefined, since: ago(5) }, NOW, 10, 240)).toBe("needs");
  });

  test("a self-healing card is held back until it has lasted needs_grace_min", () => {
    const a = { kind: "agent_broken", id: "x", title: "Agent broken" };
    expect(cardPlace({ ...a, since: ago(2) }, NOW)).toBe("later");
    expect(cardPlace({ ...a, since: ago(9) }, NOW)).toBe("later");
    expect(cardPlace({ ...a, since: ago(10) }, NOW)).toBe("needs");
    expect(cardPlace({ ...a, since: ago(2) }, NOW, 1)).toBe("needs");
    expect(cardPlace({ id: "loop-studio.limit-z", title: "Studio out of credits", since: ago(3) }, NOW)).toBe("later");
  });

  test("provider-billing-fallback U4: an account out of credits is Needs-you after the grace; the moved note is a note", () => {
    const card = { kind: "out_of_credits", id: "loop-credits.card_muse_default-k", title: "muse/default out of credits" };
    expect(cardPlace({ ...card, since: ago(3) }, NOW)).toBe("later");
    expect(cardPlace({ ...card, since: ago(10) }, NOW)).toBe("needs");
    expect(cardPlace({ kind: "credits_moved", id: "loop-credits.moved_muse_default-k", title: "muse/default out of credits", since: ago(60) }, NOW)).toBe("note");
  });

  test("claude-login-ended U3: a login-ended card is Needs-you at once; the moved note is a note", () => {
    const card = { kind: "login_ended", id: "loop-login.card_claude_x-k", title: "work: login ended" };
    expect(cardPlace({ ...card, since: ago(0) }, NOW)).toBe("needs");
    expect(cardPlace({ kind: "login_moved", id: "loop-login.moved_claude_x-k", title: "claude/x login ended", since: ago(60) }, NOW)).toBe("note");
  });

  test("studio.ctx and Restart failed never wait", () => {
    expect(cardPlace({ id: "loop-studio.ctx-1", title: "studio.ctx", since: ago(0) }, NOW)).toBe("needs");
    expect(cardPlace({ kind: "restart_failed", id: "x", title: "t", since: ago(0) }, NOW)).toBe("needs");
  });

  test("the brief and a finished squad never wait", () => {
    expect(cardPlace({ id: "brief-2026-11-16", title: "New morning brief", since: ago(0) }, NOW)).toBe("needs");
    expect(cardPlace({ kind: "poke_unanswered", reason: "all-done", id: "x", title: "t", since: ago(0) }, NOW)).toBe("needs");
  });
});

describe("U287 merge cards", () => {
  const card = { kind: "merge_card", id: "x", title: "Merge-ready PR left open", text: "merge it by hand" };
  test("another cause waits for the grace, then is Needs-you", () => {
    expect(cardPlace({ ...card, since: new Date((NOW - 60) * 1000).toISOString() }, NOW)).toBe("later");
    expect(cardPlace({ ...card, since: new Date((NOW - 3600) * 1000).toISOString() }, NOW)).toBe("needs");
  });
});

describe("loopnotes U3: cards that need a person", () => {
  const cards = [
    { id: "sweep-studio.adopt-1", title: "Studio terminal not adopted" },
    { id: "sweep-x-2", title: "Lifecycle failed" },
  ];
  test("an adopt card and a Lifecycle-failed card are later inside the grace, needs after it", () => {
    for (const c of cards) {
      expect(cardPlace({ ...c, since: new Date((NOW - 60) * 1000).toISOString() }, NOW)).toBe("later");
      expect(cardPlace({ ...c, since: new Date((NOW - 3600) * 1000).toISOString() }, NOW)).toBe("needs");
    }
  });
  test("an unrelated title is still a note", () => {
    expect(cardPlace({ id: "sweep-other-1", title: "Something else", since: new Date((NOW - 3600) * 1000).toISOString() }, NOW)).toBe("note");
  });
});
