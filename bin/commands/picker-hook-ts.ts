// picker-hook-ts.ts — bin/hooks/picker-hook.sh, ported (U190): mirror a terminal AskUserQuestion
// picker onto the board and clear it when answered. bin/hooks/picker-hook.sh runs it (U193: the only body).
// Same stdin, exit codes (always 0), picker-hook.log lines, tombstones and
// squad-state.sh / ask-operator.sh calls as the shell body; `pre` starts the .sh again detached.
import { accessSync, appendFileSync, constants, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, run as runCmd, writeErr } from "../lib/shared";
import { mktemp } from "../lib/lib";

export const help = "picker-hook-ts <pre|post|pre-async> <state> <role> <wt> [input] — the picker-mirror hook (bin/hooks/picker-hook.sh)";

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

export async function run(argv: string[]): Promise<number> {
  const [MODE = "", STATE = "", ROLE = "", WT = ""] = argv;
  const usage = () => { writeErr("picker-hook: usage: picker-hook.sh <pre|post> <state> <role> <wt>\n"); return 0; };
  if (!["pre", "post", "pre-async"].includes(MODE)) return usage();
  if (MODE !== "pre-async" && (!STATE || !ROLE || !WT)) return usage();

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

  if (MODE === "post") {
    let input = "";
    try { input = await Bun.stdin.text(); } catch { /* none */ }
    let j: any = null, ok = true;
    try { j = JSON.parse(input); } catch { ok = false; }
    let tid = "";
    try { if (ok) { const v = dot(j, "tool_use_id"); tid = alt(v, null) === null ? "" : raw(v); } } catch { tid = ""; }
    if (!tid) return 0;
    const id = `picker-${last8(tid)}`;
    let answer = "";
    try { if (ok) answer = join_(each(alt(dot(dot(j, "tool_response"), "answers"), {}), true).map((v) => (typeof v === "string" ? v : JSON.stringify(v))), "; "); }
    catch { answer = ""; }
    try { writeFileSync(join(TDONE, id), answer); } catch { /* the picker is done even if its entry never lands */ }
    if (await resolvePicker(id, answer)) log(`post: resolved ${id}`);
    return 0;
  }

  if (MODE === "pre") {
    const tmp = mktemp(join(tmpdir(), "ds-picker-pre."));
    if (!tmp) return 0;
    try { writeFileSync(tmp, await Bun.stdin.text()); } catch { rmSync(tmp, { force: true }); return 0; }
    // Detached: the queueing (backend calls) must never delay the picker's display.
    let fd: number;
    try { fd = openSync(LOG, "a"); } catch { return 0; }
    const p = Bun.spawn([SELF, "pre-async", STATE, ROLE, WT, tmp], { stdin: "ignore", stdout: fd, stderr: fd });
    p.unref();
    closeSync(fd);
    return 0;
  }

  // pre-async <input-file>: the detached half of `pre`; stdout/stderr go to the log.
  const input = argv[4] ?? "";
  try { return await preAsync(input); } finally { if (input) rmSync(input, { force: true }); }

  async function preAsync(file: string): Promise<number> {
    const h = readJsonFile(file);
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
    // The answer beat the enqueue (post ran first): don't queue a corpse. Prune tombstones past 2h first.
    try {
      for (const f of readdirSync(TDONE)) {
        if (!f.startsWith("picker-")) continue;
        const p = join(TDONE, f);
        try { if (Date.now() - statSync(p).mtimeMs > 120 * 60_000) rmSync(p, { recursive: true, force: true }); } catch { /* gone */ }
      }
    } catch { /* as the shell */ }
    const t = tomb(id);
    if (t !== null) {
      await resolvePicker(id, t);
      rmSync(join(TDONE, id), { force: true });
      log(`pre: ${id} skipped — the picker was already answered (tombstone)`);
      return 0;
    }
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
    // A role has at most one live picker: clear any earlier picker entry of this worktree first.
    const olds: string[] = [];
    try {
      for (const e of each(alt(dot(st.v, "waiting_on_you"), []))) {
        const eid = alt(dot(e, "id"), "");
        if (typeof eid !== "string") break; // startswith on a non-string: jq stops here
        if (!eid.startsWith("picker-")) continue;
        if (alt(dot(e, "card_wt"), "") === WT || dot(e, "asker") === ROLE) olds.push(raw(dot(e, "id")));
      }
    } catch { /* jq stops; earlier lines stand */ }
    for (const old of olds) {
      if (!old) continue;
      await ss(["resolve-question", old]);
      log(`pre: resolved earlier picker entry ${old}`);
    }
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
    let rc: number;
    let fd: number | null = null;
    try { fd = openSync(LOG, "a"); } catch { fd = null; }
    if (fd === null) rc = 1;
    else {
      const p = Bun.spawn([ASK, STATE, id, ROLE, "true", "--title", title, "--question", question, ...opts,
        "--recommend", "1", "--why", why, "--picker", tid, tpath, answerable], { stdin: "ignore", stdout: fd, stderr: fd });
      rc = await p.exited;
      closeSync(fd);
    }
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
