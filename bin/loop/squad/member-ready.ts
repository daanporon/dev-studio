// member-ready.ts — KTD4 (board chat): may the loop type into this member's agent terminal now?
//
// Only when nobody is mid-anything there: the member is not working, its output (and its Claude
// transcript) has been quiet for `quietS`, the screen was read since that output and its prompt row
// is empty, no picker is open (an open picker question for it, or a menu its driver knows on the
// screen), no mail to it is unread, and no earlier typed action for it (an undone answer, poke, keys
// or chat request, or a delivery not yet taken) is ahead of this one. Each refusal names its own why.
// A board chat to a Claude member passes `screenNoise: "ignore"`: output alone does not hold it, only a
// fresh transcript or Claude's working marker on a screen read since that output.
// A Claude member Orca reads `working` whose last turn ended or was interrupted (Esc) and whose screen
// shows an empty prompt with no working marker is not working (stoppedAtPrompt, U4).
//
// A member is read by worktree (observed_workers: the worktree's agent terminal, the one the backend's
// poke types into). The Studio is read by its adopted handle only (observed_terminals), since its
// worktree also holds ds-loop panes and shells: studioReady() (studio.ts) is this on that handle plus
// the Studio's own extras.
import { driverModule } from "../drivers/index.ts";
import type { Seat } from "../drivers/types.ts";
import type { Row, Store } from "../core/store.ts";
import { turnEnded } from "../reconcilers/liveness.ts";

export type Ready = { ready: boolean; why: string };
export type ReadyOpts = {
  quietS: number;
  handle?: string | null;   // read this terminal (the Studio's adopted one) instead of the worktree's
  agent?: string | null;    // whose driver knows the menus on the screen
  before?: number | null;   // this request's id: only requests filed before it count as ahead
  // "ignore" (board chat only, fulfil/chat.ts): for a Claude member, recent terminal output alone is
  // not busy. It is busy only while its transcript was written within quietS or the newest screen read,
  // taken after that output, shows Claude's working marker (workingOnScreen). Any other agent keeps the rule.
  screenNoise?: "ignore";
};

// Claude's working marker: `esc to interrupt` in the status row under its prompt box (or on the
// spinner row just above it). Only the screen's last rows are read, so a reply quoting the words
// higher up does not read as working.
const MARKER_ROWS = 6;
export function workingOnScreen(tail: string): boolean {
  return tail.replace(/\s+$/, "").split("\n").slice(-MARKER_ROWS).some((l) => /esc to interrupt/i.test(l));
}

// The request kinds that type into a member's terminal.
export const TYPED_KINDS = ["answer", "poke", "keys", "chat"] as const;

const parse = (s: unknown): Row => { try { const o = JSON.parse(String(s ?? "")); return o && typeof o === "object" ? o : {}; } catch { return {}; } };

// The prompt row's text: the last screen row that is a prompt (`>`, `❯` or `›`, inside a box or
// not). "" for an empty prompt, null when no prompt row shows.
export function promptDraft(tail: string): string | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*[│┃|]?\s*[>❯›](?:\s(.*?))?\s*[│┃|]?\s*$/.exec(lines[i]!);
    if (m) return (m[1] ?? "").trim();
  }
  return null;
}

// answerMenu reads only the screen; the driver is built on a seat that is never called.
const NO_SEAT: Seat = {
  squad: { project: "", topic: "", run_id: null, repo: null, lead_wt: null },
  call: () => Promise.reject(new Error("member-ready: no seat")),
  send: () => Promise.reject(new Error("member-ready: no seat")),
};
function menuOn(agent: string | null | undefined, tail: string): boolean {
  try { return driverModule(agent).make(NO_SEAT).answerMenu(tail) != null; } catch { return false; }
}

// studio-hung-agent-broken U4: a Claude member Orca still reads `working` after an Esc (no Stop hook
// runs, so Orca keeps `working` until the next turn ends) is not working when its screen and transcript
// agree: the newest screen read, taken since its last output, shows an empty prompt and no working
// marker, and its transcript's last turn ended or was interrupted (liveness.ts turnEnded). Cheap checks
// first, the transcript parse last. No transcript, or a screen older than the output: still working.
function stoppedAtPrompt(store: Store, wt: string, agent: string | null | undefined, out: number, tail: string, tailAt: number | null): boolean {
  if ((agent || "claude") !== "claude") return false;
  if (tailAt == null || tailAt < out) return false;
  if (promptDraft(tail) !== "" || workingOnScreen(tail)) return false;
  return turnEnded(store, wt);
}

export function memberReady(store: Store, project: string, wt: string, now: number, o: ReadyOpts): Ready {
  const no = (why: string): Ready => ({ ready: false, why });
  let out: number, tail: string, tailAt: number | null, unread: number;
  if (o.handle) {
    const t = store.db.query("SELECT tail, tail_at, doc FROM observed_terminals WHERE project = ? AND handle = ? AND gone_at IS NULL").get(project, o.handle) as Row | null;
    if (!t) return no(`terminal ${o.handle} is gone`);
    const doc = parse(t.doc);
    out = Number(doc.last_output_at ?? 0); tail = String(t.tail ?? ""); tailAt = t.tail_at == null ? null : Number(t.tail_at); unread = Number(doc.unread ?? 0);
  } else {
    const w = store.db.query("SELECT state, last_output_at, tail, tail_at, unread, gone_at FROM observed_workers WHERE project = ? AND wt = ?").get(project, wt) as Row | null;
    if (!w || w.gone_at != null) return no("no live terminal");
    out = Number(w.last_output_at ?? 0); tail = String(w.tail ?? ""); tailAt = w.tail_at == null ? null : Number(w.tail_at); unread = Number(w.unread ?? 0);
    if (w.state === "working" && !stoppedAtPrompt(store, wt, o.agent, out, tail, tailAt)) return no("busy: working");
  }
  const noise = o.screenNoise === "ignore" && (o.agent || "claude") === "claude";
  if (!noise && now - out < o.quietS) return no("busy: terminal output");
  const tr = store.db.query("SELECT MAX(mtime) AS m FROM observed_transcripts WHERE project = ? AND wt = ? AND COALESCE(entrypoint, '') != 'sdk-cli'").get(project, wt) as { m: number | null };
  if (tr.m != null && now - tr.m < o.quietS) return no("busy: transcript");
  if (tailAt == null || tailAt < out) return no("screen not read since its last output");
  if (noise && workingOnScreen(tail)) return no("busy: working on screen");
  const draft = promptDraft(tail);
  if (draft === null) return no("no prompt on screen");
  if (draft) return no("text at the prompt");
  if (unread > 0) return no("unread mail");
  const asker = [wt, ...(o.handle ? [o.handle] : [])];
  const picker = store.db.query(`SELECT 1 FROM questions q WHERE q.project = ? AND q.status = 'open' AND json_extract(q.doc, '$.tool_use_id') IS NOT NULL
      AND (q.asker IN (${asker.map(() => "?").join(", ")}) OR q.card_wt = ?)
      AND NOT EXISTS (SELECT 1 FROM observed_pickers p WHERE p.project = q.project AND p.id = q.id AND json_extract(p.doc, '$.closed') = 1) LIMIT 1`)
    .get(project, ...asker, wt);
  if (picker) return no("a picker is open");
  if (menuOn(o.agent, tail)) return no("a menu is open");
  const kinds = TYPED_KINDS.map(() => "?").join(", ");
  if (store.db.query(`SELECT 1 FROM requests WHERE project = ? AND member = ? AND done_at IS NULL AND kind IN (${kinds}) AND (? IS NULL OR id < ?) LIMIT 1`)
    .get(project, wt, ...TYPED_KINDS, o.before ?? null, o.before ?? null)) return no("an earlier message waits");
  if (store.db.query("SELECT 1 FROM deliveries WHERE project = ? AND member = ? AND state = 'accepted' LIMIT 1").get(project, wt)) return no("an earlier message is not taken yet");
  return { ready: true, why: "idle" };
}
