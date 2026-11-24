// limits.test.ts — U8: limit recognition (limits/fingerprints.ts) and the limits reconciler.
// The fingerprint cases port tests/orca-adapter.sh's `limited` scenarios by name (screens copied
// from its strings; the real dialogs from tests/fixtures/limit-dialog-*.txt); the reconciler cases
// port the removed sweep tests step 3 and sweep-required U6/U8/U10/U11/U12/U15/U16, on a temp copy of
// tests/fixtures/loop/state with a fake picker.
import { beforeAll, afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempRoot } from "./temp-roots.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { importMarkers } from "../../bin/loop/db/import-markers.ts";
import { alertRows } from "../../bin/loop/db/import-json.ts";
import { alertId } from "../../bin/loop/core/actuator.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Actuator, type Reconciler, type TickCtx } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { wake } from "../../bin/loop/pause/wake.ts";
import { since } from "../../bin/loop/core/events.ts";
import { dialog, LIMIT_RE, limitReset, scan, type Gate } from "../../bin/loop/capacity/fingerprints.ts";
import pending, { retireCapacityFacts } from "../../bin/loop/fulfil/pending.ts";
import request from "../../bin/loop/fulfil/request.ts";
import { accountBlock, pick as pickAccount } from "../../bin/loop/capacity/pick.ts";
import alertsReconciler, { dropAlerts } from "../../bin/loop/reconcilers/alerts.ts";
import { makeLimits, pickLoop, type Pick, type PickArgs } from "../../bin/loop/reconcilers/limits.ts";
import record from "../../bin/loop/reconcilers/record.ts";
import { decide } from "../../bin/loop/core/decide.ts";
import { cleanupGlobs, limit, limitInt, limitLine } from "../../bin/loop/settings/limits.ts";
import { clearCredits, creditsHold } from "../../bin/loop/capacity/credits.ts";
import { setAccountEnabled } from "../../bin/loop/capacity/accounts.ts";
import { CHECKPOINT_S } from "../../bin/loop/pause/pause.ts";

// U150: a transient refusal is tried again every 15 minutes (DS_LOOP_RETRY_S); these tests step
// a retry one tick at a time. The spacing itself is tested in actuator.test.ts ("refusals").
beforeAll(() => { process.env.DS_LOOP_RETRY_S = "1"; });
afterAll(() => { delete process.env.DS_LOOP_RETRY_S; });

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const SCREENS = join(ROOT, "tests", "fixtures", "loop", "screens");
const screen = (f: string) => readFileSync(join(SCREENS, f), "utf8");
const T = 1_792_144_800;   // tests/orca-adapter.sh's LN
const WS = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-";
const LEAD = `${WS}lead-demo`, THINKER = `${WS}thinker-demo`, BUILDER = `${WS}builder-u1-spike-loop-as-coordinator-demo`, STUDIO = `${WS.replace("ds-dev-studio-", "ds-fx-studio")}`;
const ACCT = "6b9a19e7-e78f-4a78-ba77-b573b3c9f95d";
const WEEKLY = "You've hit your weekly limit · resets Oct 31, 9pm (Europe/Berlin)";

// "resets 3pm" in the host zone: the next 15:00 after the anchor.
function next(anchor: number, h: number, mi = 0): number {
  const d = new Date(anchor * 1000), c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi).getTime() / 1000;
  return c > anchor ? c : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, mi).getTime() / 1000;
}

describe("fingerprints (tests/orca-adapter.sh limited)", () => {
  const idle: Gate = { state: "idle", since: T - 900, lastOutput: null, now: T, silentMin: 10 };
  const working = (ago: number): Gate => ({ state: "working", since: T - 3600, lastOutput: T - ago, now: T, silentMin: 10 });
  const DLG = screen("dialog-weekly-u22.txt");
  const wk = Date.UTC(2026, 9, 31, 20) / 1000;   // Oct 31, 9pm Berlin (CET after 25 Oct)
  const cases: [string, string, Gate, { notice?: string; reset?: number | null; dialog?: boolean } | null][] = [
    ["limited: idle 15 min + notice -> row with parsed reset", screen("session-notice.txt"), idle, { notice: "5-hour limit reached ∙ resets 3pm", reset: next(T - 900, 15), dialog: false }],
    ["limited: loop poke after a notice leaves the limit visible", "  ⎿  5-hour limit reached ∙ resets 3pm\n• dev-studio loop: you went quiet with unread messages.", idle, { notice: "5-hour limit reached ∙ resets 3pm", reset: next(T - 900, 15) }],
    ["limited: assistant entry mentioning the loop clears the notice", "  ⎿  5-hour limit reached ∙ resets 3pm\n● Reviewed dev-studio loop: wake text.", idle, null],
    ["limited: rate/gas limit test output -> nothing", "FAIL: rate limit exceeded in test_gas\nError: gas limit exceeded\n❯", idle, null],
    ["Codex usage limit -> row with unknown reset", "■ You've hit your usage limit. Try again later.", { ...idle, agent: "codex" }, { reset: null, notice: "You've hit your usage limit. Try again later." }],
    ["Codex Azure 429 -> row", "■ unexpected status 429 Too Many Requests", { ...idle, agent: "codex" }, { reset: null }],
    ["Codex active retry -> nothing", "■ unexpected status 429 Too Many Requests", { ...working(60), agent: "codex" }, null],
    ["Codex recovered after a limit -> nothing", "■ You've hit your usage limit.\n• Continuing with the task", { ...idle, agent: "codex" }, null],
    ["Codex error quoted in a finding -> nothing", "Finding: ■ You've hit your usage limit.", { ...idle, agent: "codex" }, null],
    ["limited: the sweep's own poke text -> nothing", "❯ dev-studio sweep: you went quiet with unread messages. Check your inbox now.", idle, null],
    ["limited: 'Claude usage limit reached' -> row, reset '-'", "  ⎿  Claude usage limit reached. Try again later.", idle, { reset: null }],
    ["limited: idle under SILENT_MIN -> nothing", screen("session-notice.txt"), { ...idle, since: T - 60 }, null],
    ["limited: weekly notice -> row with tz-aware dated reset", screen("weekly-notice.txt"), idle, { reset: Date.UTC(2026, 9, 31, 19) / 1000 }],
    ["limited: weekly 8:30pm (Europe/Berlin)", "  ⎿  You've hit your weekly limit · resets Oct 31, 8:30pm (Europe/Berlin)", idle, { reset: Date.UTC(2026, 9, 31, 19, 30) / 1000 }],
    ["limited: 'resets at 15:00' -> row", "  ⎿  5-hour limit reached ∙ resets at 15:00", idle, { reset: next(T - 900, 15) }],
    ["limited: Buenos Aires zone", "  ⎿  You've hit your weekly limit · resets Oct 31, 8pm (America/Argentina/Buenos_Aires)", idle, { reset: Date.UTC(2026, 9, 31, 23) / 1000 }],
    ["limited: 'resets 5 hours from now' -> reset '-'", "  ⎿  5-hour limit reached ∙ resets 5 hours from now", idle, { reset: null }],
    ["limited: working, no output 15 min (dialog) -> row", screen("session-notice.txt"), working(900), { reset: next(T - 900, 15), dialog: false }],
    ["limited: working with recent output + 429 -> nothing", "  ⎿  API Error: 429 usage limit, resets at 15:00", working(60), null],
    ["limited: working+dialog with recent output -> row flagged dialog", "  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait\n2. Wait here", working(60), { dialog: true }],
    ["limited: dialog words alone -> nothing", "What do you want to do?\n1. Stop and wait\n2. Wait here\n3. Add funds", working(60), null],
    ["limited: notice outside the 12-line window -> nothing", "  ⎿  5-hour limit reached ∙ resets 3pm\nf1\nf2\nf3\nf4\nf5\nf6\nf7\nf8\nf9\nf10\nWhat do you want to do?\n1. Stop and wait\n2. Wait here", working(60), null],
    ["limited: header only -> no dialog", "  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?", working(60), null],
    ["limited: one option -> no dialog", "  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait", working(60), null],
    ["limited: dialog near-miss (quoted on one line) -> no dialog", screen("dialog-near-miss.txt"), working(60), null],
    ["limited: dialog near-miss, idle -> plain row, no flag", screen("dialog-near-miss.txt"), idle, { dialog: false }],
    ["limited: dialog does not roll an undated reset forward", "  ⎿  5-hour limit reached ∙ resets 11am\nWhat do you want to do?\n1. Stop and wait\n2. Wait here", working(60), { dialog: true, reset: new Date(new Date((T - 60) * 1000).setHours(11, 0, 0, 0)).getTime() / 1000 }],
    ["limited: dialog with a past dated reset keeps it", "  ⎿  You've hit your weekly limit · resets Oct 15, 8pm (Europe/Berlin)\nWhat do you want to do?\n1. Stop and wait\n2. Wait here", working(60), { dialog: true, reset: Date.UTC(2026, 9, 15, 18) / 1000 }],
    ["limited: dialog then ordinary output -> nothing", "  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait\n2. Wait here\n⏺ ordinary output after", working(60), null],
    ["limited: repeated option 1 -> no dialog", "  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait\n1. Stop and wait", working(60), null],
    ["limited: real dialog (u22), recent output -> dialog row with weekly reset", DLG, working(60), { notice: WEEKLY, reset: wk, dialog: true }],
    ["limited: real dialog (u69), recent output -> dialog row with weekly reset", screen("dialog-weekly-u69.txt"), working(60), { notice: WEEKLY, reset: wk, dialog: true }],
    ["limited: real dialog + 1 trailing blank line -> dialog row", `${DLG}\n`, working(60), { dialog: true }],
    ["limited: real dialog, notice dropped -> nothing", DLG.split("\n").filter((l) => !l.includes("weekly limit")).join("\n"), working(60), null],
    ["limited: notice without the dialog, idle -> row without the flag", DLG.slice(0, DLG.indexOf("▔")), idle, { notice: WEEKLY, dialog: false }],
    ["limited: other footer -> no dialog", DLG.replace("Enter to confirm · Esc to cancel", "Press any key to continue"), working(60), null],
    ["limited: quoted dialog then the input box -> no dialog", `${DLG.split("\n").filter((l) => !l.startsWith("▔") && !l.includes("Enter to confirm")).join("\n")}\n╭──────╮\n❯ \n╰──────╯`, working(60), null],
    ["limited: notice quoted in prose (R4) -> nothing", screen("prose-quote.txt"), idle, null],
    ["limited: R4 quote under ⎿ -> nothing", `  ⎿  Finding P2: the Builder sat on "${WEEKLY}"\n❯`, idle, null],
    ["limited: ⏺ message quoting a notice -> nothing", `⏺ ${WEEKLY}\n❯`, idle, null],
    ["limited: timestamp prefix -> nothing", "  ⎿  2026-10-30 14:02 5-hour limit reached ∙ resets 3pm\n❯", idle, null],
    ["limited: Opus weekly notice, footer and input box -> row", "  ⎿  Opus weekly limit reached ∙ resets 3pm\n✻ Worked for 2m · done 2:11 PM\n╭──────╮\n│ >    │\n╰──────╯\n❯", idle, { dialog: false }],
    ["limited: 429 then ⏺ entry -> nothing", "  ⎿  API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}\n⏺ Retrying the build.\n❯", idle, null],
    ["limited: notice then ● entry -> nothing", "  ⎿  5-hour limit reached ∙ resets 3pm\n\n● Back at it, the reset passed.\n❯", idle, null],
    ["limited: 429 followed by more output, then the idle prompt -> nothing", screen("429-recovered.txt"), idle, null],
    ["limited: 'Usage limit reset · Continuing automatically', idle -> nothing", "  ⎿  Usage limit reset · Continuing automatically\n❯", idle, null],
    ["limited: notice then the recovery line, idle -> nothing", `  ⎿  ${WEEKLY}\n  ⎿  Usage limit reset · Continuing automatically\n❯`, idle, null],
    ["limited: aggregator 429 idle -> row with ISO reset", screen("pool-429.txt"), idle, { reset: Date.parse("2026-10-29T16:11:19Z") / 1000 }],
    ["limited: aggregator 429 with recent output -> nothing", screen("pool-429.txt"), working(60), null],
    ["limited: bare rate_limit_exceeded/quota without 429-or-cooling -> nothing", "rate_limit_exceeded: Subscription quota exhausted", idle, null],
    ["limited: ISO reset with +02:00 offset -> same instant", "  ⎿  API Error: Request rejected (429) · resets at 2026-10-29T16:11:19+02:00", idle, { reset: Date.parse("2026-10-29T14:11:19Z") / 1000 }],
    ["limited: cooling-down alone -> row, reset '-'", "  ⎿  All credentials for model claude-sonnet-5-5 are cooling down", idle, { reset: null }],
    ["limited: past ISO reset -> that instant, not rolled", "  ⎿  API Error: Request rejected (429) · resets at 2026-10-15T16:11:19Z", idle, { reset: Date.parse("2026-10-15T16:11:19Z") / 1000 }],
  ];
  // U40: the real screen of 2 Nov (acme builder u6; u7 in a narrow pane), on an idle worker Orca gives no state time.
  const timeless: Gate = { state: "idle", since: null, lastOutput: null, now: T, silentMin: 10 };
  const CREDITS = screen("dialog-weekly-credits.txt"), SIX = Date.UTC(2026, 10, 2, 17) / 1000;
  cases.push(
    ["U40: the real screen, no state time -> dialog row with the 6pm reset", CREDITS, timeless, { notice: "You've hit your weekly limit · resets Nov 2, 6pm (Europe/Berlin)", reset: SIX, dialog: true }],
    ["U40: the real screen wrapped in a narrow pane -> the same reset", screen("dialog-weekly-credits-wrapped.txt"), timeless, { reset: SIX, dialog: true }],
    ["U40: the real screen, working with recent output -> dialog row", CREDITS, working(60), { reset: SIX, dialog: true }],
    ["U40: no state time, last output long ago -> dialog row", CREDITS, { ...timeless, lastOutput: T - 900 }, { reset: SIX, dialog: true }],
    ["U40: no state time, last output just now -> nothing yet", CREDITS, { ...timeless, lastOutput: T - 60 }, null],
    ["U40: the old wording, no state time -> dialog row", DLG, timeless, { notice: WEEKLY, reset: wk, dialog: true }],
    ["U40: a notice with no dialog and no time at all -> nothing", screen("weekly-notice.txt"), timeless, null],
    ["U40: near-miss, no time -> nothing", screen("dialog-near-miss.txt"), timeless, null],
    ["U40: prose, no time -> nothing", screen("prose-quote.txt"), timeless, null],
    ["U40: option 3 without option 2 -> no dialog", "  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait\n3. Switch to usage credits", working(60), null],
    ["U40: any option 3, then text at its own indent -> no dialog", `  ⎿  5-hour limit reached ∙ resets 3pm\nWhat do you want to do?\n1. Stop and wait\n2. Wait here\n3. Something new\nprose after it`, working(60), null],
  );
  for (const [name, tail, gate, want] of cases) {
    test(name, () => {
      const r = scan(tail, gate);
      if (want === null) { expect(r).toBeNull(); return; }
      expect(r).not.toBeNull();
      for (const [k, v] of Object.entries(want)) expect((r as Record<string, unknown>)[k]).toBe(v);
    });
  }
  test("limited: the aggregator 429's notice is cut at 160 bytes as `cut -c` does, its reset read past the cut", () => {
    const r = scan(screen("pool-429.txt"), idle)!;
    const line = screen("pool-429.txt").split("\n").find((l) => LIMIT_RE.test(l))!.replace(/^[^A-Za-z0-9]+/, "");
    const bash = Bun.spawnSync(["cut", "-c1-160"], { stdin: Buffer.from(line), env: { LC_ALL: "C.UTF-8" } }).stdout.toString().replace(/\n$/, "");
    expect(r.notice).toBe(bash);
    expect(Buffer.byteLength(r.notice)).toBe(160);
    expect(r.reset).toBe(Date.parse("2026-10-29T16:11:19Z") / 1000);
  });
  test("limit_reset: an unknown zone is no reset; a dialog row keeps a past undated candidate", () => {
    expect(limitReset("resets Oct 31, 8pm (Nowhere/Atlantis)", T)).toBeNull();
    expect(limitReset("resets 3pm", T + 86400 * 400, true)).toBeLessThanOrEqual(T + 86400 * 401);
    expect(dialog(["What do you want to do?", "❯ 1. Stop and wait for limit to reset", "  2. Wait here, then continue", ""])).toBe(true);
  });
});

// --- the reconciler -------------------------------------------------------------------------

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function roster(s: Store) {
  for (const [key, value] of [["lead", "claude sonnet spawn -"], ["thinker", "claude opus spawn -"], ["builder", "claude opus spawn -"]])
    s.upsert("config", { project: "fx", file: "roles.conf", key }, { value, observed_at: T });
}
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzlimits-")); temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  rmSync(join(d, "fx", "loop", "limited.json"), { force: true });
  const s = open(d); stores.push(s); importJson(s, d, () => {});
  roster(s);
  s.upsert("accounts", { agent: "claude", account: ACCT }, { observed_at: T });
  for (const account of [ACCT, "acct-b"]) s.upsert("observed_accounts", { agent: "claude", account }, { updated: String(T), observed_at: T });
  // The fixture parks acct-b on a stale limit (an "expired" note); the decider reads real account
  // state, so these tests start unparked — a test needing a limit sets its own.
  s.db.run("UPDATE observed_accounts SET limited_until = NULL WHERE agent = 'claude'");
  s.db.run("UPDATE units SET status = 'dispatched' WHERE slug = 'u1-spike-loop-as-coordinator'");
  // The fixture's u1 PR is merged (its builder reads archived); these tests work a live unit, so
  // the PR reads reopened — the same reopen the phase path handles.
  s.upsert("observed_prs", { project: "fx", ref: "demo/u1-spike-loop-as-coordinator" }, { state: "OPEN", observed_at: T });
  return s;
}
function worker(s: Store, wt: string, state: string, o: { tail?: string; since?: number; out?: number } = {}) {
  s.upsert("observed_workers", { project: "fx", wt }, { state, tail: o.tail ?? "❯", tail_at: T, since: o.since ?? T - 900, last_output_at: o.out ?? T - 900, limited: null, gone_at: null, suspect: 0, observed_at: T });
}
function usage(s: Store, session: string | null, weekly: string | null, account = ACCT) {
  s.upsert("observed_accounts", { agent: "claude", account }, { session_pct: session, session_reset: session ? String(T + 7200) : null, weekly_pct: weekly, weekly_reset: weekly ? String(T + 86400) : null, observed_at: T });
}
const conf = (s: Store, key: string, value: string) => s.upsert("config", { project: "fx", file: "limits.conf", key }, { value, observed_at: T });
type Picker = { calls: PickArgs[]; next: Pick | ((a: PickArgs) => Pick) };
function picker(next: Pick | ((a: PickArgs) => Pick) = null): Picker { return { calls: [], next }; }
const OTHER: Pick = { agent: "claude", model: "sonnet", effort: "-", account: "acct-b", fallback: false };
const SAME: Pick = { agent: "claude", model: "sonnet", effort: "-", account: ACCT, fallback: false };
function ctx(s: Store, at = T, poked = new Set<string>()): TickCtx { return { store: s, project: "fx", tick: 1, now: at, fired: [], poked }; }
async function limitsOnly(s: Store, p: Picker, at = T): Promise<Action[]> {
  const r = makeLimits({ pick: (a) => { p.calls.push(a); return typeof p.next === "function" ? p.next(a) : p.next; } });
  return (await r.run(ctx(s, at))) ?? [];
}
const reconcile = limitsOnly;
const member = (s: Store, wt: string) => s.db.query("SELECT * FROM members WHERE wt = ?").get(wt) as Row;
const episode = (s: Store, subject: string, kind: string) => s.get("episodes", { project: "fx", subject, kind });
const listed = (s: Store) => { const f = join(s.root, "fx", "loop", "limited.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };
const kinds = (a: Action[]) => a.map((x) => x.kind);
// U154: the move is the decider's, not the reconciler's. These helpers run it directly: `stops`
// are its stop acts (payload.stop), `tells` its limit-recovery pokes.
const decided = (s: Store, at = T) => decide({ store: s, project: "fx", tick: 1, now: at, fired: [], poked: new Set<string>() });
const stops = (a: Action[]) => a.filter((x) => x.kind === "member" && (x.payload as Row)?.stop);
const tells = (a: Action[]) => a.filter((x) => x.kind === "poke");
// A live agent on the member (presence running) and a standing acted wish (a start happened, so
// the decider only considers stops).
function live(s: Store, wt: string, state = "idle") {
  s.upsert("observed_workers", { project: "fx", wt }, { presence: "running", account_at: T, state, observed_at: T });
  s.db.run("UPDATE members SET want = 'running', want_at = ?, want_result = 'fresh', status = 'running' WHERE wt = ?", [T - 60, wt]);
}

describe("Muse account exhaustion", () => {
  const reset = () => new Date(2026, 10, 9, 1).getTime() / 1000;
  test("recognizes Muse's wrapped limit notice and dated reset, without matching prose", () => {
    const gate = { agent: "muse", state: "idle", since: T - 900, lastOutput: T - 900, now: T, silentMin: 10 };
    expect(scan(screen("muse-limit.txt"), gate)).toMatchObject({ reset: reset(), dialog: false });
    expect(scan("Example: " + screen("muse-limit.txt"), gate)).toBeNull();
    expect(scan(screen("muse-limit.txt") + "\n● Work resumed", gate)).toBeNull();
  });

  test("U107: a Muse or Codex notice counts only on its own agent's worker", () => {
    const g = (agent: string | null): Gate => ({ agent, state: "idle", since: T - 900, lastOutput: T - 900, now: T, silentMin: 10 });
    const muse = screen("muse-limit.txt"), codex = "■ You've hit your usage limit. Try again later.", codex429 = "■ unexpected status 429 Too Many Requests";
    for (const text of [muse, codex, codex429]) {
      for (const agent of ["claude", "", null]) expect(scan(text, g(agent))).toBeNull();
    }
    expect(scan(muse, g("codex"))).toBeNull();
    expect(scan(codex, g("muse"))).toBeNull();
    expect(scan(muse, g("muse"))).not.toBeNull();
    expect(scan(codex, g("codex"))).not.toBeNull();
    expect(scan(codex429, g("codex"))).not.toBeNull();
    // The Claude shapes stay agent-independent.
    for (const agent of ["claude", "muse", "codex", null]) expect(scan(screen("session-notice.txt"), g(agent))).not.toBeNull();
  });

  test("U107: a Claude Builder quoting Muse's notice is not limited and blocks no account", async () => {
    const s = imported();
    worker(s, BUILDER, "idle", { tail: screen("muse-limit.txt") });
    await makeLimits().run(ctx(s));
    expect(member(s, BUILDER).limited_until ?? null).toBeNull();
    expect(s.db.query("SELECT 1 FROM episodes WHERE kind = 'account'").all()).toEqual([]);
  });

  test("waits on Claude rather than returning to exhausted Muse after switching away", async () => {
    const s = imported();
    s.db.run("UPDATE members SET agent = 'muse', model = 'muse-spark-1.3', account = 'default' WHERE wt = ?", [BUILDER]);
    s.upsert("observed_accounts", { agent: "muse", account: "default" }, { updated: String(T), observed_at: T });
    worker(s, BUILDER, "idle", { tail: screen("muse-limit.txt") });
    live(s, BUILDER, "idle");
    expect(await reconcile(s, picker(SAME))).toEqual([]);
    // Claude has room: the decider stops the Muse-limited builder; the start's pick lands on Claude.
    const d = stops(decided(s)).filter((x) => x.member === BUILDER);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ payload: { stop: true, why: "limit" } });
    // Both families capped: one tell, no stop — it waits rather than flapping back to Muse.
    usage(s, "100", "100");
    usage(s, "100", "100", "acct-a");
    usage(s, "100", "100", "acct-b");
    s.upsert("observed_accounts", { agent: "muse", account: "default" }, { session_pct: "100", session_reset: String(T + 7200), weekly_pct: "100", weekly_reset: String(T + 86400), observed_at: T });
    const a = decided(s, T + 60);
    expect(stops(a).filter((x) => x.member === BUILDER)).toEqual([]);
    expect(tells(a)).toHaveLength(1);
  });
});

describe("limits reconciler (the removed sweep tests step 3)", () => {
  test("usage limit: an idle agent whose screen shows a limit notice is listed, never poked or restart-requested", async () => {
    const s = imported(), p = picker(SAME);
    worker(s, LEAD, "idle", { tail: screen("weekly-notice.txt") });
    live(s, LEAD);
    expect(await reconcile(s, p)).toEqual([]);
    const until = Date.UTC(2026, 9, 31, 19) / 1000;
    expect(member(s, LEAD).limited_until).toBe(until);
    const ep = episode(s, LEAD, "limited")!;
    expect([ep.episode_key, ep.state, ep.ended_at, ep.source]).toEqual([`claude/${ACCT}|You've hit your weekly limit · resets Oct 31, 8pm (Europe/Berlin)`, "weekly", until, "loop"]);
    expect(listed(s)).toEqual([{ wt: LEAD, who: "lead", topic: "demo", line: "You've hit your weekly limit · resets Oct 31, 8pm (Europe/Berlin)", since: T - 900 }]);
    // U154: another account has room, so the decider stops it when idle (never a poke: room means a move).
    const d = stops(decided(s));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ member: LEAD, payload: { stop: true, why: "limit" } });
    expect(tells(decided(s))).toEqual([]);
  });

  test("a pool 429 with an ISO reset: the episode runs until that instant, the member is not stamped", async () => {
    const s = imported();
    worker(s, BUILDER, "idle", { tail: screen("pool-429.txt") });
    await reconcile(s, picker(SAME));
    expect(episode(s, BUILDER, "limited")!.ended_at).toBe(Date.parse("2026-10-29T16:11:19Z") / 1000);
    expect(episode(s, BUILDER, "limited")!.state).toBe("pool");
    expect(member(s, BUILDER).limited_until).toBeNull();
    expect(String(s.get("observed_workers", { project: "fx", wt: BUILDER })!.limited)).toContain("Request rejected (429)");
  });

  test("main #138: a pool notice leaves its account pickable for others, a real limit does not", async () => {
    // acct-a is the account the picker fills first; BUILDER sits on it and is the one limited.
    const on = (tail: string) => {
      const s = imported();
      importConfig(s, s.root, join(ROOT, "conventions"));
      s.db.run("UPDATE members SET account = 'acct-a' WHERE wt = ?", [BUILDER]);
      worker(s, BUILDER, "idle", { tail });
      return s;
    };
    const pickFor = (s: Store) => pickLoop({ project: "fx", role: "builder", squad: "", member: null } as PickArgs, ctx(s));
    expect(pickFor(on("❯"))).toMatchObject({ account: "acct-a" });
    for (const tail of [screen("pool-429.txt"), "  ⎿  All credentials for model claude-sonnet-5-5 are cooling down"]) {
      const s = on(tail);
      await reconcile(s, picker(SAME));
      expect(pickFor(s)).toMatchObject({ account: "acct-a" });
    }
    const s = on(`  ⎿  ${WEEKLY}`);
    await reconcile(s, picker(SAME));
    expect(pickFor(s)).not.toMatchObject({ account: "acct-a" });
  });

  test("a pool move passes its exclusion to the restart's fresh ds pick", async () => {
    const s = imported();
    importConfig(s, s.root, join(ROOT, "conventions"));
    roster(s); // importConfig drops DB-upserted rows: restore the roster the decider picks from.
    s.db.run("UPDATE members SET account = 'acct-a' WHERE wt = ?", [BUILDER]);
    worker(s, BUILDER, "idle", { tail: screen("pool-429.txt") });
    live(s, BUILDER);
    expect(await reconcile(s, picker(SAME))).toEqual([]);
    expect(member(s, BUILDER).limited_until).toBeNull();
    // U154: the decider stops it (acct-b has room); the start's pick excludes the pool-limited account.
    const d = stops(decided(s));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ member: BUILDER, payload: { stop: true, why: "limit" } });
    const ep = episode(s, BUILDER, "limited")!;
    const limited = `claude:acct-a=${Number(ep.ended_at)}`;
    const o = Bun.spawnSync([join(ROOT,"bin/ds"), "pick", "fx", "builder", "--member", BUILDER, "--limited", limited, "--json"],
      { env: { ...process.env, DS_STATE_ROOT: s.root, DS_NOW: String(T) } });
    expect(o.exitCode).toBe(0);
    expect(JSON.parse(o.stdout.toString()).account).not.toBe("acct-a");
  });

  test("a bare API 429 still counts against the account, as accounts-refresh's skip list has it", async () => {
    const s = imported();
    worker(s, BUILDER, "idle", { tail: "  ⎿  API Error: 429 usage limit, resets at 15:00" });
    await reconcile(s, picker(SAME));
    expect(episode(s, BUILDER, "limited")!.state).toBe("pool");
    expect(member(s, BUILDER).limited_until).toBeGreaterThan(T);
  });

  test("a recovered bare API 429 does not leave an account parked for the fallback hour", async () => {
    const s = imported();
    importConfig(s, s.root, join(ROOT, "conventions"));
    s.db.run("UPDATE members SET account = 'acct-a' WHERE wt = ?", [BUILDER]);
    worker(s, BUILDER, "idle", { tail: "  ⎿  API Error: 429" });
    await reconcile(s, picker(SAME));
    worker(s, BUILDER, "idle");
    await reconcile(s, picker(SAME), T + 1);
    expect(accountBlock(s, "claude", "acct-a", T + 1, [], "fx")).toBeNull();
  });

  // U154: request.stale's run-switch branch is gone with the kind. A stop whose member left that
  // account, or whose limit cleared, drops in fulfil/member.ts stale (covered by the decider rows
  // below: the stop is only re-emitted while its row holds).

  test("a stamp left from before the pool rule, or by a real limit, is cleared when a pool notice shows", async () => {
    const s = imported();
    s.db.run("UPDATE members SET limited_until = ? WHERE wt = ?", [T + 600, BUILDER]);
    worker(s, BUILDER, "idle", { tail: screen("pool-429.txt") });
    await reconcile(s, picker(SAME));
    expect(member(s, BUILDER).limited_until).toBeNull();
  });

  test("dialog state: working with no output for 15 min -> limited and listed, not hung", async () => {
    const s = imported();
    worker(s, THINKER, "working", { tail: screen("session-notice.txt"), out: T - 900 });
    await reconcile(s, picker(SAME));
    expect(member(s, THINKER).limited_until).toBe(next(T - 900, 15));
    expect(listed(s).map((e: Row) => e.wt)).toEqual([THINKER]);
  });

  test("two dialog-stuck agents in one run are both listed", async () => {
    const s = imported();
    worker(s, LEAD, "working", { tail: screen("dialog-weekly-u22.txt"), out: T - 900 });
    worker(s, THINKER, "working", { tail: screen("dialog-weekly-u69.txt"), out: T - 900 });
    await reconcile(s, picker(SAME));
    expect(listed(s).map((e: Row) => e.wt).sort()).toEqual([LEAD, THINKER].sort());
  });

  test("a genuinely active agent with a 429: recent output, so it is not limited, poked or listed", async () => {
    const s = imported();
    worker(s, LEAD, "working", { tail: "  ⎿  API Error: 429 usage limit, resets at 15:00", out: T - 60 });
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(member(s, LEAD).limited_until).toBeNull();
    expect(listed(s)).toBeNull();
  });

  test("the limit notice quoted in prose -> not limited; a fingerprint near-miss is no dialog", async () => {
    const s = imported();
    worker(s, LEAD, "idle", { tail: screen("prose-quote.txt") });
    worker(s, THINKER, "working", { tail: screen("dialog-near-miss.txt"), out: T - 60 });
    worker(s, BUILDER, "idle", { tail: screen("429-recovered.txt") });
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    for (const wt of [LEAD, THINKER, BUILDER]) expect(member(s, wt).limited_until).toBeNull();
  });

  test("U11: a dialog on a working agent with recent output is listed and never poked; the switch still fires", async () => {
    const s = imported();
    worker(s, BUILDER, "working", { tail: screen("dialog-weekly-u22.txt"), out: T - 60 });
    live(s, BUILDER, "working");
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(String(s.get("observed_workers", { project: "fx", wt: BUILDER })!.limited).endsWith("\tdialog")).toBe(true);
    expect(listed(s)).toHaveLength(1);
    // Stuck on the dialog: the limit stop fires while working, like the old run-switch did.
    const d = stops(decided(s));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ member: BUILDER, payload: { stop: true, why: "limit" } });
  });

  test("U11: a dialog that sits there gets no poke even on its own account", async () => {
    const s = imported();
    worker(s, LEAD, "working", { tail: screen("dialog-weekly-u22.txt"), out: T - 900 });
    expect(kinds(await reconcile(s, picker(SAME)))).toEqual([]);
    expect(member(s, LEAD).limited_until).toBe(Date.UTC(2026, 9, 31, 20) / 1000);
  });

  test("U11: a dialog whose reset has passed is expired: not limited, not listed", async () => {
    const s = imported(), after = Date.UTC(2026, 9, 31, 21) / 1000;
    worker(s, LEAD, "working", { tail: screen("dialog-weekly-u22.txt"), out: after - 60 });
    expect(await reconcile(s, picker(SAME), after)).toEqual([]);
    expect(member(s, LEAD).limited_until).toBeNull();
    expect(listed(s)).toBeNull();
  });

  test("'-' reset dialog bounded by the accounts episode until: past it, expired", async () => {
    const s = imported(), tail = "  ⎿  Claude usage limit reached. Try again later.\nWhat do you want to do?\n1. Stop and wait\n2. Wait here";
    worker(s, LEAD, "working", { tail, out: T - 60 });
    s.upsert("episodes", { project: "", subject: `${LEAD}|Claude usage limit reached. Try again later.`, kind: "account" }, { ended_at: T - 1, source: "sweep", observed_at: T });
    expect(await reconcile(s, picker(SAME))).toEqual([]);
    expect(member(s, LEAD).limited_until).toBeNull();
  });

  test("reset unknown: first seen + 1h, and a still-showing notice never extends it", async () => {
    const s = imported();
    worker(s, LEAD, "idle", { tail: "  ⎿  All credentials for model claude-sonnet-5-5 are cooling down" });
    await reconcile(s, picker(SAME));
    expect(episode(s, LEAD, "limited")!.ended_at).toBe(T + 3600);
    await reconcile(s, picker(SAME), T + 600);
    expect(episode(s, LEAD, "limited")!.ended_at).toBe(T + 3600);
  });

  test("U4: a limited worker with another account free gets a decider stop, never a restart-role line (U95)", async () => {
    const s = imported();
    worker(s, BUILDER, "idle", { tail: screen("weekly-notice.txt") });
    live(s, BUILDER);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    const d = stops(decided(s));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ member: BUILDER, subject: `member:${member(s, BUILDER).id}`, payload: { stop: true, why: "limit" } });
    expect(String(d[0].episode)).toMatch(/^stop:limit:claude\/\S+\|You've hit your weekly limit · resets Oct 31, 8pm \(Europe\/Berlin\)@\d+$/);   // U200: @<limit episode start>
  });

  test("U101: a limit stop keeps the member's tier and phase (the babysit row, not the base row)", async () => {
    const s = imported();
    // A standard babysitter: the tier from its unit, the phase from its member row.
    s.db.run("UPDATE units SET tier = 'standard', status = 'dispatched' WHERE slug = 'u1-spike-loop-as-coordinator'");
    s.db.run("UPDATE members SET phase = 'babysit' WHERE wt = ?", [BUILDER]);
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder-standard-babysit" },
      { value: "claude haiku ondemand - muse:muse-spark-1.3", observed_at: T });
    // Claude full on every listed account (the fixture lists acct-a too), spark free. The base
    // `builder` row has no muse rung, so reaching spark proves the pick used the tier+phase row.
    s.db.run("UPDATE observed_accounts SET session_pct = '100', session_reset = ? WHERE agent = 'claude'", [String(T + 7200)]);
    s.upsert("accounts", { agent: "muse", account: "mu" }, { observed_at: T });
    s.upsert("observed_accounts", { agent: "muse", account: "mu" }, { updated: String(T), observed_at: T });
    worker(s, BUILDER, "idle", { tail: screen("weekly-notice.txt") });
    live(s, BUILDER);
    expect(await reconcile(s, picker(SAME))).toEqual([]);
    const d = stops(decided(s));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ member: BUILDER, payload: { stop: true, why: "limit" } });
    // The decider's pick (and the start's) uses the tier+phase row: spark, not the base row.
    const until = Number(episode(s, BUILDER, "limited")!.ended_at);
    const p = pickLoop({ project: "fx", role: "builder", tier: "standard", phase: "babysit", squad: "demo",
      member: member(s, BUILDER).id, limited: [`claude:${ACCT}=${until}`] } as PickArgs, ctx(s));
    expect(p).toMatchObject({ agent: "muse", model: expect.stringContaining("spark"), account: "mu" });
  });

  // U154: the switch_recheck alert is gone with the run-switch. A stop that is acted on but lands
  // nowhere retries through the refusals classifier's backoff, not a recheck alert.

  test("the usage path: an idle worker on an account at 100% stops when idle; a working one waits", async () => {
    const s = imported();
    usage(s, "100", "40");
    worker(s, LEAD, "idle");
    live(s, LEAD);
    worker(s, THINKER, "working", { out: T - 30 });
    live(s, THINKER, "working");
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(episode(s, LEAD, "limited")!.episode_key).toBe(`claude/${ACCT}|account ${ACCT} at 100% (session)`);
    expect(member(s, LEAD).limited_until).toBe(T + 7200);
    const d = stops(decided(s));
    expect(d.map((x) => x.member)).toEqual([LEAD]);
    expect(d[0]).toMatchObject({ payload: { stop: true, why: "limit" } });
  });

  test("…unless that working Builder is dialog-stuck: it is listed, and the stop fires while working", async () => {
    const s = imported();
    usage(s, "100", "40");
    worker(s, BUILDER, "working", { out: T - 900 });
    live(s, BUILDER, "working");
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    // Silent 15 minutes past SILENT_MIN: stuck, so the limit stop fires while working.
    const d = stops(decided(s));
    expect(d.map((x) => x.member)).toEqual([BUILDER]);
    expect(d[0]).toMatchObject({ payload: { stop: true, why: "limit" } });
  });

  test("U10: weekly caps every claude model — a sonnet worker on a weekly-capped account is limited", async () => {
    const s = imported();
    usage(s, "20", "100");
    s.db.run("UPDATE members SET model = 'sonnet' WHERE wt = ?", [THINKER]);
    worker(s, THINKER, "idle");
    live(s, THINKER, "idle");
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(member(s, THINKER).limited_until).toBe(T + 86400);
    // U154: the weekly cap limits the member, and the decider stops it (room on acct-a/acct-b).
    const d = stops(decided(s)).filter((x) => x.member === THINKER);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ payload: { stop: true, why: "limit" } });
  });

  test("e12: no session pct or reset, weekly at 50 -> not limited, no switch", async () => {
    const s = imported();
    usage(s, null, "50");
    worker(s, LEAD, "idle");
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(member(s, LEAD).limited_until).toBeNull();
  });

  test("no account room: one tell, no stop, no poke storm, no park", async () => {
    const s = imported(), p = picker({ wait: T + 7200 });
    usage(s, "100", "100");
    usage(s, "100", "100", "acct-b");
    usage(s, "100", "100", "acct-a");
    worker(s, LEAD, "idle", { tail: screen("weekly-notice.txt") });
    live(s, LEAD);
    expect(await reconcile(s, p)).toEqual([]);
    expect(episode(s, "demo.lead", "park")).toBeNull();
    expect(listed(s)[0].wait_until).toBeUndefined();
    expect(member(s, LEAD).limited_until).toBeGreaterThan(T);
    // U154: nowhere to go tells once ("carry on") instead of poking on a cap.
    const a = decided(s);
    expect(stops(a)).toEqual([]);
    const t = tells(a);
    expect(t).toHaveLength(1);
    expect(String((t[0].payload as Row).text)).toContain("carry on");
    expect(tells(decided(s, T + 60))).toEqual([]);
  });

  test("a Builder stays unfinished without a capacity countdown and stops as soon as room appears", async () => {
    const s = imported(), p = picker({ wait: T + 7200 });
    const unit = () => s.get("units", { project: "fx", squad: "demo", slug: "u1-spike-loop-as-coordinator" })!;
    usage(s, "100", "100");
    usage(s, "100", "100", "acct-b");
    usage(s, "100", "100", "acct-a");
    worker(s, BUILDER, "idle", { tail: screen("weekly-notice.txt") });
    live(s, BUILDER);
    await reconcile(s, p);
    expect(unit().wait_until).toBeNull();
    expect(episode(s, "demo.builder-u1-spike-loop-as-coordinator", "park")).toBeNull();
    const a0 = decided(s);
    expect(stops(a0)).toEqual([]);
    expect(tells(a0)).toHaveLength(1);
    // Room appears: the decider stops it; while the stop is in flight the board shows switching.
    usage(s, "10", "10", "acct-b");
    const d = stops(decided(s, T + 60));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ member: BUILDER, payload: { stop: true, why: "limit" } });
    s.upsert("episodes", { project: "fx", subject: `member:${member(s, BUILDER).id}`, kind: "action:member" },
      { episode_key: String(d[0].episode), state: "acted", action: JSON.stringify({ action: d[0] }), started_at: T + 60, source: "loop", observed_at: T + 60 });
    await reconcile(s, p, T + 60);
    expect(listed(s)[0].switching).toBe(true);
  });

  test("the limit clears: episode closed, limited_until and the limit row cleared, listing emptied", async () => {
    const s = imported();
    worker(s, LEAD, "idle", { tail: screen("weekly-notice.txt") });
    await reconcile(s, picker(SAME));
    worker(s, LEAD, "idle", { tail: "⏺ Back at it.\n❯" });
    await reconcile(s, picker(SAME), T + 60);
    expect(episode(s, LEAD, "limited")!.state).toBe("closed");
    expect(member(s, LEAD).limited_until).toBeNull();
    expect(s.get("observed_workers", { project: "fx", wt: LEAD })!.limited).toBeNull();
    expect(listed(s)).toEqual([]);
  });
});

describe("sweep parity", () => {
  const NOTICE = "You've hit your weekly limit · resets Oct 31, 8pm (Europe/Berlin)";

  test("an idle Builder of a done unit gets no limit handling; a working one still does", async () => {
    const s = imported();
    s.db.run("UPDATE units SET status = 'done' WHERE slug = 'u1-spike-loop-as-coordinator'");
    worker(s, BUILDER, "idle", { tail: screen("weekly-notice.txt") });
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(member(s, BUILDER).limited_until).toBeNull();
    // Still counted and on the board while working, but the loop doesn't restart finished work itself.
    worker(s, BUILDER, "working", { tail: screen("dialog-weekly-u22.txt"), out: T - 60 });
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(member(s, BUILDER).limited_until).not.toBeNull();
  });

  test("a no-clock-time dialog stays expired while it shows; gone and back, a fresh episode", async () => {
    const s = imported(), tail = "  ⎿  Claude usage limit reached. Try again later.\nWhat do you want to do?\n1. Stop and wait\n2. Wait here";
    worker(s, LEAD, "working", { tail, out: T - 60 });
    await reconcile(s, picker(SAME));
    expect(member(s, LEAD).limited_until).toBe(T + 3600);
    for (const at of [T + 3600, T + 7200]) {
      worker(s, LEAD, "working", { tail, out: T - 60 });
      await reconcile(s, picker(SAME), at);
      expect(member(s, LEAD).limited_until).toBeNull();
      expect(episode(s, LEAD, "limited")!.state).toBe("expired");
    }
    worker(s, LEAD, "working", { out: T + 7200 });
    await reconcile(s, picker(SAME), T + 7300);
    expect(episode(s, LEAD, "limited")!.state).toBe("closed");
    worker(s, LEAD, "working", { tail, out: T + 7300 });
    await reconcile(s, picker(SAME), T + 7400);
    expect(member(s, LEAD).limited_until).toBe(T + 7400 + 3600);
  });

  test("limit tells: one carry-on per limit episode, never a poke storm", async () => {
    const s = imported();
    usage(s, "100", "100");
    usage(s, "100", "100", "acct-a");
    usage(s, "100", "100", "acct-b");
    worker(s, LEAD, "idle", { tail: screen("weekly-notice.txt") });
    live(s, LEAD, "idle");
    expect(await reconcile(s, picker(SAME))).toEqual([]);
    // Nowhere to go: one tell, no stop, no poke storm.
    const a = decided(s);
    expect(stops(a)).toEqual([]);
    expect(tells(a)).toHaveLength(1);
    expect(String((tells(a)[0].payload as Row).text)).toContain("carry on");
    // Later ticks in the same episode: nothing more.
    expect(tells(decided(s, T + 300))).toEqual([]);
    expect(tells(decided(s, T + 960))).toEqual([]);
  });

  test("host switch: a sweep-era poke row neither suppresses nor duplicates the loop's one tell", async () => {
    const s = imported();
    s.upsert("episodes", { project: "fx", subject: "demo.lead.limit", kind: "poke" }, { started_at: T - 60, episode_key: `limit|${LEAD}`, count: 3, state: "poked", source: "sweep", observed_at: T });
    usage(s, "100", "100");
    usage(s, "100", "100", "acct-a");
    usage(s, "100", "100", "acct-b");
    worker(s, LEAD, "idle", { tail: screen("weekly-notice.txt") });
    live(s, LEAD, "idle");
    expect(await reconcile(s, picker(SAME))).toEqual([]);
    // The loop's tell is keyed on its own wake rows: the legacy poke row is ignored, told once.
    expect(tells(decided(s))).toHaveLength(1);
    expect(tells(decided(s, T + 841))).toEqual([]);
  });

  test("an expired dialog still on screen keeps every poke out (a key would pick an option)", async () => {
    const s = imported(), tail = "  ⎿  Claude usage limit reached. Try again later.\nWhat do you want to do?\n1. Stop and wait\n2. Wait here";
    worker(s, LEAD, "working", { tail, out: T - 60 });
    await reconcile(s, picker(SAME));
    worker(s, LEAD, "working", { tail, out: T - 60 });
    await reconcile(s, picker(SAME), T + 3600);
    expect(s.get("observed_workers", { project: "fx", wt: LEAD })!.limited).toBeNull();
    expect(wake(ctx(s, T + 3600), LEAD, "are you stuck?", "quiet", "q1", { allowWorking: true }).status).toBe("skipped:busy");
  });

  test("one member that throws costs only its own actions; the error is logged", async () => {
    const s = imported();
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    worker(s, BUILDER, "idle", { tail: screen("weekly-notice.txt") });
    // The Studio path picks for the studio role (U264): its throw is guarded, the Builder still lists.
    const a = await reconcile(s, picker((x) => { if (x.role === "studio") throw new Error("boom"); return OTHER; }));
    expect(a).toEqual([]);
    expect(since(s, 0, { kinds: ["plugin_error"] }).map((e) => JSON.parse(String(e.payload)).error)).toEqual(["boom"]);
    expect(listed(s).map((e: Row) => e.wt)).toEqual(expect.arrayContaining([BUILDER]));
  });

  test("host switch: the recheck alert the sweep already raised is not raised again", async () => {
    const s = imported(), ep = `limit|${LEAD}|claude/${ACCT}|${NOTICE}`;
    s.upsert("episodes", { project: "fx", subject: "demo.lead", kind: "switch" }, { started_at: T - 600, episode_key: ep, state: "requested", source: "sweep", observed_at: T });
    s.upsert("episodes", { project: "fx", subject: "demo.lead", kind: "alerted" }, { state: JSON.stringify([`${ep}|recheck`]), source: "sweep", observed_at: T });
    worker(s, LEAD, "idle", { tail: screen("weekly-notice.txt") });
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
  });

  test("an imported account episode is dropped once its notice is gone: a recurrence gets a fresh until", async () => {
    const s = imported(), notice = "Claude usage limit reached. Try again later.";
    const tail = `  ⎿  ${notice}\nWhat do you want to do?\n1. Stop and wait\n2. Wait here`, acct = { project: "", subject: `${LEAD}|${notice}`, kind: "account" };
    s.upsert("episodes", acct, { ended_at: T - 1, source: "sweep", observed_at: T });
    worker(s, LEAD, "working", { tail, out: T - 60 });
    await reconcile(s, picker(SAME));
    expect(member(s, LEAD).limited_until).toBeNull();
    expect(s.get("episodes", acct)).not.toBeNull();   // still on screen: still that episode
    worker(s, LEAD, "working", { out: T + 60 });
    await reconcile(s, picker(SAME), T + 60);
    expect(s.get("episodes", acct)).toBeNull();
    worker(s, LEAD, "working", { tail, out: T + 60 });
    await reconcile(s, picker(SAME), T + 120);
    expect(member(s, LEAD).limited_until).toBe(T + 120 + 3600);
  });

  test("the env override wins over limits.conf (DS_SWEEP_LIMIT_PCT)", async () => {
    const s = imported();
    usage(s, "85", "40");
    worker(s, LEAD, "idle");
    await reconcile(s, picker(SAME));
    expect(member(s, LEAD).limited_until).toBeNull();
    process.env.DS_SWEEP_LIMIT_PCT = "80";
    try {
      await reconcile(s, picker(SAME));
      expect(member(s, LEAD).limited_until).toBe(T + 7200);
    } finally { delete process.env.DS_SWEEP_LIMIT_PCT; }
  });

  test("host switch: obsolete capacity parks are retired", async () => {
    const s = imported();
    s.upsert("episodes", { project: "fx", subject: "demo.builder-u1-spike-loop-as-coordinator", kind: "park" }, { started_at: T - 60, ended_at: T + 7200, episode_key: "123456", state: "parked", source: "sweep", observed_at: T });
    s.db.run("UPDATE units SET wait_until = ? WHERE slug = 'u1-spike-loop-as-coordinator'", [T + 7200]);
    worker(s, BUILDER, "idle", { tail: screen("weekly-notice.txt") });
    retireCapacityFacts(s);
    await reconcile(s, picker({ wait: T + 9000 }));
    expect(episode(s, "demo.builder-u1-spike-loop-as-coordinator", "park")).toBeNull();
    expect((s.db.query("SELECT wait_until FROM units WHERE slug = 'u1-spike-loop-as-coordinator'").get() as Row).wait_until).toBeNull();
  });
});

describe("usage below the limit", () => {
  test("idle roles at 90 percent stay put, including with legacy project settings", async () => {
    for (const [session, weekly] of [["90", "40"], ["20", "91"]]) {
      const s = imported();
      usage(s, session, weekly);
      conf(s, "early_pct", "80");
      conf(s, "early_switch_pct", "90");
      for (const wt of [LEAD, THINKER, BUILDER]) worker(s, wt, "idle");
      const p = { calls: [], next: (a: PickArgs) => ({ ...OTHER, model: a.role === "builder" ? "opus" : "sonnet" }) as Pick };
      expect(await reconcile(s, p)).toEqual([]);
      for (const wt of [LEAD, THINKER, BUILDER]) expect(member(s, wt).limited_until).toBeNull();
    }
  });
});

describe("the Studio out of credits (U8, U10)", () => {
  function studioLoop(s: Store, pick: Pick) {
    const got: Action[] = [];
    const act: Actuator = { act: (a) => { got.push(a); } };
    return { got, loop: new Loop(s, { observers: [], reconcilers: [makeLimits({ pick: () => pick })] }, act, { projects: () => ["fx"] }) };
  }

  test("a dialog re-observed across many ticks keeps its first episode", async () => {
    for (const wt of [STUDIO, LEAD, BUILDER]) {
      const s = imported(), { loop } = studioLoop(s, { wait: T + 7200 });
      worker(s, wt, "working", { tail: screen("dialog-weekly-u22.txt"), out: T - 60 });
      for (let i = 0; i < 30; i++) {
        worker(s, wt, "working", { tail: screen("dialog-weekly-u22.txt"), out: T - 60 });
        importMarkers(s);
        await loop.tick(T + i * 60);
      }
      expect(since(s, 0, { kinds: ["limited"] }).filter((e) => e.member === wt)).toHaveLength(1);
      expect(episode(s, wt, "limited")!.started_at).toBe(T);
    }
  });

  test("one Studio card survives episode restarts, clears on recovery and returns once", async () => {
    const s = imported(), act = new LoopActuator({ orca: new FakeBackend() });
    const loop = new Loop(s, { observers: [], reconcilers: [makeLimits({ pick: () => ({ wait: T + 7200 }) }), alertsReconciler] }, act, { projects: () => ["fx"] });
    const file = join(s.root, "fx", "alerts.json");
    const cards = () => (JSON.parse(readFileSync(file, "utf8")).alerts as Row[]).filter((a) => String(a.id).startsWith("loop-studio.limit-"));
    const tick = async (at: number) => {
      s.db.run("DELETE FROM observed_alerts WHERE project = 'fx'");
      for (const r of alertRows(s.root, "fx")) s.upsert(r.table, r.key, r.set);
      await loop.tick(at); await act.drain();
    };
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    await tick(T);
    const id = cards()[0].id;
    for (let i = 1; i <= 20; i++) {
      // A restarted episode must not restart the still-open card's lifetime.
      s.db.run("DELETE FROM episodes WHERE project = 'fx' AND subject = ? AND kind = 'limited'", [STUDIO]);
      await tick(T + i * 60);
      expect(cards().map((c) => c.id)).toEqual([id]);
    }
    const old = JSON.parse(readFileSync(file, "utf8"));
    for (const c of old.alerts) if (c.id === id) c.since = new Date(T * 1000).toISOString();
    writeFileSync(file, JSON.stringify(old));
    await tick(T + 86401);
    expect(cards().map((c) => c.id)).toEqual([id]);
    worker(s, STUDIO, "idle");
    await tick(T + 86500);
    expect(cards()).toEqual([]);
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    await tick(T + 86600);
    expect(cards()).toHaveLength(1);
    expect(cards()[0].id).not.toBe(id);

    // Another account or notice replaces the card, without a recovery in between.
    s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { walk: "running", agent: "claude", account: "acct-b", account_at: T + 86700, observed_at: T + 86700 });
    await tick(T + 86700);
    expect(cards()).toHaveLength(1);
    expect(String(cards()[0].question)).toContain("claude/acct-b");
    worker(s, STUDIO, "idle", { tail: screen("session-notice.txt") });
    s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { walk: "running", agent: "claude", account: "acct-b", account_at: T + 86800, observed_at: T + 86800 });
    await tick(T + 86800);
    expect(cards()).toHaveLength(1);
    expect(String(cards()[0].question)).toContain("5-hour limit");
  });

  test("existing duplicate Studio cards collapse on the first tick, even after recovery", async () => {
    for (const limited of [true, false]) {
      const s = imported(), { got, loop } = studioLoop(s, { wait: T + 7200 });
      worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
      await loop.tick(T);
      const sent = got[0];
      const cards = [sent, { ...sent, episode: sent.episode + "-older" }].map((a) => ({ id: alertId(a.subject, a.episode), question: (a.payload as Row).text, since: "2026-10-28T12:00:00Z" }));
      for (const c of cards) s.upsert("observed_alerts", { project: "fx", id: c.id }, { doc: JSON.stringify(c), observed_at: T });
      if (!limited) worker(s, STUDIO, "idle");
      const report = await loop.tick(T + 60);
      const ids = report.acted.filter((a) => a.kind === "alert-clear").map((a) => (a.payload as Row).id).filter(Boolean);
      expect(ids).toContain(cards[1].id);
      if (limited) expect(ids).not.toContain(cards[0].id);
      else expect(ids).toContain(cards[0].id);
    }
  });

  test("a vanished Studio's day-old limit card can be cleared", async () => {
    const s = imported(), { got, loop } = studioLoop(s, { wait: T + 7200 });
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    await loop.tick(T);
    const id = alertId(got[0].subject, got[0].episode);
    s.upsert("observed_alerts", { project: "fx", id }, { doc: JSON.stringify({ id, asker: "sweep", since: new Date((T - 86401) * 1000).toISOString() }), observed_at: T });
    s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { gone_at: T });
    expect(dropAlerts(ctx(s)).map((a) => (a.payload as Row).id)).toContain(id);
  });

  test("a changed limit keeps the old card when the picker cannot supply a replacement", async () => {
    const s = imported(), act = new LoopActuator({ orca: new FakeBackend() });
    let pick: Pick = { wait: T + 7200 };
    const loop = new Loop(s, { observers: [], reconcilers: [makeLimits({ pick: () => pick })] }, act, { projects: () => ["fx"] });
    const file = join(s.root, "fx", "alerts.json");
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    await loop.tick(T); await act.drain();
    const before = readFileSync(file, "utf8");
    for (const r of alertRows(s.root, "fx")) s.upsert(r.table, r.key, r.set);
    s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { walk: "running", agent: "claude", account: "acct-b", account_at: T + 60, observed_at: T + 60 });
    pick = null;
    await loop.tick(T + 60); await act.drain();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("sweep-era duplicates keep one card, then a changed account replaces it", async () => {
    const s = imported(), act = new LoopActuator({ orca: new FakeBackend() });
    const loop = new Loop(s, { observers: [], reconcilers: [makeLimits({ pick: () => ({ wait: T + 7200 }) })] }, act, { projects: () => ["fx"] });
    const file = join(s.root, "fx", "alerts.json");
    writeFileSync(file, JSON.stringify({ alerts: [{ id: "sweep-studio.limit-1" }, { id: "sweep-studio.limit-2" }] }));
    s.upsert("episodes", { project: "fx", subject: "studio.limit", kind: "alerted" }, { source: "sweep", state: JSON.stringify([`limit|${STUDIO}|claude/acct-a|You've hit your weekly limit · resets Oct 31, 8pm (Europe/Berlin)`]), observed_at: T });
    const tick = async (at: number) => {
      s.db.run("DELETE FROM observed_alerts WHERE project = 'fx'");
      for (const r of alertRows(s.root, "fx")) s.upsert(r.table, r.key, r.set);
      await loop.tick(at); await act.drain();
    };
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    await tick(T);
    expect(JSON.parse(readFileSync(file, "utf8")).alerts).toEqual([{ id: "sweep-studio.limit-2" }]);
    for (const [at, account] of [[T + 60, "acct-b"], [T + 120, "acct-a"]] as const) {
      s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { walk: "running", agent: "claude", account, account_at: at, observed_at: at });
      await tick(at);
      const cards = JSON.parse(readFileSync(file, "utf8")).alerts as Row[];
      expect(cards).toHaveLength(1);
      expect(String(cards[0].id)).toStartWith("loop-studio.limit-");
      expect(String(cards[0].question)).toContain(`claude/${account}`);
    }
  });

  test("without an alert claim a picker error keeps the newest observed duplicate", async () => {
    const s = imported(), act = new LoopActuator({ orca: new FakeBackend() });
    const loop = new Loop(s, { observers: [], reconcilers: [makeLimits({ pick: () => null })] }, act, { projects: () => ["fx"] });
    const file = join(s.root, "fx", "alerts.json");
    writeFileSync(file, JSON.stringify({ alerts: [{ id: "loop-studio.limit-zzz" }, { id: "loop-studio.limit-aaa" }] }));
    for (const r of alertRows(s.root, "fx")) s.upsert(r.table, r.key, r.set);
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    await loop.tick(T); await act.drain();
    expect(JSON.parse(readFileSync(file, "utf8")).alerts).toEqual([{ id: "loop-studio.limit-aaa" }]);
  });

  test("changing the Lead to Codex does not attribute a legacy Claude Studio limit to Codex", async () => {
    const s = imported(), { loop } = studioLoop(s, null);
    s.upsert("config", { project: "fx", file: "roles.conf", key: "lead" }, { value: "codex gpt-6.1-sol always low muse:muse-spark:low", observed_at: T });
    s.upsert("observed_accounts", { agent: "codex", account: "default" }, { observed_at: T });
    s.upsert("accounts", { agent: "codex", account: "default" }, { observed_at: T });
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { walk: "running", agent: "claude", account: "system", account_at: T });
    await loop.tick(T);
    expect(s.get("episodes", { project: "", subject: "limit|codex/default", kind: "account" })).toBeNull();
    expect(s.get("episodes", { project: "", subject: "limit|claude/system", kind: "account" })?.ended_at).toBeGreaterThan(T);
    expect(pickAccount(s, { project: "fx", role: "lead" }, T)).toMatchObject({ agent: "codex", account: "default" });
  });

  test("out of credits, every account out: ONE out_of_credits alert per episode, never a restart", async () => {
    const s = imported(), { got, loop } = studioLoop(s, { wait: T + 7200 });
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    await loop.tick(T); await loop.tick(T + 60);
    expect(kinds(got)).toEqual(["alert"]);
    expect([got[0].subject, (got[0].payload as Row).kind]).toEqual(["studio.limit", "out_of_credits"]);
    expect(String((got[0].payload as Row).text)).toStartWith("Studio is out of credits on claude/");
    expect(listed(s)[0]).toMatchObject({ wt: STUDIO, who: "studio", topic: "" });
  });

  test("resolved, then the same notice again: alerted again; the sweep's .alerted is not repeated", async () => {
    const s = imported(), { got, loop } = studioLoop(s, { wait: T + 7200 });
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    await loop.tick(T);
    worker(s, STUDIO, "idle", { since: T - 900 });
    await loop.tick(T + 60);
    worker(s, STUDIO, "idle", { tail: screen("weekly-notice.txt"), since: T - 900 });
    await loop.tick(T + 120);
    expect(kinds(got)).toEqual(["alert", "alert-clear", "alert"]);

    const s2 = imported(), b = studioLoop(s2, { wait: T + 7200 });
    s2.upsert("episodes", { project: "fx", subject: "studio.limit", kind: "alerted" }, { episode_key: "x",
      state: JSON.stringify([`limit|${STUDIO}|claude/acct-a|You've hit your weekly limit · resets Oct 31, 8pm (Europe/Berlin)`]), source: "sweep", observed_at: T });
    worker(s2, STUDIO, "idle", { tail: screen("weekly-notice.txt") });
    await b.loop.tick(T);
    expect(b.got).toEqual([]);
    // Cleared: the sweep's memory goes (alert_clear) and its alert is resolved; a recurrence alerts.
    worker(s2, STUDIO, "idle", { since: T - 900 });
    await b.loop.tick(T + 60);
    expect(b.got.map((a) => [a.kind, (a.payload as Row)?.prefix])).toEqual([["alert-clear", "sweep-studio.limit-"]]);
    worker(s2, STUDIO, "idle", { tail: screen("weekly-notice.txt"), since: T - 900 });
    await b.loop.tick(T + 120);
    expect(kinds(b.got)).toEqual(["alert-clear", "alert"]);
  });

  test("dialog-stuck Studio on a 100% account: the limit path, with the next pick named", async () => {
    const s = imported(), { got, loop } = studioLoop(s, OTHER);
    usage(s, "100", "40", "acct-a");   // no member row: the agent's default (first listed) account
    worker(s, STUDIO, "working", { out: T - 900 });
    await loop.tick(T);
    expect(kinds(got)).toEqual(["alert"]);
    expect(String((got[0].payload as Row).text)).toContain("restart it on claude:sonnet@acct-b");
    expect(String((got[0].payload as Row).why)).not.toContain("--continue");   // U95: a hand-run restart starts fresh
  });

  test("U10: weekly caps the lead-row sonnet Studio too", async () => {
    const s = imported(), { got, loop } = studioLoop(s, OTHER);
    usage(s, "10", "100", "acct-a");
    worker(s, STUDIO, "idle");
    await loop.tick(T);
    expect(String((got[0].payload as Row).text)).toContain("(weekly)");
  });

  test("a Studio with a past-reset dialog: expired, no alert, not listed", async () => {
    const s = imported(), { got, loop } = studioLoop(s, { wait: T });
    const after = Date.UTC(2026, 9, 31, 21) / 1000;
    worker(s, STUDIO, "working", { tail: screen("dialog-weekly-u22.txt"), out: after - 60 });
    await loop.tick(after);
    expect(got).toEqual([]);
    expect(listed(s)).toBeNull();
  });

  test("an idle Studio below its limit gets no alert", async () => {
    const s = imported(), { got, loop } = studioLoop(s, OTHER);
    usage(s, "93", "40", "acct-a");
    worker(s, STUDIO, "idle");
    await loop.tick(T); await loop.tick(T + 60);
    expect(got).toEqual([]);
  });
});

describe("U16: informational pokes skip any limited agent", () => {
  test("a limited Lead gets no PR or all-done poke; the limit-recovery poke still goes", async () => {
    const s = imported();
    worker(s, LEAD, "idle", { tail: screen("session-notice.txt") });
    live(s, LEAD, "idle");
    expect(await reconcile(s, picker(SAME))).toEqual([]);
    const c = ctx(s, T + 1);
    expect(wake(c, LEAD, "PR #1 is stale", "pr:demo#1", "e1").status).toBe("skipped:limited");
    expect(wake(c, LEAD, "all done", "all-done", "e1").status).toBe("skipped:limited");
    // U154: the recovery poke is the decider's tell, allowed through on a limited member.
    expect(wake(c, LEAD, "carry on", "limit", "tell|e1", { allowLimited: true, cap: 1 }).status).toBe("sent");
  });

  test("a dialog-limited Builder: no PR poke either", async () => {
    const s = imported();
    worker(s, BUILDER, "working", { tail: screen("dialog-weekly-u69.txt"), out: T - 60 });
    await reconcile(s, picker(SAME));
    expect(wake(ctx(s, T + 1), BUILDER, "PR blocked", "pr:demo#2", "e1").status).toBe("skipped:limited");
  });

  test("once back, the PR poke goes again", async () => {
    const s = imported();
    worker(s, LEAD, "idle", { tail: screen("session-notice.txt") });
    await reconcile(s, picker(SAME));
    worker(s, LEAD, "idle", { tail: "⏺ Back.\n❯" });
    await reconcile(s, picker(SAME), T + 60);
    expect(wake(ctx(s, T + 61), LEAD, "PR #1 is stale", "pr:demo#1", "e1").status).toBe("sent");
  });
});

describe("the picker seam", () => {
  const roster = (s: Store) => s.upsert("config", { project: "", file: "roles.conf", key: "lead" }, { value: "claude  sonnet always", observed_at: T });
  test("pickLoop: bin/loop/capacity/pick.ts with the limited account out; nothing left is a WAIT", () => {
    const s = imported(), c = ctx(s);
    roster(s);
    usage(s, "10", "10", "acct-a"); usage(s, "10", "10", "acct-b"); usage(s, "10", "10");
    const a = { project: "fx", squad: "demo", role: "lead", suffix: "" };
    const free = pickLoop(a, c) as Row;
    const other = pickLoop({ ...a, limited: { agent: "claude", account: String(free.account), until: T + 3600 } }, c) as Row;
    expect(other.account).not.toBe(free.account);
    for (const acct of ["acct-a", "acct-b", ACCT]) usage(s, "100", "10", acct);
    expect(pickLoop(a, c)).toMatchObject({ wait: expect.any(Number) });
  });


});
const isWait = (p: Pick) => !!p && "wait" in p;

// --- U40: stuck members move on their own --------------------------------------------------
// U154: the move is the decider's stop. These tests drive detection (reconcile) and the decider
// directly: a limited idle member gets one stop act with a stable episode; acting it (the seat,
// the restart) is the fulfil path's job.

describe("U40: stuck members move on their own", () => {
  const on = (s: Store, wt: string, account: string | null) => s.db.run("UPDATE members SET account = ? WHERE wt = ?", [account, wt]);
  const list = (s: Store) => s.db.run("UPDATE observed_accounts SET updated = ? WHERE agent = 'claude'", [String(T)]);
  const roster = (s: Store) => { for (const [key, value] of [["lead", "claude sonnet always"], ["thinker", "claude opus always"], ["builder", "claude sonnet ondemand"]]) s.upsert("config", { project: "", file: "roles.conf", key }, { value, observed_at: T }); };
  // Room on the listed accounts so a stop is owed (imported() already clears acct-b's stale limit).
  const room = (s: Store) => { usage(s, "10", "10", "acct-a"); usage(s, "10", "10", "acct-b"); };
  const bstop = (s: Store, at = T) => stops(decided(s, at)).filter((x) => x.member === BUILDER);
  const lstop = (s: Store, at = T) => stops(decided(s, at)).filter((x) => x.member === LEAD);
  const failedAlerts = (s: Store) => { const f = join(s.root, "fx", "alerts.json"); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((a) => String(a.title ?? "").includes("Restart failed")) : []; };

  test("a restart wish on a working Builder leaves unrelated account recovery free", async () => {
    const s = imported();
    worker(s, BUILDER, "working", { out: T - 30 });
    live(s, BUILDER, "working");
    s.db.run("UPDATE members SET restart_at = ?, restart_mode = 'now', restart_by = 'board' WHERE wt = ?", [T, BUILDER]);
    on(s, LEAD, "acct-gone");
    worker(s, LEAD, "idle");
    live(s, LEAD, "idle");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    // The working Builder's restart is due at once; the gone-account Lead still gets its stop.
    const a = decided(s);
    expect(stops(a).filter((x) => x.member === BUILDER)).toMatchObject([{ payload: { stop: true, why: "restart" } }]);
    expect(stops(a).filter((x) => x.member === LEAD)).toMatchObject([{ payload: { stop: true, why: "limit" } }]);
  });

  test("members on an unlisted account — idle, on the dialog, and done — each get a stop in one tick", async () => {
    const s = imported();
    for (const wt of [LEAD, THINKER, BUILDER]) on(s, wt, "acct-gone");
    worker(s, LEAD, "idle");
    worker(s, THINKER, "idle", { tail: screen("dialog-weekly-credits.txt") });
    s.db.run("UPDATE observed_workers SET since = NULL, last_output_at = NULL WHERE wt = ?", [THINKER]);
    worker(s, BUILDER, "done");
    live(s, LEAD, "idle");
    live(s, THINKER, "idle");
    live(s, BUILDER, "done");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    const a = decided(s);
    expect(stops(a).map((x) => x.member).sort()).toEqual([BUILDER, LEAD, THINKER].sort());
    for (const x of stops(a)) expect(x.payload).toMatchObject({ stop: true, why: "limit" });
    // The decider only emits member stops: no external script, no tell to the Lead.
    expect(a.every((x) => x.kind === "member")).toBe(true);
  });

  test("a Lead's limit stop is a plain member stop: no wish, no seat, no request file", async () => {
    const s = imported();
    on(s, LEAD, "acct-gone");
    worker(s, LEAD, "idle");
    live(s, LEAD, "idle");
    room(s);
    const run = String(s.get("squads", { project: "fx", topic: "demo" })!.run_id);
    s.upsert("coordinators", { project: "fx", squad: "demo" }, { handle: "term_s", pane_key: "p:s", wt: LEAD, run_id: run, created_at: T, bound_at: T });
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    const d = lstop(s);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "member", subject: `member:${member(s, LEAD).id}`, payload: { stop: true, why: "limit" } });
    // U153: detection and the decider write no wish and never touch the seat.
    expect(s.db.query("SELECT 1 FROM members WHERE restart_at IS NOT NULL").all()).toEqual([]);
    expect(s.get("coordinators", { project: "fx", squad: "demo" })).toMatchObject({ handle: "term_s" });
  });

  test("a stop already acted keeps its episode: the decider re-emits the same stop, never a second one", async () => {
    const s = imported();
    usage(s, "100", "40");
    worker(s, BUILDER, "idle");
    live(s, BUILDER, "idle");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    const first = bstop(s);
    expect(first).toHaveLength(1);
    const claim = { project: "fx", subject: `member:${member(s, BUILDER).id}`, kind: "action:member" };
    s.upsert("episodes", claim, { episode_key: String(first[0].episode), state: "acted", action: JSON.stringify({ action: first[0] }), started_at: T, source: "loop", observed_at: T });
    // In flight the claim locks the member: no duplicate stop.
    expect(bstop(s, T + 60)).toEqual([]);
    // Settled while still due: the same episode re-emits, never a second one.
    s.upsert("episodes", claim, { state: "done", observed_at: T + 60 });
    const second = bstop(s, T + 120);
    expect(second).toHaveLength(1);
    expect(second[0].episode).toBe(first[0].episode);
  });

  test("a member out of usage on a full account gets a stop", async () => {
    const s = imported();
    usage(s, "100", "40");
    worker(s, BUILDER, "idle");
    live(s, BUILDER, "idle");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    const d = bstop(s);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ payload: { stop: true, why: "limit" } });
  });

  test("no room for 100 ticks leaves the limited role idle: no stops, no parks, no poke storm", async () => {
    const s = imported();
    usage(s, "100", "100");
    usage(s, "100", "100", "acct-a");
    usage(s, "100", "100", "acct-b");
    worker(s, BUILDER, "idle", { tail: screen("dialog-weekly-credits.txt") });
    live(s, BUILDER, "idle");
    let tellCount = 0;
    for (let i = 0; i < 100; i++) {
      expect(await reconcile(s, picker(SAME), T + i)).toEqual([]);
      const a = decided(s, T + i);
      expect(stops(a).filter((x) => x.member === BUILDER)).toEqual([]);
      tellCount += tells(a).length;
    }
    // A dialog never gets poked (a keypress would pick a menu option): silence, not a storm.
    expect(tellCount).toBe(0);
    expect(episode(s, "demo.builder-u1-spike-loop-as-coordinator", "park")).toBeNull();
    expect(member(s, BUILDER).limited_until).toBeGreaterThan(T);
  });

  test("a removed account with no room: its members get tells, never stops, and nothing is parked", async () => {
    const s = imported();
    for (const wt of [LEAD, BUILDER]) on(s, wt, "acct-gone");
    worker(s, LEAD, "idle");
    live(s, LEAD, "idle");
    worker(s, BUILDER, "idle");
    live(s, BUILDER, "idle");
    usage(s, "100", "100");
    usage(s, "100", "100", "acct-a");
    usage(s, "100", "100", "acct-b");
    expect(await reconcile(s, picker(SAME))).toEqual([]);
    const a = decided(s);
    expect(stops(a)).toEqual([]);
    expect(tells(a)).toHaveLength(2);
    expect(listed(s).map((e: Row) => e.wait_until)).toEqual([undefined, undefined]);
  });

  test("U109: a member winding down gets no stop and no failure card", async () => {
    const s = imported();
    usage(s, "100", "40");
    worker(s, BUILDER, "idle", { tail: screen("dialog-weekly-credits.txt") });
    live(s, BUILDER, "idle");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    worker(s, BUILDER, "waiting", { tail: screen("dialog-weekly-credits.txt") });
    live(s, BUILDER, "waiting");
    const a = decided(s);
    // Not idle, not done: no stop while it winds down (U153: nothing runs, so nothing can fail).
    expect(stops(a).filter((x) => x.member === BUILDER)).toEqual([]);
    expect(failedAlerts(s)).toEqual([]);
  });

  test("U109: a limit stop names only its member; the Lead is told nothing", async () => {
    const s = imported();
    usage(s, "100", "40");
    worker(s, BUILDER, "idle");
    live(s, BUILDER, "idle");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    const a = decided(s);
    expect(stops(a).filter((x) => x.member === BUILDER)).toMatchObject([{ payload: { stop: true, why: "limit" } }]);
    // No poke, alert, or card anywhere: the moved tell to the Lead is dropped.
    expect(a.filter((x) => x.kind === "poke" || x.kind === "alert" || x.kind === "card")).toEqual([]);
  });

  test("limited members each get a stop and no failure alert", async () => {
    const s = imported();
    usage(s, "100", "40");
    worker(s, LEAD, "idle", { tail: screen("dialog-weekly-credits.txt") });
    live(s, LEAD, "idle");
    worker(s, BUILDER, "idle", { tail: screen("dialog-weekly-credits.txt") });
    live(s, BUILDER, "idle");
    room(s);
    for (let i = 0; i < 6; i++) expect(await reconcile(s, picker(OTHER), T + i * 2)).toEqual([]);
    const a = decided(s, T + 12);
    expect(stops(a).map((x) => x.member).sort()).toEqual([BUILDER, LEAD].sort());
    expect(failedAlerts(s)).toEqual([]);
  });

  test("a limit stop's episode is stable across ticks: one stop, same key", async () => {
    const s = imported();
    usage(s, "100", "40");
    worker(s, BUILDER, "idle", { tail: screen("dialog-weekly-credits.txt") });
    live(s, BUILDER, "idle");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    const e0 = String(bstop(s)[0].episode);
    expect(e0).toContain("stop:limit:");
    expect(String(bstop(s, T + 300)[0].episode)).toBe(e0);
    expect(String(bstop(s, T + 600)[0].episode)).toBe(e0);
  });

  test("a stop fires while stuck working, waits while waiting, and goes quiet when suspended", async () => {
    const s = imported();
    usage(s, "100", "40");
    worker(s, BUILDER, "idle", { tail: screen("dialog-weekly-credits.txt") });
    live(s, BUILDER, "idle");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(bstop(s)).toHaveLength(1);
    // Back to work but silent on the dialog: stuck, so the stop still fires.
    worker(s, BUILDER, "working", { tail: screen("dialog-weekly-credits.txt"), out: T + 1 });
    live(s, BUILDER, "working");
    expect(await reconcile(s, picker(OTHER), T + 2)).toEqual([]);
    expect(bstop(s, T + 2)).toHaveLength(1);
    // Waiting on an ask: the stop waits.
    worker(s, BUILDER, "waiting", { tail: screen("dialog-weekly-credits.txt") });
    live(s, BUILDER, "waiting");
    expect(bstop(s, T + 4)).toEqual([]);
    // Squad suspended: nothing at all.
    worker(s, BUILDER, "idle", { tail: screen("dialog-weekly-credits.txt") });
    live(s, BUILDER, "idle");
    s.db.run("UPDATE squads SET status = 'suspended' WHERE topic = 'demo'");
    expect(bstop(s, T + 6)).toEqual([]);
  });

  test("finished work on the dialog is not stopped, and takes nobody else's turn", async () => {
    const s = imported();
    s.db.run("UPDATE units SET status = 'merged' WHERE slug = 'u1-spike-loop-as-coordinator'");
    worker(s, BUILDER, "working", { tail: screen("dialog-weekly-credits.txt"), out: T - 30 });
    live(s, BUILDER, "working");
    worker(s, THINKER, "working", { tail: screen("dialog-weekly-credits.txt"), out: T - 30 });
    s.db.run("UPDATE members SET want = 'gone' WHERE wt = ?", [THINKER]);
    worker(s, LEAD, "idle", { tail: screen("dialog-weekly-credits.txt") });
    live(s, LEAD, "idle");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    const a = decided(s, T + 1);
    // The merged unit's Builder is archived: no stop for it; the Lead still gets one.
    expect(stops(a).filter((x) => x.member === BUILDER)).toEqual([]);
    expect(stops(a).filter((x) => x.member === LEAD)).toHaveLength(1);
  });

  test("a Lead on a removed account gets a stop even with no lead_wt", async () => {
    const s = imported();
    s.db.run("UPDATE squads SET lead_wt = NULL WHERE topic = 'demo'");
    on(s, LEAD, "acct-gone");
    worker(s, LEAD, "idle", { tail: screen("dialog-weekly-credits.txt") });
    live(s, LEAD, "idle");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    // A stop needs no restart terminal (U153): the fulfil path closes the agent it finds.
    expect(lstop(s)).toHaveLength(1);
  });

  test("a member waiting on an ask stays put until it is answered", async () => {
    const s = imported();
    on(s, LEAD, "acct-gone");
    worker(s, LEAD, "waiting");
    live(s, LEAD, "waiting");
    usage(s, "100", "40");
    worker(s, BUILDER, "waiting");
    live(s, BUILDER, "waiting");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(lstop(s)).toEqual([]);
    expect(bstop(s)).toEqual([]);
    worker(s, LEAD, "idle");
    live(s, LEAD, "idle");
    expect(await reconcile(s, picker(OTHER), T + 1)).toEqual([]);
    expect(lstop(s, T + 1)).toHaveLength(1);
  });

  test("a stop for an account the member left is not re-emitted once the screen is clear", async () => {
    const s = imported();
    usage(s, "100", "40");
    worker(s, LEAD, "idle");
    live(s, LEAD, "idle");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(lstop(s)).toHaveLength(1);
    // The member moved to acct-b and its screen is clear: the episode closes, no stop.
    on(s, LEAD, "acct-b");
    worker(s, LEAD, "idle", { tail: "❯" });
    live(s, LEAD, "idle");
    expect(await reconcile(s, picker(OTHER), T + 60)).toEqual([]);
    expect(lstop(s, T + 60)).toEqual([]);
  });

  test("a working one waits until it stops", async () => {
    const s = imported();
    on(s, BUILDER, "acct-gone");
    worker(s, BUILDER, "working", { out: T - 30 });
    live(s, BUILDER, "working");
    room(s);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(bstop(s)).toEqual([]);
    worker(s, BUILDER, "idle");
    live(s, BUILDER, "idle");
    expect(await reconcile(s, picker(OTHER), T + 60)).toEqual([]);
    expect(bstop(s, T + 60)).toHaveLength(1);
  });


  for (const [name, spoil] of [
    ["empty", (s: Store) => s.db.run("DELETE FROM observed_accounts")],
    ["stale", (s: Store) => s.db.run("UPDATE observed_accounts SET updated = ?", [String(T - 3600)])],
    ["a failed read (claude's `system` alone)", (s: Store) => { s.db.run("DELETE FROM observed_accounts"); s.upsert("observed_accounts", { agent: "claude", account: "system" }, { updated: String(T), observed_at: T }); }],
  ] as [string, (s: Store) => void][]) {
    test(`an account list that is ${name} moves nobody`, async () => {
      const s = imported();
      list(s);
      spoil(s);
      on(s, THINKER, "acct-gone");
      worker(s, THINKER, "idle");
      worker(s, BUILDER, "idle", { tail: screen("dialog-weekly-credits.txt") });
      const a = await reconcile(s, picker(OTHER));
      expect(kinds(a).filter((k) => k !== "poke")).toEqual([]);
      expect(listed(s).map((e: Row) => e.wt)).toEqual([BUILDER]);
      expect(listed(s)[0].switching).toBeUndefined();
      expect(member(s, THINKER).limited_until).toBeNull();
    });
  }

  test("a member with no account or the `system` account counts as listed", async () => {
    const s = imported();
    on(s, LEAD, null);
    on(s, BUILDER, "system");
    worker(s, LEAD, "idle");
    worker(s, BUILDER, "idle");
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(listed(s)).toBeNull();
  });

  test("a squad that isn't live is not revived", async () => {
    const s = imported();
    s.db.run("UPDATE squads SET status = 'done' WHERE topic = 'demo'");
    on(s, BUILDER, "acct-gone");
    worker(s, BUILDER, "idle");
    worker(s, LEAD, "idle", { tail: screen("dialog-weekly-credits.txt") });
    expect(kinds(await reconcile(s, picker(OTHER))).filter((k) => k === "run-switch")).toEqual([]);
    expect(listed(s).map((e: Row) => e.wt)).toEqual([LEAD]);
  });

  test("the pick skips an old `accounts` row that the current list no longer has", () => {
    const s = imported();
    roster(s);
    s.db.run("DELETE FROM observed_accounts WHERE account != 'acct-a'");
    s.db.run("DELETE FROM accounts");
    for (const account of ["acct-a", "acct-old"]) s.upsert("accounts", { agent: "claude", account }, { observed_at: T });
    s.db.run("UPDATE observed_accounts SET updated = ?", [String(T)]);
    const a: PickArgs = { project: "fx", squad: "demo", role: "lead", suffix: "", limited: { agent: "claude", account: "acct-a", until: T + 3600 } };
    expect(isWait(pickLoop(a, ctx(s)))).toBe(true);
    s.upsert("observed_accounts", { agent: "claude", account: "acct-old" }, { updated: String(T), observed_at: T });
    expect(pickLoop(a, ctx(s))).toMatchObject({ account: "acct-old" });
  });

  test("the Studio on a removed account gets its one alert and is never restarted", async () => {
    const s = imported(), got: Action[] = [];
    s.upsert("members", { project: "fx", squad: "", role: "studio", suffix: "" }, { wt: STUDIO, agent: "claude", account: "acct-gone", updated_at: T, observed_at: T });
    worker(s, STUDIO, "idle");
    const loop = new Loop(s, { observers: [], reconcilers: [makeLimits({ pick: () => OTHER })] }, { act: (a) => { got.push(a); } }, { projects: () => ["fx"] });
    await loop.tick(T); await loop.tick(T + 60);
    expect(kinds(got)).toEqual(["alert"]);
    expect(String((got[0].payload as Row).text)).toStartWith("Studio's account acct-gone is no longer listed");
  });
});

// U55, moved to reconcilers/record.ts by U149: limits judges the live main agent (worker()), and the
// record reconciler, after it in the loop, makes the record follow. `reconcile` here runs both, in that order.
describe("U55/U149: the record follows the live main agent (record.ts)", () => {
  const live = (s: Store, wt: string, account: string | null, at = T, agent = "claude", model: string | null = null) =>
    s.db.run("UPDATE observed_workers SET walk = 'running', agent = ?, live_model = ?, account = ?, account_at = ? WHERE wt = ?", [agent, model, account, at, wt]);
  const reconcile = async (s: Store, p: Picker, at = T) => { const a = await limitsOnly(s, p, at); await record.run(ctx(s, at)); return a; };
  const rec = (s: Store, wt: string) => { const m = member(s, wt); return [m.agent, m.model, m.account]; };
  const on = (s: Store, wt: string, account: string) => s.db.run("UPDATE members SET account = ? WHERE wt = ?", [account, wt]);
  const drift = (s: Store) => s.db.query("SELECT payload FROM events WHERE kind = 'member_account'").all().map((r) => JSON.parse(String((r as Row).payload)));

  test("recorded on a removed account, its live agent on a listed one: no restart, the record names the listed account", async () => {
    const s = imported();
    on(s, BUILDER, "acct-gone");
    worker(s, BUILDER, "idle");
    live(s, BUILDER, "acct-b");
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(member(s, BUILDER).account).toBe("acct-b");
    expect(drift(s)).toEqual([{ from: "acct-gone", to: "acct-b" }]);
    expect(await reconcile(s, picker(OTHER), T + 60)).toEqual([]);
  });

  test("the same member with its live agent on the removed account gets a stop", async () => {
    const s = imported();
    on(s, BUILDER, "acct-gone");
    worker(s, BUILDER, "idle");
    live(s, BUILDER, "acct-gone");
    // Presence and a standing wish (the local live() only sets the walk reading).
    s.upsert("observed_workers", { project: "fx", wt: BUILDER }, { presence: "running", observed_at: T });
    s.db.run("UPDATE members SET want = 'running', want_at = ?, want_result = 'fresh', status = 'running' WHERE wt = ?", [T - 60, BUILDER]);
    usage(s, "10", "10", "acct-a");
    usage(s, "10", "10", "acct-b");
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(member(s, BUILDER).account).toBe("acct-gone");
    // U154: the gone account is a limit switch through the decider, not a run-switch.
    const d = stops(decided(s)).filter((x) => x.member === BUILDER);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ payload: { stop: true, why: "limit" } });
  });

  test("an unknown or old reading changes nothing, and the removed account still gets a stop", async () => {
    const s = imported();
    on(s, BUILDER, "acct-gone");
    worker(s, BUILDER, "idle");
    live(s, BUILDER, "acct-b", T - 600);   // the read keeps failing: this is ten minutes old
    s.upsert("observed_workers", { project: "fx", wt: BUILDER }, { presence: "running", observed_at: T });
    s.db.run("UPDATE members SET want = 'running', want_at = ?, want_result = 'fresh', status = 'running' WHERE wt = ?", [T - 60, BUILDER]);
    usage(s, "10", "10", "acct-a");
    usage(s, "10", "10", "acct-b");
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(member(s, BUILDER).account).toBe("acct-gone");
    const d = stops(decided(s)).filter((x) => x.member === BUILDER);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ payload: { stop: true, why: "limit" } });
  });

  test("a listed record that differs follows only once the two have differed for the settle time", async () => {
    const s = imported();
    on(s, BUILDER, ACCT);
    worker(s, BUILDER, "working", { out: T - 5 });
    live(s, BUILDER, "acct-b");
    await reconcile(s, picker(OTHER));
    expect(member(s, BUILDER).account).toBe(ACCT);
    live(s, BUILDER, "acct-b", T + 60);
    await reconcile(s, picker(OTHER), T + 60);
    expect(member(s, BUILDER).account).toBe(ACCT);
    live(s, BUILDER, "acct-b", T + 120);
    await reconcile(s, picker(OTHER), T + 120);
    expect(member(s, BUILDER).account).toBe("acct-b");
  });

  test("a reading taken before a restart wrote its new account does not undo it", async () => {
    const s = imported();
    on(s, BUILDER, ACCT);
    worker(s, BUILDER, "working", { out: T - 5 });
    live(s, BUILDER, ACCT);
    await reconcile(s, picker(OTHER));
    on(s, BUILDER, "acct-b");                // restart-role.sh: the new account, the old reading
    await reconcile(s, picker(OTHER), T + 20);
    live(s, BUILDER, "acct-b", T + 30);      // the next read sees the restarted agent
    await reconcile(s, picker(OTHER), T + 200);
    expect(member(s, BUILDER).account).toBe("acct-b");
    expect(drift(s)).toEqual([]);
  });

  test("not while the loop's own move of it is under way", async () => {
    const s = imported();
    on(s, BUILDER, "acct-gone");
    worker(s, BUILDER, "idle");
    live(s, BUILDER, "acct-b");
    s.upsert("episodes", { project: "fx", subject: "demo.builder-u1-spike-loop-as-coordinator", kind: "action:run-switch" },
      { episode_key: "limit|x", state: "running", source: "loop", started_at: T, observed_at: T });
    await reconcile(s, picker(OTHER));
    expect(member(s, BUILDER).account).toBe("acct-gone");
  });

  test("U149: a hand restart onto another agent: no move, and after the settle time the record names what runs", async () => {
    const s = imported();
    s.db.run("UPDATE members SET agent = 'codex', model = 'gpt-6.1-sol', account = 'default' WHERE wt = ?", [BUILDER]);
    worker(s, BUILDER, "idle");
    const p = picker(OTHER);
    for (const at of [T, T + 60, T + 120]) {
      live(s, BUILDER, "acct-b", at, "claude", "opus");
      expect(await reconcile(s, p, at)).toEqual([]);
    }
    expect(rec(s, BUILDER)).toEqual(["claude", "opus", "acct-b"]);
    expect(since(s, 0, { kinds: ["member_record"] }).map((e) => JSON.parse(String(e.payload)))).toEqual([
      { from: { agent: "codex", model: "gpt-6.1-sol", account: "default" }, to: { agent: "claude", model: "opus", account: "acct-b" } }]);
  });

  test("U149: a reading the observer stopped refreshing ages against the tick, so a restart's new record decides", async () => {
    const s = imported();
    on(s, BUILDER, "acct-b");                // restart-role.sh wrote the new account; the walk failed since
    worker(s, BUILDER, "idle");
    live(s, BUILDER, "acct-gone", T - 600);
    s.db.run("UPDATE observed_workers SET observed_at = ? WHERE wt = ?", [T - 600, BUILDER]);
    expect(await reconcile(s, picker(OTHER))).toEqual([]);
    expect(member(s, BUILDER).account).toBe("acct-b");
  });

  test("U149: a reading of the agent a restart replaced never rewrites the new record", async () => {
    for (const placed of [T + 10, null]) {
      const s = imported();
      s.db.run("UPDATE members SET agent = 'codex', model = 'gpt-6.1-sol', account = 'default', placed_at = ? WHERE wt = ?", [placed, BUILDER]);
      worker(s, BUILDER, "idle");
      live(s, BUILDER, ACCT, T, "claude", "opus");   // read just before the hand restart onto Codex
      await reconcile(s, picker(OTHER), T + 20);
      expect(rec(s, BUILDER)).toEqual(["codex", "gpt-6.1-sol", "default"]);   // not urgent: another agent's list
      if (placed != null) {
        await reconcile(s, picker(OTHER), T + 200);
        expect(rec(s, BUILDER)).toEqual(["codex", "gpt-6.1-sol", "default"]); // older than the start: not this agent
      }
    }
  });

  test("U149: a live model id that contains the record's ladder word leaves it; unknown and none never change it", async () => {
    const s = imported();
    on(s, BUILDER, ACCT);
    const was = rec(s, BUILDER);
    worker(s, BUILDER, "working", { out: T - 5 });
    live(s, BUILDER, ACCT, T, "claude", `claude-${was[1]}-5-5`);
    await reconcile(s, picker(OTHER)); await reconcile(s, picker(OTHER), T + 200);
    expect(rec(s, BUILDER)).toEqual(was);
    for (const walk of ["unknown", "none"]) {
      s.db.run("UPDATE observed_workers SET walk = ?, agent = 'codex', account = 'default', account_at = ? WHERE wt = ?", [walk, T + 300, BUILDER]);
      await reconcile(s, picker(OTHER), T + 300); await reconcile(s, picker(OTHER), T + 500);
      expect(rec(s, BUILDER)).toEqual(was);
    }
  });
});

// --- U65: a switch the actuator holds back keeps its pick ------------------------------------

// U65 is gone with the held pick: the decider re-picks from rows every tick, and a member start
// holds its pick only inside its own action (fulfil/member.ts placements). What remains is the
// sharing behavior: many limited members, one free account, paced by start slots.
describe("limited members share the one free account", () => {
  test("twelve members limited on one account get stops paced by start slots", async () => {
    const s = imported();
    s.upsert("observed_accounts", { agent: "claude", account: "acct-c" }, { updated: String(T), observed_at: T });
    usage(s, "100", "10", ACCT);
    usage(s, "5", "5", "acct-c");
    s.db.run("UPDATE units SET status = 'dispatched'");
    const wts: string[] = [];
    for (let i = 0; i < 12; i++) {
      const wt = `${WS}builder-x${i}-demo`;
      wts.push(wt);
      // want_result NULL: a fresh standing wish the seed leaves alone (a result would let it re-seed).
      s.db.run("INSERT INTO members (project, squad, role, suffix, wt, status, agent, model, account, want, want_at, want_result, observed_at, updated_at) VALUES ('fx','demo','builder',?,?,'running','claude','opus',?,'running',?,NULL,?,?)", [`x${i}`, wt, ACCT, T - 60, T, T]);
      worker(s, wt, "idle", { tail: screen("weekly-notice.txt") });
      s.upsert("observed_workers", { project: "fx", wt }, { presence: "running", account_at: T, observed_at: T });
    }
    const stopped = new Set<string>();
    for (let tick = 0; tick < 8 && stopped.size < 12; tick++) {
      const at = T + tick * 60;
      expect(await makeLimits().run(ctx(s, at))).toEqual([]);
      const acts = stops(decided(s, at)).filter((a) => wts.includes(String(a.member)));
      // Start slots pace the stops; each member stops at most once per limit episode.
      expect(acts.length).toBeLessThanOrEqual(4);
      for (const a of acts) {
        expect(stopped.has(String(a.member))).toBe(false);
        stopped.add(String(a.member));
        // The restart ran: the member is on the free account with a fresh screen, no longer limited.
        s.db.run("UPDATE members SET account = 'acct-c' WHERE wt = ?", [a.member]);
        s.upsert("observed_workers", { project: "fx", wt: String(a.member) }, { tail: "❯", tail_at: at, observed_at: at });
        s.upsert("episodes", { project: "fx", subject: String(a.member), kind: "limited" }, { state: "closed", ended_at: at, source: "loop", observed_at: at });
      }
    }
    expect(stopped.size).toBe(12);
  });
});


describe("U63: a short known limit wait beats a restart", () => {
  const limited = (s: Store, resetIn: number | null) => {
    worker(s, BUILDER, "idle");
    s.upsert("observed_accounts", { agent: "claude", account: ACCT }, { session_pct: "100", session_reset: resetIn === null ? null : String(T + resetIn), weekly_pct: null, weekly_reset: null, observed_at: T });
  };
  const events = (s: Store, kind: string) => s.db.query("SELECT * FROM events WHERE kind = ?").all(kind) as Row[];

  test("a reset 10 minutes away is waited out: no stop, no tell, one limit_wait event, one poke after the reset", async () => {
    const s = imported(), p = picker(OTHER);
    limited(s, 600);
    live(s, BUILDER, "idle");
    expect(await reconcile(s, p)).toEqual([]);
    expect(member(s, BUILDER).limited_until).toBe(T + 600);
    expect(events(s, "limit_wait")).toHaveLength(1);
    expect(episode(s, BUILDER, "limit-wait")!.state).toBe("waiting");
    // The decider leaves a waited-out limit alone: no stop, no tell.
    const a = decided(s);
    expect(stops(a).filter((x) => x.member === BUILDER)).toEqual([]);
    expect(tells(a)).toEqual([]);
    const after = await reconcile(s, p, T + 601);
    expect(kinds(after)).toEqual(["poke"]);
    expect(episode(s, BUILDER, "limit-wait")!.state).toBe("done");
    expect(kinds(await reconcile(s, p, T + 602))).toEqual([]);
    // The reset passed: the limit is over, so no stop is owed either — the poke told it to carry on.
    expect(stops(decided(s, T + 602)).filter((x) => x.member === BUILDER)).toEqual([]);
  });

  test("a reset 2 hours away still gets the switch", async () => {
    const s = imported(), p = picker(OTHER);
    limited(s, 7200);
    live(s, BUILDER, "idle");
    expect(await reconcile(s, p)).toEqual([]);
    expect(events(s, "limit_wait")).toHaveLength(0);
    expect(stops(decided(s)).filter((x) => x.member === BUILDER)).toHaveLength(1);
  });

  test("an unknown reset gets the switch", async () => {
    const s = imported(), p = picker(OTHER);
    limited(s, null);
    live(s, BUILDER, "idle");
    expect(await reconcile(s, p)).toEqual([]);
    expect(stops(decided(s)).filter((x) => x.member === BUILDER)).toHaveLength(1);
  });

  test("limit_wait_max 0 always switches", async () => {
    const s = imported(), p = picker(OTHER);
    conf(s, "limit_wait_max", "0");
    limited(s, 600);
    live(s, BUILDER, "idle");
    expect(await reconcile(s, p)).toEqual([]);
    expect(events(s, "limit_wait")).toHaveLength(0);
    expect(stops(decided(s)).filter((x) => x.member === BUILDER)).toHaveLength(1);
  });

  test("a project override of limit_wait_max is used over the default", async () => {
    const s = imported(), p = picker(OTHER);
    conf(s, "limit_wait_max", "5");
    limited(s, 600);
    live(s, BUILDER, "idle");
    expect(await reconcile(s, p)).toEqual([]);
    expect(stops(decided(s)).filter((x) => x.member === BUILDER)).toHaveLength(1);
    const s2 = imported(), p2 = picker(OTHER);
    conf(s2, "limit_wait_max", "120");
    limited(s2, 7200);
    live(s2, BUILDER, "idle");
    expect(await reconcile(s2, p2)).toEqual([]);
    const a2 = decided(s2);
    expect(stops(a2).filter((x) => x.member === BUILDER)).toEqual([]);
    expect(tells(a2)).toEqual([]);
  });
});

describe("U6: cleanup keys and the whole-value reader", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.DS_LIMIT_CLEANUP_ON_CLOSE; delete process.env.DS_LIMIT_CLEANUP_TMP_GLOBS; });
  function store(rows: Record<string, string> = {}, project: Record<string, string> = {}): Store {
    const d = mkdtempSync(join(tmpdir(), "zzloop-")); dirs.push(d);
    const s = open(d);
    const put = (p: string, k: string, v: string) => s.db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES (?, 'limits.conf', ?, ?, 1)", [p, k, v]);
    for (const [k, v] of Object.entries(rows)) put("", k, v);
    for (const [k, v] of Object.entries(project)) put("fx", k, v);
    return s;
  }
  test("limitLine returns the whole value; project beats '' and env beats both", () => {
    const s = store({ cleanup_on_close: "default cmd" }, { cleanup_on_close: "docker compose down -v" });
    expect(limitLine(s, "fx", "cleanup_on_close")).toBe("docker compose down -v");
    expect(limitLine(s, "other", "cleanup_on_close")).toBe("default cmd");
    process.env.DS_LIMIT_CLEANUP_ON_CLOSE = "from env --all";
    expect(limitLine(s, "fx", "cleanup_on_close")).toBe("from env --all");
    s.close();
  });
  test("limitLine is null for -, empty and a missing key; limit() still cuts at the first word", () => {
    const s = store({ a: "-", b: "   " }, { c: "-", d: "one two" });
    for (const k of ["a", "b", "c", "missing"]) expect(limitLine(s, "fx", k)).toBeNull();
    expect(limit(s, "fx", "d")).toBe("one");
    expect(limitLine(s, "fx", "d")).toBe("one two");
    s.close();
  });
  test("a limits.conf line keeps its value whole and drops the ` #` comment", () => {
    const s = store(); const f = join(s.root, "fx"); mkdirSync(join(f, "squads"), { recursive: true });
    writeFileSync(join(f, "limits.conf"), "cleanup_on_close scripts/down.sh --all  # note\n");
    importConfig(s, s.root, tempRoot("zzloop-conv-"));
    expect(limitLine(s, "fx", "cleanup_on_close")).toBe("scripts/down.sh --all");
    s.close();
  });
  test("cleanupGlobs splits on commas and spaces", () => {
    for (const v of ["/tmp/aaa-*,/tmp/bbb-*", "/tmp/aaa-* /tmp/bbb-*"]) {
      const s = store({}, { cleanup_tmp_globs: v });
      expect(cleanupGlobs(s, "fx")).toEqual({ valid: ["/tmp/aaa-*", "/tmp/bbb-*"], rejected: [] });
      s.close();
    }
  });
  test("cleanupGlobs rejects unsafe globs with a reason", () => {
    const s = store();
    const bad = ["tmp/x-*", "/tmp/*", "/tmp/*/x-*", "/xxx-*", `${s.root}/xxx-*`, `${s.root}/fx/xxx-*`, "/tmp/ab*", "/tmp/[a-z]*", "/tmp/[abc][de]*", "/tmp/plain"];
    s.db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES ('fx', 'limits.conf', 'cleanup_tmp_globs', ?, 1)", [bad.join(" ")]);
    const r = cleanupGlobs(s, "fx");
    expect(r.valid).toEqual([]);
    expect(r.rejected.map((x) => x.glob)).toEqual(bad);
    expect(r.rejected.map((x) => x.reason)).toEqual(["not an absolute path", "last segment has fewer than 3 literal characters", "wildcard in a middle segment",
      "parent / is protected", `parent ${s.root} is protected`, `under protected ${s.root}`, "last segment has fewer than 3 literal characters",
      "last segment has fewer than 3 literal characters", "last segment has fewer than 3 literal characters", "no wildcard"]);
    s.close();
  });
  test("cleanup_tmp_age_h is 48 by default and again for a non-number", () => {
    const conv = readFileSync(join(ROOT, "conventions", "limits.conf"), "utf8");
    expect(conv).toMatch(/^cleanup_tmp_age_h 48\b/m);
    expect(conv).toMatch(/^cleanup_tmp_globs -/m);
    expect(conv).toMatch(/^cleanup_on_close -/m);
    const s = store({ cleanup_tmp_age_h: "48" }, {});
    expect(limitInt(s, "fx", "cleanup_tmp_age_h", 48)).toBe(48);
    s.db.run("UPDATE config SET value = 'abc'");
    expect(limitInt(s, "fx", "cleanup_tmp_age_h", 48)).toBe(48);
    s.close();
  });
});

describe("credits fingerprint (provider billing error)", () => {
  const CR = join(import.meta.dir, "..", "fixtures", "credits");
  const fx = (f: string) => readFileSync(join(CR, f), "utf8");
  const g = (agent: string | null, over: Partial<Gate> = {}): Gate => ({ agent, state: "idle", since: T - 30, lastOutput: T - 30, now: T, silentMin: 10, ...over });

  test("the three Muse screens read as credits: no reset, the billing link, at once on an idle worker", () => {
    for (const f of ["muse-402-a.txt", "muse-402-b.txt", "muse-402-c.txt"]) {
      const r = scan(fx(f), g("muse"));
      expect(r).toMatchObject({ reset: null, dialog: false, kind: "credits" });
      expect(r!.link).toMatch(/^https:\/\/dev\.meta\.ai\/billing\/\?team_id=\d{4}$/);
      expect(r!.notice).toStartWith("model failed: API error 402");
    }
  });
  test("a working worker keeps the silence rule", () => {
    expect(scan(fx("muse-402-a.txt"), g("muse", { state: "working", lastOutput: T - 30 }))).toBeNull();
    expect(scan(fx("muse-402-a.txt"), g("muse", { state: "working", lastOutput: T - 900 }))).toMatchObject({ kind: "credits" });
  });
  test("near misses return null: prose quoting the line, output after the error", () => {
    expect(scan(fx("muse-prose-after.txt"), g("muse"))).toBeNull();
    expect(scan(fx("muse-quoted.txt"), g("muse"))).toBeNull();
    expect(scan(fx("claude-quoted.txt"), g("claude"))).toBeNull();
    expect(scan(fx("muse-402-a.txt").replace("◆ model failed", "Example: ◆ model failed"), g("muse"))).toBeNull();
  });
  test("each shape counts only on its own agent", () => {
    expect(scan(fx("muse-402-a.txt"), g("claude"))).toBeNull();
    expect(scan(fx("muse-402-a.txt"), g(null))).toBeNull();
    expect(scan(fx("codex-quota.txt"), g("muse"))).toBeNull();
    expect(scan(fx("codex-quota.txt"), g("codex"))).toMatchObject({ kind: "credits", reset: null });
    for (const f of ["claude-402.txt", "claude-credit-low.txt"]) {
      expect(scan(fx(f), g("claude"))).toMatchObject({ kind: "credits", reset: null });
      expect(scan(fx(f), g(null))).toMatchObject({ kind: "credits" });
      expect(scan(fx(f), g("muse"))).toBeNull();
    }
    expect(scan(fx("claude-credit-low.txt"), g("claude"))!.link).toBe("https://console.anthropic.com/settings/billing");
  });
  test("a Muse limit notice followed by agent output no longer counts", () => {
    expect(scan(screen("muse-limit.txt") + "\n◆ carrying on", { agent: "muse", state: "idle", since: T - 900, lastOutput: T - 900, now: T, silentMin: 10 })).toBeNull();
  });
  // provider-billing-fallback U4: a narrow pane cuts the billing line into rows of its width, the link too.
  // (Below ~45 columns muse-402-b's 402 row leaves the WINDOW rows the scan reads at all.)
  test("the link is captured whole when a narrow pane wraps it", () => {
    const cut = (text: string, w: number) => text.split("\n").flatMap((l) => Array.from({ length: Math.max(1, Math.ceil(l.length / w)) }, (_, i) => l.slice(i * w, i * w + w))).join("\n");
    for (const f of ["muse-402-a.txt", "muse-402-b.txt", "claude-credit-low.txt"]) {
      const whole = scan(fx(f), g(f.startsWith("muse") ? "muse" : "claude"))!.link;
      expect(whole).toMatch(/^https:\/\//);
      for (const w of [47, 60, 80, 120, 200]) expect([f, w, scan(cut(fx(f), w), g(f.startsWith("muse") ? "muse" : "claude"))?.link]).toEqual([f, w, whole]);
    }
  });
  test("on a wide pane the notice row is not a cut: the next row stays off the link", () => {
    const low = "  ⎿  Credit balance is too low · Add funds: https://console.anthropic.com/settings/billing";
    expect(scan(`${low}\n✻ Worked for 3s`, g("claude"))?.link).toBe("https://console.anthropic.com/settings/billing");
    // Narrow panes too, also where the link's last row exactly fills the pane.
    for (let w = 40; w <= 90; w++) {
      const rows = [low.slice(0, w), low.slice(w, 2 * w), low.slice(2 * w)].filter(Boolean).join("\n");
      expect([w, scan(`${rows}\n✻ Worked for 3s`, g("claude"))?.link]).toEqual([w, "https://console.anthropic.com/settings/billing"]);
    }
    const bare = scan("  ⎿  API Error: 402 Billing verification failed: your team needs to resolve a billing issue\nSee https://status.example.com/x", g("claude"));
    expect(bare?.kind).toBe("credits");
    expect(bare?.link).toBeUndefined();
  });
});

describe("U2: an account out of credits is held host-wide", () => {
  const CR = join(import.meta.dir, "..", "fixtures", "credits");
  const fx = (f: string) => readFileSync(join(CR, f), "utf8");
  const H = 24 * 3600;
  // The builder runs Muse on its default login and shows `f` (a 402 screen) idle since `at`.
  function muse(s: Store, f: string, at = T) {
    s.db.run("UPDATE members SET agent = 'muse', model = 'muse-spark-1.3', account = 'default' WHERE wt = ?", [BUILDER]);
    s.upsert("observed_accounts", { agent: "muse", account: "default" }, { updated: String(at), observed_at: at });
    s.upsert("observed_workers", { project: "fx", wt: BUILDER }, { state: "idle", tail: fx(f), tail_at: at, since: at - 900, last_output_at: at - 900, limited: null, gone_at: null, suspect: 0, observed_at: at });
  }
  const tick = (s: Store, at: number) => makeLimits().run(ctx(s, at));
  const said = (s: Store, kind: string) => since(s, 0, { kinds: [kind] }).map((e) => ({ ...e, payload: JSON.parse(String(e.payload)) as Row }));
  const held = (s: Store) => said(s, "account_credits_held");
  const cleared = (s: Store) => said(s, "account_credits_cleared");
  const probe = (s: Store, set: Row, at: number) => s.upsert("observed_accounts", { agent: "muse", account: "default" }, { session_pct: "-", weekly_pct: "-", note: "-", observed_at: at, ...set });
  // Nothing blocks the account any more, from any source: no live account episode, no stamp.
  function unblocked(s: Store, at: number) {
    expect(s.db.query("SELECT subject FROM episodes WHERE kind = 'account' AND state = 'muse/default' AND ended_at > ?").all(at)).toEqual([]);
    expect(s.db.query("SELECT 1 FROM members WHERE account = 'default' AND limited_until IS NOT NULL").all()).toEqual([]);
    expect(s.db.query("SELECT 1 FROM observed_accounts WHERE agent = 'muse' AND limited_until IS NOT NULL").all()).toEqual([]);
    expect(accountBlock(s, "muse", "default", at)).toBeNull();
  }

  test("a 402 on screen holds the account for credits_hold_h, not the 1 h guess", async () => {
    const s = imported();
    muse(s, "muse-402-a.txt");
    await tick(s, T);
    expect(creditsHold(s, "muse", "default", T)).toBe(T + H);
    expect(accountBlock(s, "muse", "default", T)).toBe("credits");
    expect(held(s).map((e) => (e.payload as Row).from)).toEqual(["screen"]);
    expect((held(s)[0].payload as Row).link).toMatch(/^https:\/\/dev\.meta\.ai\/billing\//);
    expect(member(s, BUILDER).limited_until).toBe(T + H);
    // An hour on, the notice still up: still held, until the same end.
    await tick(s, T + 3600);
    expect(creditsHold(s, "muse", "default", T + 3600)).toBe(T + H);
    expect(accountBlock(s, "muse", "default", T + 3601)).toBe("credits");
  });

  test("two 402s in a row on one member make one hold", async () => {
    const s = imported();
    muse(s, "muse-402-a.txt");
    await tick(s, T);
    muse(s, "muse-402-b.txt", T + 60);
    await tick(s, T + 60);
    expect(held(s)).toHaveLength(1);
    expect(creditsHold(s, "muse", "default", T + 60)).toBe(T + H);
    const ep = episode(s, BUILDER, "limited")!;
    expect([ep.state, ep.started_at, String(ep.episode_key)]).toEqual(["credits", T, expect.stringContaining("req_8")]);
    expect(since(s, 0, { kinds: ["limited"] })).toHaveLength(1);
  });

  test("a 402 after the hold ran out is a new hold, not merged into the old episode", async () => {
    const s = imported();
    muse(s, "muse-402-a.txt");
    await tick(s, T);
    muse(s, "muse-402-b.txt", T + H + 60);
    await tick(s, T + H + 60);
    expect(held(s)).toHaveLength(2);
    expect(creditsHold(s, "muse", "default", T + H + 60)).toBe(T + 2 * H + 60);
    expect(episode(s, BUILDER, "limited")!.started_at).toBe(T + H + 60);
  });

  test("a clear leaves no block; the old notice stays cleared, a new request id holds again", async () => {
    const s = imported();
    muse(s, "muse-402-a.txt");
    await tick(s, T);
    const r = clearCredits(s, "muse", "default", "operator", T + 120);
    expect(r).toMatchObject({ held: true, members_cleared: 1 });
    expect((cleared(s)[0].payload as Row).by).toBe("operator");
    unblocked(s, T + 120);
    // The same billing line still on screen: stays cleared, no hold, no stamp.
    await tick(s, T + 180);
    // Ended at the clear: the decider and restart picks read a member's limit by its ended_at.
    expect([episode(s, BUILDER, "limited")!.state, episode(s, BUILDER, "limited")!.ended_at]).toEqual(["cleared", T + 120]);
    unblocked(s, T + 180);
    expect(held(s)).toHaveLength(1);
    // A fresh 402 (new request id) is a new hold.
    muse(s, "muse-402-c.txt", T + 240);
    await tick(s, T + 240);
    expect(held(s)).toHaveLength(2);
    expect(creditsHold(s, "muse", "default", T + 240)).toBe(T + 240 + H);
  });

  test("ds account enable clears the hold of an account that was never disabled", async () => {
    const s = imported();
    muse(s, "muse-402-a.txt");
    await tick(s, T);
    expect(setAccountEnabled(s, { agent: "muse", account: "default", enabled: true, by: "test" }, T + 60)).toMatchObject({ cleared: true });
    unblocked(s, T + 60);
    expect(setAccountEnabled(s, { agent: "muse", account: "default", enabled: true, by: "test" }, T + 61).cleared).toBeUndefined();
  });

  test("the probe's out-of-credits note holds the account with no member involved; an allowance ends it", async () => {
    const s = imported();
    probe(s, { note: "out of credits" }, T);
    await tick(s, T);
    expect(creditsHold(s, "muse", "default", T)).toBe(T + H);
    expect(held(s).map((e) => (e.payload as Row).from)).toEqual(["probe"]);
    await tick(s, T + 60);
    expect(held(s)).toHaveLength(1);
    probe(s, { session_pct: "3" }, T + 600);
    await tick(s, T + 600);
    expect(creditsHold(s, "muse", "default", T + 600)).toBeNull();
    expect((cleared(s)[0].payload as Row).by).toBe("probe");
    unblocked(s, T + 600);
  });

  test("after an operator clear the probe's stale note holds again only once it recovered and ran out again", async () => {
    const s = imported();
    probe(s, { note: "out of credits" }, T);
    await tick(s, T);
    clearCredits(s, "muse", "default", "operator", T + 60);
    await tick(s, T + 120);
    expect(creditsHold(s, "muse", "default", T + 120)).toBeNull();
    probe(s, { note: "no usage yet" }, T + 180);
    await tick(s, T + 180);
    expect(cleared(s)).toHaveLength(1);   // nothing held: the allowance has nothing to clear
    probe(s, { note: "out of credits" }, T + 240);
    await tick(s, T + 240);
    expect(creditsHold(s, "muse", "default", T + 240)).toBe(T + 240 + H);
    expect(held(s)).toHaveLength(2);
  });

  test("credits_hold_h sets the hold's length", async () => {
    const s = imported();
    conf(s, "credits_hold_h", "2");
    muse(s, "muse-402-a.txt");
    await tick(s, T);
    expect(creditsHold(s, "muse", "default", T)).toBe(T + 7200);
  });
});

describe("U3: a member out of credits moves, or is left alone until its account works again", () => {
  const CR = join(import.meta.dir, "..", "fixtures", "credits");
  const fx = (f: string) => readFileSync(join(CR, f), "utf8");
  const tick = (s: Store, at: number) => makeLimits().run(ctx(s, at));
  const builderRow = (s: Store, value: string) => s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value, observed_at: T });
  // `wt` runs `agent` on `account` and shows the credits screen `f`, idle, with a live agent.
  function stuck(s: Store, wt: string, agent: string, model: string, account: string, f: string, at = T) {
    s.db.run("UPDATE members SET agent = ?, model = ?, account = ? WHERE wt = ?", [agent, model, account, wt]);
    s.upsert("observed_accounts", { agent, account }, { updated: String(at), observed_at: at });
    s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", tail: fx(f), tail_at: at, since: at - 900, last_output_at: at - 900, limited: null, gone_at: null, suspect: 0, observed_at: at });
    live(s, wt);
  }
  const mine = (a: Action[], wt: string) => a.filter((x) => x.member === wt);
  const AGAIN = "dev-studio loop: the muse/default account works again — carry on where you left off.";

  test("a Muse Builder on the 402 is stopped when idle, and its start's pick is the roster's next rung", async () => {
    const s = imported();
    builderRow(s, "muse muse-spark-1.3 ondemand max claude:opus:high");
    stuck(s, BUILDER, "muse", "muse-spark-1.3", "default", "muse-402-a.txt");
    await tick(s, T);
    expect(episode(s, BUILDER, "limited")!.state).toBe("credits");
    const a = decided(s);
    expect(stops(mine(a, BUILDER))).toEqual([expect.objectContaining({ payload: expect.objectContaining({ stop: true, why: "limit" }) })]);
    expect(tells(a)).toEqual([]);
    const p = pickAccount(s, { project: "fx", role: "builder", tier: "hard", phase: "build" }, T);
    expect(p).toMatchObject({ agent: "claude", model: "opus", effort: "high", fallback: true });
  });

  test("a Thinker on Claude's credit-balance 402 is stopped when idle and moves to another account", async () => {
    const s = imported();
    stuck(s, THINKER, "claude", "opus", ACCT, "claude-402.txt");
    await tick(s, T);
    expect(episode(s, THINKER, "limited")!.state).toBe("credits");
    const a = decided(s);
    expect(stops(mine(a, THINKER))).toEqual([expect.objectContaining({ payload: expect.objectContaining({ stop: true, why: "limit" }) })]);
    expect(tells(a)).toEqual([]);
    const p = pickAccount(s, { project: "fx", role: "thinker", phase: "build" }, T) as Row;
    expect(p.agent).toBe("claude");
    expect(p.account).not.toBe(ACCT);   // its account is held out of every pick
  });

  test("with every rung out it gets no tell and no stop; after a clear it is told it works again, once", async () => {
    const s = imported();
    builderRow(s, "muse muse-spark-1.3 ondemand max -");
    stuck(s, BUILDER, "muse", "muse-spark-1.3", "default", "muse-402-a.txt");
    await tick(s, T);
    for (const at of [T, T + 60, T + 3600]) {
      const a = mine(decided(s, at), BUILDER);
      expect(stops(a)).toEqual([]);
      expect(tells(a)).toEqual([]);
    }
    expect(setAccountEnabled(s, { agent: "muse", account: "default", enabled: true, by: "test" }, T + 3700)).toMatchObject({ cleared: true });
    await tick(s, T + 3720);   // the notice is still on screen: the episode stays `cleared`
    expect(episode(s, BUILDER, "limited")!.state).toBe("cleared");
    const told = tells(mine(decided(s, T + 3720), BUILDER));
    expect(told.map((x) => (x.payload as Row).text)).toEqual([AGAIN]);
    expect(told[0].episode).toStartWith("credits-ok:credits-ok|muse/default|");
    for (const at of [T + 3780, T + 7200]) expect(tells(mine(decided(s, at), BUILDER))).toEqual([]);
  });

  test("a second clear with the same notice (Claude's 402 has no request id) tells it again, once", () => {
    const s = imported();
    stuck(s, BUILDER, "claude", "opus", ACCT, "claude-402.txt");
    const key = `claude/${ACCT}|API Error: 402 credit balance`;
    const cleared = (started: number, at: number) => s.upsert("episodes", { project: "fx", subject: BUILDER, kind: "limited" },
      { episode_key: key, state: "cleared", started_at: started, ended_at: at, source: "loop", observed_at: at });
    cleared(T, T + 60);
    expect(tells(mine(decided(s, T + 60), BUILDER))).toHaveLength(1);
    expect(tells(mine(decided(s, T + 120), BUILDER))).toEqual([]);
    cleared(T + 3600, T + 3660);
    expect(tells(mine(decided(s, T + 3660), BUILDER)).map((x) => (x.payload as Row).text)).toEqual([`dev-studio loop: the claude/${ACCT} account works again — carry on where you left off.`]);
    expect(tells(mine(decided(s, T + 3720), BUILDER))).toEqual([]);
  });

  test("a member that moved off the cleared account is not told it works again", async () => {
    const s = imported();
    builderRow(s, "muse muse-spark-1.3 ondemand max -");
    stuck(s, BUILDER, "muse", "muse-spark-1.3", "default", "muse-402-a.txt");
    await tick(s, T);
    clearCredits(s, "muse", "default", "operator", T + 60);
    s.db.run("UPDATE members SET agent = 'claude', model = 'opus', account = ? WHERE wt = ?", [ACCT, BUILDER]);
    expect(tells(mine(decided(s, T + 120), BUILDER))).toEqual([]);
  });
});

describe("claude-login-ended U2: a member whose login ended moves like one out of credits", () => {
  const LOGIN = readFileSync(join(import.meta.dir, "..", "fixtures", "login", "claude-login-ended.txt"), "utf8");
  const tick = (s: Store, at: number) => makeLimits().run(ctx(s, at));
  const mine = (a: Action[], wt: string) => a.filter((x) => x.member === wt);
  function stuck(s: Store, wt: string, account: string, at = T) {
    s.db.run("UPDATE members SET agent = 'claude', model = 'opus', account = ? WHERE wt = ?", [account, wt]);
    s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", tail: LOGIN, tail_at: at, since: at - 900, last_output_at: at - 900, limited: null, gone_at: null, suspect: 0, observed_at: at });
    live(s, wt);
  }

  test("a Thinker on Claude's login line is stopped when idle, with no tell, and its account is out of the pick", async () => {
    const s = imported();
    stuck(s, THINKER, ACCT);
    await tick(s, T);
    expect(episode(s, THINKER, "limited")!.state).toBe("login");
    expect(member(s, THINKER).limited_until).toBe(T + 3600);
    const a = decided(s);
    expect(stops(mine(a, THINKER))).toEqual([expect.objectContaining({ payload: expect.objectContaining({ stop: true, why: "limit" }) })]);
    expect(tells(a)).toEqual([]);
    expect(accountBlock(s, "claude", ACCT, T)).toBe("login");
    expect((pickAccount(s, { project: "fx", role: "thinker", phase: "build" }, T) as Row).account).not.toBe(ACCT);
  });

  test("a member that moved off the cleared account is not told its login works again", async () => {
    const s = imported();
    stuck(s, BUILDER, ACCT);
    await tick(s, T);
    setAccountEnabled(s, { agent: "claude", account: ACCT, enabled: true, by: "test" }, T + 60);
    s.db.run("UPDATE members SET account = 'acct-b' WHERE wt = ?", [BUILDER]);
    expect(tells(mine(decided(s, T + 120), BUILDER))).toEqual([]);
  });
});

describe("U5: a member on an account the operator switched off moves when idle", () => {
  const builderRow = (s: Store, value: string) => s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value, observed_at: T });
  const mine = (a: Action[], wt: string) => a.filter((x) => x.member === wt);
  const off = (s: Store, at: number, enabled = false) => setAccountEnabled(s, { agent: "muse", account: "default", enabled, by: "test" }, at);
  // A Muse Builder on muse:default, idle with a live agent, roster `muse … <next>`.
  function museBuilder(next = "claude:opus:high", state = "idle"): Store {
    const s = imported();
    builderRow(s, `muse muse-spark-1.3 ondemand max ${next}`);
    s.db.run("UPDATE members SET agent = 'muse', model = 'muse-spark-1.3', account = 'default' WHERE wt = ?", [BUILDER]);
    s.upsert("observed_accounts", { agent: "muse", account: "default" }, { updated: String(T), observed_at: T });
    worker(s, BUILDER, state);
    live(s, BUILDER, state);
    return s;
  }
  const disabledId = (s: Store) => Number((s.db.query("SELECT max(id) AS id FROM events WHERE kind = 'account_disabled'").get() as Row).id);
  // The checkpoint ask, then (with no line written) the stop once CHECKPOINT_S passed.
  function stopAfterCheckpoint(s: Store, at: number): Action[] {
    const asked = mine(decided(s, at), BUILDER);
    expect(stops(asked)).toEqual([]);
    expect(asked.map((x) => String((x.payload as Row).text ?? ""))).toEqual([expect.stringContaining("bin/role/pause-checkpoint.sh")]);
    return stops(mine(decided(s, at + CHECKPOINT_S), BUILDER));
  }

  test("idle on muse:default: its checkpoint is asked, then it stops, and its start's pick is the next rung", () => {
    const s = museBuilder();
    off(s, T - 60);
    const stop = stopAfterCheckpoint(s, T);
    expect(stop).toEqual([expect.objectContaining({ episode: `stop:account:muse/default@${disabledId(s)}`, payload: expect.objectContaining({ stop: true, why: "account" }) })]);
    expect(pickAccount(s, { project: "fx", role: "builder", tier: "hard", phase: "build" }, T)).toMatchObject({ agent: "claude", model: "opus", effort: "high", fallback: true });
  });

  test("mid-turn it is left alone, no checkpoint asked, until it is idle", () => {
    const s = museBuilder("claude:opus:high", "working");
    off(s, T - 60);
    expect(mine(decided(s, T), BUILDER)).toEqual([]);
    worker(s, BUILDER, "idle"); live(s, BUILDER);
    expect(stopAfterCheckpoint(s, T + 60).map((x) => (x.payload as Row).why)).toEqual(["account"]);
  });

  test("with every rung out nothing is stopped; it keeps running on the switched-off account", () => {
    const s = museBuilder("-");
    off(s, T - 60);
    for (const at of [T, T + CHECKPOINT_S, T + 3600]) expect(mine(decided(s, at), BUILDER)).toEqual([]);
  });

  test("disable, enable, disable: two stops with two keys; the same switch never stops twice", () => {
    const s = museBuilder();
    off(s, T - 60);
    const first = stopAfterCheckpoint(s, T);
    expect(first).toHaveLength(1);
    off(s, T + 400, true);
    expect(stops(mine(decided(s, T + 420), BUILDER))).toEqual([]);   // enabling moves nobody back
    off(s, T + 500);
    const second = stopAfterCheckpoint(s, T + 520);
    expect(second).toHaveLength(1);
    expect(second[0].episode).not.toBe(first[0].episode);
  });

  test("through the fulfillers: stopped once idle (a mid-turn stop drops), then started on claude:opus", async () => {
    const s = museBuilder();
    off(s, T - 60);
    s.db.run("CREATE TRIGGER proved AFTER INSERT ON stop_checkpoints BEGIN UPDATE stop_checkpoints SET state = 'verified' WHERE id = NEW.id; END");
    s.upsert("coordinators", { project: "fx", squad: "demo" }, { handle: "term_loop", run_id: "run1", created_at: T - 3600, bound_at: T - 3600 });
    const [a] = stops(mine(decided(s), BUILDER));
    const memberFulfiller = (await import("../../bin/loop/fulfil/member.ts")).default;
    expect(memberFulfiller.stale!(a, { store: s, now: T } as never)).toBe(false);
    s.upsert("observed_workers", { project: "fx", wt: BUILDER }, { state: "working" });
    expect(memberFulfiller.stale!(a, { store: s, now: T } as never)).toBe(true);
    s.upsert("observed_workers", { project: "fx", wt: BUILDER }, { state: "idle" });
    const orca = new FakeBackend(), act = new LoopActuator({ orca });
    const fulfillers = await load<Reconciler>(DIRS.fulfil), decider = (await import("../../bin/loop/core/decide.ts")).default;
    const loop = new Loop(s, { observers: [], reconcilers: [decider, ...fulfillers] }, act, { projects: () => ["fx"] });
    const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
    await tick(T);
    expect(orca.of("worker-stop").filter((c) => c.args[1] === BUILDER)).toHaveLength(1);
    s.upsert("observed_workers", { project: "fx", wt: BUILDER }, { presence: "none", account_at: T + 1, observed_at: T + 1 });
    await tick(T + 1);
    const started = orca.of("worker-start").filter((c) => c.args[1] === BUILDER);
    expect(started).toHaveLength(1);
    expect(member(s, BUILDER)).toMatchObject({ agent: "claude", model: "opus" });
    expect(String(started[0].args[2])).toContain("journal.sh fx demo builder-u1-spike-loop-as-coordinator briefing");
  });

  test("a member pinned to the account is not moved", () => {
    const s = museBuilder();
    off(s, T - 60);
    s.db.run("INSERT INTO overrides (member, model, account, scope, set_by, set_at) VALUES (?, NULL, 'default', 'member', 'operator', ?)", [BUILDER, T - 30]);
    for (const at of [T, T + CHECKPOINT_S]) expect(mine(decided(s, at), BUILDER)).toEqual([]);
  });
});
