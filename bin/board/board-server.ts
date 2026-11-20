// board-server.ts — the web board server the loop runs (`board.sh --serve` wishes for it; U16) (Bun).
//
//   bun board-server.ts <binds> <port> <page.html> <board-cmd...>
//
// Answers only requests whose Host names this machine (DS_BOARD_HOSTS, space-separated names/IPs,
// set by board.sh); any other Host gets 403, so a web page can't read the board via DNS rebinding.
// The server only talks to loop.db: it never runs a command and never reads a state or conf file
// (the page file is the one file read). Reads open loop.db read-only per request; a write is one
// wish or `requests` row the loop fulfils on its next tick, answered 202 with the row's id — the
// page then learns the outcome from the event log (GET /api/stream).
//
// Reads:
//   GET /                      the page file
//   GET /board.json            bin/board/board-data.ts's board, cached ~2s so several open tabs share one
//                              render; a failed render is 500 with the error ("stale since ...")
//   GET /api/events?before=<id>|after=<id>|until=<epoch>&limit=50[&project=<label>][&squad=<slug|_studio>[&member=<worktree>]|&nosquad=1]
//                  [&cat=<category>|other][&noise=hide][&hide=<kind>,…][&sev=bad|wait|ok][&kind=<kind>][&lists=0][&q=<text>]
//                              one page of the event log (event-cats.ts has the categories and the
//                              noise kinds; `member` needs `squad`; `lists=0` leaves the old pickers out;
//                              `q` searches kind, squad, unit, member and payload in one slice of ids back
//                              from `before`/`until` and says how far in `searched`, never with `after`;
//                              `messages` holds the message rows the page's message events name)
//   GET /api/events/lists[?project=<label>][&squad=<slug|_studio>]   the event log's pickers: squads
//                              (live/closed), the squad's crew, categories, kinds, noise kinds
//   GET /api/stream[?after=<id>]   the event log as server-sent events, from `after` (or now) on
//   GET /api/questions?squad=<slug>&status=answered[&before=<seq>]&limit=50   past answers
//   GET /api/briefing?project=<label>&date=<YYYY-MM-DD>   one morning brief's markdown (404 when none)
//   GET /api/limits?project=<label>, /api/roles?project=<label>, /api/skills?project=<label>   from the config rows
//   GET /api/chat?project=<label>&topic=<slug|_studio>&wt=<worktree>   one live member's turns from
//                              observed_chat and its last 10 chats with their state (404: no such member)
//   GET /api/messages?project=<label>&topic=<slug>[&wt=<worktree>]   that member's (or the squad's) message rows, newest first; a read, never an ack
//   GET /healthz               {ok, pid, port}: the loop's ping (the loop runs this server, U16)
//   GET /lavish/<key>          302 to that Lavish review page; when Lavish is down, a `lavish`
//                              request and a page that reloads until it is up
// Writes (POST, JSON, same-origin), each a `requests` row unless said otherwise:
//   /api/request  {project, action, topic?, role?, text?}  `studio`: the loop files the one-line
//                 request for the Studio ("board: the operator asks you to run: /ds-…")
//   /api/answer   {project, topic, id, answer}  the questions row answered via `board` and an
//                 `answer` row: the loop types it into the asker's terminal (the card's worktree,
//                 else the Lead; a picker by keystroke). A Studio alert (topic _studio): `dismiss`,
//                 even with an empty answer (one click); agent questions still need one.
//   /api/restart  {project, topic, wt, role?}  a `restart_at` wish (mode now, by the board; U153)
//   /api/pause, /api/resume {scope, project, topic?, wt?, role?, suffix?, prerequisites?}
//                 shared activity state, answered 200; the loop owns checkpoint/close/start
//   /api/poke     {project, topic}  `poke`: a wake-up line typed into a quiet Lead's terminal
//   /api/chat     {project, topic, wt, text}  `chat`: one line (no newline or control character, at most
//                 2000 characters) the loop types into that live, unpaused member's terminal once it is ready
//   /api/limits   {project, key, value|null}  `limits`: the loop sets or drops the limit; {project, key, undo: <history id>} files `config-undo` (U258)
//   GET /api/settings-export?project=<label> the export text (a transfer file, header line first); GET /api/settings-import?project= the other projects an import can read
//   /api/settings-import/preview {project, text|from}  the plan (one row per setting; reads only)
//   /api/settings-import  {project, text|from, picks: [{file, key, expect}]}  `settings-import`: the loop writes the picked rows as `board`
//   /api/skills   {project, role, set: {<skill|hook:name|mcp:server|*>: level}} | {project, role, reset: true}  `skills` (U230)
//   /api/roles    {project, role, agent, model, effort, spawn, fallbacks | reset:true}  `roles`
//   /api/unit    {project, topic, slug, action: release|cancel, why?}  `unit-action`: a Work units ⋯ menu choice
//   /api/plan    {project, topic, plan, why, keep_started?}  `plan-revoke`: take back an approved plan (Plans list ⋯ menu)
//   /api/account {project, agent, account, enabled}  `account`: switch one account off/on for every pick
//   /api/account-reset {project, agent, account, grant}  `account-reset`: use one free reset grant (usable now, none
//                 open for that account: else 400/409); the server adds the idempotency key every try reuses
//   /api/override {project, topic, wt, scope?(member|squad|role|project), role?, model?, effort?, plan?, account? | clear:true}  `override`: this member's
//                 model/account "until done", or back to auto
// Everything else is 404, so no state file is ever reachable.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { briefingJson, buildBoard, chatJson, chatMember, messagesJson, dsLabel, eventsAfter, eventsLists, eventsPage, lavishUrl, limitsJson, questionsPage, rolesJson } from "./board-data.ts";
import { isTestProject } from "../loop/settings/projects.ts";
import { isCat } from "./event-cats.ts";
import { approvedPlans } from "../loop/squad/plan-approved.ts";
import { squadDoc } from "../loop/db/export-json.ts";
import { skillsJson } from "./skills-data.ts";
import { lavishUp } from "../loop/io/lavish-up.ts";
import { answer as answerQuestion } from "../loop/messages/questions.ts";
import { dbPath, open, openReadOnly, type Row, type Store } from "../loop/core/store.ts";
import { checkExportText, exportTransfer, IMPORT_FILES, planImport, SettingsError, type ImportSource } from "../loop/settings/settings.ts";
import { canRestartRole } from "../loop/pause/restart-roles.ts";
import { paused, type PauseTarget, type Prerequisite } from "../loop/pause/pause.ts";

const CACHE_MS = 2000;
const MAX_BODY = 128 * 1024; // a 32 KiB brief doubles at worst under JSON escaping
const BRIEF_MAX = 32 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // a project label / squad topic: no path separators
const SQUAD = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/; // a squad a read may name: NAME, or the loop's own `_studio` (any `_` name)

const [bindArg, portArg, page, ...cmd] = process.argv.slice(2);
// The board's scope from the board-data.ts command line board.sh passes: [<project>] [--topic <slug>].
const scope = { project: "", topic: "" };
{
  const a = cmd.slice(cmd.findIndex((x) => x.endsWith("board-data.ts")) + 1);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--topic") scope.topic = a[++i] ?? "";
    else if (!a[i].startsWith("--")) scope.project = dsLabel(a[i]); // a selector or a label -> the label
  }
}
const port = Number(portArg);
const hosts = new Set((process.env.DS_BOARD_HOSTS || "localhost 127.0.0.1 ::1").toLowerCase().split(/\s+/).filter(Boolean));

// 'name:port' / '[v6]:port' / bare name -> the name, lowercased.
function hostName(h: string | null): string {
  h = (h || "").trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1).split("]")[0];
  return h.split(":").length === 2 ? h.split(":")[0] : h;
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const json = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const NO_DB = { error: "no loop.db yet — start the loop: bin/loop/loop.sh --ensure" };
// A whole-number query parameter, or undefined.
const intParam = (q: URLSearchParams, k: string) => (/^\d+$/.test(q.get(k) ?? "") ? Number(q.get(k)) : undefined);

// One line of operator text, safe to type into a terminal: no newlines, no control characters.
const oneLine = (v: unknown) => typeof v === "string" ? v.replace(/\s*[\r\n]+\s*/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim() : "";

// readPost: the CSRF checks every POST shares — only this board's own page may post: same-origin,
// and JSON (a plain form can't send that). Returns the parsed body, or the refusal to send back.
async function readPost(req: Request): Promise<{ b: any } | { r: Response }> {
  const origin = req.headers.get("Origin");
  let oh = "";
  try { oh = origin ? new URL(origin).host.toLowerCase() : ""; } catch { /* bad Origin: refused below */ }
  if (!oh || oh !== (req.headers.get("Host") || "").toLowerCase()) return { r: text(403, "forbidden origin\n") };
  if (!(req.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) return { r: text(415, "want application/json\n") };
  if (Number(req.headers.get("Content-Length") || 0) > MAX_BODY) return { r: text(413, "too large\n") };
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return { r: text(413, "too large\n") };
    return { b: JSON.parse(raw) ?? {} };
  } catch { return { r: json(400, { error: "body is not JSON" }) }; }
}

// write: run `fn` over one writable loop.db connection (never created here: no loop.db is 503). `fn`
// returns the response, an error response, or the new requests row (-> 202 {ok, id}).
class Refusal { constructor(readonly status: number, readonly error: string) {} }
const no = (status: number, error: string) => { throw new Refusal(status, error); };
function write(fn: (s: Store) => Row | Response): Response {
  if (!existsSync(dbPath())) return json(503, NO_DB);
  let s: Store;
  try { s = open(); } catch (e) { return json(503, { error: `loop.db: ${e}` }); }
  try {
    const r = s.tx(() => fn(s));
    return r instanceof Response ? r : json(202, { ok: true, id: Number(r.id) });
  } catch (e) {
    return e instanceof Refusal ? json(e.status, { error: e.error }) : json(500, { error: String(e).slice(-500) });
  } finally { s.close(); }
}
const one = (s: Store, sql: string, ...a: (string | number | null)[]) => (s.db.query(sql).get(...a) as Row | null) ?? null;
const pendingReq = (s: Store, kind: string, project: string, squad: string | null, field: string, value: string) =>
  one(s, `SELECT id FROM requests WHERE kind = ? AND project = ? AND squad IS ? AND done_at IS NULL AND json_extract(payload, '$.' || ?) = ?`,
    kind, project, squad, field, value);
const squadRow = (s: Store, project: string, topic: string) =>
  one(s, "SELECT * FROM squads WHERE project = ? AND topic = ?", project, topic) ?? no(409, `no squad ${project}/${topic}`);
const board = (s: Store, kind: string, payload: unknown, o: { project: string; squad?: string | null; member?: string | null }) =>
  s.requestAny(kind, payload, { ...o, by: "board" }).row;

// The Studio command each board action asks for; topic/role are NAME-checked before they get here.
const ACTIONS: Record<string, { topic: boolean; cmd: (p: string, t: string, role: string, brief: string) => string }> = {
  close:   { topic: true,  cmd: (_, t) => `/ds-close-squad ${t}` },
  restart: { topic: true,  cmd: (p, t, r) => `/ds-restart ${p} --topic ${t}${r ? ` --role ${r}` : ""}` },
  suspend: { topic: true,  cmd: (_, t) => `/ds-suspend ${t}` },
  resume:  { topic: true,  cmd: (p, t) => `/ds-resume --suspended ${p} ${t}` },
  reload:  { topic: false, cmd: (p) => `/ds-reload ${p}` },
  update:  { topic: false, cmd: (p) => `/ds-update ${p}` },
  start:   { topic: false, cmd: (_, __, ___, brief) => `/ds-start-squad ${brief}` }, // the dialog's start builds its own line (startRequest)
};

// The start dialog's fields (contract of board-start-squad-box U1). An error string, or the clean fields.
const START_ENUMS = { type: ["feature", "testing"], autonomy: ["checkpoints", "lfg"], start: ["plan", "brainstorm", "ask", "investigate", "auto"] } as const;
function startFields(b: any): { error: string } | { framing: string; slug?: string; type?: string; autonomy?: string; start?: string } {
  if (typeof b.text !== "string") return { error: "say what the squad should do: the text is empty" };
  // CRLF and a lone CR become LF; nothing else changes.
  const framing = b.text.replace(/\r\n?/g, "\n");
  if (!framing.trim()) return { error: "say what the squad should do: the text is empty" };
  const bytes = Buffer.byteLength(framing, "utf8");
  if (bytes > BRIEF_MAX) return { error: `the text is ${(bytes / 1024).toFixed(1)} KiB; the limit is 32 KiB` };
  const bad = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.exec(framing);
  if (bad) return { error: `the text has a control character on line ${framing.slice(0, bad.index).split("\n").length}` };
  const out: { framing: string; slug?: string; type?: string; autonomy?: string; start?: string } = { framing };
  if (b.slug != null && b.slug !== "") {
    if (typeof b.slug !== "string" || b.slug.length > 64 || b.slug.startsWith(".") || /[^A-Za-z0-9._-]/.test(b.slug))
      return { error: "topic slug may only use letters, digits, . _ - and must not start with ." };
    out.slug = b.slug;
  }
  for (const k of ["type", "autonomy", "start"] as const) {
    if (b[k] == null || b[k] === "") continue;
    const ok = START_ENUMS[k] as readonly string[];
    if (typeof b[k] !== "string" || !ok.includes(b[k])) return { error: `${k} must be one of ${ok.join(", ")}` };
    out[k] = b[k];
  }
  if (out.start === "auto") delete out.start;
  if (out.start && out.type === "testing") return { error: "a testing squad has no start" };
  return out;
}

async function request(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, action, topic = "", role = "" } = pr.b;
  const isStart = action === "start" && Object.hasOwn(ACTIONS, action);
  const brief = isStart ? "" : oneLine(pr.b.text);
  if (!NAME.test(project ?? "")) return json(400, { error: "need project" });
  const a = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined; // not "constructor" etc.
  if (!a) return json(400, { error: `unknown action ${action}` });
  if (a.topic ? !NAME.test(topic) : topic !== "") return json(400, { error: a.topic ? "need a topic" : "no topic for this action" });
  if (role !== "" && (action !== "restart" || !NAME.test(role))) return json(400, { error: "bad role" });
  let sf: Exclude<ReturnType<typeof startFields>, { error: string }> | null = null;
  if (isStart) {
    const f = startFields(pr.b);
    if ("error" in f) return json(400, { error: f.error });
    sf = f;
  }
  const line = sf
    ? `board: the operator asks you to run: /ds-start-squad --repo ${project}${sf.slug ? ` --topic ${sf.slug}` : ""}${sf.type ? ` --type ${sf.type}` : ""}${sf.autonomy ? ` --autonomy ${sf.autonomy}` : ""}${sf.start ? ` --start ${sf.start}` : ""}`
    : `board: the operator asks you to run: ${a.cmd(project, topic, role, brief)}`;
  return write((s) => {
    if (sf && !one(s, "SELECT 1 AS x FROM projects WHERE label = ?", project)) no(409, `no project ${project} on this board`);
    if (a.topic) squadRow(s, project, topic);
    if (action === "restart") {
      const targets = s.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND COALESCE(want,'') != 'gone' AND COALESCE(status,'') != 'gone'").all(project, topic) as Row[];
      if (paused(s, { project, squad: topic }) || targets.some((m) => (!role || role === m.role || role === `${m.role}${m.suffix ? "-" + m.suffix : ""}`) && paused(s, m as { project: string })))
        no(409, "work is paused or resuming; use Resume before restarting");
    }
        const stem = `file:${project}/_studio/board-${action}${topic ? "-" + topic : ""}-`;
    // One pending request per action+squad, queued or filed. The rest of a filed name must be just
    // "<n>.txt": squad "ans" must not match squad "ans-2"'s file.
    const filed = s.db.query("SELECT key FROM requests WHERE done_at IS NULL AND substr(key, 1, ?) = ?").all(stem.length, stem) as Row[];
    if (action !== "start" && (pendingReq(s, "studio", project, topic || null, "action", action)
      || filed.some((r) => /^\d+\.txt$/.test(String(r.key).slice(stem.length))))) no(409, "already requested — waiting for the Studio");
    return board(s, "studio", { action, topic: topic || null, line, ...(sf ? { framing: sf.framing } : {}) }, { project, squad: topic || null });
  });
}

async function restart(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, topic, wt, role } = pr.b;
  if (!NAME.test(project ?? "") || !NAME.test(topic ?? "") || typeof wt !== "string" || !wt || wt.length > 1000
    || (role != null && !canRestartRole(role)))
    return json(400, { error: "need project, topic and a member worktree with a supported role" });
  return write((s) => {
    // A done or failed squad is still in use until archived (Restart squad restarts it too), so only a
    // parked or ended one is refused; the page's RestartMember keeps the same list.
    const st = String(squadRow(s, project, topic).status ?? "running");
    if (["suspended", "on-hold", "closed", "gone"].includes(st)) no(409, `this squad is ${st}`);
    const m = one(s, "SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? ORDER BY id DESC", project, topic, wt);
    if (!m || !canRestartRole(m.role) || (role != null && role !== m.role)) no(409, "this member cannot be restarted here");
    if (paused(s, m as { project: string })) no(409, "this member is paused or resuming; use Resume before restarting");
    // U153: the Restart button writes restart_at (mode now, by the board); a pending one reads back.
    if (Number(m.restart_at ?? 0) > Number(m.placed_at ?? 0)) no(409, "already requested — waiting for the loop");
    const w = s.wishOnce(String(m.id), "restart", { by: "board", mode: "now", why: "board restart" });
    return { id: w.row.id } as Row;
  });
}

// poke: wake a squad's quiet Lead by typing into its terminal (an inbox message would sit unread).
async function poke(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, topic } = pr.b;
  if (!NAME.test(project ?? "") || !NAME.test(topic ?? "")) return json(400, { error: "need project and topic" });
  return write((s) => {
    const wt = String(squadRow(s, project, topic).lead_wt ?? "") || no(409, "this squad has no Lead yet");
    if (paused(s, { project, squad: topic, role: "lead", member: wt })) no(409, "the Lead is paused or resuming; use Resume before poking");
    return board(s, "poke", { text: "dev-studio board: the operator pinged you — you went quiet. Check your inbox now and carry on with your work." },
      { project, squad: topic, member: wt });
  });
}

// chat (crew-terminal-access U3): the member a chat names. topic is a squad, or `_studio` for the
// project's Studio; wt is the member's worktree. A string error when the names are malformed or
// outside this board's scope.
const CHAT_MAX = 2000; // as fulfil/chat.ts, which fails a longer one
function chatTarget(project: unknown, topic: unknown, wt: unknown): { project: string; topic: string; wt: string } | { status: number; error: string } {
  if (typeof project !== "string" || !NAME.test(project) || typeof topic !== "string" || (topic !== "_studio" && !NAME.test(topic))
    || typeof wt !== "string" || !wt || wt.length > 1000)
    return { status: 400, error: "need project, topic (a squad or _studio) and the member's worktree" };
  if ((scope.project && scope.project !== project) || (scope.topic && scope.topic !== topic))
    return { status: 403, error: "target is outside this board's scope" };
  return { project, topic, wt };
}

const noMember = (t: { project: string; topic: string; wt: string }) => `no live member ${t.wt} in ${t.project}/${t.topic}`;

// GET /api/chat?project=&topic=&wt=: the member's recent turns (observed_chat) and its last 10 chats.
function chatGet(url: URL) {
  const q = url.searchParams, t = chatTarget(q.get("project"), q.get("topic"), q.get("wt"));
  if ("error" in t) return json(t.status, { error: t.error });
  const r = chatJson(t);
  if (!r) return json(503, NO_DB);
  return "missing" in r ? json(404, { error: noMember(t) }) : json(200, r);
}

// POST /api/chat {project, topic, wt, text}: one `chat` request; the loop types
// `dev-studio board, the operator says: <text>` into the member's own agent terminal once it is ready
// (fulfil/chat.ts). One line only: a newline or control character is refused, never flattened.
async function chatPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const t = chatTarget(pr.b.project, pr.b.topic, pr.b.wt);
  if ("error" in t) return json(t.status, { error: t.error });
  const raw = pr.b.text;
  if (typeof raw !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(raw)) return json(400, { error: "one line of text, no newlines or control characters" });
  const text = raw.trim();
  if (!text) return json(400, { error: "say something" });
  if (Array.from(text).length > CHAT_MAX) return json(400, { error: `at most ${CHAT_MAX} characters` });
  return write((s) => {
    const m = chatMember(s, t.project, t.topic, t.wt) ?? no(404, noMember(t));
    if (t.topic !== "_studio" && paused(s, m as { project: string })) no(409, "this member is paused or resuming; use Resume before chatting");
    return board(s, "chat", { text, via: "board" }, { project: t.project, squad: t.topic, member: t.wt });
  });
}

// GET /api/messages?project=&topic=[&wt=]: U278's read-only View of a member's (or the squad's) message rows.
// A select only: it never marks a message read, delivered or acked.
function messagesGet(url: URL) {
  const q = url.searchParams, project = q.get("project"), topic = q.get("topic"), wt = q.get("wt");
  if (typeof project !== "string" || !NAME.test(project) || typeof topic !== "string" || !SQUAD.test(topic) || (wt != null && (!wt || wt.length > 1000)))
    return json(400, { error: "need project, topic and optionally the member's worktree" });
  if ((scope.project && scope.project !== project) || (scope.topic && scope.topic !== topic)) return json(403, { error: "target is outside this board's scope" });
  const r = messagesJson({ project, topic, ...(wt ? { wt } : {}), ...(q.get("open") === "1" ? { open: true } : {}) });
  if (!r) return json(503, NO_DB);
  return "missing" in r ? json(404, { error: `no live member ${wt} in ${project}/${topic}` }) : json(200, r);
}

// Both interfaces use the lifecycle store: no Studio turn, picker or imperative restart here.
async function activity(req: Request, resume: boolean) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { scope: level, project, topic, wt, role, suffix, prerequisites } = pr.b;
  if (!["project", "squad", "member"].includes(level) || typeof project !== "string" || !NAME.test(project))
    return json(400, { error: "need pause scope and project" });
  const hasMember = wt != null || role != null || suffix != null;
  if ((level === "project" && (topic != null || hasMember)) || (level !== "project" && (typeof topic !== "string" || !NAME.test(topic)))
    || (level === "squad" && hasMember) || (level === "member" && (wt != null ? typeof wt !== "string" || !wt || wt.length > 1000
      : typeof role !== "string" || !NAME.test(role) || (suffix != null && (typeof suffix !== "string" || (suffix !== "" && !NAME.test(suffix)))))))
    return json(400, { error: "identity must match the requested pause scope" });
  const validPrerequisite = (p: any) => {
    if (!p || typeof p.project !== "string" || !NAME.test(p.project)) return false;
    if (p.kind === "unit") return typeof p.squad === "string" && NAME.test(p.squad) && typeof p.slug === "string" && NAME.test(p.slug);
    return p.kind === "pr" && typeof p.ref === "string" && !!p.ref && p.ref.length <= 1000;
  };
  if (prerequisites != null && (resume || level !== "member" || !Array.isArray(prerequisites) || !prerequisites.length || !prerequisites.every(validPrerequisite)))
    return json(400, { error: "dependency wait needs tracked unit or PR references for a member" });
  if ((scope.project && scope.project !== project) || (scope.topic && (level === "project" || scope.topic !== topic)))
    return json(403, { error: "target is outside this board's scope" });
  return write((s) => {
    const target: PauseTarget = { scope: level, project, ...(level !== "project" ? { squad: topic } : {}) };
    if (level === "member") {
      const m = wt != null ? one(s, "SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? ORDER BY id DESC", project, topic, wt)
        : one(s, "SELECT * FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix = ? ORDER BY id DESC", project, topic, role, suffix ?? "");
      if (!m || (role != null && role !== m.role) || (suffix != null && suffix !== String(m.suffix ?? ""))) no(409, "no registered member at that identity");
      const latest = one(s, "SELECT id FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix = ? ORDER BY id DESC", project, topic, String(m.role), String(m.suffix ?? ""));
      if (latest?.id !== m.id) no(409, "member identity changed; refresh the board");
      target.role = String(m.role); target.suffix = String(m.suffix ?? "");
    }
    try {
      const pause = resume ? s.resume(target) : s.pause(target, { source: prerequisites ? "dependency" : "manual", prerequisites: prerequisites as Prerequisite[] | undefined, by: "board" });
      cache.at = 0;
      return json(200, { ok: true, target, pause });
    } catch (e) { no(409, e instanceof Error ? e.message : String(e)); }
  });
}

async function limitsPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, key, value, undo } = pr.b;
  if (!NAME.test(project ?? "")) return json(400, { error: "need project" });
  const shown = limitsJson(project);
  if (!shown) return json(503, NO_DB);
  const row = shown.limits.find((l) => l.key === key);
  if (typeof key !== "string" || !row) return json(400, { error: `unknown limit ${String(key).slice(0, 60)}` });
  if (row.source === "env") return json(409, { error: `${key} is set by env var ${row.env}; unset it there` });
  // U258: Undo puts the key back to what its last change replaced; `undo` is that change's history id.
  if (undo !== undefined) {
    if (!row.changed?.undo || row.changed.id !== undo) return json(409, { error: `${key} changed since this page loaded, or has nothing to undo; reload` });
    return write((s) => board(s, "config-undo", { file: "limits.conf", key, history: row.changed!.id }, { project }));
  }
  let v: string | null = null;
  if (value === null || value === undefined) {
    if (row.source !== "override") return json(409, { error: `${key} has no override to reset` });
  } else {
    v = String(value).trim();
    if (row.fileOnly) return json(400, { error: `${key} is set with \`ds config export --project ${project}\`, an edit and \`ds config import --project ${project} <file>\`, not here` });
    if (key === "review_risk_paths") {
      if (!v || /\s/.test(v) || v.startsWith(",") || v.endsWith(",") || v.includes(",,"))
        return json(400, { error: `${key} must be comma-separated shell globs, or -` });
    } else if (key === "review_skip_lenses") {
      // Same rule as skipLensesProblem (bin/lib/operator.ts): lowercase lens names, never correctness.
      const lenses = v === "-" ? [] : v.split(",");
      if (lenses.some((l) => !/^[a-z][a-z0-9_-]*$/.test(l)))
        return json(400, { error: `${key} must be comma-separated lowercase lens names, or -` });
      if (lenses.some((l) => l.replace(/-reviewer$/, "").replace(/-researcher$/, "") === "correctness"))
        return json(400, { error: `${key} cannot drop correctness: every review runs it` });
    } else if (key === "focus_squad") {
      // squad-priority U2: the squad menu's Make focus sends a squad name; the loop's settings write checks it is a live feature squad.
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(v)) return json(400, { error: `${key} must be a squad name, or - for none` });
    } else if (key === "briefing_time") {
      if (!/^(off|([01][0-9]|2[0-3]):[0-5][0-9])$/.test(v)) return json(400, { error: `${key} must be off or HH:MM, 24h (00:00-23:59)` });
    } else if (key === "briefing_days") {
      const DAY = "(mon|tue|wed|thu|fri|sat|sun)";
      if (!(v === "daily" || new RegExp(`^${DAY}(-${DAY})?(,${DAY}(-${DAY})?)*$`).test(v)))
        return json(400, { error: `${key} must be daily, or comma-separated mon..sun days and ranges like mon-fri, mon,wed,fri` });
    } else if (row.list ? !/^[A-Za-z0-9._,-]{1,200}$/.test(v) : row.allowed ? !row.allowed.includes(v) : !/^\d{1,15}$/.test(v))
      return json(400, { error: row.list ? `${key} must be comma-separated check names, no spaces` : row.allowed ? `${key} must be one of ${row.allowed.join(", ")}` : `${key} must be a whole number, 0 or more` });
  }
  return write((s) => board(s, "limits", { key, value: v }, { project }));
}

// Settings transfer (Import / Export in Settings): the export text, the plan, the apply.
const IMPORT_PICKS_MAX = 2000;
function importSource(b: any, project: string): { src: ImportSource } | { r: Response } {
  const hasText = typeof b.text === "string" && b.text !== "", hasFrom = typeof b.from === "string" && b.from !== "";
  if (hasText === hasFrom) return { r: json(400, { error: "give either text (an export) or from (another project)" }) };
  if (hasFrom) {
    if (!NAME.test(b.from)) return { r: json(400, { error: "bad source project" }) };
    if (b.from === project) return { r: json(400, { error: `'${project}' can't import from itself` }) };
    return { src: { project: b.from } };
  }
  return { src: { text: b.text, name: typeof b.name === "string" ? b.name.slice(0, 60) : undefined } };
}
// A board scoped to one project writes only that one; its reads cover the host.
const importTarget = (b: any): { project: string } | { r: Response } => {
  if (!NAME.test(b.project ?? "")) return { r: json(400, { error: "need project" }) };
  if (scope.project && scope.project !== b.project) return { r: json(403, { error: "project is outside this board's scope" }) };
  return { project: b.project };
};
function settingsExportGet(url: URL) {
  const project = url.searchParams.get("project") ?? "";
  if (!NAME.test(project)) return json(400, { error: "need project" });
  if (!existsSync(dbPath())) return json(503, NO_DB);
  const s = openReadOnly();
  try {
    return new Response(exportTransfer(s, project), { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${project}-settings.txt"`, "Cache-Control": "no-store" } });
  } catch (e) { return json(e instanceof SettingsError ? 400 : 500, { error: e instanceof Error ? e.message : String(e) }); } finally { s.close(); }
}
function settingsImportGet(url: URL) {
  const project = url.searchParams.get("project") ?? "";
  if (!NAME.test(project)) return json(400, { error: "need project" });
  if (!existsSync(dbPath())) return json(503, NO_DB);
  const s = openReadOnly();
  try {
    const rows = s.db.query("SELECT label FROM projects UNION SELECT project FROM config WHERE project <> '' ORDER BY 1").all() as { label: string }[];
    return json(200, { project, projects: rows.map((r) => r.label).filter((l) => l !== project && NAME.test(l) && !isTestProject(l)) });
  } finally { s.close(); }
}
async function settingsImportPreview(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const t = importTarget(pr.b); if ("r" in t) return t.r;
  const so = importSource(pr.b, t.project); if ("r" in so) return so.r;
  if (!existsSync(dbPath())) return json(503, NO_DB);
  const s = openReadOnly();
  try { return json(200, { project: t.project, rows: planImport(s, t.project, so.src, { board: true, replace: pr.b.replace === true }) }); }
  catch (e) { return e instanceof SettingsError ? json(400, { error: e.message }) : json(500, { error: String(e).slice(-500) }); } finally { s.close(); }
}
async function settingsImportPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const t = importTarget(pr.b); if ("r" in t) return t.r;
  const so = importSource(pr.b, t.project); if ("r" in so) return so.r;
  if ("text" in so.src) try { checkExportText(so.src.text); } catch (e) { if (e instanceof SettingsError) return json(400, { error: e.message }); throw e; }
  const { picks } = pr.b;
  if (!Array.isArray(picks) || !picks.length || picks.length > IMPORT_PICKS_MAX) return json(400, { error: `picks needs 1 to ${IMPORT_PICKS_MAX} rows` });
  for (const p of picks)
    if (!p || typeof p.file !== "string" || !(IMPORT_FILES as readonly string[]).includes(p.file) || typeof p.key !== "string" || !p.key || p.key.length > 200
      || (p.expect !== undefined && p.expect !== null && typeof p.expect !== "string")) return json(400, { error: "each pick needs a file, a key and the expected current value" });
  const payload = "project" in so.src ? { from: so.src.project, picks } : { text: so.src.text, ...(so.src.name ? { name: so.src.name } : {}), picks };
  return write((s) => board(s, "settings-import", payload, { project: t.project }));
}

const WORD = /^[A-Za-z0-9._-]{1,64}$/;
const EFFORTS = ["", "minimal", "low", "medium", "high", "xhigh", "max"];
const FALLBACKS = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)?)?(,[A-Za-z0-9._-]+:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)?)?)*$/;

async function rolesPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, role, agent, model, effort, spawn, fallbacks, plan, reset } = pr.b;
  if (!NAME.test(project ?? "")) return json(400, { error: "need project" });
  const shown = rolesJson(project);
  if (!shown) return json(503, NO_DB);
  const row = shown.roles.find((x) => x.role === role);
  if (typeof role !== "string" || !row?.default) return json(400, { error: `unknown role ${String(role).slice(0, 60)}` });
  if (pr.b.undo !== undefined) {
    if (!row.changed?.undo || row.changed.id !== pr.b.undo) return json(409, { error: `${role} changed since this page loaded, or has nothing to undo; reload` });
    return write((s) => board(s, "config-undo", { file: "roles.conf", key: role, history: row.changed!.id }, { project }));
  }
  if (reset === true) {
    if (row.source !== "project") return json(409, { error: `${role} has no project row to reset` });
    return write((s) => board(s, "roles", { role, reset: true }, { project }));
  }
  const bad = (m: string) => json(400, { error: m });
  if (typeof agent !== "string" || !WORD.test(agent)) return bad("agent must be letters, digits, . _ -");
  if (typeof model !== "string" || !WORD.test(model)) return bad("model must be letters, digits, . _ -");
  const eff = effort === undefined || effort === null || effort === "default" ? "" : effort;
  if (typeof eff !== "string" || !EFFORTS.includes(eff)) return bad(`effort must be one of default, ${EFFORTS.slice(1).join(", ")}`);
  if (!["always", "ondemand", "elevate"].includes(spawn)) return bad("spawn must be always, ondemand or elevate");
  const fb = typeof fallbacks === "string" ? fallbacks.replace(/\s+/g, "") : fallbacks ?? "";
  if (typeof fb !== "string" || (fb !== "" && !FALLBACKS.test(fb))) return bad("fallbacks must be agent:model[:effort[:plan]][,agent:model[:effort[:plan]]...]");
  const chosenPlan = plan === undefined ? row.plan : plan === null || plan === "-" ? "" : plan;
  if (typeof chosenPlan !== "string" || (chosenPlan !== "" && !WORD.test(chosenPlan))) return bad("plan must be letters, digits, . _ - or empty for Any");
  return write((s) => board(s, "roles", { role, agent, model, spawn, effort: eff, fallbacks: fb, plan: chosenPlan }, { project }));
}

// skills (U230): a role's skill levels. {set: {<name>: level}} edits, {reset: true} drops the role's
// project rows. A name a shipped `required` rule pins can't change; the fulfiller checks it again.
const SKILL_LEVELS = ["on", "name-only", "user-invocable-only", "off"];
async function skillsPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, role, set, reset } = pr.b;
  if (!NAME.test(project ?? "")) return json(400, { error: "need project" });
  const shown = skillsJson(project);
  if (!shown) return json(503, NO_DB);
  const row = shown.roles.find((x) => x.role === role);
  if (typeof role !== "string" || !row) return json(400, { error: `unknown role ${String(role).slice(0, 60)}` });
  if (reset === true) {
    if (!row.override) return json(409, { error: `${role} has no project edits to reset` });
    return write((s) => board(s, "skills", { role, reset: true }, { project }));
  }
  if (!set || typeof set !== "object" || Array.isArray(set) || !Object.keys(set).length) return json(400, { error: "set needs at least one skill: level" });
  const known = new Map<string, { required: boolean; level: string; reason: string | null }>([["*", { required: false, level: row.other.level, reason: null }],
    ...[...row.skills, ...row.hooks, ...row.mcp].map((x) => [x.name, x] as [string, { required: boolean; level: string; reason: string | null }])]);
  for (const [name, level] of Object.entries(set as Record<string, unknown>)) {
    const k = known.get(name);
    if (!k) return json(400, { error: `unknown skill ${name.slice(0, 80)}` });
    if (typeof level !== "string" || !SKILL_LEVELS.includes(level) || ((name.startsWith("hook:") || name.startsWith("mcp:")) && level !== "on" && level !== "off")) return json(400, { error: `${name}: level must be ${name.startsWith("hook:") || name.startsWith("mcp:") ? "on or off" : SKILL_LEVELS.join(", ")}` });
    if (k.required && level !== k.level) return json(400, { error: `${name} is required for ${role} (${k.reason}); it can't be lowered` });
  }
  return write((s) => board(s, "skills", { role, set }, { project }));
}
// override: one member's model/account "until done" (pick.ts honours it on the next pick and the
// loop clears it once the work is done), or {clear: true} — back to auto.
async function overridePost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, topic, wt, model, account, clear, effort, plan, scope: sc, role: rl } = pr.b;
  // U24: `scope` is member (default, needs the member's worktree), squad, role (`role` names it; default the member's) or project.
  const scope = sc == null || sc === "" ? "member" : sc;
  if (!["member", "squad", "role", "project"].includes(scope)) return json(400, { error: `unknown scope '${String(scope).slice(0, 40)}' (member, squad, role, project)` });
  if (!NAME.test(project ?? "") || (scope === "member" || scope === "squad" ? !NAME.test(topic ?? "") : topic != null && topic !== "" && !NAME.test(topic)) || (scope === "member" || scope === "role" ? typeof wt !== "string" || !wt || wt.length > 1000 : wt != null && (typeof wt !== "string" || wt.length > 1000)))
    return json(400, { error: "need project, topic and the member's worktree" });
  if (rl != null && rl !== "" && (typeof rl !== "string" || !WORD.test(rl))) return json(400, { error: "role must be letters, digits, . _ -" });
  const m = model == null || model === "" ? null : model, ac = account == null || account === "" ? null : account;
  if (clear !== true) {
    if (m === null && ac === null) return json(400, { error: "pick a model or an account (or back to auto)" });
    if ((m !== null && (typeof m !== "string" || !WORD.test(m))) || (ac !== null && (typeof ac !== "string" || ac.length > 200 || /[\x00-\x1f]/.test(ac))))
      return json(400, { error: "model must be letters, digits, . _ -; account one line" });
    for (const v of [effort, plan]) if (v != null && v !== "" && (typeof v !== "string" || !WORD.test(v))) return json(400, { error: "effort and plan must be letters, digits, . _ -" });
    if (ac !== null && plan) return json(400, { error: "a pin names an account or a plan, not both" });
  }
  return write((s) => {
    if (wt && !one(s, "SELECT 1 FROM members WHERE project = ? AND squad = ? AND wt = ?", project, topic, wt)) no(409, `no member ${wt} in ${project}/${topic}`);
    if (clear === true) {
      const target = scope === "squad" ? `${project}/${topic}` : scope === "project" ? project : scope === "role" ? `${project}/${rl || (one(s, "SELECT role FROM members WHERE wt = ?", wt) as { role?: string } | null)?.role || ""}` : wt;
      if (!one(s, "SELECT 1 FROM overrides WHERE member = ? AND COALESCE(scope, 'member') = ? AND cleared_at IS NULL", target, scope)) no(409, scope === "member" ? "this member has no override (already on auto)" : `no ${scope} override to clear`);
    }
    const sp = scope === "member" ? {} : { scope, ...(rl ? { role: rl } : {}) };
    return board(s, "override", clear === true ? { clear: true, ...sp } : { model: m, account: ac, effort: effort || null, plan: plan || null, ...sp }, { project, squad: topic || null, member: wt || null });
  });
}

// account: the operator's on/off switch for one account, host-wide (an `account` request; the loop's
// fulfiller calls accounts.ts setAccountEnabled, as `ds account` does).
async function accountPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, agent, account, enabled } = pr.b;
  const line = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
  if (!NAME.test(project ?? "") || !WORD.test(agent ?? "") || !line(account) || account === "-" || typeof enabled !== "boolean")
    return json(400, { error: "need project, agent, account and enabled (true or false)" });
  return write((s) => {
    if (!one(s, "SELECT 1 FROM observed_accounts WHERE agent = ? AND account = ? UNION SELECT 1 FROM accounts WHERE agent = ? AND account = ?", agent, account, agent, account))
      no(409, `no account ${agent}:${account}`);
    return board(s, "account", { agent, account, enabled }, { project });
  });
}

// account-reset (account-free-resets U4): the Use button on one free reset grant. Only a grant the
// account's stored resets (observed_accounts.resets) list as usable now, and only while no press of that
// account is still open: a double click or a second tab files nothing. The server makes the press's
// idempotency key; the loop's fulfiller passes it on every try, so a retry is the same claim.
async function accountResetPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, agent, account, grant } = pr.b;
  const line = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
  if (!NAME.test(project ?? "") || !WORD.test(agent ?? "") || !line(account) || account === "-" || !line(grant))
    return json(400, { error: "need project, agent, account and grant" });
  return write((s) => {
    const row = one(s, "SELECT resets FROM observed_accounts WHERE agent = ? AND account = ?", agent, account) ?? no(400, `no account ${agent}:${account}`);
    let doc: any = null;
    try { doc = JSON.parse(String(row!.resets ?? "")); } catch { /* no resets read: no grant */ }
    const g = doc?.state === "reported" && Array.isArray(doc.grants) ? doc.grants.find((x: any) => x && x.id === grant) : undefined;
    if (!g) no(400, `${agent}:${account} has no grant ${grant}`);
    if (g.usable_now !== true) no(400, `grant ${grant} of ${agent}:${account} is not usable now`);
    const open = one(s, "SELECT id FROM requests WHERE kind = 'account-reset' AND done_at IS NULL AND json_extract(payload, '$.agent') = ? AND json_extract(payload, '$.account') = ?", agent, account);
    if (open) no(409, `a reset of ${agent}:${account} is already in progress (request #${open.id})`);
    const row2 = board(s, "account-reset", { agent, account, grant, key: crypto.randomUUID() }, { project });
    // U7: a paused or pausing project holds the request until Resume; say so in the answer.
    return paused(s, { project }) ? json(202, { ok: true, id: Number(row2.id), queued: true }) : row2;
  });
}

// unit: the ⋯ menu on a Work units row (squad-done-definition U5). One `unit-action` request; the loop's
// fulfiller (fulfil/unit-action.ts) runs cancel-unit for the unit and its open dependents, or resumes
// the squad and tells the Lead to release the unit. Cancel needs a reason; a done or cancelled unit
// cannot be cancelled; only a held unit can be released.
async function unitPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, topic, slug, action } = pr.b;
  const why = oneLine(pr.b.why);
  if (!NAME.test(project ?? "") || !NAME.test(topic ?? "") || !NAME.test(slug ?? "")) return json(400, { error: "need project, topic and slug" });
  if (action !== "release" && action !== "cancel") return json(400, { error: "action is release or cancel" });
  if (why.length > 500) return json(400, { error: "reason is longer than 500 characters" });
  if (action === "cancel" && !why) return json(400, { error: "say why the unit is cancelled" });
  return write((s) => {
    squadRow(s, project, topic);
    const u = one(s, "SELECT status, hold FROM units WHERE project = ? AND squad = ? AND slug = ?", project, topic, slug) ?? no(409, `no unit ${slug} in ${project}/${topic}`);
    const st = String(u.status ?? "planned");
    if (st === "done" || st === "cancelled") no(409, `unit ${slug} is ${st}`);
    if (action === "release" && !u.hold) no(409, `unit ${slug} is not held`);
    if (one(s, "SELECT id FROM requests WHERE kind = 'unit-action' AND project = ? AND squad IS ? AND done_at IS NULL AND json_extract(payload, '$.slug') = ?", project, topic, slug))
      no(409, "already requested — waiting for the loop");
    return board(s, "unit-action", { action, slug, ...(why ? { why } : {}) }, { project, squad: topic });
  });
}

// plan: "Take back approval" on the squad's Plans list (hold-cancels-queue-undo-approval U3). One `plan-revoke`
// request; the loop's fulfiller (fulfil/plan-revoke.ts) runs squad-state revoke-plan. The plan must be one of
// this squad's plan files and still approved; one request may wait per plan; a reason is required.
async function planPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, topic, plan } = pr.b;
  const why = oneLine(pr.b.why);
  if (!NAME.test(project ?? "") || !NAME.test(topic ?? "") || typeof plan !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*-plan\.md$/.test(plan) || plan.length > 200)
    return json(400, { error: "need project, topic and a plan file name" });
  if (!why) return json(400, { error: "say why the approval is taken back" });
  if (why.length > 500) return json(400, { error: "reason is longer than 500 characters" });
  if (pr.b.keep_started !== undefined && typeof pr.b.keep_started !== "boolean") return json(400, { error: "keep_started is true or false" });
  return write((s) => {
    squadRow(s, project, topic);
    if (!plan.startsWith(topic + "-")) no(409, `${plan} is not a plan of ${project}/${topic}`);
    let doc: any = {};
    try { doc = squadDoc(s, project, topic) ?? {}; } catch { /* a doc that won't parse reads as no approvals */ }
    if (!approvedPlans(s.root, doc.approved_plans, join(s.root, project, "squads", plan))) no(409, `${plan} is not approved`);
    if (one(s, "SELECT id FROM requests WHERE kind = 'plan-revoke' AND project = ? AND squad IS ? AND done_at IS NULL AND json_extract(payload, '$.plan') = ?", project, topic, plan))
      no(409, "already requested — waiting for the loop");
    return board(s, "plan-revoke", { plan, why, ...(pr.b.keep_started ? { keep_started: true } : {}) }, { project, squad: topic });
  });
}

async function answer(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, topic, id } = pr.b;
  const ans = oneLine(pr.b.answer);
  if (!NAME.test(project ?? "") || (topic !== "_studio" && !NAME.test(topic ?? "")) || typeof id !== "string" || !id || id.length > 200)
    return json(400, { error: "need project, topic and id" });
  // A Studio alert asks nothing: it dismisses with one click, even with an empty answer.
  // An agent question still needs an answer.
  if (ans.length > 4000 || (topic !== "_studio" && !ans)) return json(400, { error: "answer is empty or longer than 4000 characters" });
  return write((s) => {
    // A Studio alert (topic _studio) belongs to the project: answering dismisses it, no agent is typed into.
    if (topic === "_studio") {
      if (!one(s, "SELECT 1 FROM observed_alerts WHERE project = ? AND id = ?", project, id) || pendingReq(s, "dismiss", project, null, "id", id))
        no(409, `alert ${id} is not open (already dismissed?)`);
      // U264: the answer goes along; only the card's own suggestion ("move it") approves a Studio move.
      return board(s, "dismiss", { id, ...(ans ? { answer: ans } : {}) }, { project });
    }
    const st = squadRow(s, project, topic);
    const q = one(s, "SELECT * FROM questions WHERE project = ? AND squad = ? AND id = ? AND status = 'open' ORDER BY seq DESC LIMIT 1", project, topic, id)
      ?? no(409, `question ${id} is not open (already answered?)`);
    let e: any = {};
    try { e = JSON.parse(String(q.doc ?? "{}")) ?? {}; } catch { /* a bare row */ }
    const picker = e.source === "picker";
    // Only a one-question, single-select picker maps onto one keystroke answer.
    if (picker && e.picker_answerable !== true) no(409, "answer it in the terminal");
    // Keys typed after the picker closed would land in the agent's prompt: the state observer's mirror
    // must say it is open (the answer fulfiller checks the transcript again before each key).
    if (picker) {
      let closed: unknown = null;
      try { closed = JSON.parse(String(one(s, "SELECT doc FROM observed_pickers WHERE project = ? AND squad = ? AND id = ?", project, topic, id)?.doc ?? "{}"))?.closed ?? null; } catch { /* unreadable */ }
      if (closed !== false) no(409, closed ? "that picker is already closed" : "can't tell whether the picker is still open — answer it in the terminal");
    }
    // A picker lives only in its asker's terminal.
    const wt = String((picker ? q.card_wt : q.card_wt || st.lead_wt) ?? "") || no(409, "no agent to send it to (no card or Lead worktree)");
    // Answered here and now: the question leaves the board at once, and a second send finds it closed.
    answerQuestion(s, project, topic, id, ans, "board");
    const choices = picker ? (() => { try { return JSON.parse(String(q.choices ?? "[]")); } catch { return []; } })() : undefined;
    const pick = picker ? { choices, transcript: e.transcript_path, tool_use_id: e.tool_use_id } : {};
    return board(s, "answer", { id, answer: ans, seq: q.seq, card_wt: q.card_wt ?? undefined, via: "board", ...pick }, { project, squad: topic, member: wt });
  });
}

// --- read routes (GET) ---------------------------------------------------------------------------
// loop.db only (bin/board/board-data.ts, read-only per request): no command, no state file. The one file
// read is the page itself; GET /lavish/<key> may file a `lavish` request (a write, through write()).

// The page's fingerprint (U7): a hash of web/board.html, read per call (the file is small; a `git pull` that changes it
// changes the fingerprint at once). It rides in the served page (<meta name="page-version">) and in /board.json
// (`page_version`), so an open tab sees that the server's page code moved and offers a reload.
const readPage = () => readFileSync(page).toString(); // the one file this server reads
function pageVersion(): string {
  try { return createHash("sha1").update(readPage()).digest("hex").slice(0, 12); } catch { return ""; }
}
function withPageVersion(html: string): string {
  const meta = `<meta name="page-version" content="${pageVersion()}">`;
  return html.includes("</head>") ? html.replace("</head>", `${meta}</head>`) : meta + html;
}
function withVersionField(body: string): string { return body.endsWith("}") ? `${body.slice(0, -1)},"page_version":"${pageVersion()}"}` : body; }

let cache = { at: 0, status: 0, body: "" };
function render() {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  try { cache = { at: Date.now(), status: 200, body: JSON.stringify(buildBoard(scope.project, scope.topic)) }; }
  catch (e) { cache = { at: Date.now(), status: 500, body: JSON.stringify({ error: String(e).slice(-2000) }) }; }
  return cache;
}

function limitsGet(url: URL) {
  const project = url.searchParams.get("project") ?? "";
  if (!NAME.test(project)) return json(400, { error: "need project" });
  const r = limitsJson(project);
  return r ? json(200, r) : json(503, NO_DB);
}

function briefingGet(url: URL) {
  const project = url.searchParams.get("project") ?? "", date = url.searchParams.get("date") ?? "";
  if (!NAME.test(project)) return json(400, { error: "need project" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: "date must be YYYY-MM-DD" });
  const b = briefingJson(project, date);
  if (b === null) return json(404, { error: `no brief for ${date}` });
  return json(200, { project, date, markdown: b.markdown, prs: b.prs });
}

function skillsGet(url: URL) {
  const project = url.searchParams.get("project") ?? "";
  if (!NAME.test(project)) return json(400, { error: "need project" });
  const r = skillsJson(project);
  return r ? json(200, r) : json(503, NO_DB);
}
function rolesGet(url: URL) {
  const project = url.searchParams.get("project") ?? "";
  if (!NAME.test(project)) return json(400, { error: "need project" });
  const r = rolesJson(project);
  return r ? json(200, r) : json(503, NO_DB);
}

// GET /api/events: one page of the event log (the parameters are in the header). `sev` keeps one
// colour, `kind` one kind, `cat` one category; `squad` takes `_studio`, `member` needs `squad`; `q` is
// search text (an empty one is no search).
const KIND = /^[a-z0-9_-]{1,40}$/;
// The project a request names: the board's own, or any on a host-wide board; 403 outside the scope.
function eventsProject(q: URLSearchParams): { project: string } | { r: Response } {
  const project = q.get("project");
  if (project == null || project === "") return { project: scope.project };
  if (!NAME.test(project)) return { r: json(400, { error: "bad project" }) };
  if (scope.project && scope.project !== project) return { r: json(403, { error: "project is outside this board's scope" }) };
  return { project };
}
function eventsGet(url: URL) {
  const q = url.searchParams;
  const squad = q.get("squad") ?? "", hide = (q.get("hide") ?? "").split(",").filter(Boolean);
  const sev = q.get("sev") ?? "", kind = q.get("kind") ?? "", cat = q.get("cat") ?? "", member = q.get("member");
  const flag = (k: string, v: string) => q.get(k) == null || q.get(k) === v;
  if (squad && !SQUAD.test(squad)) return json(400, { error: "bad squad" });
  if (!flag("nosquad", "1")) return json(400, { error: "bad nosquad: 1 only" });
  if (squad && q.get("nosquad")) return json(400, { error: "squad and nosquad exclude each other" });
  if (member != null && (!member || member.length > 1000 || /[\x00-\x1f\x7f-\x9f]/.test(member))) return json(400, { error: "bad member" });
  if (member != null && !squad) return json(400, { error: "member needs squad" });
  if (hide.some((k) => !KIND.test(k))) return json(400, { error: "bad hide" });
  if (sev && !["bad", "wait", "ok"].includes(sev)) return json(400, { error: "bad sev" });
  if (kind && !KIND.test(kind)) return json(400, { error: "bad kind" });
  if (cat && !isCat(cat)) return json(400, { error: "bad cat" });
  if (!flag("noise", "hide")) return json(400, { error: "bad noise: hide only" });
  if (!flag("lists", "0")) return json(400, { error: "bad lists: 0 only" });
  for (const k of ["before", "after", "until", "limit"]) if (q.get(k) != null && intParam(q, k) == null) return json(400, { error: `bad ${k}` });
  if (q.get("until") != null && q.get("after") != null) return json(400, { error: "until and after exclude each other" });
  const text = q.get("q") ?? "";
  if (text.length > 100 || /[\x00-\x1f\x7f-\x9f]/.test(text)) return json(400, { error: "bad q: 1-100 characters, no control characters" });
  if (text && q.get("after") != null) return json(400, { error: "q and after exclude each other: a search pages back with before" });
  const p = eventsProject(q);
  if ("r" in p) return p.r;
  const r = eventsPage({
    project: p.project, squad, nosquad: q.get("nosquad") === "1", ...(member != null ? { member } : {}), cat, noise: q.get("noise") === "hide",
    before: intParam(q, "before"), after: intParam(q, "after"), until: intParam(q, "until"), limit: intParam(q, "limit") ?? 50,
    hide, sev, kind, lists: q.get("lists") !== "0", ...(text ? { q: text } : {}),
  });
  return r ? json(200, r) : json(503, NO_DB);
}

// GET /api/events/lists[?project=<label>][&squad=<slug>]: the pickers' squads (live/closed), the
// picked squad's crew, the categories, the kinds and the noise kinds.
function eventsListsGet(url: URL) {
  const q = url.searchParams, squad = q.get("squad") ?? "";
  if (squad && !SQUAD.test(squad)) return json(400, { error: "bad squad" });
  const p = eventsProject(q);
  if ("r" in p) return p.r;
  const r = eventsLists({ project: p.project, ...(squad ? { squad } : {}) });
  return r ? json(200, r) : json(503, NO_DB);
}

// GET /api/questions?squad=<slug>&status=answered&before=<seq>&limit=<n>: a squad's past answers.
function questionsGet(url: URL) {
  const q = url.searchParams;
  const squad = q.get("squad") ?? "", project = q.get("project") || scope.project;
  if (!NAME.test(squad) || !NAME.test(project)) return json(400, { error: "need squad (and project on a host-wide board)" });
  if ((q.get("status") ?? "answered") !== "answered") return json(400, { error: "status: answered only" });
  const r = questionsPage({ project, squad, before: intParam(q, "before"), limit: intParam(q, "limit") ?? 50 });
  return r ? json(200, r) : json(503, NO_DB);
}

// GET /api/stream?after=<id>: the event log as server-sent events (one `data:` per events row, its id
// the event id, so a reconnecting EventSource resumes after Last-Event-ID). Polls loop.db each second;
// a comment line every 5 s keeps the connection (and Bun's idle timer) alive.
function stream(req: Request, url: URL) {
  const from = req.headers.get("Last-Event-ID") ?? url.searchParams.get("after") ?? "";
  let after = /^\d+$/.test(from) ? Number(from) : eventsAfter(scope.project, null, 0)?.last ?? 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      let ticks = 0;
      const send = (s: string) => { try { c.enqueue(enc.encode(s)); } catch { clearInterval(timer); } };
      const poll = () => {
        for (let more = true; more;) {
          const evs = eventsAfter(scope.project, after, 200)?.events ?? [];
          for (const e of evs) { send(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`); after = Number(e.id); }
          more = evs.length === 200;
        }
        if (++ticks % 5 === 0) send(": keepalive\n\n");
      };
      send("retry: 3000\n\n");
      poll();
      timer = setInterval(poll, 1000);
    },
    cancel() { clearInterval(timer); },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
}

// A page that reloads itself until Lavish answers (the loop starts it on its next tick).
const waitPage = (why: string) => new Response(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>Starting Lavish</title><body style="font:15px system-ui;margin:2em">Lavish is starting (${why}); this page reloads until it is up.</body>`,
  { status: 202, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

// GET /lavish/<key> -> 302 to that Lavish review page; when Lavish is down, one `lavish` request.
async function lavish(key: string) {
  if (!/^[0-9a-f]{16}$/.test(key)) return text(404, "not found\n");
  const url = lavishUrl(key) ?? "";
  if (!/^https?:\/\//.test(url)) return text(404, "no such Lavish session\n");
  const port = new URL(url).port || "80";
  if (await lavishUp(port)) return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
  let id = 0;
  const r = write((s) => {
    const open = one(s, "SELECT * FROM requests WHERE kind = 'lavish' AND done_at IS NULL ORDER BY id LIMIT 1");
    const row = open ?? board(s, "lavish", { port: Number(port) }, { project: scope.project || "" });
    id = Number(row.id);
    return row;
  });
  return r.status === 202 ? waitPage(`request ${id}`) : r;
}

async function get(req: Request, url: URL) {
  if (url.pathname === "/api/stream") return stream(req, url);
  const path = url.pathname;
  if (path === "/api/limits") return limitsGet(url);
  if (path === "/api/roles") return rolesGet(url);
  if (path === "/api/skills") return skillsGet(url);
  if (path === "/api/settings-export") return settingsExportGet(url);
  if (path === "/api/settings-import") return settingsImportGet(url);
  if (path === "/api/briefing") return briefingGet(url);
  if (path === "/api/events") return eventsGet(url);
  if (path === "/api/events/lists") return eventsListsGet(url);
  if (path === "/api/chat") return chatGet(url);
  if (path === "/api/messages") return messagesGet(url);
  if (path === "/api/questions") return questionsGet(url);
  if (path === "/") {
    // Read per request: a `git pull` that changes the page applies on the next reload.
    try { return new Response(withPageVersion(readPage()), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }); }
    catch (e) { return text(500, `board page unreadable: ${e}\n`); }
  }
  if (path === "/board.json") { const r = render(); return json(r.status, r.status === 200 ? withVersionField(r.body) : r.body); }
  // The loop's liveness ping (U16): cheap, no db read, so a slow render is never a dead board.
  if (path === "/healthz") return json(200, { ok: true, pid: process.pid, port });
  if (path.startsWith("/lavish/")) return lavish(path.slice(8));
  return text(404, "not found\n");
}
// --- end of read routes ---------------------------------------------------------------------------

const POSTS: Record<string, (req: Request) => Promise<Response>> = {
  "/api/pause": (r) => activity(r, false), "/api/resume": (r) => activity(r, true),
  "/api/restart": restart, "/api/answer": answer, "/api/poke": poke, "/api/request": request, "/api/override": overridePost, "/api/account": accountPost, "/api/account-reset": accountResetPost, "/api/unit": unitPost, "/api/plan": planPost,
  "/api/settings-import/preview": settingsImportPreview,
};

async function handle(req: Request) {
  if (!hosts.has(hostName(req.headers.get("Host")))) return text(403, "forbidden host\n");
  const path = new URL(req.url).pathname;
  if (Object.hasOwn(POSTS, path)) return req.method === "POST" ? POSTS[path](req) : text(405, "POST only\n");
  // These paths are GET routes too (the read block), so they are not in POSTS.
  if (path === "/api/limits" && req.method === "POST") return limitsPost(req);
  if (path === "/api/roles" && req.method === "POST") return rolesPost(req);
  if (path === "/api/skills" && req.method === "POST") return skillsPost(req);
  if (path === "/api/settings-import" && req.method === "POST") return settingsImportPost(req);
  if (path === "/api/chat" && req.method === "POST") return chatPost(req);
  if (req.method !== "GET" && req.method !== "HEAD") return text(405, "GET only\n");
  return get(req, new URL(req.url));
}

// One listener per address (e.g. 127.0.0.1 and the tailnet IP). Retry a few seconds (30 tries,
// DS_BOARD_BIND_TRIES): a just-replaced server may still be releasing the port.
const bindTries = Math.max(1, Number(process.env.DS_BOARD_BIND_TRIES) || 30);
for (const hostname of bindArg.split(/\s+/).filter(Boolean)) {
  for (let i = 0; ; i++) {
    try { Bun.serve({ hostname, port, fetch: handle, maxRequestBodySize: MAX_BODY, idleTimeout: 30 }); break; }
    catch (e) {
      if (i >= bindTries - 1) { console.error(`board (serve): could not bind ${hostname}:${port} — ${e}`); process.exit(1); }
      await Bun.sleep(200);
    }
  }
}
// board.sh waits for this before it says "listening".
if (process.env.DS_READY_FILE) writeFileSync(process.env.DS_READY_FILE, "");
// The page (web/board.html) is re-read per request, but every .ts file this server imports loads ONCE
// (static imports): this file's routes, board-data.ts, and the loop modules under bin/loop/. A
// `git pull` that changes any of them would leave the new page talking to old code. So record the mtime
// of each such file at start (bin/board/ and bin/loop/, not *.test.ts, not fakes/) and exit 75 when any
// differs or is gone; the loop (or board.sh --serve-fg) then runs the new code. The new server records
// the new mtimes, so one pull restarts it once.
function codeFiles(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: dir, followSymlinks: true })) {
      if (!rel.endsWith(".test.ts") && !/(^|\/)(fakes|node_modules)\//.test(rel)) out.push(join(dir, rel));
    }
  } catch { /* no such dir */ }
  return out;
}
const watched = new Map<string, number>();
for (const f of [import.meta.path, ...codeFiles(dirname(import.meta.path)), ...codeFiles(join(dirname(import.meta.path), "..", "loop"))]) {
  const m = statSync(f, { throwIfNoEntry: false })?.mtimeMs;
  if (m !== undefined) watched.set(f, m);
}
setInterval(() => {
  for (const [f, born] of watched) {
    try {
      if (statSync(f).mtimeMs !== born) { console.error(`board (serve): server code changed (${f}) — restarting`); process.exit(75); }
    } catch { console.error(`board (serve): server code changed (${f}) — restarting`); process.exit(75); }
  }
}, 2000);
