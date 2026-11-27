// fulfil-cleanup.test.ts — host-disk-cleanup U2: the Host tidy card (kind cleanup.report): its text
// from seeded rows, invalid globs and refusals, raised and resolved through alerts.sh on the temp
// state root, and a retry when alerts.sh fails.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alertId } from "../../bin/loop/core/actuator.ts";
import cleanup, { cardText, human, needsYou } from "../../bin/loop/fulfil/cleanup.ts";
import type { Store } from "../../bin/loop/core/store.ts";
import { project, store } from "./cleanup-fixture.ts";

const AT = 2_000_000_000;
function seed(s: Store, cls: string, key: string, verdict: string, size: number, facts: Record<string, unknown> = {}, pid: number | null = null): void {
  s.db.query(`INSERT INTO observed_cleanup (project, class, key, path, pid, size_kb, first_seen, verdict, facts, observed_at)
    VALUES ('p', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(cls, key, cls === "e" ? "/t" : key, pid, size, AT, verdict, JSON.stringify(facts), AT);
}
function scan(s: Store, o: { ps?: string | null; loose?: number } = {}): void {
  s.db.query("INSERT OR REPLACE INTO observed_cleanup_scan (host, started_at, ms, entries, ps_error, loose_count, loose_kb, observed_at) VALUES ('h', ?, 1, 1, ?, ?, 40, ?)")
    .run(AT, o.ps ?? null, o.loose ?? 0, AT);
}
const action = (refused: string | null = null) => ({ project: "p", subject: "cleanup:p", kind: "cleanup.report", episode: "report:x", payload: { refused } });
const exec = (s: Store, refused: string | null = null) => cleanup.exec(action(refused), { store: s, project: "p", tick: 1, now: AT, fired: [], poked: new Set() } as never);
const cards = (s: Store) => {
  try { return (JSON.parse(readFileSync(join(s.root, "p", "alerts.json"), "utf8")) as { alerts?: Record<string, unknown>[] } & Record<string, unknown>[]); } catch { return null; }
};
const list = (s: Store): Record<string, unknown>[] => { const c = cards(s); return (Array.isArray(c) ? c : c?.alerts ?? []) as Record<string, unknown>[]; };

describe("card text", () => {
  test("the header splits removable disk from removable memory (class a RSS)", () => {
    const s = store();
    project(s, "p"); scan(s);
    seed(s, "a", "7:1", "removable", 40_000, { comm: "node", cwd: "/w/ds-p-gone" }, 7);
    seed(s, "a", "8:1", "removable", 62_400, { comm: "node", cwd: "/w/ds-p-gone" }, 8);
    expect(cardText(s, "p")!.split("\n")[1]).toBe("2 rows, 2 removable (0 kB disk, 100.0 MB memory).");
    const t = store();
    project(t, "p"); scan(t);
    seed(t, "c", "/h/x", "removable", 2048);
    expect(cardText(t, "p")!.split("\n")[1]).toBe("1 rows, 1 removable (2.0 MB disk).");
  });

  test("a partial size not measured yet reads ≥, in its row and its By-class total; a measured one (size_from du) does not", () => {
    const s = store();
    project(s, "p"); scan(s);
    seed(s, "c", "/h/a", "kept", 2048, { partial: true });
    seed(s, "c", "/h/b", "kept", 2048);
    seed(s, "d", "/w/ds-p-x", "kept", 1024, { partial: false });
    seed(s, "d", "/w/ds-p-big", "kept", 3_145_728, { partial: true, size_from: "du", size_at: AT });
    seed(s, "e", "/t/zzcache-*", "too new", 300, { count: 2, dirs: 2, partial: true, too_new: 2 });
    const lines = cardText(s, "p")!.split("\n");
    const by = lines.find((l) => l.startsWith("By class:"))!;
    expect(by).toContain("c helper checkouts 2 (≥ 4.0 MB)");
    expect(by).toContain("d worktrees 2 (3.0 GB)");
    expect(by).toContain("e glob files 1 (≥ 300 kB)");
    expect(lines).toContain("- [c] kept · ≥ 2.0 MB · /h/a");
    expect(lines).toContain("- [c] kept · 2.0 MB · /h/b");
    expect(lines).toContain("- [d] kept · 3.0 GB · /w/ds-p-big");
    expect(lines).toContain("- [e] too new · ≥ 300 kB · 2 files matching /t/zzcache-*");
    expect(lines).toContain("Glob /t/zzcache-*: 2 matched (≥ 300 kB), 0 removable, too new 2, not ours 0, in use 0.");
  });

  test("totals per class and verdict, removable first then by size, live members counted but not listed", () => {
    const s = store();
    project(s, "p"); scan(s, { loose: 3 });
    seed(s, "b", "/t/slug-big", "too new", 4096);
    seed(s, "b", "/t/slug-old", "removable", 100);
    seed(s, "d", "/w/ds-p-u1", "live member", 9999);
    seed(s, "a", "7:1", "in use by pid 9", 0, { comm: "node", cwd: "/w/ds-p-gone" }, 7);
    seed(s, "e", "/t/zzdebris-*", "removable", 12, { count: 4, removable: 2, too_new: 1, not_ours: 1, in_use: 0 });
    const t = cardText(s, "p")!;
    expect(t.split("\n")).toEqual([
      "Report only: the loop deletes and stops nothing here.",
      "5 rows, 2 removable (112 kB disk).",
      "By class: a processes 1 · b Claude temp dirs 2 (4.1 MB) · d worktrees 1 (9.8 MB) · e glob files 1 (12 kB)",
      "By verdict: removable 2 · in use 1 · too new 1 · live member 1",
      "Largest:",
      "- [b] removable · 100 kB · /t/slug-old",
      "- [e] removable · 12 kB · 4 files matching /t/zzdebris-*",
      "- [b] too new · 4.0 MB · /t/slug-big",
      "- [a] in use by pid 9 · 0 kB · pid 7 node in /w/ds-p-gone",
      "Glob /t/zzdebris-*: 4 matched (12 kB), 2 removable, too new 1, not ours 1, in use 0.",
      "Host: 3 loose files in the Claude temp root (40 kB), report only.",
      "Every row: ds observed cleanup --project p",
    ]);
  });

  test("more than 20 rows: the largest 20 of them", () => {
    const s = store();
    project(s, "p"); scan(s);
    for (let i = 0; i < 25; i++) seed(s, "b", `/t/s${String(i).padStart(2, "0")}`, "too new", i);
    const lines = cardText(s, "p")!.split("\n");
    expect(lines).toContain("Largest 20 of 25:");
    expect(lines.filter((l) => l.startsWith("- [b]"))).toHaveLength(20);
    expect(lines.find((l) => l.startsWith("- [b]"))).toBe("- [b] too new · 24 kB · /t/s24");
  });

  test("an invalid glob is listed as matching nothing; a refusal and a failed backend list say so", () => {
    const s = store();
    project(s, "p"); scan(s, { ps: "failed (boom)" });
    s.db.run("INSERT OR REPLACE INTO host_config (host, key, value, set_at) VALUES ('local', 'cleanup_tmp_globs', ?, 1)", ["/tmp/*"]);
    const t = cardText(s, "p", { refused: "project p has squads but nothing in loop.db names a worktree of it" })!;
    expect(t).toMatch(/^Invalid glob \/tmp\/\*: .+ \(matches nothing\)\.$/m);
    expect(t).toContain("Refused: project p has squads but nothing in loop.db names a worktree of it. Every row is report only.");
    expect(t).toContain("Refused for classes c and d: the backend worktree list failed (boom).");
  });

  test("apply (U3): the first line says so, the last 24 hours are totalled from the events, a failed row names its error", () => {
    const s = store();
    project(s, "p"); scan(s);
    s.db.run("INSERT OR REPLACE INTO host_config (host, key, value, set_at) VALUES ('local', 'host_tidy', ?, 1)", ["apply"]);
    seed(s, "d", "/w/ds-p-u2", "removable", 50, { act_error: "worktree busy" });
    const ev = (kind: string, payload: Record<string, unknown>, at: number) =>
      s.db.query("INSERT INTO events (at, project, kind, payload) VALUES (?, 'p', ?, ?)").run(at, kind, JSON.stringify(payload));
    ev("cleanup_removed", { class: "b", kb: 2048 }, AT - 60);
    ev("cleanup_removed", { class: "e", count: 3, kb: 10 }, AT - 60);
    ev("cleanup_stopped", { class: "a", pids: [7] }, AT - 60);
    ev("cleanup_failed", { class: "d", error: "worktree busy" }, AT - 60);
    ev("cleanup_removed", { class: "b", kb: 999 }, AT - 2 * 86400);
    const lines = cardText(s, "p", { now: AT })!.split("\n");
    expect(lines[0]).toBe("Apply: the loop removes what reads removable, one at a time, after reading it again.");
    expect(lines).toContain("Last 24 hours: removed 4 (2.0 MB), stopped 1 process, failed 1.");
    expect(lines).toContain("- [d] removable · 50 kB · /w/ds-p-u2 · failed: worktree busy");
  });

  test("nothing to report: no text", () => {
    const s = store();
    project(s, "p"); scan(s);
    seed(s, "d", "/w/ds-p-u1", "live member", 10);
    expect(cardText(s, "p")).toBeNull();
    expect([human(0), human(1023), human(1024), human(5 * 1024 * 1024)]).toEqual(["0 kB", "1023 kB", "1.0 MB", "5.0 GB"]);
  });
});

describe("the card", () => {
  test("raised with its title, kind and removable count under the project's one id; resolved when nothing is left", async () => {
    const s = store();
    project(s, "p"); scan(s);
    seed(s, "b", "/t/slug-old", "removable", 100);
    expect(await exec(s)).toEqual({ done: true });
    const id = alertId("cleanup:p", "card");
    const [c] = list(s).filter((x) => x.id === id);
    expect(c).toMatchObject({ title: "Host tidy: p", kind: "host_tidy", removable: 1, refused: null });
    expect(String(c.question)).toContain("/t/slug-old");
    s.db.query("UPDATE observed_cleanup SET gone_at = ?").run(AT);
    expect(await exec(s)).toEqual({ done: true });
    expect(list(s).filter((x) => x.id === id)).toEqual([]);
  });

  test("alerts.sh failing: a retry, not done", async () => {
    const s = store();
    project(s, "p"); scan(s);
    seed(s, "b", "/t/slug-old", "removable", 100);
    mkdirSync(join(s.root, "p", "alerts.json"));
    const r = await exec(s) as { done?: boolean; retry?: string };
    expect([r.done, r.retry]).toEqual([undefined, expect.stringContaining("not valid JSON")]);
  });
});
describe("shown only when it needs the operator (U8)", () => {
  const mode = (s: Store, v: string) => s.db.run("INSERT OR REPLACE INTO host_config (host, key, value, set_at) VALUES ('local', 'host_tidy', ?, 1)", [v]);
  const setup = (v: string | null) => { const s = store(); project(s, "p"); scan(s); if (v) mode(s, v); return s; };
  const id = alertId("cleanup:p", "card");
  const shown = (s: Store) => list(s).filter((x) => x.id === id);
  const kept = () => [["b", "/t/a", "too new"], ["a", "7:1", "in use by pid 9"], ["d", "/w/ds-p-x", "live member"], ["c", "/h/x", "report only"]] as const;
  test("apply, only kept rows: resolved, and a card shown before is resolved", async () => {
    const s = setup("report");
    seed(s, "b", "/t/old", "removable", 100);
    await exec(s);
    expect(shown(s)).toHaveLength(1);
    mode(s, "apply");
    for (const [c, k, v] of kept()) seed(s, c, k, v, 5);
    s.db.query("UPDATE observed_cleanup SET gone_at = ? WHERE key = '/t/old'").run(AT);
    expect(await exec(s)).toEqual({ done: true });
    expect(shown(s)).toEqual([]);
    expect(needsYou(s, "p")).toBeNull();
  });
  test("apply, removable rows but no act_error: resolved", async () => {
    const s = setup("apply");
    seed(s, "b", "/t/old", "removable", 100);
    await exec(s);
    expect(shown(s)).toEqual([]);
  });
  test("apply, a row with act_error: shown, first line names the failed count", async () => {
    const s = setup("apply");
    seed(s, "d", "/w/ds-p-u2", "removable", 50, { act_error: "busy" });
    seed(s, "d", "/w/ds-p-u3", "removable", 50, { act_error: "busy" });
    await exec(s);
    expect(String(shown(s)[0].question).split("\n")[0]).toBe("Needs you: 2 removals failed.");
  });
  test("report (or unset, or any non-apply value), a removable row: shown with the count and the mode", async () => {
    for (const v of ["report", null, "yes"]) {
      const s = setup(v);
      seed(s, "b", "/t/old", "removable", 100);
      for (const [c, k, vv] of kept()) seed(s, c, k, vv, 5);
      await exec(s);
      expect(String(shown(s)[0].question).split("\n")[0]).toBe(`Needs you: 1 removable, host_tidy is ${v === "yes" ? "yes" : "report"} — switch it to apply or leave it.`);
      expect(String(shown(s)[0].question)).toContain("Every row: ds observed cleanup --project p");
    }
  });
  test("report, no row removable: resolved", async () => {
    const s = setup("report");
    for (const [c, k, v] of kept()) seed(s, c, k, v, 5);
    await exec(s);
    expect(shown(s)).toEqual([]);
  });
  test("any mode: an invalid glob, a refusal or a scan ps_error shows the card", async () => {
    for (const m of ["apply", "report"]) {
      const s = setup(m);
      s.db.run("INSERT OR REPLACE INTO host_config (host, key, value, set_at) VALUES ('local', 'cleanup_tmp_globs', ?, 1)", ["/tmp/*"]);
      await exec(s);
      expect(String(shown(s)[0].question)).toMatch(/^Needs you: invalid glob \/tmp\/\*: /);
      const r = setup(m);
      await exec(r, "no worktrees");
      expect(String(shown(r)[0].question).split("\n")[0]).toBe("Needs you: refused: no worktrees.");
      const t = store(); project(t, "p"); scan(t, { ps: "failed (boom)" }); mode(t, m);
      await exec(t);
      expect(String(shown(t)[0].question).split("\n")[0]).toContain("Needs you: the backend worktree list failed (boom)");
    }
  });
});
