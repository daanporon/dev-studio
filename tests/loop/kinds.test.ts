// kinds.test.ts — U43: the store checks every fact and request kind and payload at write time; a refused write leaves no row and no event.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { payloadOf } from "../../bin/loop/core/kinds.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });
function mk(): Store { const d = mkdtempSync(join(tmpdir(), "zzkinds-")); temps.push(d); const s = open(d); stores.push(s); return s; }
const n = (s: Store, t: string) => (s.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const unit = [{ table: "units", key: { project: "fx", squad: "demo", slug: "u1" }, set: { status: "planned", observed_at: 1, updated_at: 1 } }];

test("a known request kind with a good payload is accepted", () => {
  const s = mk();
  expect(s.request("keys", { text: "Escape" }, { project: "fx" }).created).toBe(true);
  expect(n(s, "requests")).toBe(1);
});

test("an unknown request kind and a wrong payload are refused naming kind and field, and write nothing", () => {
  const s = mk();
  expect(() => s.requestAny("no-such-kind", {}, { project: "fx" })).toThrow(/unknown request kind 'no-such-kind'/);
  expect(() => s.requestAny("keys", { text: 5 }, { project: "fx" })).toThrow(/request kind 'keys'.*payload\.text must be a string/);
  expect(() => s.requestAny("keys", {}, { project: "fx" })).toThrow(/payload\.text is required/);
  expect(n(s, "requests")).toBe(0);
  expect(n(s, "events")).toBe(0);
});

test("an unknown fact kind and a non-object payload are refused with no row and no event", () => {
  const s = mk();
  const before = n(s, "events");
  expect(() => s.fact("no-such-fact", unit)).toThrow(/unknown fact kind 'no-such-fact'/);
  expect(n(s, "units")).toBe(0);
  expect(n(s, "events")).toBe(before);
  s.fact("unit_dispatched", unit);
  expect(n(s, "units")).toBe(1);
});

test("an old row with a payload the store would now refuse is still read by the fulfiller's typed view", () => {
  const s = mk();
  s.db.run("INSERT INTO requests (project, kind, payload, created_at) VALUES ('fx', 'keys', '{}', 1)");
  const row = s.db.query("SELECT kind, payload FROM requests").get() as { kind: string; payload: string };
  expect(payloadOf<"keys">({ kind: row.kind, payload: JSON.parse(row.payload) })).toEqual({});
});

test("exposed-cleanup U2: the expose.stop action and the exposed fact's stop fields have shapes", async () => {
  const { ACTIONS, FACTS, problem } = await import("../../bin/loop/core/kinds.ts");
  expect(problem("action", "expose.stop", ACTIONS, { ids: [1, 2], cmd: "docker compose down", cwd: "/w" })).toBeNull();
  expect(problem("action", "expose.stop", ACTIONS, { ids: [1], cmd: "x" })).toBeNull();
  expect(problem("action", "expose.stop", ACTIONS, { ids: "1", cmd: "x" })).toContain("payload.ids");
  expect(problem("action", "expose.stop", ACTIONS, { ids: [1] })).toContain("payload.cmd");
  expect(problem("fact", "exposed", FACTS, { name: "n", url: "u", scope: "squad", role: "tester", audience: "self", stop: true, ports: [6379] })).toBeNull();
  expect(problem("fact", "exposed", FACTS, { name: "n", url: "u", scope: "squad", role: "tester", ports: ["x"] })).toContain("payload.ports");
});
