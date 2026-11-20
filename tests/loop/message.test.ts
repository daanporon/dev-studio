// message.test.ts — U75: a message that fails goes back to its sender. send-role, send-peer and
// notify-squads are requests the loop fulfils by running the script again as a child (fulfil/message.ts).
// Hermetic: a copy of tests/fixtures/loop/state, a fake Orca, one fake child script.
//   - a request that ends failed (exit 2 or 3, retries given up) pokes the terminal in `from` with one
//     line naming what was not delivered; a card only when that poke fails
//   - a send-peer refused for the cross-run pin is sent once more from the target squad's pane
//   - a request with no project takes the sender's, from its worktree name
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
let tries: string | undefined;
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (tries === undefined) delete process.env.DS_LOOP_SEND_TRIES; else process.env.DS_LOOP_SEND_TRIES = tries;
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzmsg-"));
  temps.push(d);
  cpSync(join(ROOT, "tests", "fixtures", "loop", "state"), d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}

// The child: logs how it ran, then does what the `mode` file in the state root says (default ok).
//   refuse   "no squad 'x' in 'fx'" on stderr, exit 2
//   crossrun refused with Orca's cross-run text (exit 1) unless it runs --from a pane (DS_ORCA_FROM is set); then ok
//   ok       prints "did <args>"
const mode = (s: Store, m: string) => writeFileSync(join(s.root, "mode"), m);
function child(s: Store): string {
  const f = join(s.root, "child.sh");
  writeFileSync(f, `#!/usr/bin/env bash
printf 'from=%s orcafrom=%s args=%s\\n' "\${ORCA_TERMINAL_HANDLE:-}" "\${DS_ORCA_FROM:-}" "$*" >> "$DS_STATE_ROOT/child.log"
case "$(cat "$DS_STATE_ROOT/mode" 2>/dev/null)" in
  refuse) echo "directory: no squad 'x' in 'fx'" >&2; exit 2 ;;
  crossrun) [ -n "\${DS_ORCA_FROM:-}" ] || { echo "orca adapter: send-run-worker NOT delivered — cross-run delivery needs a sender with no dispatch" >&2; exit 1; }; echo "did $*" ;;
  *) echo "did $*" ;;
esac
`);
  chmodSync(f, 0o755);
  return f;
}
const runs = (s: Store) => (existsSync(join(s.root, "child.log")) ? readFileSync(join(s.root, "child.log"), "utf8").trim().split("\n") : []);
const replay = (s: Store, kind: string, key: string, args: string[], over: Record<string, unknown> = {}) =>
  ({ kind, key, argv: [child(s), ...args], cwd: s.root, from: "term_asker", ...over });
const req = (s: Store, kind: string, key: string, args: string[], over: Record<string, unknown> = {}, row: Record<string, unknown> = {}) =>
  Number(s.request(kind, replay(s, kind, key, args, over), { key, ...row }).row.id);
const observe = (s: Store, handle = "term_asker") => s.db.run("INSERT INTO observed_terminals (project, handle, observed_at) VALUES ('fx', ?, 100)", [handle]);
const get = (s: Store, id: number) => s.db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row;

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
function rig(s: Store) {
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  return { orca, tick };
}
const pokes = (o: FakeOrca) => o.of("poke-terminal").map((c) => c.args);
const cards = (s: Store, project = "fx") => {
  const f = join(s.root, project, "alerts.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((a) => a.title === "Message not delivered") : [];
};

describe("a failed message goes back to its sender", () => {
  test("a send-role whose child exits 2 pokes its sender once, with the error, and raises no card", async () => {
    const s = imported(), a = rig(s);
    mode(s, "refuse"); observe(s);
    const id = req(s, "send-role", "send-role:fx:k", ["x", "lead", "WAIT for #1", "body"], {}, { project: "fx", squad: "x" });
    await a.tick(T);
    expect(get(s, id).done_at).toBe(T);
    expect(JSON.parse(String(get(s, id).result)).ok).toBe(false);
    expect(pokes(a.orca)).toEqual([["term_asker",
      `dev-studio loop: your send-role to x/lead "WAIT for #1" was NOT delivered: directory: no squad 'x' in 'fx'. Fix it and send again.`]]);
    expect(cards(s)).toEqual([]);
    await a.tick(T + 1); await a.tick(T + 60);
    expect(pokes(a.orca)).toHaveLength(1);
    expect(runs(s)).toHaveLength(1);
  });

  test("with no live sender terminal it raises one card naming the sender, the target and the subject", async () => {
    const s = imported(), a = rig(s);
    mode(s, "refuse"); observe(s);
    a.orca.fail("poke-terminal", { code: 1, out: "", err: "orca adapter: poke-terminal: terminal send failed for term_asker" });
    req(s, "send-role", "send-role:fx:k", ["x", "lead", "WAIT for #1", "body"], {}, { project: "fx", squad: "x" });
    await a.tick(T);
    expect(pokes(a.orca)).toHaveLength(1);
    const c = cards(s);
    expect(c).toHaveLength(1);
    expect(String(c[0].question)).toContain("term_asker");
    expect(String(c[0].question)).toContain("x/lead");
    expect(String(c[0].question)).toContain("WAIT for #1");
    await a.tick(T + 1);
    expect(cards(s)).toHaveLength(1);
    expect(pokes(a.orca)).toHaveLength(1);
  });

  test("a sender that is no known role terminal (a shell tab) is never typed into: a card instead", async () => {
    const s = imported(), a = rig(s);
    mode(s, "refuse");
    req(s, "send-role", "send-role:fx:k", ["x", "lead", "subj", "body"], {}, { project: "fx", squad: "x" });
    await a.tick(T);
    expect(pokes(a.orca)).toEqual([]);
    expect(cards(s)).toHaveLength(1);
  });

  test("a request with no project gets the sender's, from its worktree name", async () => {
    const s = imported(), a = rig(s);
    mode(s, "refuse");
    a.orca.fail("poke-terminal", { code: 1, out: "", err: "gone" });
    req(s, "send-role", "send-role::k", ["x", "lead", "subj", "body"], { cwd: "/w/ds-fx-thinker-demo" }, { squad: "x" });
    await a.tick(T);
    expect(cards(s, "fx")).toHaveLength(1);
  });

  test("a send-peer refused for the cross-run pin is sent again from the target squad's pane and ends done", async () => {
    const s = imported(), a = rig(s);
    mode(s, "crossrun");
    s.upsert("coordinators", { project: "fx", squad: "demo" }, { run_id: "run_demo", handle: "term_pane", bound_at: T, created_at: T });
    const id = req(s, "send-peer", "send-peer:fx:k", ["demo", "thinker", "subj", "body", "--project", "fx"], {}, { project: "fx", squad: "demo" });
    await a.tick(T);
    expect(get(s, id).done_at).toBe(T);
    expect(JSON.parse(String(get(s, id).result)).ok).toBe(true);
    const pane = String(s.get("coordinators", { project: "fx", squad: "demo" })?.handle);
    expect(pane).not.toBe("");
    expect(runs(s).map((l) => l.replace(/ args=.*/, ""))).toEqual(["from=term_asker orcafrom=", `from=term_asker orcafrom=${pane}`]);
    expect(pokes(a.orca)).toEqual([]);
  });

  test("a send-peer queued without --project is still re-sent from the target pane (the sender's project)", async () => {
    const s = imported(), a = rig(s);
    mode(s, "crossrun");
    s.upsert("coordinators", { project: "fx", squad: "demo" }, { run_id: "run_demo", handle: "term_pane", bound_at: T, created_at: T });
    const id = req(s, "send-peer", "send-peer::k", ["demo", "thinker", "subj", "body"], { cwd: "/w/ds-fx-thinker-demo" }, { squad: "demo" });
    await a.tick(T);
    expect(JSON.parse(String(get(s, id).result)).ok).toBe(true);
    expect(runs(s)).toHaveLength(2);
  });

  test("with no bound pane on the target squad a cross-run refusal pokes the sender", async () => {
    const s = imported(), a = rig(s);
    mode(s, "crossrun"); observe(s);
    req(s, "send-peer", "send-peer:fx:k", ["demo", "thinker", "subj", "body", "--project", "fx"], {}, { project: "fx", squad: "demo" });
    await a.tick(T);
    expect(runs(s)).toHaveLength(1);
    expect(pokes(a.orca)).toHaveLength(1);
    expect(pokes(a.orca)[0][1]).toContain("your send-peer to demo/thinker \"subj\" was NOT delivered: orca adapter: send-run-worker NOT delivered — cross-run delivery needs a sender with no dispatch");
  });
});
