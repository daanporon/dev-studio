// ds watch-ts — one coordination tick (U260): what bin/lib/watch.sh runs. Same arguments, backend
// calls (the inbox read with its --ack), output blocks, instruction fingerprint, watch-seen snapshot,
// beat file and exit codes as the shell body.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { contractStates, squadContract } from "../lib/contract-roles.ts";
import { ROOT, backendPath, chomp, dsLabel, dsLoopOn, readJson, run as runCmd, stateRoot, writeErr, writeOut } from "../lib/shared";
import { repoSlug } from "../lib/lib";
import { cksum } from "./rewake-hook-ts";
import { settle } from "../loop/squad/squad-finish.ts";
import { open, openReadOnly } from "../loop/core/store.ts";
import { toplevel } from "../loop/squad/exposed.ts";
import { ack, inbox, line, senderAt, waitingFor, waitingLines, type Addr, type Message } from "../loop/messages/messages.ts";
import { parseMember, whoAmI } from "../loop/core/whoami.ts";
import { instructionFilesFor } from "../lib/update-classes";

/** U276: whose message rows this tick reads on a loop root — `me`, else this worktree's member; null when
 *  loop.db can't tell (no db, no member: the Orca read stays). */
export function rowsReader(root: string, me: Addr | null): Addr | null {
  if (me) return me;
  let s: ReturnType<typeof openReadOnly> | null = null;
  try {
    s = openReadOnly(root);
    const f = senderAt(s, toplevel());
    return f.project && f.squad && f.member ? { project: f.project, squad: f.squad, role: f.role, suffix: f.suffix } : null;
  } catch { return null; }
  finally { s?.close(); }
}

/** The `--ack` form of a batch of rows (`msg:<id>,<id>`) and back. */
export const rowsAckId = (ms: Message[]): string => (ms.length ? `msg:${ms.map((m) => m.id).join(",")}` : "");
const ackIds = (v: string): number[] | null => (/^msg:\d+(,\d+)*$/.test(v) ? v.slice(4).split(",").map(Number) : null);

/** One rows tick (U276): ack the `--ack` batch, then the unread rows — waiting up to `ms` for one unless `poll` —
 *  or with `all` the newest 20 read or not. */
export async function rowsTick(root: string, who: Addr, o: { ack: string; ms: number; poll: boolean; all: boolean }): Promise<Message[]> {
  const ids = o.ack ? ackIds(o.ack) : null;
  if (o.ack && !ids) writeErr(`watch: --ack ${o.ack} is no loop message batch (msg:<id>,…); Orca mail is not read on a loop root (U276)\n`);
  if (ids?.length) { const w = open(root); try { ack(w, who, ids); } finally { w.close(); } }
  const s = openReadOnly(root);
  try {
    if (o.all) return inbox(s, who, { all: true }).slice(-20);
    const end = Date.now() + (o.poll ? 0 : o.ms);
    for (;;) {
      const got = inbox(s, who);
      if (got.length || Date.now() >= end) return got;
      await Bun.sleep(Math.min(500, Math.max(0, end - Date.now())));
    }
  } finally { s.close(); }
}

export const help = "<project> <topic> [ms] [--ack id] | --worktree [ms] | --run <run_id> [ms] [--requests <label>] [--full] [--all] [--poll] — one coordination tick (watch.sh)";

// ---- jq semantics the shell body relied on ----
class JqError extends Error {}
const isObj = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v);
/** `.a.b[0]`: null through null, an error indexing anything else the wrong way. */
function jget(v: any, ...path: (string | number)[]): any {
  for (const k of path) {
    if (v === null || v === undefined) return null;
    if (typeof k === "number") { if (!Array.isArray(v)) throw new JqError(); v = v[k]; }
    else { if (!isObj(v)) throw new JqError(); v = v[k]; }
  }
  return v === undefined ? null : v;
}
/** `a // b`. */
export const alt = (a: any, b: any): any => (a === null || a === undefined || a === false ? b : a);
export const truthy = (v: any): boolean => v !== null && v !== undefined && v !== false;
/** `\(x)` and `-r` output: a string raw, anything else as JSON. */
export const interp = (v: any): string => (typeof v === "string" ? v : JSON.stringify(v === undefined ? null : v));
/** `.[]?`: an array's elements, an object's values, nothing for the rest. */
const each = (v: any): any[] => (Array.isArray(v) ? v : isObj(v) ? Object.values(v) : []);
/** `length` (codepoints for a string); an error for a boolean. */
function jqLength(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") throw new JqError();
  if (typeof v === "string") return Array.from(v).length;
  if (typeof v === "number") return Math.abs(v);
  return Array.isArray(v) ? v.length : Object.keys(v).length;
}
/** `(.x // []) | length > 0`, false where jq -e would fail. */
const hasItems = (v: any): boolean => { try { return jqLength(alt(v, [])) > 0; } catch { return false; } };
/** `join(s)` (jq 1.7): null as "", numbers and booleans as their text, anything else an error. */
function join_(xs: any[], sep: string): string {
  return xs.map((x) => {
    if (x === null || x === undefined) return "";
    if (typeof x === "string") return x;
    if (typeof x === "number" || typeof x === "boolean") return String(x);
    throw new JqError();
  }).join(sep);
}
const jqRank = (v: any): number => (v === null || v === undefined ? 0 : v === false ? 1 : v === true ? 2 : typeof v === "number" ? 3 : typeof v === "string" ? 4 : Array.isArray(v) ? 5 : 6);
/** jq's `sort` over scalars (null first, then booleans, numbers, strings by codepoint). */
function jqSort(xs: any[]): any[] {
  return [...xs].sort((a, b) => {
    const r = jqRank(a) - jqRank(b);
    if (r !== 0) return r;
    if (typeof a === "number") return a - b;
    if (typeof a === "string") return a < b ? -1 : a > b ? 1 : 0;
    return 0;
  });
}
/** `cut -f n`: a line with no tab is printed whole. */
const cutF = (line: string, n: number): string => (line.includes("\t") ? line.split("\t")[n - 1] ?? "" : line);
/** `awk -F'\t' '$1==id{print; exit}'` over a here-string. */
const rowOf = (text: string, id: string): string => text.split("\n").find((l) => l.split("\t")[0] === id) ?? "";
/** `awk -F'\t' '{print $n}'` of one row (empty past the last field). */
const cutAwk = (row: string, n: number): string => row.split("\t")[n - 1] ?? "";
/** jget that reads a jq error as null (for the `-e` tests). */
const jget0 = (v: any, k: string): any => { try { return jget(v, k); } catch { return null; } };
const numeric = (s: string): boolean => /^[0-9]+$/.test(s);

/** One word of a file list, glob-expanded in its folder like an unquoted shell word (no match: the word itself). */
function expandWord(word: string): string[] {
  const dir = dirname(word), pat = basename(word);
  if (!/[*?[]/.test(pat)) return [word];
  const re = new RegExp("^" + pat.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => !f.startsWith(".") && re.test(f)).sort(); } catch { /* no folder */ }
  return names.length ? names.map((f) => join(dir, f)) : [word];
}
/** The role this worktree's session is (DS_MEMBER, else loop.db's member for the folder); null when unknown. */
function myRole(): string | null {
  const id = parseMember(whoAmI().member);
  if (id) return id.role;
  if (!dsLoopOn()) return null;
  let s: ReturnType<typeof openReadOnly> | null = null;
  try { const f = senderAt((s = openReadOnly(stateRoot())), toplevel()); return f.role && f.role !== "unknown" ? f.role : null; }
  catch { return null; } finally { s?.close(); }
}
/** `cksum` of the instruction files catted together (missing ones skipped): AGENTS.md plus the role's own file
 *  (`studio/studio.md` for the Studio), not every conventions file; with no role known, all of them. */
function instrHash(): string {
  const env = process.env.DS_INSTR_FILES;
  const words = env ? env.split(/\s+/).filter((w) => w !== "")
    : instructionFilesFor(myRole()).map((f) => join(process.env.DS_INSTR_ROOT || ROOT, f)); // DS_INSTR_ROOT: a test tree
  const parts: Buffer[] = [];
  for (const f of words.flatMap(expandWord)) { try { parts.push(readFileSync(f)); } catch { /* cat 2>/dev/null */ } }
  return cksum(Buffer.concat(parts));
}

const readText = (f: string): string | undefined => { try { return readFileSync(f, "utf8"); } catch { return undefined; } };
const isFile = (f: string): boolean => { try { return statSync(f).isFile(); } catch { return false; } };

function requestHint(line: string): string {
  if (line.startsWith("board:")) return "run that command (the operator asked from the board), then";
  if (line.startsWith("switch:") && line.includes("(early, while idle")) return "historical early move: run that exact command ONLY if the agent is still idle; otherwise clear it with done-request.sh, then";
  if (line.startsWith("switch:")) return "usage limit: run that exact command (it moves the agent to the next free account/model), journal why, then";
  if (line.startsWith("briefing:")) return 'write the morning brief (studio/studio.md, "Morning brief"), then clear it with done-request.sh';
  if (line.startsWith("idle:")) return "an idle Builder with an open unit: look at it, then wake it, release the unit or close it (not a restart), then";
  return "restart it (restart-role.sh; look at it first), journal why, then";
}

const age = (m: number): string => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`);
const hhmm = (sec: number): string => { const d = new Date(sec * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const nowS = (): number => Math.floor(Date.now() / 1000);

function usage(): number {
  writeErr("usage: watch.sh <project> <topic> [ms] [--ack id] | --worktree | --run <run_id>\n");
  return 2;
}

export async function run(argv: string[]): Promise<number> {
  const BACKEND = backendPath();
  const SR = stateRoot();
  let MODE: "lead" | "worktree" | "run" = "lead";
  let LABEL = "", TOPIC = "", RUN = "", STATE = "", BEAT = "", REQDIR = "";
  let TIMEOUT = "90000", ACK = "", POLL = false, ALL = false, FULL = false, LOOPRUN = false;

  const args: string[] = [];
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    // a flag missing its value ended the shell body with exit 1 (set -u)
    if ((a === "--ack" || a === "--run" || a === "--requests") && i + 1 >= argv.length) { writeErr(`watch.sh: ${a} needs a value\n`); return 1; }
    if (a === "--ack") { ACK = argv[i + 1]; i += 2; }
    else if (a === "--worktree") { MODE = "worktree"; i++; }
    else if (a === "--run") { MODE = "run"; RUN = argv[i + 1]; i += 2; }
    else if (a === "--requests") { REQDIR = join(SR, dsLabel(argv[i + 1]), "requests", "_studio"); i += 2; }
    else if (a === "--full") { FULL = true; i++; }
    else if (a === "--all") { ALL = true; i++; }
    else if (a === "--poll") { POLL = true; i++; }
    else { args.push(a); i++; }
  }

  if (MODE === "run") {
    if (!RUN) return usage();
    if (args.length >= 1) TIMEOUT = args[0];
  } else if (MODE === "worktree") {
    // the first numeric positional; a stray project/topic degrades to the default
    const n = args.find(numeric);
    if (n !== undefined) TIMEOUT = n;
  } else {
    if (args.length < 2) return usage();
    LABEL = dsLabel(args[0]); TOPIC = args[1];
    if (args.length >= 3) TIMEOUT = args[2];
    STATE = join(SR, LABEL, "squads", `${TOPIC}.json`);
    if (!isFile(STATE)) { writeErr(`watch: no squad '${TOPIC}' for '${LABEL}' (${STATE})\n`); return 1; }
    BEAT = join(SR, LABEL, "squads", `${TOPIC}.beat`);
  }
  if (!numeric(TIMEOUT)) TIMEOUT = "90000";

  // --- block for a message (and ack the prior batch) ---
  // U276: on a loop root the messages are loop.db rows (ds msg): read, waited for and acked there, never
  // through an Orca inbox; the loop holds every Run there and writes its mail to the Lead as rows (relay.ts).
  const ROWS = MODE !== "run" && dsLoopOn() ? rowsReader(SR, MODE === "lead" ? { project: LABEL, squad: TOPIC, role: "lead", suffix: "" } : null) : null;
  let own: boolean, hdr: string;
  let st: any;
  if (MODE === "worktree") { own = true; hdr = ROWS ? "worktree messages (loop.db)" : "worktree inbox"; }
  else {
    if (MODE !== "run") {
      st = readJson(STATE);
      let r: any = null;
      try { r = jget(st, "run_id"); } catch { /* jq error: empty */ }
      RUN = truthy(r) ? interp(r) : "";
    }
    // A squad off Orca has no Run (U11b): its Lead's mail is only ever loop.db rows.
    const OFF = MODE === "lead" ? squadContract(SR, LABEL, TOPIC) : null;
    if (!RUN && !(ROWS && OFF)) { writeErr("watch: no run_id\n"); return 1; }
    let holder = "";
    if (MODE === "lead" && !ROWS) holder = chomp((await runCmd([BACKEND, "run-coordinator", RUN])).out);
    if (ROWS && !RUN) { own = true; LOOPRUN = true; hdr = `lead messages (loop.db; no Run: the squad runs on ${OFF})`; }
    else if (ROWS) { own = true; LOOPRUN = true; hdr = `lead messages (loop.db; the loop holds run=${RUN} and writes its mail here)`; }
    else if (holder && holder !== (whoAmI().handle ?? "")) { own = true; LOOPRUN = true; hdr = `worktree inbox (the loop holds run=${RUN} and relays its mail here)`; }
    else { own = false; hdr = `run=${RUN}`; }
  }
  let rows: Message[] | null = null, rd = { out: "", err: "", rc: 0 };
  if (ROWS) {
    try { rows = await rowsTick(SR, ROWS, { ack: ACK, ms: Number(TIMEOUT), poll: POLL, all: ALL }); }
    catch (e) { rd = { out: "", err: `loop.db read: ${(e as Error).message}`, rc: 1 }; }
  } else {
    const readArgs = own
      ? (ALL ? ["inbox-all-self"] : POLL ? ["inbox-peek-self"] : ["inbox-wait-self", TIMEOUT, ACK])
      : (ALL ? ["inbox-all", RUN] : POLL ? ["inbox-peek", RUN] : ["inbox-wait", RUN, TIMEOUT, ACK]);
    rd = await runCmd([BACKEND, ...readArgs]);
    if (rd.rc !== 0) rd.err = rd.err || `backend_error: ${readArgs[0]} exited ${rd.rc}`;
  }
  const msgs = chomp(rd.out);
  const readRc = rd.rc;
  let detail = "";
  if (readRc !== 0) detail = rd.err.replace(/\n/g, " ").replace(/\s+$/, "");

  const finishTick = (): number => {
    if (readRc === 0) return 0;
    // a failed poll must wake the agent only for a real request, not for the read error
    (POLL ? writeErr : writeOut)(`INBOX READ FAILED: ${detail}\n`);
    return readRc;
  };

  if (readRc === 0) {
    let parsed: any, json = true;
    try { parsed = JSON.parse(msgs); } catch { json = false; }
    let ackid = "";
    if (json) {
      try {
        const v = alt(alt(jget(parsed, "result", "deliveryId"), jget(parsed, "result", "delivery", "id")), jget(parsed, "result", "messages", 0, "deliveryId"));
        if (truthy(v)) ackid = interp(v);
      } catch { /* jq error: no ack id */ }
    }
    if (ALL) ackid = ""; // a re-read of consumed mail has nothing to ack

    writeOut(`=== ${TOPIC || "run"} ${LABEL ? `(${LABEL}) ` : ""}— ${hdr} ===\n`);
    // Re-read instructions only when they changed since this worktree last saw them; a --poll peek is
    // never shown to the agent, so it marks nothing seen.
    if (!POLL) {
      const ihash = instrHash();
      const iseen = join(process.env.DS_INSTR_SEEN || join(SR, "_instr-seen"), cksum(process.env.PWD || process.cwd()));
      if (chomp(readText(iseen) ?? "") === ihash) writeOut("INSTRUCTIONS: unchanged since your last read — no need to re-read them\n");
      else {
        writeOut("INSTRUCTIONS: changed (or first tick here) — re-read ~/.dev-studio/AGENTS.md + your role file now\n");
        try { mkdirSync(dirname(iseen), { recursive: true }); writeFileSync(iseen, `${ihash}\n`); } catch { /* best effort */ }
      }
    }
    writeOut("MESSAGES:\n");
    let list: any = null, any = false;
    if (rows) {
      // U276: the rows, a question that still needs an answer flagged with its reply command.
      for (const m of rows) {
        let out = `  ✉ ${line(m)}  (id=${m.id})\n${String(m.body).replace(/\r/g, "").split("\n").map((l) => "      " + l).join("\n")}`;
        if (m.needs_reply && m.replied_at == null)
          out += `\n      ↳ QUESTION — you MUST answer: ~/.dev-studio/bin/ds msg reply ${m.id} "<answer>"  (or route it to the owning Thinker, then reply)`;
        writeOut(out + "\n");
      }
      if (!rows.length) writeOut("  (none — timeout; do a check-in and re-arm)\n");
      if (!ALL) ackid = rowsAckId(rows);
      // The questions the board counts as waiting for this member: listed, never acked or re-sent.
      try { const w = openReadOnly(SR); try { for (const l of waitingLines(ROWS ? waitingFor(w, ROWS) : [])) writeOut(l + "\n"); } finally { w.close(); } } catch { /* no db: none */ }
    } else if (json) { try { list = jget(parsed, "result", "messages"); any = hasItems(list); } catch { any = false; } }
    if (any) {
      // a readable summary per message, a question flagged loudly with its reply command
      try {
        for (const m of each(list)) {
          const body = alt(jget(m, "body"), "");
          if (typeof body !== "string") throw new JqError();
          const lines = body.replace(/\r/g, "");
          let out = `  • [${interp(alt(jget(m, "type"), "msg"))}] ${interp(alt(alt(jget(m, "from_handle"), jget(m, "from")), "?"))} — ${interp(alt(jget(m, "subject"), "(no subject)"))}  (id=${interp(alt(jget(m, "id"), "?"))})`
            + "\n" + (lines === "" ? "" : lines.split("\n").map((l) => "      " + l).join("\n"));
          if (alt(jget(m, "type"), "") === "question")
            out += `\n      ↳ QUESTION — you MUST answer: orch.sh reply ${interp(alt(jget(m, "id"), "<id>"))} <run> "<answer>"  (or route it to the owning Thinker, then reply)`;
          else if (/^\[run mail · question/.test(body)) {
            const q = body.match(/· id ([^ \]]+)/)?.[1];
            out += `\n      ↳ QUESTION — you MUST answer: ~/.dev-studio/bin/ds reply ${q ?? "<id>"} "<answer>"  (or route it to the owning Thinker, then reply)`;
          }
          writeOut(out + "\n");
        }
      } catch { writeOut(msgs + "\n"); }
    } else if (!rows) writeOut("  (none — timeout; do a check-in and re-arm)\n");
    if (ackid) writeOut(`ACK-ID: ${ackid}   (after handling every message above, re-run with --ack ${ackid})\n`);
  }

  // REQUESTS: restart requests filed for the one above a broken agent (the Lead its squad's, the Studio
  // `_studio`). Each `↻ request` line also makes the rewake hook wake the agent.
  if (MODE === "lead") REQDIR = join(SR, LABEL, "requests", TOPIC);
  if (REQDIR) {
    let files: string[] = [];
    try { files = readdirSync(REQDIR).filter((f) => f.endsWith(".txt") && !f.startsWith(".")).sort().map((f) => join(REQDIR, f)).filter(isFile); } catch { /* none */ }
    if (files.length) writeOut("REQUESTS:\n");
    for (const f of files) {
      const line = chomp((readText(f) ?? "").split("\n")[0]);
      writeOut(`  ↻ request\t${line}\n      ↳ ${requestHint(line)}: ${ROOT}/bin/role/done-request.sh ${f}\n`);
    }
    if (!files.length && (readRc === 0 || !POLL)) writeOut("REQUESTS:\n  (none)\n");
  }

  // Thinker/run modes stop here — no team, no work items.
  if (MODE !== "lead" || (readRc !== 0 && POLL)) return finishTick();

  // the squad as it is now, after the wait: the tick usually woke because it changed
  st = readJson(STATE);

  // --- beat: prove this tick ran (the board flags a Lead whose beat is stale) ---
  try { writeFileSync(BEAT, ""); } catch { /* best effort */ }

  // --- team check-in + work items ---
  // A squad off Orca: its members' states from its own backend, through the contract (U11b), never Orca.
  const sr = squadContract(SR, LABEL, TOPIC)
    ? await contractStates(SR, LABEL).then((c) => ({ out: c.lines.join("\n"), err: c.blind.join("; "), rc: c.blind.length && !c.lines.length ? 1 : 0 }))
    : await runCmd([BACKEND, "worker-states"]);
  const states = chomp(sr.out);
  const STATES_UNKNOWN = readRc !== 0 && (sr.rc !== 0 || states === "");
  const stateOf = (id: string): string => {
    const s = cutAwk(rowOf(states, id), 2);
    return s === "" && STATES_UNKNOWN ? "unknown" : s;
  };

  // [role, suffix, wt, owns] per member, stopping where jq would have errored
  const members: string[][] = [];
  try {
    for (const m of each(jget(st, "members"))) {
      const owns = alt(jget(m, "owns"), []);
      if (!Array.isArray(owns)) throw new JqError();
      members.push([join_([jget(m, "role")], ""), join_([alt(jget(m, "suffix"), "")], ""), join_([jget(m, "wt")], ""), join_(owns, ", ")]);
    }
  } catch { /* the rows before the error */ }
  const hasMembers = hasItems(jget0(st, "members"));

  // standing-role dispatch: the loop's own verdict (U100) through `bin/ds members`, read once and only
  // when a standing role's agent reads `done`
  let disps = "";
  if (hasMembers) {
    for (const [role, , wid] of members) {
      if (!wid || role === "lead" || role === "builder") continue;
      if (stateOf(wid) === "done") {
        const r = await runCmd([join(ROOT, "bin", "ds"), "--state", SR, "members", LABEL]);
        try {
          const rows: string[] = [];
          for (const x of each(JSON.parse(r.out))) rows.push(`${interp(alt(jget(x, "wt"), ""))}\t${interp(alt(jget(x, "dispatch_verdict"), ""))}`);
          disps = rows.join("\n");
        } catch { disps = ""; }
        break;
      }
    }
  }
  const dispOf = (id: string): string => cutAwk(rowOf(disps, id), 2);

  const GH = (process.env.DS_GH || "gh").split(/\s+/).filter((w) => w !== "");
  // the squad's repo slug for the gh read: .repo first, then any squad worktree's checkout
  let PR_SLUG = await repoSlug(strOrEmpty(st, "repo"));
  if (!PR_SLUG) {
    for (let w of worktrees(st)) {
      if (!w) continue;
      if (w.includes("::")) w = w.slice(w.lastIndexOf("::") + 2);
      PR_SLUG = await repoSlug(w);
      if (PR_SLUG) break;
    }
  }
  // "<OPEN|MERGED|CLOSED>\t<mergeable/checks words>" from one gh call, or undefined
  const prLive = async (n: string): Promise<string | undefined> => {
    if (!PR_SLUG) return undefined;
    const r = await runCmd([...GH, "pr", "view", n, "--repo", PR_SLUG, "--json", "state,mergeable,mergeStateStatus,statusCheckRollup"]);
    if (r.rc !== 0) return undefined;
    let j: any;
    try { j = JSON.parse(r.out); } catch { return undefined; }
    let s: any;
    try { s = alt(jget(j, "state"), ""); } catch { return undefined; }
    const sv = interp(s);
    if (sv !== "OPEN" && sv !== "MERGED" && sv !== "CLOSED") return undefined;
    if (sv !== "OPEN") return `${sv}\t`;
    let mg = "";
    try { const v = alt(jget(j, "mergeable"), ""); mg = v === "" ? "" : interp(v); } catch { mg = ""; }
    let checks: string;
    try {
      const cs = each(jget(j, "statusCheckRollup")).map((c) => alt(alt(jget(c, "conclusion"), jget(c, "state")), ""));
      const bad = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
      checks = cs.some((c) => bad.includes(c)) ? "checks failing"
        : cs.some((c) => c !== "SUCCESS" && c !== "SKIPPED" && c !== "NEUTRAL") ? "checks running" : "checks green";
    } catch { return undefined; }
    return `${sv}\tmergeable ${mg || "unknown"}, ${checks}`;
  };
  // the live PR line under a dispatched unit; a merged PR also gets an action row until the loop marks
  // that unit done. `suppress` is true when `⏸ sitting` must not fire.
  const prBlock = async (slug: string, wt: string, pr: string): Promise<{ text: string; suppress: boolean }> => {
    if (!pr) return { text: "", suppress: false };
    const n = pr.replace(/.*\//, "").replace(/[^0-9]/g, "");
    if (!n) return { text: "", suppress: false };
    const live = await prLive(n);
    if (!live) return { text: `      PR #${n} state unknown\n`, suppress: false };
    const lstate = cutF(live, 1), lsum = cutF(live, 2);
    if (lstate === "MERGED") return { text: `      PR #${n} MERGED (live)\n  ‼ merged\t${slug}\t${wt}\tPR #${n} MERGED\tthe loop has not marked it done yet: it does on its next PR read; if this stays after a tick, mark it done (refused until the loop has read the merge), and it retires the Builder\n`, suppress: true };
    if (lstate === "CLOSED") return { text: `      PR #${n} CLOSED (live)\n`, suppress: false };
    return { text: `      PR #${n} OPEN ${lsum} (live)\n`, suppress: false };
  };
  // A dispatched Builder whose agent isn't working has been SITTING since its state started:
  // 15m+ -> nudge; 45m+ (the nudge didn't wake it) -> look, then restart.
  const SIT_NUDGE = Number(process.env.DS_SIT_NUDGE_MIN || "15"), SIT_RESTART = Number(process.env.DS_SIT_RESTART_MIN || "45");
  const builderLines = async (slug: string, wt: string, pr: string): Promise<string> => {
    const row = rowOf(states, wt);
    let s = cutF(row, 2);
    const since = cutF(row, 4), said = cutF(row, 5);
    if (s === "" && STATES_UNKNOWN) s = "unknown";
    if (!numeric(since)) {
      let o = `  ⟳ dispatched\t${slug}\t${wt}\t${s}\n`;
      if (said) o += `      last said: ${said}\n`;
      return o + (await prBlock(slug, wt, pr)).text;
    }
    const sinceS = Math.floor(Number(since) / 1000);
    const mins = Math.max(0, Math.floor((nowS() - sinceS) / 60));
    let o = `  ⟳ dispatched\t${slug}\t${wt}\t${s} ${age(mins)}\n`;
    if (said) o += `      last said (≤${age(mins)} ago): ${said}\n`;
    const pb = await prBlock(slug, wt, pr);
    o += pb.text;
    if (pb.suppress || s === "working" || s === "" || !(mins >= SIT_NUDGE)) return o;
    const stage = mins >= SIT_RESTART ? "nudge didn't wake it — look at it, then restart" : "nudge it";
    return o + `  ⏸ sitting\t${slug}\t${wt}\t${mins}m ${s}\t${stage}\t(since ${hhmm(sinceS)})\n`;
  };

  // Loop-run squad: TEAM and WORK ITEMS list only rows whose state changed since the last tick, plus one
  // count line. A --poll peek never reads or writes the snapshot, and --full prints everything.
  const SEEN = join(SR, LABEL, "squads", `${TOPIC}.watch-seen`);
  const seenText = readText(SEEN) ?? "";
  const QUIET = LOOPRUN && !FULL && !POLL && seenText !== "" && readRc === 0;
  const seen = new Set(seenText.split("\n"));
  const seenNew: string[] = [];
  const quietRow = (key: string): boolean => { seenNew.push(key); return QUIET && seen.has(key); };
  let nQW = 0, nQU = 0;

  let out = STATES_UNKNOWN ? `TEAM: (worker state unavailable: ${detail})\n` : "TEAM:\n";
  let anyW = false;
  if (hasMembers) {
    for (const [role, suffix, wid, owns] of members) {
      if (!wid) continue;
      anyW = true;
      let s = stateOf(wid) || "GONE";
      const label = role + (suffix ? `-${suffix}` : "");
      let extra = "";
      if (s === "done" && role !== "lead" && role !== "builder") {
        // a standing role reading `done`: open and rebound are idle at the prompt, settled exited
        const d = dispOf(wid);
        if (d === "settled") { s = "⚠ settled"; extra = " (dispatch settled — exited; restart in place)"; }
        else if (d !== "" && d !== "unknown") s = "waiting";
      }
      if (s !== "GONE" && quietRow(`W|${wid}|${s}`)) { nQW++; continue; }
      if (s === "GONE") out += `  ${s}\t${label}\t(worktree gone — dead/removed; re-dispatch)\n`;
      else if (extra) out += `  ${s}\t${label}\t${extra}\n`;
      else out += `  ${s}\t${label}${owns ? `  owns: ${owns}` : ""}\n`;
    }
  } else {
    // legacy squads (no roster yet): the flat worktree list
    for (const wid of worktrees(st)) {
      if (!wid) continue;
      anyW = true;
      const s = stateOf(wid);
      out += s ? `  ${s}\t${wid}\n` : `  GONE\t${wid}\t(worktree not found — dead/removed; re-dispatch its unit)\n`;
    }
  }
  if (!anyW) out += "  (no recorded workers yet)\n";
  writeOut(out);

  // ❓ unasked: a standing role stopped on a question in chat while the board holds none from it.
  let asked: string[] = [];
  try { asked = each(alt(jget(st, "waiting_on_you"), [])).map((q) => interp(jget(q, "asker"))); } catch { asked = []; }
  out = "";
  try {
    for (const m of each(jget(st, "members"))) {
      const role = jget(m, "role");
      if (role === "lead" || role === "builder") continue;
      const suffix = join_([alt(jget(m, "suffix"), "")], "");
      const label = join_([role], "") + (suffix ? `-${suffix}` : "");
      const wid = join_([jget(m, "wt")], "");
      if ((asked.length ? asked : [""]).includes(label)) continue; // its question is queued
      const row = rowOf(states, wid);
      const s = cutF(row, 2), said = cutF(row, 5);
      if (s === "working" || s === "") continue;
      if (said.includes("?")) out += `  ❓ unasked\t${label}\t${wid}\t${said}\t(since ${cutF(row, 4)})\n`;
    }
  } catch { /* the rows before the error */ }
  writeOut(out);

  // WORK ITEMS: the durable plan queue (planned -> dispatched -> done, or cancelled).
  writeOut("WORK ITEMS:\n");
  if (hasItems(jget0(st, "units"))) {
    const units: string[][] = [];
    try {
      for (const u of each(jget(st, "units")))
        units.push([join_([jget(u, "slug")], ""), join_([alt(jget(u, "status"), "planned")], ""), join_([alt(jget(u, "builder_wt"), "")], ""), join_([alt(jget(u, "superseded_by"), "")], ""), interp(alt(jget(u, "pr"), ""))]);
    } catch { /* the rows before the error */ }
    for (const [slug, status, bwt, into, upr] of units) {
      if (!slug) continue;
      let row: string;
      if (status === "planned") row = `  ○ planned\t${slug}\t(not dispatched yet — spawn its Builder)\n`;
      else if (status === "done") row = `  ✓ done\t${slug}\n`;
      else if (status === "cancelled") row = into ? `  ✗ cancelled\t${slug}\t(folded into ${into})\n` : `  ✗ cancelled\t${slug}\n`;
      else if (status === "dispatched") {
        if (bwt && !stateOf(bwt)) row = `  ⚠ dispatched\t${slug}\t${bwt}\tGONE — re-dispatch\n` + (await prBlock(slug, bwt, upr)).text;
        else row = await builderLines(slug, bwt, upr);
      } else row = `  ?\t${slug}\t${status}\n`;
      row = chomp(row);
      // the key holds the PR lines too, so CLOSED / red checks show; an action marker keeps the row up
      const ukey = `U|${slug}|${status}|${stateOf(bwt)}|${upr}|${row.split("\n").filter((l) => l.includes("PR #")).map((l) => l + ";").join("")}`;
      if (/[⚠‼⏸]/.test(row) || !quietRow(ukey)) writeOut(row + "\n");
      else nQU++;
    }
  } else writeOut("  (none yet — the Thinker's plan becomes units as you dispatch them)\n");
  if (QUIET && nQW + nQU > 0) writeOut(`  (${nQW} workers, ${nQU} units unchanged since your last tick — watch.sh <project> <topic> 4000 --full lists them)\n`);
  // a --poll peek is not a tick, and the --ack re-arm tick only shows a diff the next wake shows again
  if (!POLL && !ACK && readRc === 0) { try { writeFileSync(SEEN, seenNew.map((k) => k + "\n").join("")); } catch { /* best effort */ } }

  // ★ finished: a running feature squad whose every unit is done or cancelled (none held) and that has
  // no Tester (squad-finish.ts: wrapping up). The token
  // changes with each finish, so the rewake hook wakes the Lead once per finish. Shows on --poll too.
  if (finishable(st)) {
    let tok = "";
    try {
      const slugs = join_(jqSort(each(jget(st, "units")).map((u) => jget(u, "slug"))), ",");
      const roles = join_(jqSort(each(jget(st, "members")).map((m) => jget(m, "role"))), ",");
      tok = cksum(`${RUN}|${slugs}|${roles}\n`);
    } catch { tok = cksum(""); }
    writeOut(`  ★ finished\t${TOPIC}\t${tok}\twrapping up — every unit done or cancelled, nothing held and no Tester left: do the testability handoff, check the Try it page is current, then set-status done and tell the operator /ds-close-squad ${TOPIC} (no debrief now: the loop asks for it at archive)\n`);
  }

  // OPEN QUESTIONS: the waiting_on_you queue, every tick, so none can rot unseen.
  writeOut("OPEN QUESTIONS:\n");
  if (hasItems(jget0(st, "waiting_on_you"))) {
    try {
      for (const q of each(jget(st, "waiting_on_you"))) {
        const text = alt(jget(q, "question"), "");
        if (typeof text !== "string") throw new JqError();
        const one = text.replace(/[\n\r]+/g, " ");
        const cps = Array.from(one);
        const id = interp(jget(q, "id"));
        writeOut(`  ⧖ ${id}  [${truthy(jget(q, "blocking")) ? "blocking" : "non-blocking"}] asked by ${interp(alt(jget(q, "asker"), "?"))}  (since ${interp(alt(jget(q, "since"), "?"))})`
          + "\n      " + (cps.length > 300 ? cps.slice(0, 300).join("") + " …" : one)
          + `\n      ↳ if reality already answered it (PR merged, unit done), clear it: squad-state.sh <state> resolve-question ${id}\n`);
      }
    } catch { /* the rows before the error */ }
  } else writeOut("  (none)\n");

  // CROSS-SQUAD: peer exchanges naming this squad, last 24h, at most 10.
  writeOut("CROSS-SQUAD:\n");
  const xs = crossSquad(join(SR, LABEL, "cross-squad.md"), TOPIC);
  writeOut(xs.length ? xs.map((l) => `  ${l}\n`).join("") : "  (none)\n");
  // CREW CHAT: what the operator told this squad's crew from the board (fulfil/chat.ts), last 24h, at most 10.
  writeOut("CREW CHAT:\n");
  const cc = crewChat(join(SR, LABEL, "crew-chat.md"), TOPIC);
  writeOut(cc.length ? cc.map((l) => `  ${l}\n`).join("") : "  (none)\n");
  return finishTick();
}

/** `jq -r '.k // empty'`. */
function strOrEmpty(st: any, k: string): string {
  try { const v = jget(st, k); return truthy(v) ? interp(v) : ""; } catch { return ""; }
}
/** `jq -r '.worktrees[]? // empty'`. */
function worktrees(st: any): string[] {
  try { return each(jget(st, "worktrees")).filter(truthy).flatMap((w) => interp(w).split("\n")); } catch { return []; }
}
// squad-finish.ts' settle() over the squad JSON (no PRs here: a done unit's PR is merged): a held unit
// is open work, so a squad whose only open units are held gets no line.
function finishable(st: any): boolean {
  try {
    if (alt(jget(st, "status"), "running") !== "running") return false;
    const units = alt(jget(st, "units"), []), members = alt(jget(st, "members"), []);
    return settle({ type: alt(jget(st, "type"), "feature"), units: Array.isArray(units) ? units : [], members: Array.isArray(members) ? members : [] }).state === "wrapping-up";
  } catch { return false; }
}
/** The cross-squad.md lines (`- <iso> <from> … <to>`) from the last 24 h naming `<topic>/` as field 3 or 5. */
function crossSquad(file: string, topic: string): string[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  let re: RegExp;
  try { re = new RegExp(`^${topic}/`); } catch { return []; }
  const cut = new Date(Date.now() - 86400_000).toISOString().replace(/\.\d+Z$/, "Z");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.filter((l) => {
    if (!l.startsWith("- ")) return false;
    const f = l.replace(/^[ \t]+/, "").split(/[ \t]+/);
    return (f[1] ?? "") >= cut && (re.test(f[2] ?? "") || re.test(f[4] ?? ""));
  }).slice(-10);
}
/** The crew-chat.md lines (`- <iso> operator → <topic>/<role>: <text>`) from the last 24 h to `<topic>/`. */
function crewChat(file: string, topic: string): string[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const cut = new Date(Date.now() - 86400_000).toISOString().replace(/\.\d+Z$/, "Z");
  return text.split("\n").filter((l) => {
    const f = /^- (\S+) \S+ → (\S+)/.exec(l);
    return !!f && f[1]! >= cut && f[2]!.startsWith(`${topic}/`);
  }).slice(-10);
}
