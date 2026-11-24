// chat/turns.ts — the turn shape every chat reader produces and the window observed_chat keeps
// (crew-terminal-access U1, U5): the newest 20 messages (user, assistant and screen text turns) within
// 32 KB, each run of tool calls between two messages folded into one turn, a tool call one line and its
// output never kept, and an operator's board line marked `from: "operator"` with its prefix stripped.
import { redact } from "./redact.ts";
import { CHAT_FILE_NAME, IMAGES_MARK } from "./files.ts";

export type Turn = {
  role: "user" | "assistant" | "screen"; text: string; at: number | null;
  tool?: string;                       // a tool call's name; a folded run's "<n> tools"
  tools?: string[];                    // a folded run: its newest one-line calls, at most MAX_RUN_LIST
  counts?: Record<string, number>;     // a folded run: calls per tool name, every call counted
  from?: "operator" | "interrupted";   // a user turn the operator typed (board or terminal), or an interrupt
  via?: "terminal";                    // with from "operator": typed in the member's terminal, not on the board
  images?: (string | null)[];          // a board line's attached images: a stored file name, or null (a native attachment)
};

export const MAX_TURNS = 20;           // messages, not tool calls
export const MAX_BYTES = 32 * 1024;
export const PIN_CUT = 1500;        // a reply after the pinned operator line is cut to this when the window is still too big
export const CUT_NOTE = "… (cut — full text in the terminal)";
export const MAX_TEXT = 4000;      // one turn's text, in characters
export const MAX_TARGET = 80;      // a tool call's target
export const MAX_RUN_LIST = 10;    // the calls a folded run lists

// The line the loop types for a board chat (fulfil/chat.ts), and the prefix that marks it in a transcript.
export const CHAT_PREFIX = "dev-studio board, the operator says: ";
export const chatLine = (text: string) => `${CHAT_PREFIX}${text}`;

// Who a user turn is from (U7): one decision, made here by the loop, never by the board.
// `machine` lines are what the loop or the harness typed, not the operator. A new line the loop types must
// start with `dev-studio`, so this list holds; the rest are the harness's own wrappers and Orca's brief.
export type UserSource = "operator-board" | "operator-terminal" | "interrupted" | "machine";
export const MACHINE_LINE = /^\s*(?:dev-studio\b|<(?:task-notification|system-reminder|command-(?:name|message|args)|local-command-\w+|user-prompt-submit-hook|bash-(?:input|stdout|stderr))\b|Stop hook feedback|You are working inside Orca\b|Base directory for this skill)/i;
export const INTERRUPTED = /^\s*\[Request interrupted by user/;
export const PASTE_CUT = 600;          // a pasted block shows this many characters of its inner text
const PASTED = /^\s*<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content[^>]*>\s*$/;

export function userSource(text: string): UserSource {
  const t = text.trim();
  if (t.startsWith(CHAT_PREFIX)) return "operator-board";
  if (INTERRUPTED.test(t)) return "interrupted";
  if (MACHINE_LINE.test(t) || harnessText(t)) return "machine";
  return "operator-terminal";
}

// A stored user turn with no mark (written before U7) is classified once from its stored text; a turn
// already marked, an assistant or screen turn, and a machine line are returned as they were.
export function remark(turns: Turn[]): Turn[] {
  return turns.map((t) => {
    if (t.role !== "user" || t.from || t.tool) return t;
    const src = userSource(t.text);
    if (src === "operator-terminal") return { ...t, from: "operator", via: "terminal" };
    if (src === "interrupted") return { ...t, from: "interrupted" };
    return t;
  });
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export const epoch = (t: unknown): number | null => {
  const ms = typeof t === "string" ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

// A text turn: redacted, then cut; empty text gives none. A user turn is marked by userSource: a board line
// (CHAT_PREFIX, stored without it) `from: "operator"`, a typed one also `via: "terminal"`.
export function textTurn(role: Turn["role"], text: string, at: number | null): Turn | null {
  let t = text.trim();
  // A multi-line board chat (U19) is pasted whole, so the harness may store it wrapped as a paste.
  const board = role === "user" ? PASTED.exec(t) : null;
  if (board && board[1].trim().startsWith(CHAT_PREFIX)) t = board[1].trim();
  const src = role === "user" ? userSource(t) : null;
  let images: (string | null)[] | undefined;
  if (src === "operator-board") {
    t = t.slice(CHAT_PREFIX.length).trim();
    // The suffix the loop typed for attached images (fulfil/chat.ts) is cut off before redaction and the
    // text cut: each path becomes its file name, `[Image #N]` (the TUI made an attachment of it) or anything
    // else becomes null.
    const at = t.lastIndexOf(IMAGES_MARK);
    if (at >= 0 && t.endsWith("]")) {
      images = t.slice(at + IMAGES_MARK.length, -1).split(", ").map((p) => { const b = p.trim().split("/").pop() ?? ""; return CHAT_FILE_NAME.test(b) ? b : null; });
      t = t.slice(0, at).trim();
    }
  }
  let max = MAX_TEXT;
  if (src === "operator-terminal") {
    const p = PASTED.exec(t);
    if (p) { t = p[1].trim(); max = PASTE_CUT; }
  }
  if (!t && !images) return null;
  const turn: Turn = { role, text: cut(redact(t), max), at };
  if (src === "operator-board") { turn.from = "operator"; if (images) turn.images = images; }
  else if (src === "operator-terminal") { turn.from = "operator"; turn.via = "terminal"; }
  else if (src === "interrupted") turn.from = "interrupted";
  return turn;
}

// The keys a tool call's target is taken from, in order; else its first string value.
const TARGET_KEYS = ["file_path", "path", "notebook_path", "command", "cmd", "pattern", "url", "query", "skill", "description", "prompt"];

export function targetOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.filter((x) => typeof x === "string").join(" ");
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of TARGET_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v) && v.length) return targetOf(v);
  }
  for (const v of Object.values(o)) if (typeof v === "string" && v.trim()) return v;
  return "";
}

// One line per tool call: `<name> <target>`, the target one line, redacted, at most 80 characters.
export function toolTurn(name: string, input: unknown, at: number | null): Turn {
  const target = cut(redact(oneLine(targetOf(input))), MAX_TARGET);
  return { role: "assistant", tool: name, text: target ? `${name} ${target}` : name, at };
}

const bytes = (ts: Turn[]) => Buffer.byteLength(JSON.stringify(ts));
const plural = (n: number) => `${n} tool${n === 1 ? "" : "s"}`;

// Each run of tool calls (one-line calls a reader made, or a run folded on an earlier tick) becomes one
// turn: every call counted per tool name, the newest MAX_RUN_LIST listed, the time of its last call.
export function foldRuns(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    if (!t.tool) { out.push(t); continue; }
    const prev = out.at(-1), run = prev?.counts ? prev : null;
    const counts = { ...(run?.counts ?? {}) };
    let tools = [...(run?.tools ?? [])];
    if (t.counts) {
      for (const [k, n] of Object.entries(t.counts)) counts[k] = (counts[k] ?? 0) + n;
      tools.push(...(t.tools ?? []));
    } else {
      counts[t.tool] = (counts[t.tool] ?? 0) + 1;
      tools.push(t.text);
    }
    tools = tools.slice(-MAX_RUN_LIST);
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    const folded: Turn = { role: "assistant", tool: plural(n), text: `${plural(n)} · last: ${tools.at(-1) ?? ""}`, tools, counts, at: t.at ?? run?.at ?? null };
    if (run) out[out.length - 1] = folded; else out.push(folded);
  }
  return out;
}

// The window: tool runs folded, then from the MAX_TURNS-th newest message on (a run before it goes
// with it) within MAX_BYTES, oldest dropped first; a lone turn still too big (multi-byte text) is cut
// until it fits.
export function capTurns(turns: Turn[]): Turn[] {
  const all = foldRuns(turns);
  let start = 0;
  for (let i = all.length - 1, seen = 0; i >= 0; i--) if (!all[i].tool && ++seen === MAX_TURNS) { start = i; break; }
  const out = all.slice(start);
  // The newest operator line stays (U8): older turns go first, then the replies after it are cut.
  let pin = -1;
  for (let i = out.length - 1; i >= 0; i--) if (out[i].from === "operator") { pin = i; break; }
  while (out.length > 1 && bytes(out) > MAX_BYTES && pin !== 0) { out.shift(); if (pin > 0) pin--; }
  if (pin === 0 && bytes(out) > MAX_BYTES) {
    const order = out.map((t, i) => i).filter((i) => i > 0 && out[i].role !== "user" && !out[i].tool && out[i].text.length > PIN_CUT)
      .sort((a, b) => out[b].text.length - out[a].text.length);
    for (const i of order) {
      if (bytes(out) <= MAX_BYTES) break;
      out[i] = { ...out[i], text: out[i].text.slice(0, PIN_CUT - CUT_NOTE.length) + CUT_NOTE };
    }
    while (out.length > 1 && bytes(out) > MAX_BYTES) out.pop();   // still over: the newest replies go last
  }
  if (out.length === 1) {
    let t = out[0];
    for (let n = t.text.length; n > 1 && bytes([t]) > MAX_BYTES; n = Math.floor(n * 0.8)) t = { ...t, text: cut(t.text, n) };
    out[0] = t;
  }
  return out;
}

// Whole JSON lines of a chunk; a line that fails to parse (a cut first line) is skipped.
export function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const j = JSON.parse(l);
      if (j && typeof j === "object") yield j as Record<string, unknown>;
    } catch { /* a cut line */ }
  }
}

// User text that is a wrapper the harness added, not something a person typed: command output,
// environment and instruction blocks, reminders.
export function harnessText(text: string): boolean {
  return /^\s*(?:# AGENTS\.md instructions|<(?:local-command-stdout|local-command-stderr|local-command-caveat|environment_context|user_instructions|system-reminder|permissions instructions|turn_aborted|INSTRUCTIONS)\b)/.test(text);
}
