// cleanup-card.test.ts — host-disk-cleanup U2 end to end: the loop's own tick runs the cleanup
// observer (fixture roots), reconciler and fulfiller, and the project's one Host tidy card appears,
// follows its rows and resolves. AE6: the run changes nothing on disk and signals no process.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alertId, LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import cleanupCard from "../../bin/loop/fulfil/cleanup.ts";
import { cleanupObserver } from "../../bin/loop/observers/cleanup.ts";
import { mangle } from "../../bin/loop/observers/orca.ts";
import reconciler from "../../bin/loop/reconcilers/cleanup.ts";
import type { Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { aged, fakeProc, observedWt, opts, project, store, tmp } from "./cleanup-fixture.ts";

const AT = Math.floor(Date.now() / 1000), H = 3600;
let kills: ReturnType<typeof spyOn>;
beforeEach(() => { kills = spyOn(process, "kill"); });
afterEach(() => kills.mockRestore());

function world(labels: string[]) {
  const s = store(), ws = tmp(), root = tmp();
  for (const p of labels) project(s, p);
  const ob = cleanupObserver(opts({ proc: fakeProc([]), tmpRoot: root }));
  const act = new LoopActuator({ orca: new FakeBackend(), fulfillers: [cleanupCard] });
  const loop = new Loop(s, { observers: [ob], reconcilers: [reconciler, cleanupCard] }, act, { projects: () => labels });
  loop.boot(AT);
  // A pass: one tick starts the scan, the next writes it and acts on the verdicts.
  const pass = async (at: number) => { await loop.tick(at); await ob.idle(); await loop.tick(at + 1); await act.drain(); };
  const slug = (p: string, name: string, gone = true) => {
    observedWt(s, p, `${p}-${name}`, `${ws}/ds-${p}-${name}`, gone ? AT - 900 : null);
    const d = join(root, mangle(`${ws}/ds-${p}-${name}`));
    mkdirSync(d); writeFileSync(join(d, "out"), "x".repeat(4096)); aged(join(d, "out"), AT - 72 * H); aged(d, AT - 72 * H);
    return d;
  };
  return { s, ws, root, pass, slug };
}
const cards = (s: Store, p: string): { id: string; title: string; question: string; kind: string }[] => {
  try { return JSON.parse(readFileSync(join(s.root, p, "alerts.json"), "utf8")).alerts ?? []; } catch { return []; }
};
function snapshot(...dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name), st = statSync(p, { throwIfNoEntry: false });
      out.push(`${p} ${st?.size ?? "-"} ${st?.mtimeMs ?? "-"}`);
      if (e.isDirectory()) walk(p);
    }
  };
  dirs.forEach(walk);
  return out.sort();
}

describe("Host tidy card", () => {
  test("appears with both rows, follows them, resolves; one id per project; nothing on disk changes and nothing is signalled (AE6)", async () => {
    const { s, ws, root, pass, slug } = world(["p", "q"]);
    const a = slug("p", "gone1"), b = slug("p", "gone2");
    slug("q", "gone3");
    mkdirSync(join(ws, "keep")); writeFileSync(join(ws, "keep", "f"), "x");
    const before = snapshot(root, ws);

    await pass(AT);
    const id = alertId("cleanup:p", "card");
    const [card] = cards(s, "p");
    expect(cards(s, "p").map((c) => [c.id, c.title, c.kind])).toEqual([[id, "Host tidy: p", "host_tidy"]]);
    expect(card.question).toContain("2 rows, 2 removable");
    expect(card.question).toContain(a);
    expect(card.question).toContain(b);
    expect(cards(s, "q").map((c) => c.id)).toEqual([alertId("cleanup:q", "card")]);
    expect(alertId("cleanup:q", "card")).not.toBe(id);
    expect(snapshot(root, ws)).toEqual(before);
    expect(kills).not.toHaveBeenCalled();

    // The same rows again: the same card, unchanged.
    await pass(AT + H);
    expect(cards(s, "p")).toEqual([card]);

    // One row goes (by hand, outside the loop): the card's text follows, under the same id.
    rmSync(b, { recursive: true });
    await pass(AT + 2 * H);
    expect(cards(s, "p").map((c) => c.id)).toEqual([id]);
    expect(cards(s, "p")[0].question).toContain("1 rows, 1 removable");
    expect(cards(s, "p")[0].question).not.toContain(b);

    // The last one goes: the card resolves; q's card stays.
    rmSync(a, { recursive: true });
    await pass(AT + 3 * H);
    expect(cards(s, "p")).toEqual([]);
    expect(cards(s, "q")).toHaveLength(1);
    expect(kills).not.toHaveBeenCalled();
  });
});
