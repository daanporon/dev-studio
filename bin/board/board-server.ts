// board-server.ts — the web board server the loop runs (`board.sh --serve` wishes for it; U16) (Bun).
//
//   bun board-server.ts <binds> <port> <page.html> <board-cmd...>
//
// Answers only requests whose Host names this machine (DS_BOARD_HOSTS, space-separated names/IPs,
// set by board.sh); any other Host gets 403, so a web page can't read the board via DNS rebinding.
// The server only talks to loop.db: it never runs a command and never reads a state or conf file
// (the page file is the one file read; the one folder it writes and serves is a project's chat images,
// `<state root>/<label>/chat-files/<topic>/`). Reads open loop.db read-only per request; a write is one
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
//   GET /api/chat-file?project=<label>&topic=<slug|_studio|_start>&name=<sha16>.<ext>   one stored chat image (and HEAD),
//                              nosniff, a no-script CSP, cached a day (the name is a content hash); no member check
//   GET /healthz               {ok, pid, port}: the loop's ping (the loop runs this server, U16)
//   GET /page/<label>/pages/<topic>/<path>   one saved copy of a review page (sandboxed, read-only; saved-pages.ts)
//   GET /lavish/<key>          302 to that Lavish review page; when Lavish is down, a `lavish`
//                              request and a page that reloads until it is up
// Writes (POST, JSON, same-origin), each a `requests` row unless said otherwise:
//   /api/request  {project, action, topic?, role?, text?}  `studio`: the loop files the one-line
//                 request for the Studio ("board: the operator asks you to run: /ds-…"); a start may add
//                 `files`, up to 8 images uploaded to topic `_start` (a gone one is 409)
//   /api/answer   {project, topic, id, answer, since?}  the questions row answered via `board` and an
//                 `answer` row: the loop types it into the asker's terminal (the card's worktree,
//                 else the Lead; a picker by keystroke). A Studio alert (topic _studio): `dismiss`,
//                 even with an empty answer (one click); agent questions still need one.
//   /api/restart  {project, topic, wt, role?}  a `restart_at` wish (mode now, by the board; U153)
//   /api/pause, /api/resume {scope, project, topic?, wt?, role?, suffix?, prerequisites?}
//                 shared activity state, answered 200; the loop owns checkpoint/close/start
//   /api/poke     {project, topic}  `poke`: a wake-up line typed into a quiet Lead's terminal
//   GET /api/feedback, POST /api/feedback {action: post|add-to|edit|dismiss|restore, draft|note, …}  the Feedback panel (U4)
//   /api/keys     {project, topic, wt, keys}  `keys`: 1-8 named keys pressed in the member's terminal, even while it works (409: paused, or a press still open)
//   /api/chat-dismiss  {project, id}  `chat-dismiss` of a failed or cancelled send: it leaves the chat (409: still queued or sent)
//   /api/chat-cancel, /api/chat-now  {project, id}  `chat-cancel`/`chat-now` of an open chat request (409: already typed)
//   /api/chat     {project, topic, wt, text, files?}  `chat`: a message of at most 2000 characters, line breaks and
//                 tabs allowed (CR LF read as LF; no other control character, U19) the loop types into that live, unpaused member's terminal once it is ready;
//                 `files` names up to 4 stored chat images (text may then be empty; a gone one is 409)
//   /api/chat-file?project=&topic=&wt=  the raw bytes of one PNG/JPEG/WebP/GIF (Content-Type the image's, at
//                 most 5 MiB, magic bytes checked) for a live member (topic `_start` and no wt: for a squad
//                 start, in a project the loop knows), stored once as
//                 `<state root>/<label>/chat-files/<topic>/<sha256[:16]>.<ext>` (0600), answered 200 {id, url, bytes};
//                 each upload first prunes the project's images older than chat_files_keep_d days (500 MiB cap: 507).
//                 The only route a body over 128 KiB may reach.
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
//   /api/leftover-remove {project, topic, wt, fingerprint?}  `leftover-remove`: a Leftovers box's Remove (404 for no such
//                 leftover, 409 with one open for it); the loop removes a safe tree, a look-first one only saved and
//                 with the fingerprint the operator saw (archive-leftovers U4)
//   /api/override {project, topic, wt, scope?(member|squad|role|project), role?, model?, effort?, plan?, account? | clear:true}  `override`: this member's
//                 model/account "until done", or back to auto
// Everything else is 404, so no state file is ever reachable.
import { createHash } from "node:crypto";
import { closeSync, constants as fsc, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { briefingJson, buildBoard, chatJson, feedbackJson, chatMember, messagesJson, dsLabel, eventsAfter, eventsLists, eventsPage, lavishUrl, limitsJson, questionsPage, rolesJson } from "./board-data.ts";
import { isTestProject } from "../loop/settings/projects.ts";
import { BACKEND_NAMES, DEFAULT_BACKEND, isBackend, squadBackendRule } from "../backend/registry.ts";
import { projectStudioBackend } from "../loop/squad/studio.ts";
import { limit } from "../loop/settings/limits.ts";
import { chatProblem } from "../loop/chat/limits.ts";
import { CHAT_FILE_NAME, CHAT_FILES_MAX, START_FILES_MAX, START_TOPIC, chatFileDir } from "../loop/chat/files.ts";
import { isCat } from "./event-cats.ts";
import { KEYS, KEYS_MAX, keyOk } from "../loop/chat/keys.ts";
import { approvedPlans } from "../loop/squad/plan-approved.ts";
import { squadDoc } from "../loop/db/export-json.ts";
import { skillsJson } from "./skills-data.ts";
import { lavishUp } from "../loop/io/lavish-up.ts";
import { servePage } from "./saved-pages.ts";
import { answer as answerQuestion } from "../loop/messages/questions.ts";
import { dbPath, open, openReadOnly, stateRoot, type Row, type Store } from "../loop/core/store.ts";
import { checkExportText, exportTransfer, IMPORT_FILES, planImport, readGet, SettingsError, type ImportSource } from "../loop/settings/settings.ts";
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

// sameOrigin: the request's Origin names this board's own Host (a missing or bad Origin is not).
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  let oh = "";
  try { oh = origin ? new URL(origin).host.toLowerCase() : ""; } catch { /* bad Origin: refused */ }
  return !!oh && oh === (req.headers.get("Host") || "").toLowerCase();
}
// readPost: the CSRF checks every POST shares — only this board's own page may post: same-origin,
// and JSON (a plain form can't send that). Returns the parsed body, or the refusal to send back.
async function readPost(req: Request): Promise<{ b: any } | { r: Response }> {
  if (!sameOrigin(req)) return { r: text(403, "forbidden origin\n") };
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
  update:  { topic: false, cmd: (p) => `/ds-update ${p}` },
  start:   { topic: false, cmd: (_, __, ___, brief) => `/ds-start-squad ${brief}` }, // the dialog's start builds its own line (startRequest)
};

// restart, suspend, resume and reload are the loop's own wishes: the board writes them in the request's
// transaction (`by: "board"`, as the per-member Restart does), nothing goes through the Studio.
const WISH_ACTIONS: Record<string, { topic: boolean }> = { restart: { topic: true }, suspend: { topic: true }, resume: { topic: true }, reload: { topic: false } };
const LOOP_WAIT = "already requested — waiting for the loop";
const pendingMember = (m: Row, kind: "restart" | "reload") => kind === "restart"
  ? Number(m.restart_at ?? 0) > Number(m.placed_at ?? 0)
  : m.reload_at != null && Number(m.reload_at) > Number(m.reloaded_at ?? 0);
// Newest row per (squad, role, suffix), as a Restart / Reload of the squad picks it.
const newestPerRole = (rows: Row[]) => {
  const seen = new Map<string, Row>();
  for (const m of rows) { const k = `${m.squad}/${m.role}/${m.suffix ?? ""}`; if (!seen.has(k) || Number(m.id) > Number(seen.get(k)!.id)) seen.set(k, m); }
  return [...seen.values()];
};
function wishAction(s: Store, project: string, action: string, topic: string, role: string): Response {
  const why = `board ${action}`;
  if (pendingReq(s, "studio", project, topic || null, "action", action)) no(409, "already requested — waiting for the Studio");
  const ok = (wishes: number) => json(202, { ok: true, action, wishes });
  const live = "COALESCE(want,'') != 'gone' AND COALESCE(status,'') != 'gone'";
  if (action === "reload") {
    const rows = s.db.query(`SELECT m.* FROM members m JOIN squads q ON q.project = m.project AND q.topic = m.squad
      WHERE m.project = ? AND m.squad != '_studio' AND COALESCE(m.want,'') != 'gone' AND COALESCE(m.status,'') != 'gone'
        AND COALESCE(q.status,'') != 'suspended' AND COALESCE(q.run_id,'') != ''`).all(project) as Row[];
    const studio = one(s, `SELECT * FROM members WHERE project = ? AND squad = '_studio' AND role = 'studio' AND suffix = '' AND ${live} ORDER BY id DESC LIMIT 1`, project);
    const targets = [...newestPerRole(rows), ...(studio ? [studio] : [])];
    if (!targets.length) no(409, "nothing to reload");
    const todo = targets.filter((m) => !pendingMember(m, "reload"));
    if (!todo.length) no(409, LOOP_WAIT);
    for (const m of todo) s.wishOnce(String(m.id), "reload", { by: "board", why });
    return ok(todo.length);
  }
  const q = squadRow(s, project, topic);
  const st = String(q.status ?? "running");
  if (action === "restart") {
    if (["suspended", "on-hold", "closed", "gone"].includes(st)) no(409, `this squad is ${st}`);
    const all = s.db.query(`SELECT * FROM members WHERE project = ? AND squad = ? AND ${live}`).all(project, topic) as Row[];
    if (paused(s, { project, squad: topic }) || all.some((m) => (!role || role === m.role || role === `${m.role}${m.suffix ? "-" + m.suffix : ""}`) && paused(s, m as { project: string })))
      no(409, "work is paused or resuming; use Resume before restarting");
    const targets = newestPerRole(all).filter((m) => canRestartRole(String(m.role))
      && (!role || role === m.role || role === `${m.role}${m.suffix ? "-" + m.suffix : ""}`));
    if (!targets.length) no(409, "no member of this squad can be restarted here");
    const todo = targets.filter((m) => !pendingMember(m, "restart"));
    if (!todo.length) no(409, LOOP_WAIT);
    for (const m of todo) s.wishOnce(String(m.id), "restart", { by: "board", mode: "now", why });
    return ok(todo.length);
  }
  if (action === "suspend") {
    if (["closed", "gone"].includes(st)) no(409, `this squad is ${st}`);
    if (st === "suspended") no(409, "this squad is already suspended");
    if (q.want === "suspended") no(409, "already suspending");
    s.want("squad", `${project}/${topic}`, "suspended", { by: "board", why });
    return ok(1);
  }
  if (st !== "suspended") no(409, "this squad is not suspended");
  if (q.want === "running") no(409, "already resuming");
  s.want("squad", `${project}/${topic}`, "running", { by: "board", why });
  return ok(1);
}

// The start dialog's fields (contract of board-start-squad-box U1). An error string, or the clean fields.
const START_ENUMS = { type: ["feature", "testing"], autonomy: ["checkpoints", "lfg"], start: ["plan", "brainstorm", "ask", "investigate", "fix", "auto"], backend: BACKEND_NAMES } as const;
type StartFields = { framing: string; slug?: string; type?: string; autonomy?: string; start?: string; backend?: string; files?: string[] };
function startFields(b: any): { error: string } | StartFields {
  if (typeof b.text !== "string") return { error: "say what the squad should do: the text is empty" };
  // CRLF and a lone CR become LF; nothing else changes.
  const framing = b.text.replace(/\r\n?/g, "\n");
  if (!framing.trim()) return { error: "say what the squad should do: the text is empty" };
  const bytes = Buffer.byteLength(framing, "utf8");
  if (bytes > BRIEF_MAX) return { error: `the text is ${(bytes / 1024).toFixed(1)} KiB; the limit is 32 KiB` };
  const bad = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.exec(framing);
  if (bad) return { error: `the text has a control character on line ${framing.slice(0, bad.index).split("\n").length}` };
  const out: StartFields = { framing };
  if (b.slug != null && b.slug !== "") {
    if (typeof b.slug !== "string" || b.slug.length > 64 || b.slug.startsWith(".") || /[^A-Za-z0-9._-]/.test(b.slug))
      return { error: "topic slug may only use letters, digits, . _ - and must not start with ." };
    out.slug = b.slug;
  }
  for (const k of ["type", "autonomy", "start", "backend"] as const) {
    if (b[k] == null || b[k] === "") continue;
    const ok = START_ENUMS[k] as readonly string[];
    if (typeof b[k] !== "string" || !ok.includes(b[k])) return { error: `${k} must be one of ${ok.join(", ")}` };
    out[k] = b[k];
  }
  if (out.start === "auto") delete out.start;
  if (out.start && out.type === "testing") return { error: "a testing squad has no start" };
  // chat-image-upload U4: names of images uploaded to `chat-files/_start/` (names only, never a path).
  const files = b.files ?? [];
  if (!Array.isArray(files) || files.length > START_FILES_MAX || new Set(files).size !== files.length
    || files.some((f) => typeof f !== "string" || !CHAT_FILE_NAME.test(f)))
    return { error: `files: at most ${START_FILES_MAX} distinct image names from /api/chat-file` };
  if (files.length) out.files = files;
  return out;
}

async function request(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, action, topic = "", role = "" } = pr.b;
  const isStart = action === "start" && Object.hasOwn(ACTIONS, action);
  const brief = isStart ? "" : oneLine(pr.b.text);
  if (!NAME.test(project ?? "")) return json(400, { error: "need project" });
  const a = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : Object.hasOwn(WISH_ACTIONS, action) ? { ...WISH_ACTIONS[action], cmd: () => "" } : undefined; // not "constructor" etc.
  if (!a) return json(400, { error: `unknown action ${action}` });
  if (a.topic ? !NAME.test(topic) : topic !== "") return json(400, { error: a.topic ? "need a topic" : "no topic for this action" });
  if (role !== "" && (action !== "restart" || !NAME.test(role))) return json(400, { error: "bad role" });
  let sf: StartFields | null = null;
  if (isStart) {
    const f = startFields(pr.b);
    if ("error" in f) return json(400, { error: f.error });
    for (const n of f.files ?? []) if (!chatFileAt(project, START_TOPIC, n)) return json(409, { error: `image ${n} is gone — attach it again` });
    sf = f;
  }
  const line = sf
    ? `board: the operator asks you to run: /ds-start-squad --repo ${project}${sf.slug ? ` --topic ${sf.slug}` : ""}${sf.type ? ` --type ${sf.type}` : ""}${sf.autonomy ? ` --autonomy ${sf.autonomy}` : ""}${sf.start ? ` --start ${sf.start}` : ""}${sf.backend ? ` --backend ${sf.backend}` : ""}`
    : `board: the operator asks you to run: ${a.cmd(project, topic, role, brief)}`;
  if (Object.hasOwn(WISH_ACTIONS, action)) return write((s) => wishAction(s, project, action, topic, role));
  return write((s) => {
    if (sf && !one(s, "SELECT 1 AS x FROM projects WHERE label = ?", project)) no(409, `no project ${project} on this board`);
    // U33: the project's backend is not a choice; another one is refused with U30's reason.
    if (sf?.backend) {
      const v = limit(s, project, "default_backend");
      const refused = squadBackendRule({ backend: sf.backend, projectBackend: isBackend(v) ? v : DEFAULT_BACKEND, studioBackend: projectStudioBackend(s, project), project });
      if (refused) no(409, refused);
    }
    if (a.topic) squadRow(s, project, topic);
    // board-actions-as-wishes U2: an update is the loop's own request (bin/loop/fulfil/update.ts), no Studio line.
    if (action === "update") {
      if (one(s, "SELECT id FROM requests WHERE kind = 'update' AND project = ? AND done_at IS NULL", project)
        || pendingReq(s, "studio", project, null, "action", "update")) no(409, "already requested — an update is running");
      return board(s, "update", { by: "board" }, { project });
    }
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
    return board(s, "studio", { action, topic: topic || null, line, ...(sf ? { framing: sf.framing } : {}), ...(sf?.files ? { files: sf.files } : {}) }, { project, squad: topic || null });
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
// (fulfil/chat.ts). U19: the text may span lines (CR LF and CR become LF, tabs kept; the backend pastes
// it as one message); any other control character is refused, never flattened.
async function chatPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const t = chatTarget(pr.b.project, pr.b.topic, pr.b.wt);
  if ("error" in t) return json(t.status, { error: t.error });
  if (typeof pr.b.text !== "string") return json(400, { error: "text must be a string" });
  const raw = pr.b.text.replace(/\r\n?/g, "\n"), why = chatProblem(raw);
  if (why) return json(400, { error: why });
  const files = pr.b.files ?? [];
  if (!Array.isArray(files) || files.length > CHAT_FILES_PER_SEND || new Set(files).size !== files.length
    || files.some((f) => typeof f !== "string" || !CHAT_FILE_NAME.test(f)))
    return json(400, { error: `files: at most ${CHAT_FILES_PER_SEND} distinct image names from /api/chat-file` });
  const text = raw.trim();
  if (!text && !files.length) return json(400, { error: "say something" });
  for (const f of files as string[]) if (!chatFileAt(t.project, t.topic, f)) return json(409, { error: `image ${f} is gone — attach it again` });
  return write((s) => {
    const m = chatMember(s, t.project, t.topic, t.wt) ?? no(404, noMember(t));
    if (t.topic !== "_studio" && paused(s, m as { project: string })) no(409, "this member is paused or resuming; use Resume before chatting");
    return board(s, "chat", { text, via: "board", ...(files.length ? { files } : {}) }, { project: t.project, squad: t.topic, member: t.wt });
  });
}

// GET /api/feedback: the Feedback panel's drafts, notes and filed issues (board-data.ts feedbackJson).
function feedbackGet() {
  const r = feedbackJson(undefined, scope.project);
  return r ? json(200, r) : json(503, NO_DB);
}

// POST /api/feedback {action, draft|note, target?, title?, body?, why?} (ds-feedback-github-issues U4): one
// request of U3's kinds (fulfil/feedback.ts) per press. Drafts act only while in review (409 once posted,
// dismissed or posting), a note is dismissed only while not filed, and a second press on the same open
// request is 409.
const FB_ACTIONS: Record<string, string> = { post: "feedback-post", "add-to": "feedback-add-to", edit: "feedback-edit", dismiss: "feedback-dismiss", restore: "feedback-restore" };
async function feedbackPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const b = pr.b, action = String(b.action ?? ""), kind = FB_ACTIONS[action];
  if (!Object.hasOwn(FB_ACTIONS, action)) return json(400, { error: "action is one of post, add-to, edit, dismiss, restore" });
  const id = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  const draft = id(b.draft), note = id(b.note);
  const opt = (k: string, max: number) => (b[k] == null ? undefined : typeof b[k] === "string" && b[k].length <= max ? (b[k] as string) : null);
  if (b.draft != null && draft == null || b.note != null && note == null) return json(400, { error: "draft and note are whole numbers" });
  const needDraft = action !== "restore" && !(action === "dismiss" && note != null);
  if (needDraft && draft == null) return json(400, { error: "name the draft" });
  if (!needDraft && note == null) return json(400, { error: "name the note" });
  if (action === "dismiss" && draft != null && note != null) return json(400, { error: "name a draft or a note, not both" });
  const why = opt("why", 500), title = opt("title", 300), body = opt("body", 60000);
  if (why === null || title === null || body === null) return json(400, { error: "why, title or body is too long or not text" });
  const target = id(b.target);
  if (action === "add-to" && target == null) return json(400, { error: "name the issue number to add to" });
  if (action === "edit" && title === undefined && body === undefined) return json(400, { error: "send a new title or body" });
  const project = typeof b.project === "string" && NAME.test(b.project) ? b.project : "";
  return write((s) => {
    const d = draft != null ? one(s, "SELECT id, state FROM feedback_drafts WHERE id = ?", draft) ?? no(404, `no feedback draft ${draft}`) : null;
    if (d && d.state !== "review") no(409, `draft ${draft} is ${d.state}, not in review`);
    if (note != null) {
      const n = one(s, "SELECT id, state FROM feedback_notes WHERE id = ?", note) ?? no(404, `no feedback note ${note}`);
      if (action === "restore" && n.state !== "dismissed") no(409, `note ${note} is ${n.state}, not dismissed`);
      if (action === "dismiss" && ["filed", "fixed", "closed", "dismissed"].includes(String(n.state))) no(409, `note ${note} is ${n.state}`);
    }
    const field = draft != null ? "draft" : "note", val = String(draft ?? note);
    if (one(s, `SELECT id FROM requests WHERE kind LIKE 'feedback-%' AND done_at IS NULL AND json_extract(payload, '$.' || ?) = ?`, field, Number(val))) no(409, `a request for ${field} ${val} is already open`);
    const payload: Record<string, unknown> = draft != null ? { draft } : { note };
    if (action === "add-to") payload.target = target;
    if (action === "edit") { if (title !== undefined) payload.title = title; if (body !== undefined) payload.body = body; }
    if (action === "dismiss" && why?.trim()) payload.why = why.trim();
    return board(s, kind, payload, { project });
  });
}

// POST /api/keys {project, topic, wt, keys} (U19): one `keys` request pressing 1 to KEYS_MAX named keys
// (contract.ts KEYS, or one digit or lowercase letter) in the member's terminal with no Enter added; the
// loop presses them even while the member works (fulfil/keys.ts), so Escape stops a turn and Up/Down/Enter
// or a digit picks in a menu. 409 for a paused member and while an earlier press for it is still open.
async function keysPost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const t = chatTarget(pr.b.project, pr.b.topic, pr.b.wt);
  if ("error" in t) return json(t.status, { error: t.error });
  const keys = pr.b.keys;
  if (!Array.isArray(keys) || !keys.length || keys.length > KEYS_MAX || !keys.every(keyOk))
    return json(400, { error: `keys: 1 to ${KEYS_MAX} of ${KEYS.join(", ")}, or one digit or lowercase letter` });
  return write((s) => {
    const m = chatMember(s, t.project, t.topic, t.wt) ?? no(404, noMember(t));
    if (t.topic !== "_studio" && paused(s, m as { project: string })) no(409, "this member is paused or resuming");
    if (one(s, "SELECT id FROM requests WHERE kind = 'keys' AND project = ? AND member = ? AND done_at IS NULL", t.project, t.wt)) no(409, "an earlier key press is still on its way");
    return board(s, "keys", { keys, via: "board" }, { project: t.project, squad: t.topic, member: t.wt });
  });
}

// POST /api/chat-cancel and /api/chat-now {project, id} (studio-chat-queued-busy U4): one `chat-cancel` or
// `chat-now` request naming a chat request that is still open; 409 once it is done or typed (or never was a chat).
async function chatControl(req: Request, kind: "chat-cancel" | "chat-now" | "chat-dismiss") {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const project = pr.b.project, id = pr.b.id;
  if (typeof project !== "string" || !project || typeof id !== "number" || !Number.isInteger(id) || id < 1) return json(400, { error: "project and a chat request id" });
  return write((s) => {
    const r = s.db.query("SELECT kind, project, squad, member, done_at, result FROM requests WHERE id = ?").get(id) as { kind: string; project: string; squad: string | null; member: string | null; done_at: number | null; result: string | null } | null;
    if (!r || r.kind !== "chat" || r.project !== project) no(404, "no such chat");
    if (kind === "chat-dismiss") {   // chat-multiline-send-fails U2: only a send that failed or was cancelled; a queued one has Cancel
      if (r!.done_at == null) no(409, "still queued; use Cancel");
      let res: { ok?: unknown; state?: unknown } = {};
      try { res = JSON.parse(r!.result ?? "{}") ?? {}; } catch { /* no result */ }
      if (res.ok !== false && res.state !== "cancelled") no(409, "only a failed or cancelled send can be dismissed");
      return board(s, kind, { chat: id }, { project, squad: r!.squad, member: r!.member });
    }
    if (r!.done_at != null) no(409, "already typed");
    return board(s, kind, { chat: id }, { project, squad: r!.squad, member: r!.member });
  });
}

// ---- chat images (chat-image-upload U1) -------------------------------------------------------------
// The shared contract with the loop (bin/loop/chat/files.ts, chat-image-upload U2): a project's images
// live in `<state root>/<label>/chat-files/<topic>/`, each named by the first 16 hex characters of its
// sha256 plus the extension of its sniffed type; a `chat` row names files only, never a path. These are
// the folder and name rule are that module's (bin/loop/chat/files.ts), imported here.
const chatFilesRoot = (project: string) => dirname(chatFileDir(stateRoot(), project, "x")); // `<state root>/<label>/chat-files`
const CHAT_FILE_MAX = 5 * 1024 * 1024; // per stored file
const CHAT_FILES_CAP = 500 * 1024 * 1024; // per project's chat-files/
const CHAT_FILES_PER_SEND = CHAT_FILES_MAX;
const CHAT_FILES_KEEP_D = 14; // chat_files_keep_d's default
const CHAT_TMP = /^\..*\.tmp$/;
const CHAT_TYPES: Record<string, "png" | "jpg" | "webp" | "gif"> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const CHAT_EXT_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

// The image type the first bytes say, or null: PNG, JPEG, GIF87a/89a, RIFF????WEBP. SVG is never one.
function sniffImage(b: Uint8Array): "png" | "jpg" | "webp" | "gif" | null {
  const at = (i: number, s: number[]) => s.every((v, k) => b[i + k] === v);
  const ascii = (i: number, s: string) => at(i, [...s].map((c) => c.charCodeAt(0)));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (at(0, [0xff, 0xd8, 0xff])) return "jpg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "gif";
  if (b.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  return null;
}

// A plain folder (never a symlink) at `p`, made 0700 when missing; throws ChatFolder otherwise.
class ChatFolder extends Error {}
function plainDir(p: string, make: boolean): boolean {
  let st = lstatSync(p, { throwIfNoEntry: false });
  if (!st && make) { try { mkdirSync(p, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } st = lstatSync(p, { throwIfNoEntry: false }); }
  if (!st) return false;
  if (!st.isDirectory()) throw new ChatFolder("chat-files is not a plain folder");
  return true;
}
// The topic's folder, every level under `<label>/chat-files/` checked plain; null when it is not there.
function chatDir(project: string, topic: string, make: boolean): string | null {
  const top = chatFilesRoot(project), dir = join(top, topic);
  if (make && !existsSync(join(stateRoot(), project))) mkdirSync(join(stateRoot(), project), { recursive: true, mode: 0o700 });
  return plainDir(top, make) && plainDir(dir, make) ? dir : null;
}
// The stored image's path when it is a plain file in the topic's plain folder, else null.
function chatFileAt(project: string, topic: string, name: string): string | null {
  if (!CHAT_FILE_NAME.test(name)) return null;
  try {
    const dir = chatDir(project, topic, false);
    const p = dir && join(dir, name);
    return p && lstatSync(p, { throwIfNoEntry: false })?.isFile() ? p : null;
  } catch { return null; }
}

// chat_files_keep_d through the settings read API; a bad or missing value is 14.
function chatKeepDays(project: string): number {
  try {
    const v = readGet(project, "limits.conf", "chat_files_keep_d").value ?? "";
    const n = /^\d+$/.test(v) ? Number(v) : NaN;
    return n >= 1 && n <= 365 ? n : CHAT_FILES_KEEP_D;
  } catch { return CHAT_FILES_KEEP_D; }
}

// The prune every upload runs first: over `<label>/chat-files/*/`, plain files only, an image older than
// chat_files_keep_d days and a temp file older than an hour go; any other file stays. Returns the bytes
// left. An error never fails the upload: it is one stderr line, and the walk goes on.
function chatPrune(project: string): number {
  const now = Date.now(), keepMs = chatKeepDays(project) * 86400_000;
  let left = 0, err = "";
  const top = chatFilesRoot(project);
  try {
    if (!plainDir(top, false)) return 0;
    for (const topic of readdirSync(top)) {
      const dir = join(top, topic);
      try {
        if (!lstatSync(dir).isDirectory()) continue;
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          try {
            const st = lstatSync(p);
            if (!st.isFile()) continue;
            const age = now - st.mtimeMs;
            if ((CHAT_FILE_NAME.test(name) && age > keepMs) || (CHAT_TMP.test(name) && age > 3600_000)) unlinkSync(p);
            else left += st.size;
          } catch (e) { err ||= `${p}: ${e}`; }
        }
      } catch (e) { err ||= `${dir}: ${e}`; }
    }
  } catch (e) { err ||= `${top}: ${e}`; }
  if (err) console.error(`board (serve): chat-files prune: ${err}`);
  return left;
}

// chat-image-upload U4: an image for the Start squad dialog names topic `_start` and no member (no squad
// exists yet): the project must be a name in this board's scope; a `wt` with it is refused.
function startTarget(project: unknown, wt: boolean): { project: string; topic: string } | { status: number; error: string } {
  if (typeof project !== "string" || !NAME.test(project) || wt) return { status: 400, error: `need a project and no member's worktree for topic ${START_TOPIC}` };
  if (scope.project && scope.project !== project) return { status: 403, error: "target is outside this board's scope" };
  return { project, topic: START_TOPIC };
}

// POST /api/chat-file?project=&topic=&wt=, body = the image's bytes. The checks run in this order and the
// body is read only after the header ones pass; a refused upload writes no file.
async function chatFilePost(req: Request, url: URL) {
  if (!sameOrigin(req)) return text(403, "forbidden origin\n");
  const ext = CHAT_TYPES[(req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase()];
  if (!ext) return json(415, { error: "want image/png, image/jpeg, image/webp or image/gif" });
  const q = url.searchParams, start = q.get("topic") === START_TOPIC;
  const st = start ? startTarget(q.get("project"), q.has("wt")) : null;
  const ct = start ? null : chatTarget(q.get("project"), q.get("topic"), q.get("wt"));
  if (st && "error" in st) return json(st.status, { error: st.error });
  if (ct && "error" in ct) return json(ct.status, { error: ct.error });
  const chat = ct && !("error" in ct) ? ct : null, t = (chat ?? st) as { project: string; topic: string };
  const tooBig = { error: `an image is at most ${CHAT_FILE_MAX / 1024 / 1024} MiB` };
  if (Number(req.headers.get("Content-Length") || 0) > CHAT_FILE_MAX) return json(413, tooBig);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await req.arrayBuffer()); } catch { return json(413, tooBig); }
  if (bytes.length > CHAT_FILE_MAX) return json(413, tooBig);
  if (!bytes.length) return json(400, { error: "empty body: send the image's bytes" });
  if (sniffImage(bytes) !== ext) return json(415, { error: "not a png/jpeg/webp/gif" });
  if (!existsSync(dbPath())) return json(503, NO_DB);
  // A chat's image needs its live member; a start's (no squad yet) a project the loop knows, as the start itself.
  let live = false;
  try {
    const s = openReadOnly();
    try { live = chat ? !!chatMember(s, chat.project, chat.topic, chat.wt) : !!one(s, "SELECT 1 AS x FROM projects WHERE label = ?", t.project); }
    finally { s.close(); }
  } catch (e) { return json(503, { error: `loop.db: ${e}` }); }
  if (!live) return chat ? json(404, { error: noMember(chat) }) : json(409, { error: `no project ${t.project} on this board` });
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ext}`;
  try {
    const left = chatPrune(t.project);
    const dir = chatDir(t.project, t.topic, true)!, p = join(dir, name);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (st?.isFile()) { const now = new Date(); utimesSync(p, now, now); }
    else {
      if (left + bytes.length > CHAT_FILES_CAP) return json(507, { error: `this project's chat images are over ${CHAT_FILES_CAP / 1024 / 1024} MiB; wait for old ones to be pruned` });
      const tmp = join(dir, `.${name}.${process.pid}.tmp`);
      try { writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" }); renameSync(tmp, p); }
      catch (e) { try { unlinkSync(tmp); } catch { /* not written */ } throw e; }
    }
  } catch (e) {
    return json(500, { error: e instanceof ChatFolder ? e.message : `storing the image: ${String(e).slice(-300)}` });
  }
  const u = new URLSearchParams({ project: t.project, topic: t.topic, name });
  return json(200, { id: name, url: `api/chat-file?${u}`, bytes: bytes.length });
}

// GET /api/chat-file?project=&topic=&name=: one stored image, never a symlink or anything outside its folder.
// No member check, so an ended member's old bubbles still show.
function chatFileGet(url: URL) {
  const q = url.searchParams, project = q.get("project"), topic = q.get("topic"), name = q.get("name") ?? "";
  if (typeof project !== "string" || !NAME.test(project) || typeof topic !== "string" || !SQUAD.test(topic))
    return json(400, { error: "need project and topic" });
  // A start's images (`_start`) belong to the project, as the start does.
  if ((scope.project && scope.project !== project) || (scope.topic && topic !== START_TOPIC && scope.topic !== topic)) return json(403, { error: "target is outside this board's scope" });
  if (!CHAT_FILE_NAME.test(name)) return json(400, { error: "bad image name" });
  const p = chatFileAt(project, topic, name);
  if (!p) return text(404, "image removed\n");
  let fd = -1;
  try {
    fd = openSync(p, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > CHAT_FILE_MAX) return text(404, "image removed\n");
    return new Response(readFileSync(fd), { status: 200, headers: {
      "Content-Type": CHAT_EXT_TYPE[name.split(".")[1]], "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'", "Cache-Control": "private, max-age=86400" } });
  } catch { return text(404, "image removed\n"); }
  finally { if (fd >= 0) closeSync(fd); }
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
    if (row.fileOnly && key === "feedback_repo") return json(400, { error: `${key} is an override: set it with \`ds config set --project ${project} limits.conf ${key} owner/name\` or the env, not here` });
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
  const ret = pr.b.return;
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
  // configurable-role-elevation U2: `return` is up, stay or "" (inherit); up never goes on an elevate row. U3: on
  // studio it moves the Studio back up through studio-move, following studio_move.
  if (ret !== undefined && ret !== null && ret !== "up" && ret !== "stay" && ret !== "") return bad("return must be up, stay or empty (inherit)");
  if (ret === "up" && spawn === "elevate") return bad(`'up' (move back up) can't go on '${role}': it is an elevate row, which never runs a terminal`);
  const extra = ret === undefined || ret === null ? {} : { return: ret };
  return write((s) => board(s, "roles", { role, agent, model, spawn, effort: eff, fallbacks: fb, plan: chosenPlan, ...extra }, { project }));
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

// leftover: a Leftovers box's Remove (archive-leftovers U4). One `leftover-remove` request; the loop checks the
// tree again and removes it when it is safe, or saved first when `fingerprint` is still the tree's (else refused).
async function leftoverRemovePost(req: Request) {
  const pr = await readPost(req);
  if ("r" in pr) return pr.r;
  const { project, topic, wt, fingerprint } = pr.b;
  const ok = typeof wt === "string" && wt.length > 0 && wt.length <= 400 && !/[\x00-\x1f]/.test(wt);
  if (!NAME.test(project ?? "") || !NAME.test(topic ?? "") || !ok || (fingerprint != null && !(typeof fingerprint === "string" && /^[0-9a-f]{8,64}$/.test(fingerprint))))
    return json(400, { error: "need project, topic, wt and an optional fingerprint" });
  return write((s) => {
    const row = one(s, "SELECT doc FROM squads WHERE project = ? AND topic = ?", project, topic) ?? no(404, `no squad ${project}/${topic}`);
    let list: any[] = [];
    try { list = JSON.parse(String(row!.doc ?? "{}")).leftovers ?? []; } catch { /* unreadable: no leftovers */ }
    if (!Array.isArray(list) || !list.some((l) => l && l.wt === wt)) no(404, `${project}/${topic} has no leftover ${wt}`);
    const open = one(s, "SELECT id FROM requests WHERE kind = 'leftover-remove' AND done_at IS NULL AND project = ? AND json_extract(payload, '$.wt') = ?", project, wt);
    if (open) no(409, `a removal of ${wt} is already open (request #${open.id})`);
    const r = board(s, "leftover-remove", { wt, ...(fingerprint ? { fingerprint } : {}) }, { project, squad: topic });
    // A paused squad holds the request until Resume (pause.ts actionBlock); say so in the answer.
    return paused(s, { project, squad: topic }) ? json(202, { ok: true, id: Number(r.id), queued: true }) : r;
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
    // The asking the operator saw: its `since` (epoch seconds or the entry's ISO time) must be the open row's `asked_at`.
    if (pr.b.since !== undefined && pr.b.since !== null) {
      const want = typeof pr.b.since === "number" ? Math.floor(pr.b.since) : Math.floor(Date.parse(String(pr.b.since)) / 1000);
      if (!Number.isFinite(want) || want !== (q.asked_at === null || q.asked_at === undefined ? null : Number(q.asked_at)))
        no(409, `question ${id} was answered or asked again; the board has updated`);
    }
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
    answerQuestion(s, project, topic, id, ans, "board", q.seq as number);
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
const readPage = () => readFileSync(page).toString(); // the one file this server reads, besides the chat images
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

// GET /page/<label>/pages/<topic>/<path> -> one saved copy of a review page (or a css, js, image or font file it
// links, by extension) from `<state root>/<label>/pages/<topic>/`, read-only (bin/board/saved-pages.ts). Served
// under that path so a page's relative links resolve; its scripts run in an opaque origin (CSP sandbox), so they
// cannot call this board's API.
function pageGet(url: URL) {
  let seg: string[];
  try { seg = url.pathname.slice("/page/".length).split("/").map(decodeURIComponent); } catch { return text(404, "not found\n"); }
  const [project, pages, topic, ...rest] = seg;
  if (pages !== "pages" || !NAME.test(project ?? "") || !SQUAD.test(topic ?? "")) return text(404, "not found\n");
  if ((scope.project && scope.project !== project) || (scope.topic && scope.topic !== topic)) return json(403, { error: "target is outside this board's scope" });
  const f = servePage(stateRoot(), project, topic, rest);
  if (!f) return text(404, "not found\n");
  return new Response(f.bytes, { status: 200, headers: { "Content-Type": f.type, "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox allow-scripts", "Cache-Control": "no-store" } });
}

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
  if (path === "/api/feedback") return feedbackGet();
  if (path === "/api/chat-file") return chatFileGet(url);
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
  if (path.startsWith("/page/")) return pageGet(url);
  return text(404, "not found\n");
}
// --- end of read routes ---------------------------------------------------------------------------

const POSTS: Record<string, (req: Request) => Promise<Response>> = {
  "/api/pause": (r) => activity(r, false), "/api/resume": (r) => activity(r, true),
  "/api/restart": restart, "/api/answer": answer, "/api/poke": poke, "/api/request": request, "/api/override": overridePost, "/api/account": accountPost, "/api/account-reset": accountResetPost, "/api/leftover-remove": leftoverRemovePost, "/api/unit": unitPost, "/api/plan": planPost,
  "/api/settings-import/preview": settingsImportPreview,
};

async function handle(req: Request) {
  if (!hosts.has(hostName(req.headers.get("Host")))) return text(403, "forbidden host\n");
  const url = new URL(req.url), path = url.pathname;
  // Bun takes bodies up to an image's size (maxRequestBodySize) for the upload alone: any other request
  // that says it is bigger than a JSON post may be is refused before routing.
  if (path === "/api/chat-file" && req.method === "POST") return chatFilePost(req, url);
  if (Number(req.headers.get("Content-Length") || 0) > MAX_BODY) return text(413, "too large\n");
  if (Object.hasOwn(POSTS, path)) return req.method === "POST" ? POSTS[path](req) : text(405, "POST only\n");
  // These paths are GET routes too (the read block), so they are not in POSTS.
  if (path === "/api/limits" && req.method === "POST") return limitsPost(req);
  if (path === "/api/roles" && req.method === "POST") return rolesPost(req);
  if (path === "/api/skills" && req.method === "POST") return skillsPost(req);
  if (path === "/api/settings-import" && req.method === "POST") return settingsImportPost(req);
  if (path === "/api/chat" && req.method === "POST") return chatPost(req);
  if (path === "/api/feedback" && req.method === "POST") return feedbackPost(req);
  if (path === "/api/keys" && req.method === "POST") return keysPost(req);
  if (path === "/api/chat-cancel" && req.method === "POST") return chatControl(req, "chat-cancel");
  if (path === "/api/chat-now" && req.method === "POST") return chatControl(req, "chat-now");
  if (path === "/api/chat-dismiss" && req.method === "POST") return chatControl(req, "chat-dismiss");
  if (req.method !== "GET" && req.method !== "HEAD") return text(405, "GET only\n");
  return get(req, url);
}

// One listener per address (e.g. 127.0.0.1 and the tailnet IP). Retry a few seconds (30 tries,
// DS_BOARD_BIND_TRIES): a just-replaced server may still be releasing the port.
const bindTries = Math.max(1, Number(process.env.DS_BOARD_BIND_TRIES) || 30);
for (const hostname of bindArg.split(/\s+/).filter(Boolean)) {
  for (let i = 0; ; i++) {
    try { Bun.serve({ hostname, port, fetch: handle, maxRequestBodySize: CHAT_FILE_MAX + 64 * 1024, idleTimeout: 30 }); break; }
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
