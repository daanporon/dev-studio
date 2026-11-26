// fulfil/account-add.ts — kind `account-add` (issue #125, U5): `ds account add <name>`'s request. Generic over the
// account kind (bin/lib/account-kinds/): a paste-flow kind (Claude) and a device-flow kind take the same path.
//
// A new login, staged in the request's `result` so a loop restart resumes with the same folder and terminal:
//   folder_ready    <accounts root>/<agent>/<name>, 0700, the kind's links, a marker naming this request
//                   (bin/lib/account-folder.ts); the stored `started_at` starts the 30-minute deadline
//   terminal_open   the login command (loginLine) typed into a terminal: on a project whose Studio is on a contract
//                   backend a contract terminal, else an Orca tab in the Studio worktree (projects.studio_wt), else
//                   none and the result names the line to run by hand; `why` once no link shows on its screen
//   waiting_login   the screen's login URL (and a device-flow kind's code) in the result, for the CLI and board
//   code_typed      (paste flow, U6) the code the board dropped (bin/lib/account-login-code.ts) was read, removed
//                   and typed while the paste prompt showed; the prompt still up PROMPT_BACK_S later with no
//                   credentials means it was not accepted: back to waiting_login with that `why`. A code that comes
//                   once the prompt has gone is dropped untyped. Once a code was typed no screen text goes into the
//                   result again (the URL stays as first read).
//   done            `.credentials.json` (the kind's credentials file) appeared: afterLogin, the row (addAccount:
//                   added, "back as <label>", or "already there as <label>", which removes only this add's folder),
//                   the terminal closed, one forced accounts refresh
//   failed          the login command ended without credentials ("login not finished"), or the deadline passed;
//                   the folder stays, the terminal is closed
// `--dir <folder>` adds a logged-in folder in one step, with no terminal: it is never moved, copied, written or
// removed. A one-login kind is refused with its `why` before any folder is made. The screen is read only for the
// URL, the device code and whether the paste prompt shows: the code an operator pastes is a secret and never
// reaches a row, event or log, and the typing step keeps no error text (an adapter's error may echo the input).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { finishRequest, requestActions, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { payloadOf } from "../core/kinds.ts";
import type { Action } from "../core/plugins.ts";
import type { Row } from "../core/store.ts";
import { addAccount } from "../capacity/accounts.ts";
import { refreshAccounts } from "./account-reset.ts";
import { studioContract } from "../squad/backend.ts";
import { findKind, type AccountKind } from "../../lib/account-kinds/index.ts";
import { loginExit, loginLine, makeAccountFolder, nameProblem, removeMadeFolder } from "../../lib/account-folder.ts";
import { clearLoginCode, takeLoginCode } from "../../lib/account-login-code.ts";

export const DEADLINE_S = 1800;
const CHECK_S = 2;
const NO_LINK_S = 20;     // no login link on the screen this long after the terminal opened: say so
const LOGIN_ID_S = 10;    // credentials there but no login id yet: wait this long for the agent to write it
export const NOT_FINISHED = "login not finished; the folder stays — add it with --dir or add again";
export const NO_LINK = "no login link seen; log in in the terminal";
export const PROMPT_BACK_S = 8;   // the paste prompt still up this long after the code was typed: not accepted
export const NOT_ACCEPTED = "the code was not accepted: copy the code again and paste it";
export const LATE = "the code came after the login prompt had gone, so it was not typed";
export const NOT_TYPED = "the code could not be typed into the login terminal: paste it again, or type it there";

export type LoginTerm = { via: "orca" | "contract"; handle: string; project: string };
type Rec = Record<string, unknown> & { state?: string; folder?: string; terminal?: LoginTerm | null; started_at?: number; opened_at?: number; typed_at?: number };

/** Where the login terminal lives. The default opens it beside the project's Studio. */
export type Terminals = {
  open(x: Exec, project: string, req: { id: number; folder: string; line: string; label: string }): Promise<LoginTerm | null | { error: string }>;
  /** The screen, or null when the terminal is gone. */
  read(x: Exec, t: LoginTerm): Promise<string | null>;
  close(x: Exec, t: LoginTerm): Promise<void>;
  /** Type `text` and then Enter; true when both went. Never returns or logs an error text: it may echo `text`. */
  type(x: Exec, t: LoginTerm, text: string): Promise<boolean>;
};

const studioWt = (x: Exec, project: string) => (x.store.get("projects", { label: project })?.studio_wt as string | null | undefined) ?? null;
const contractSeat = (x: Exec, project: string, key: string) => {
  const c = studioContract(x.store, project);
  return c ? x.act.studioSeatOn(x.store, project, c.backend, c.provider, key, studioWt(x, project) ?? "", x.now).contract ?? null : null;
};

export const studioTerminals: Terminals = {
  async open(x, project, { id, folder, line, label }) {
    const seat = contractSeat(x, project, `account-add:${id}`);
    if (seat) {
      const r = await seat.ask("terminal.create", { cwd: folder, label });
      if (!r.ok) return { error: `terminal.create: ${r.error.message}` };
      const s = await seat.ask("terminal.send", { id: r.terminal.id, text: line, submit: true });
      if (!s.ok) {
        await seat.ask("terminal.close", { id: r.terminal.id });
        return { error: `terminal.send: ${s.error.message}` };
      }
      return { via: "contract", handle: r.terminal.id, project };
    }
    const wt = studioWt(x, project);
    if (!wt) return null;
    const o = await x.act.orca.run("terminal-create", [wt, label, line]);
    const handle = o.out.split("\t")[0].trim();
    return o.code === 0 && handle ? { via: "orca", handle, project } : { error: `terminal-create: ${(o.err || o.out).trim() || `exit ${o.code}`}` };
  },
  async read(x, t) {
    if (t.via === "contract") {
      const r = await contractSeat(x, t.project, `account-add-read:${t.handle}`)?.ask("terminal.read", { id: t.handle, screen: true });
      return r?.ok ? r.text : null;
    }
    const o = await x.act.orca.run("terminal-read", [t.handle, "screen"]);
    return o.code === 0 ? o.out : o.code === 3 ? null : "";
  },
  async close(x, t) {
    if (t.via === "contract") await contractSeat(x, t.project, `account-add-close:${t.handle}`)?.ask("terminal.close", { id: t.handle });
    else await x.act.orca.run("terminal-close", [t.handle]);
  },
  // The text, then Enter on its own (KTD11: chat's typing primitive, with no prefix and no copy). On Orca not with
  // `enter`, which waits for an agent turn. Only the exit codes are looked at.
  async type(x, t, text) {
    if (t.via === "contract") {
      const seat = contractSeat(x, t.project, `account-add-type:${t.handle}`);
      return !!(await seat?.ask("terminal.send", { id: t.handle, text, submit: true }).catch(() => null))?.ok;
    }
    const a = await x.act.orca.run("terminal-type", [t.handle, text]).catch(() => null);
    if (a?.code !== 0) return false;
    return (await x.act.orca.run("terminal-type", [t.handle, "\r"]).catch(() => null))?.code === 0;
  },
};

/** Where the operator finds the login terminal. */
function where(t: LoginTerm, x: Exec): string {
  if (t.via === "orca") return `an Orca tab "ds-account-add" in ${t.project}'s Studio worktree (${t.handle})`;
  const backend = studioContract(x.store, t.project)?.backend ?? "contract";
  return backend === "tmux" ? `tmux -L ds-${t.project} attach (terminal ${t.handle})` : `${backend} terminal ${t.handle} of ${t.project}`;
}

const parse = (s: unknown): Rec => { try { return s ? JSON.parse(String(s)) ?? {} : {}; } catch { return {}; } };

export function accountAdd(opts: { terminals?: Terminals; refresh?: (root: string) => void; env?: Record<string, string | undefined> } = {}): Fulfiller {
  const terms = opts.terminals ?? studioTerminals, refresh = opts.refresh ?? refreshAccounts;
  const envOf = () => opts.env ?? process.env;

  return {
    name: "account-add",
    scope: "host",
    kinds: ["account-add"],
    run: (ctx) => requestActions(ctx, ["account-add"]),
    async exec(a, x) {
      const p = payloadOf<"account-add">(a), id = Number(p.request), env = envOf();
      const row = x.store.get("requests", { id }) as Row | null;
      if (!row) return { dropped: "no such request" };
      if (row.done_at != null) return { done: true, result: "already done" };
      let rec = parse(row.result);
      const save = (r: Rec) => { rec = r; x.store.upsert("requests", { id }, { result: JSON.stringify(r) }); };
      const end = async (ok: boolean, set: Rec): Promise<Result> => {
        if (rec.terminal) await terms.close(x, rec.terminal).catch(() => {});
        clearLoginCode(x.store.root, id);
        // The URL and a device code are kept only while the add runs (KTD9).
        const { url: _u, device_code: _d, ...kept } = rec;
        finishRequest(x.store, a, { ...kept, ...set, terminal: rec.terminal ?? null, state: ok ? "done" : "failed", ok }, x.now);
        if (ok) refresh(x.store.root);
        return { done: true as const, result: ok ? String(set.text) : `failed: ${set.error}` };   // the request is told: no giveUp card
      };
      const fail = (error: string) => end(false, { error, text: error });

      const kind = findKind(p.agent);
      if (!kind) return fail(`no account kind for agent '${p.agent}'`);
      if (!kind.multi) return fail(kind.why ?? `${p.agent} keeps one login`);
      const by = p.by ?? String(row.requested_by ?? "ds");

      // The row, once the folder holds a login.
      const finish = async (folder: string) => {
        const res = addAccount(x.store, { agent: kind.agent, account: p.name, folder, loginId: kind.loginId(folder, false, env), by }, env, x.now);
        // The duplicate: the login keeps its own folder, and this add's (only one its marker names) goes.
        if (res.folder !== folder) removeMadeFolder(folder, id);
        const text = res.outcome === "added" ? `added ${kind.agent}:${res.account}` : res.outcome === "back" ? `back as ${res.label}` : `already there as ${res.label}`;
        return end(true, { outcome: res.outcome, account: res.account, label: res.label, folder: res.folder, text });
      };

      if (!rec.state) {
        const bad = nameProblem(p.name, (x.store.db.query("SELECT account FROM accounts WHERE agent = ?").all(kind.agent) as Row[]).map((r) => String(r.account)));
        if (bad) return fail(bad);
        if (p.dir) {
          if (!existsSync(join(p.dir, kind.credentialsFile))) return fail(`${p.dir} has no ${kind.credentialsFile}: it is not logged in (log in there first, or add without --dir)`);
          return finish(p.dir);
        }
        if (!kind.login) return fail(`${kind.agent} has no login command yet`);
        let folder: string;
        try { folder = makeAccountFolder(kind, p.name, id, env); } catch (e) { return fail((e as Error).message); }
        save({ state: "folder_ready", folder, started_at: x.now, text: `folder ready: ${folder}` });
      }

      const folder = String(rec.folder);
      const line = loginLine(kind, folder);
      if (rec.state === "opening") {
        // A restart while the terminal was being opened: it may be open, so never a second one.
        save({ ...rec, state: "terminal_open", terminal: null, line, text: `the login terminal may have opened before a loop restart (look for a ds-account-add terminal); else run this login yourself: ${line}` });
      }
      if (rec.state === "folder_ready") {
        save({ ...rec, state: "opening" });
        const t = a.project ? await terms.open(x, a.project, { id, folder, line, label: `ds-account-add ${kind.agent}:${p.name}` }) : null;
        if (t && "error" in t) return fail(`could not open the login terminal: ${t.error}`);
        save({ ...rec, state: "terminal_open", terminal: t, opened_at: x.now,
          text: t ? `login terminal open: ${where(t, x)}` : `no Studio terminal to open: run this login yourself: ${line}`,
          ...(t ? {} : { line }) });
      }
      return watch(x, id, kind, folder, rec, save, fail, finish, terms, env);
    },
    giveUp: (a, x, why) => {
      clearLoginCode(x.store.root, Number(payloadOf<"account-add">(a).request));
      finishRequest(x.store, a, { ok: false, state: "failed", error: why, text: why }, x.now);
      return true;
    },
  };
}

async function watch(x: Exec, id: number, kind: AccountKind, folder: string, rec: Rec, save: (r: Rec) => void, fail: (why: string) => Promise<Result>,
  finish: (folder: string) => Promise<Result>, terms: Terminals, env: Record<string, string | undefined>): Promise<Result> {
  if (existsSync(join(folder, kind.credentialsFile))) {
    // The agent writes the login id beside the credentials: wait a moment for it, then add the row either way.
    if (!kind.loginId(folder, false, env) && x.now - Number(rec.creds_at ?? x.now) < LOGIN_ID_S) {
      if (rec.creds_at == null) save({ ...rec, creds_at: x.now, state: "logged_in", text: "logged in" });
      return { wait: "logged in: reading the login", at: x.now + CHECK_S };
    }
    kind.afterLogin?.(folder, env);
    return finish(folder);
  }
  if (loginExit(folder) != null) return fail(`login not finished (the login command ended); the folder stays: ${folder}`);
  if (x.now - Number(rec.started_at ?? x.now) >= DEADLINE_S) return fail(`${NOT_FINISHED}: ${folder}`);
  if (rec.terminal && kind.login) {
    const screen = await terms.read(x, rec.terminal);
    if (screen === null) return fail(`login not finished (the login terminal closed); the folder stays: ${folder}`);
    const seen = kind.login.read(screen);
    if (kind.login.flow === "paste" && rec.state === "code_typed") {
      // Only whether the prompt came back: this screen may hold the typed code.
      if (x.now - Number(rec.typed_at ?? x.now) >= PROMPT_BACK_S && seen.prompt)
        save({ ...rec, state: "waiting_login", why: NOT_ACCEPTED, text: `${NOT_ACCEPTED}: ${rec.url ?? "the login link"}` });
      return { wait: String(rec.state), at: x.now + CHECK_S };
    }
    if (kind.login.flow === "paste" && rec.state === "waiting_login") {
      const code = takeLoginCode(x.store.root, id);
      if (code !== null) {
        if (!seen.prompt) save({ ...rec, why: LATE, text: LATE });
        else if (!await terms.type(x, rec.terminal, code)) save({ ...rec, why: NOT_TYPED, text: NOT_TYPED });
        else save({ ...rec, state: "code_typed", typed_at: x.now, why: null, text: "code typed: logging in" });
        return { wait: String(rec.state), at: x.now + CHECK_S };
      }
      if (rec.typed_at != null) return { wait: String(rec.state), at: x.now + CHECK_S };   // the URL stays as first read
    }
    const url = seen.url ?? rec.url as string | undefined, code = seen.device_code ?? rec.device_code as string | undefined;
    if (url && (url !== rec.url || code !== rec.device_code || rec.state !== "waiting_login")) {
      save({ ...rec, state: "waiting_login", url, ...(code ? { device_code: code } : {}), why: null,
        text: `waiting for login: open ${url}${code ? ` and enter ${code}` : ""}${kind.login.flow === "paste" ? ", then paste the code into the login terminal" : ""}` });
    } else if (!url && rec.why !== NO_LINK && x.now - Number(rec.opened_at ?? x.now) >= NO_LINK_S) {
      save({ ...rec, why: NO_LINK, text: NO_LINK });
    }
  }
  return { wait: String(rec.state), at: x.now + CHECK_S };
}

export default accountAdd();
