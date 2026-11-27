// picker-hook-ts.ts — bin/hooks/picker-hook.sh, ported (U190): mirror a terminal AskUserQuestion
// picker onto the board and clear it when answered. bin/hooks/picker-hook.sh runs it (U193: the only body).
// `permission` (the PermissionRequest hook) mirrors a Claude safety-check prompt the same way. It never
// returns a decision: it prints nothing, exits 0, and queues from a detached `permission-async`.
// Same stdin, exit codes (always 0), picker-hook.log lines, tombstones and
// squad-state.sh / ask-operator.sh calls as the shell body; `pre` starts the .sh again detached.
// side-loop-host u8b, a member on a side host: `pre` and `permission` stay there (the detached start is local), and
// `post`, `pre-async` and `permission-async` are split (link/split.ts): the side reads the hook input and the
// transcript (postFacts, preFacts, permissionFacts) and main runs the rest with those facts, in its own state file,
// with the member row's worktree id as WT (forward-table.ts checkCall).
import { randomBytes } from "node:crypto";
import { accessSync, appendFileSync, constants, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ROOT, run as runCmd, writeErr } from "../lib/shared";
import { mktemp } from "../lib/lib";
import { findToolUse, head, promptQuestion, promptTitle, promptTranscript, shownText } from "../lib/permission-prompt.ts";
import { checkable } from "../loop/chat/permission.ts";
import { open as openStore } from "../loop/core/store.ts";
import { factsOf } from "../link/split.ts";

export const help = "picker-hook-ts <pre|post|permission|pre-async|permission-async> <state> <role> <wt> [input] — the picker-mirror hook (bin/hooks/picker-hook.sh)";

const SS = join(ROOT, "bin", "role", "squad-state.sh");
const ASK = join(ROOT, "bin", "role", "ask-operator.sh");
const SELF = join(ROOT, "bin", "hooks", "picker-hook.sh");
const tmpdir = () => process.env.TMPDIR || "/tmp";

/** The label dir (two up from the state file) when it is a writable directory. */
function labelDir(state: string): string | null {
  const d = dirname(dirname(state));
  try { if (!statSync(d).isDirectory()) return null; accessSync(d, constants.W_OK); return d; } catch { return null; }
}

// --- jq, as far as these filters use it ----------------------------------------------------------

class JqError extends Error {}
/** `.k` on a value: null for null, an error for anything but an object. */
function dot(v: any, k: string): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new JqError(k);
  return v[k] ?? null;
}
/** `x // d`: d when x is null or false. */
const alt = (x: any, d: any) => (x === null || x === undefined || x === false ? d : x);
/** `.[]` / `.[]?` over a value. */
function each(v: any, quiet = false): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.values(v);
  if (quiet) return [];
  throw new JqError("cannot iterate");
}
/** `jq -r` of one value. */
const raw = (v: any): string => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
/** jq 1.7's join over strings, numbers, booleans and null. */
function join_(xs: any[], sep: string): string {
  return xs.map((x) => {
    if (x === null) return "";
    if (typeof x === "object") throw new JqError("join");
    return String(x);
  }).join(sep);
}
/** jq `length`. */
function length(v: any): number {
  if (v === null || v === undefined) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return Array.from(v).length;
  if (typeof v === "object") return Object.keys(v).length;
  if (typeof v === "number") return Math.abs(v);
  throw new JqError("length");
}
/** jq `contains` for the string case (anything else is an error here). */
function contains(a: any, b: any): boolean {
  if (typeof a === "string" && typeof b === "string") return a.includes(b);
  throw new JqError("contains");
}
const readJsonFile = (f: string): { ok: boolean; v: any } => {
  try { return { ok: true, v: JSON.parse(readFileSync(f, "utf8")) }; } catch { return { ok: false, v: null }; }
};
/** `any((.waiting_on_you // [])[]; cond)` on the state file, false where jq would fail. */
function anyEntry(state: string, cond: (e: any) => boolean): boolean {
  const s = readJsonFile(state);
  if (!s.ok) return false;
  try {
    for (const e of each(alt(dot(s.v, "waiting_on_you"), []))) if (cond(e)) return true;
  } catch { /* jq error: exit 5 */ }
  return false;
}

/** One line per `read -r` with IFS=$'\037' into two fields (label, rest), as bash splits it. */
export function readUnitSep(text: string): [string, string][] {
  const out: [string, string][] = [];
  const ls = text.split("\n");
  if (ls[ls.length - 1] === "") ls.pop();
  for (const l of ls) {
    const i = l.indexOf("\x1f");
    if (i < 0) { out.push([l, ""]); continue; }
    let rest = l.slice(i + 1);
    if (rest.endsWith("\x1f") && !rest.slice(0, -1).includes("\x1f")) rest = rest.slice(0, -1);
    out.push([l.slice(0, i), rest]);
  }
  return out;
}

// --- the facts a side host reads for main (side-loop-host u8b) ----------------------------------------

export type PostFacts = { mode: "post"; tid: string; answer: string };
export type PreFacts = { mode: "pre-async"; ok: boolean; hook: unknown };
export type PermissionFacts = { mode: "permission-async"; tool: string; agent_id: string; agent_type: string; cwd: string; tpath: string;
  found: string; shown: string; answerable: boolean };
export type PickerFacts = PostFacts | PreFacts | PermissionFacts;

/** The PostToolUse input's tool_use_id and its answers, joined with "; " (both empty where jq would fail). */
export function postFacts(input: string): PostFacts {
  let j: any = null, ok = true;
  try { j = JSON.parse(input); } catch { ok = false; }
  let tid = "", answer = "";
  try { if (ok) { const v = dot(j, "tool_use_id"); tid = alt(v, null) === null ? "" : raw(v); } } catch { tid = ""; }
  try { if (ok) answer = join_(each(alt(dot(dot(j, "tool_response"), "answers"), {}), true).map((v) => (typeof v === "string" ? v : JSON.stringify(v))), "; "); }
  catch { answer = ""; }
  return { mode: "post", tid, answer };
}

/** The PreToolUse input as preAsync reads it, cut to the fields it uses. */
export function preFacts(file: string): PreFacts {
  const h = readJsonFile(file), v = h.v;
  if (!h.ok || !v || typeof v !== "object" || Array.isArray(v)) return { mode: "pre-async", ok: h.ok, hook: v };
  const ti = v.tool_input;
  return { mode: "pre-async", ok: true, hook: { tool_use_id: v.tool_use_id, transcript_path: v.transcript_path, tool_name: v.tool_name,
    tool_input: ti && typeof ti === "object" && !Array.isArray(ti) ? { questions: ti.questions } : ti } };
}

/** The PermissionRequest input and what the transcript says about it: the tool call's id (`found`, waiting up to 2 s
 *  for it to land), the prompt's shown text and whether the board may answer it. */
export async function permissionFacts(file: string): Promise<PermissionFacts> {
  const h = readJsonFile(file).v;
  const text = (k: string): string => (typeof h?.[k] === "string" ? h[k] : "");
  const tool = text("tool_name"), agent_id = text("agent_id");
  const base = { mode: "permission-async" as const, tool, agent_id, agent_type: agent_id ? text("agent_type") || "helper agent" : "", cwd: text("cwd") };
  if (ignoredTool(tool)) return { ...base, tpath: "", found: "", shown: "", answerable: false };
  const tpath = promptTranscript(text("transcript_path"), agent_id);
  let found = tpath ? findToolUse(tpath, tool, h.tool_input) : "";
  // The tool call may reach the transcript just after the prompt opens.
  for (let i = 0; !found && tpath && i < 4; i++) { await Bun.sleep(500); found = findToolUse(tpath, tool, h.tool_input); }
  const shown = shownText(tool, h.tool_input);
  // Answerable from the board only when shown in full and tied to its tool call (D5); the answer fulfiller
  // also reads the screen again before it presses anything (bin/loop/chat/permission.ts).
  return { ...base, tpath, found, shown, answerable: found !== "" && checkable(tool, h.tool_input, shown) };
}

// These two are the picker pair's and the plan dialog's, not a safety check.
const ignoredTool = (tool: string) => !tool || tool === "AskUserQuestion" || tool === "ExitPlanMode";

export async function run(argv: string[]): Promise<number> {
  const [MODE = "", STATE = "", ROLE = "", WT = ""] = argv;
  const usage = () => { writeErr("picker-hook: usage: picker-hook.sh <pre|post|permission> <state> <role> <wt>\n"); return 0; };
  if (!["pre", "post", "permission", "pre-async", "permission-async"].includes(MODE)) return usage();
  if (!MODE.endsWith("-async") && (!STATE || !ROLE || !WT)) return usage();

  const ld = labelDir(STATE || "/none");
  const LOG = ld ? join(ld, "picker-hook.log") : join(tmpdir(), "ds-picker-hook.log");
  const log = (msg: string) => {
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    try { appendFileSync(LOG, `${at} picker-hook ${ROLE}: ${msg}\n`); } catch { /* as the shell */ }
  };
  const TDONE = ld ? join(ld, "picker-done") : join(tmpdir(), "ds-picker-done");
  try { mkdirSync(TDONE, { recursive: true }); } catch { /* as the shell */ }
  const last8 = (s: string) => Buffer.from(s, "utf8").subarray(-8).toString("utf8");
  const tomb = (id: string): string | null => { try { return readFileSync(join(TDONE, id), "utf8"); } catch { return null; } };

  const ss = (args: string[]) => runCmd([SS, STATE, ...args]);
  // Resolve a picker entry, but only one this hook created (source:"picker").
  const resolvePicker = async (id: string, answer: string): Promise<boolean> => {
    if (!anyEntry(STATE, (e) => dot(e, "id") === id && alt(dot(e, "source"), "") === "picker")) return false;
    await ss(["resolve-question", id, "--answer", answer, "--via", "picker"]);
    return true;
  };

  // On main, a side member's split call: what the side read stands in for the input file, stdin and transcript.
  const facts = factsOf<PickerFacts>();
  if (process.env.DS_LINK_FORWARDED === "1" && facts?.mode !== MODE) { log(`${MODE}: ignored — a forwarded call without its facts`); return 0; }

  if (MODE === "post") {
    let pf = facts as PostFacts | null;
    if (!pf) {
      let input = "";
      try { input = await Bun.stdin.text(); } catch { /* none */ }
      pf = postFacts(input);
    }
    const { tid, answer } = pf;
    if (!tid) return 0;
    const id = `picker-${last8(tid)}`;
    try { writeFileSync(join(TDONE, id), answer); } catch { /* the picker is done even if its entry never lands */ }
    if (await resolvePicker(id, answer)) log(`post: resolved ${id}`);
    return 0;
  }

  if (MODE === "pre" || MODE === "permission") {
    const tmp = mktemp(join(tmpdir(), "ds-picker-pre."));
    if (!tmp) return 0;
    try { writeFileSync(tmp, await Bun.stdin.text()); } catch { rmSync(tmp, { force: true }); return 0; }
    // Detached: the queueing (backend calls) must never delay the picker's display.
    let fd: number;
    try { fd = openSync(LOG, "a"); } catch { return 0; }
    const p = Bun.spawn([SELF, `${MODE}-async`, STATE, ROLE, WT, tmp], { stdin: "ignore", stdout: fd, stderr: fd });
    p.unref();
    closeSync(fd);
    return 0;
  }

  // <mode>-async <input-file>: the detached half; stdout/stderr go to the log.
  const input = argv[4] ?? "";
  try {
    if (MODE === "pre-async") return await preAsync((facts as PreFacts | null) ?? preFacts(input));
    return await permissionAsync((facts as PermissionFacts | null) ?? await permissionFacts(input));
  } finally { if (input && !facts) rmSync(input, { force: true }); }

  // True when the prompt was answered before this run could queue it. Prunes tombstones past 2h first.
  async function answeredAlready(id: string, mode: string): Promise<boolean> {
    try {
      for (const f of readdirSync(TDONE)) {
        if (!f.startsWith("picker-")) continue;
        const p = join(TDONE, f);
        try { if (Date.now() - statSync(p).mtimeMs > 120 * 60_000) rmSync(p, { recursive: true, force: true }); } catch { /* gone */ }
      }
    } catch { /* as the shell */ }
    const t = tomb(id);
    if (t === null) return false;
    await resolvePicker(id, t);
    rmSync(join(TDONE, id), { force: true });
    log(`${mode}: ${id} skipped — the picker was already answered (tombstone)`);
    return true;
  }

  // A role has at most one live picker: clear any earlier picker entry of this worktree first.
  async function clearEarlier(doc: any, mode: string): Promise<void> {
    const olds: string[] = [];
    try {
      for (const e of each(alt(dot(doc, "waiting_on_you"), []))) {
        const eid = alt(dot(e, "id"), "");
        if (typeof eid !== "string") break; // startswith on a non-string: jq stops here
        if (!eid.startsWith("picker-")) continue;
        if (alt(dot(e, "card_wt"), "") === WT || dot(e, "asker") === ROLE) olds.push(raw(dot(e, "id")));
      }
    } catch { /* jq stops; earlier lines stand */ }
    for (const old of olds) {
      if (!old) continue;
      await ss(["resolve-question", old]);
      log(`${mode}: resolved earlier picker entry ${old}`);
    }
  }

  // ask-operator.sh, blocking, with its output in the log: its exit code (1 when the log can't open).
  async function askOperator(id: string, args: string[]): Promise<number> {
    let fd: number;
    try { fd = openSync(LOG, "a"); } catch { return 1; }
    const p = Bun.spawn([ASK, STATE, id, ROLE, "true", ...args], { stdin: "ignore", stdout: fd, stderr: fd });
    const rc = await p.exited;
    closeSync(fd);
    return rc;
  }

  async function permissionAsync(pf: PermissionFacts): Promise<number> {
    const { tool, agent_id: agentId, agent_type: agent, cwd, tpath, found, shown, answerable } = pf;
    if (ignoredTool(tool)) { log(`permission: ignoring ${tool || "input without a tool_name"}`); return 0; }
    const st = readJsonFile(STATE);
    if (!st.ok || !st.v) { log(`permission: ignored — state ${STATE} unreadable`); return 0; }
    const tid = found || `permission-${randomBytes(4).toString("hex")}`;
    const id = `picker-${last8(tid)}`;
    if (await answeredAlready(id, "permission")) return 0;
    await clearEarlier(st.v, "permission");
    const rc = await askOperator(id, ["--title", promptTitle(ROLE, tool, agent), "--question", promptQuestion(shown, cwd),
      "--option", "Yes", "let it run this once", "--option", "No", "refuse it; the role is told no",
      "--recommend", "No", "--why", "a Claude safety check stopped here — no recommendation; read it before you answer",
      "--picker", tid, tpath || "(none)", String(answerable), "--permission", tool, agent, shown, cwd]);
    log(rc === 0 || rc === 3 ? `permission: queued ${id} (${tool}, tool_use_id ${found ? "found" : "not found"})` : `permission: ${id} NOT queued — ask-operator.sh exited ${rc}`);
    permissionAsked({ role: ROLE, tool, via: "hook", agent: agentId !== "", text: head(shown, 200) });
    return 0;
  }

  // One event per prompt, in the loop.db beside the state file (none there: nothing to count in).
  function permissionAsked(payload: { role: string; tool: string; via: string; agent: boolean; text: string }): void {
    const labelRoot = dirname(dirname(STATE)), root = dirname(labelRoot);
    if (!existsSync(join(root, "loop.db"))) return;
    try {
      const s = openStore(root);
      try { s.fact("permission_asked", [], { project: basename(labelRoot), squad: basename(STATE, ".json"), payload }); } finally { s.close(); }
    } catch (e) { log(`permission: event not written — ${(e as Error).message.split("\n")[0]}`); }
  }

  async function preAsync(pf: PreFacts): Promise<number> {
    const h = { ok: pf.ok, v: pf.hook as any };
    const q = (f: () => any, d: any) => { if (!h.ok) return d; try { return f(); } catch { return d; } };
    const tid = q(() => { const v = dot(h.v, "tool_use_id"); return alt(v, null) === null ? "" : raw(v); }, "");
    const tpath = q(() => { const v = dot(h.v, "transcript_path"); return alt(v, null) === null ? "" : raw(v); }, "");
    const n = q(() => length(alt(dot(dot(h.v, "tool_input"), "questions"), [])), 0);
    const tool = q(() => { const v = dot(h.v, "tool_name"); return alt(v, null) === null ? "" : raw(v); }, "");
    if (tool !== "AskUserQuestion" || !tid || !tpath || (Number.isInteger(n) && n < 1)) {
      log("pre: ignoring (not an AskUserQuestion with tool_use_id + transcript_path + questions)");
      return 0;
    }
    const id = `picker-${last8(tid)}`;
    const st = readJsonFile(STATE);
    if (!st.ok || st.v === null || st.v === false) { log(`pre: ${id} ignored — state ${STATE} unreadable`); return 0; }
    // The answer beat the enqueue (post ran first): don't queue a corpse.
    if (await answeredAlready(id, "pre")) return 0;
    // Rule 1: the role asked through ask-operator.sh first (blocking, same card).
    if (anyEntry(STATE, (e) => alt(dot(e, "source"), "") !== "picker" && dot(e, "blocking") === true && alt(dot(e, "card_wt"), "") === WT)) {
      log(`pre: ${id} skipped — a blocking entry is already queued for ${WT} (rule 1)`);
      return 0;
    }
    // Rule 2: a picker question's text contains a queued entry's title (or id).
    let qs: any[] | null = null;
    try { qs = each(alt(dot(dot(h.v, "tool_input"), "questions"), [])).map((x) => alt(dot(x, "question"), "")); } catch { qs = null; }
    if (h.ok && qs !== null && anyEntry(STATE, (e) => {
      if (alt(dot(e, "source"), "") === "picker") return false;
      const k = alt(alt(dot(e, "title"), dot(e, "id")), "");
      return k !== "" && qs!.some((x) => contains(x, k));
    })) {
      log(`pre: ${id} skipped — a picker question restates a queued entry's title (rule 2)`);
      return 0;
    }
    await clearEarlier(st.v, "pre");
    const questions = () => dot(dot(h.v, "tool_input"), "questions");
    const first = () => { const v = questions(); if (v !== null && !Array.isArray(v)) throw new JqError("index"); return v === null ? null : v[0] ?? null; };
    const answerable = q(() => length(questions()) === 1 && alt(dot(first(), "multiSelect"), false) === false, false) === true ? "true" : "false";
    let title = q(() => {
      const q0 = first(), hd = alt(dot(q0, "header"), ""), qq = alt(dot(q0, "question"), "");
      const t = hd === "" ? qq : typeof hd === "string" && typeof qq === "string" ? `${hd}: ${qq}` : (() => { throw new JqError("+"); })();
      if (typeof t !== "string") throw new JqError("slice");
      return Array.from(t).slice(0, 80).join("");
    }, "");
    if (!title) title = `Terminal picker from ${ROLE}`;
    let question = q(() => join_(each(questions(), true).map((x) => alt(dot(x, "question"), "")), "\n\n"), "");
    if (!question) question = "(the picker had no question text)";
    const why = `raised from ${ROLE}'s terminal picker — no recommendation; option 1 is just the first`;
    let optText = "";
    if (h.ok) {
      try {
        for (const o of each(alt(dot(first(), "options"), []))) optText += join_([alt(dot(o, "label"), ""), alt(dot(o, "description"), "")], "\x1f") + "\n";
      } catch { /* jq stops; earlier lines stand */ }
    }
    const opts: string[] = [];
    let nopts = 0;
    for (const [lab, dsc] of readUnitSep(optText)) {
      if (!lab) continue;
      opts.push("--option", lab, dsc || lab); // ask-operator.sh requires a what-happens per option
      nopts++;
    }
    if (nopts === 0) { log(`pre: ${id} ignored — the first question has no options`); return 0; }
    if (nopts === 1) opts.push("--option", "Other", "answer in your own words"); // ask-operator.sh needs 2+
    const rc = await askOperator(id, ["--title", title, "--question", question, ...opts,
      "--recommend", "1", "--why", why, "--picker", tid, tpath, answerable]);
    if (rc === 0) {
      const t2 = tomb(id);
      if (t2 !== null) { // the answer landed mid-enqueue: take it back down at once
        await resolvePicker(id, t2);
        rmSync(join(TDONE, id), { force: true });
        log(`pre: queued ${id} but the picker had just closed — resolved again (tombstone)`);
      } else log(`pre: queued ${id} (answerable=${answerable} transcript=${tpath})`);
    } else log(`pre: ${id} NOT queued — ask-operator.sh exited ${rc}`);
    return 0;
  }
}
