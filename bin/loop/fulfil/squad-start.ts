// fulfil/squad-start.ts — kind `squad-start` (board-actions-as-wishes U6): the board's Start squad, done by the
// loop with no Studio. The board files the dialog's checked fields (bin/board/board-server.ts `startFields`);
// this fulfiller, a background kind so the model call never holds the tick:
//   1. writes the brief and its attached files to `framings/board-start-<request>.md` (squad/start-framing.ts);
//      a file gone from `chat-files/_start/` fails the request, naming it;
//   2. names the squad: the operator's slug, else one short model call (bin/lib/one-shot.ts) on the agent, model
//      and account the Studio's own pick gives, asked for a kebab-case name from the brief text alone; any
//      failure (no pick, no config dir, a non-zero exit, a timeout, an answer that is not a name) gives a plain
//      name from the brief (squad/squad-name.ts). A model or fallback name already taken gets `-2`, `-3` …;
//      a taken operator slug fails the request (the board refuses it first);
//   3. writes the squad's running wish (squad/squad-wish.ts, the builder `ds spawn-squad` uses) by `board`;
//   4. finishes the request with {ok, topic, named_by: operator|model|fallback, agent, framing_file}.
// Only the model's name is used: nothing else it says is shown or run, so it cannot answer the brief. The wish
// and the finish are one transaction, so a replay after a crash never makes two squads.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failRequest, finishRequest, requestActions, type Exec, type Fulfiller } from "../core/actuator.ts";
import type { Action } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { openRemoval } from "../squad/project-removal.ts";
import { envInt } from "../core/tick.ts";
import { pick } from "../capacity/pick.ts";
import { childEnv } from "../io/orca.ts";
import { limit } from "../settings/limits.ts";
import { effectiveRoster } from "../settings/roster.ts";
import { GoneFile, writeStartFraming } from "../squad/start-framing.ts";
import { squadWish } from "../squad/squad-wish.ts";
import { fallbackName, freeName, namePrompt, parseName, takenNames } from "../squad/squad-name.ts";
import { oneShotArgv } from "../../lib/one-shot.ts";

type P = { framing?: string; files?: string[]; slug?: string; type?: string; autonomy?: string; start?: string; backend?: string; by?: string; request?: number };
type Named = { name: string | null; agent: string | null; why: string };

export const nameS = () => envInt("DS_SQUAD_NAME_S", 30);

async function call(argv: string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<{ code: number; out: string; timedOut: boolean }> {
  try {
    const p = Bun.spawn(argv, { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, timedOut: p.signalCode != null && code !== 0 };
  } catch { return { code: -1, out: "", timedOut: false }; }
}

/** One model call for the name on the Studio's pick. `DS_SQUAD_NAME_CMD` (tests) runs in front of the real argv. */
export async function modelName(x: Exec, project: string, brief: string): Promise<Named> {
  const pk = pick(x.store, { project, role: "studio" }, x.now);
  if ("error" in pk) return { name: null, agent: null, why: `no pick: ${pk.error}` };
  if ("wait" in pk) return { name: null, agent: null, why: `no pick: ${pk.reason}` };
  const env = childEnv();
  delete env.CLAUDE_CONFIG_DIR;
  if (pk.agent === "claude" && pk.account && pk.account !== "system") {
    const c = await x.act.orca.run("claude-config-dir", [pk.account]);
    if (c.code !== 0 || !c.out.trim()) return { name: null, agent: pk.agent, why: `no config dir for ${pk.agent}:${pk.account}` };
    env.CLAUDE_CONFIG_DIR = c.out.trim();
  }
  const cwd = mkdtempSync(join(tmpdir(), "ds-squad-name-"));
  try {
    const cmd = oneShotArgv(pk.agent, { model: pk.model, effort: "low", prompt: namePrompt(brief), cwd });
    if (!cmd) return { name: null, agent: pk.agent, why: `no one-shot form for ${pk.agent}` };
    const stub = process.env.DS_SQUAD_NAME_CMD;
    const r = await call(stub ? [stub, ...cmd.argv] : cmd.argv, env, cwd, nameS() * 1000);
    if (r.timedOut) return { name: null, agent: pk.agent, why: `timeout after ${nameS()} s` };
    if (r.code !== 0) return { name: null, agent: pk.agent, why: `exit ${r.code}` };
    let answer = r.out;
    if (cmd.out) { try { answer = readFileSync(cmd.out, "utf8"); } catch { answer = ""; } }
    const name = parseName(answer);
    return name ? { name, agent: pk.agent, why: "ok" } : { name: null, agent: pk.agent, why: "the answer is not a name" };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

const studioHandle = (store: Store, project: string): string => {
  const r = store.db.query(`SELECT handle FROM members WHERE project = ? AND squad = '_studio' AND role = 'studio'
    AND COALESCE(want,'') != 'gone' AND COALESCE(status,'') != 'gone' AND COALESCE(handle,'') != '' ORDER BY id DESC LIMIT 1`).get(project) as Row | null;
  return r ? String(r.handle) : "";
};
const placedBackend = (store: Store, project: string, topic: string): string | null => {
  const r = store.db.query("SELECT backend FROM squads WHERE project = ? AND topic = ? AND doc IS NOT NULL AND COALESCE(status, '') NOT IN ('closed', 'gone')").get(project, topic) as Row | null;
  return r ? String(r.backend ?? "") || null : null;
};
const readDisp = (root: string, project: string): Record<string, unknown> | null => {
  try { const o = JSON.parse(readFileSync(join(root, project, "dispatcher.json"), "utf8")); return o && typeof o === "object" ? o : null; } catch { return null; }
};
const word = (store: Store, project: string, key: string) => String(limit(store, project, key) ?? "").trim().split(/\s+/)[0];

function logStart(x: Exec, a: Action, result: Record<string, unknown>): void {
  x.store.event("squad_start", { project: a.project || null, squad: (result.topic as string | undefined) ?? null, payload: { id: (a.payload as P).request ?? null, ...result } });
}

const squadStart: Fulfiller = {
  name: "squad-start",
  scope: "host",
  kinds: ["squad-start"],
  run: (ctx) => requestActions(ctx, ["squad-start"]),
  async exec(a, x) {
    const p = a.payload as P, id = Number(p.request);
    const row = x.store.get("requests", { id }) as Row | null;
    if (!row) return { dropped: "no such request" };
    if (row.done_at != null) return { done: true, result: "already done" };
    const fail = (why: string) => { failRequest(a, x, why); logStart(x, a, { ok: false, error: why }); return { done: true as const, result: `failed: ${why}` }; };
    const project = a.project;
    if (!project) return fail("a squad start needs a project");
    const removing = openRemoval(x.store, project);
    if (removing !== null) return fail(`'${project}' is being removed (request ${removing})`);
    if (typeof p.framing !== "string" || !p.framing.trim()) return fail("say what the squad should do: the text is empty");

    let framingFile: string;
    try { framingFile = writeStartFraming(x.store.root, project, id, p.framing, p.files, { strict: true }); }
    catch (e) { return fail(e instanceof GoneFile ? e.message : `could not write the brief: ${(e as Error)?.message ?? e}`); }

    let base: string, namedBy: "operator" | "model" | "fallback", agent: string | null = null, nameWhy = "";
    if (p.slug) { base = p.slug; namedBy = "operator"; }
    else {
      const n = await modelName(x, project, p.framing);
      agent = n.agent; nameWhy = n.why;
      if (n.name) { base = n.name; namedBy = "model"; } else { base = fallbackName(p.framing); namedBy = "fallback"; }
    }
    const framing = readFileSync(framingFile, "utf8");
    const roster = effectiveRoster(x.store, project), disp = readDisp(x.store.root, project), from = studioHandle(x.store, project);
    const prov = word(x.store, project, "worktree_provider");
    let refused: string | null = null;
    const out = x.store.tx(() => {
      // Checked again inside the write: a squad or another start may have taken the name during the model call.
      const taken = takenNames(x.store, project, id);
      if (namedBy === "operator" && taken.has(base)) { refused = `squad ${base} already exists in ${project}`; return null; }
      const topic = namedBy === "operator" ? base : freeName(base, taken);
      const w = squadWish({ label: project, topic, repo: project, type: p.type, autonomy: p.autonomy, backend: p.backend, framing, start: p.start,
        from, disp, roster, placed: placedBackend(x.store, project, topic), worktreeProvider: prov });
      if ("error" in w) { refused = w.error; return null; }
      x.store.want("squad", `${w.label}/${w.topic}`, "running", { payload: w.payload, fill: w.fill, by: "board", why: "board start" });
      const result = { ok: true, topic: w.topic, named_by: namedBy, agent, ...(nameWhy && nameWhy !== "ok" ? { name_why: nameWhy } : {}), framing_file: framingFile };
      finishRequest(x.store, a, result, x.now);
      return result;
    });
    if (!out) return fail(refused ?? "the squad was not started");
    logStart(x, a, out);
    return { done: true, result: `${out.topic} (${namedBy})` };
  },
  giveUp(a, x, why) {
    logStart(x, a, { ok: false, error: why });
    return failRequest(a, x, why);
  },
};
export default squadStart;
