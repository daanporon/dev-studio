// fulfil/config.ts — kinds `limits` and `roles`: the board's Settings and Roles edits (U15), written
// through bin/loop/settings/settings.ts (U256), the one writer of a project's settings rows, so each leaves a
// config_history row by `board` and the backup state/<label>/settings.export is rewritten. Payloads:
//   limits  {key, value}    value null drops the project's override (back to the default)
//   config-undo {file, key, history}  put the key back to what its last change (history row id) replaced:
//               its old value, or no row when there was none; the undo is a change with a history row of
//               its own. A key changed since the board showed it (a newer history row) is refused.
//   settings-import {text|from, name?, picks: [{file, key, expect}]}  the board's Import dialog: applyImport (settings.ts)
//               writes the picked rows as actor `board`; the result lists written, skipped (why) and stale
//   roles   {role, reset: true} | {role, agent, model, spawn, effort, fallbacks, plan}
// The row is written before the request is done, so a done request means the board's GET already
// shows the change. No file is written: there is none to disagree about where roles.conf lives. A root
// the config observer has not cut over yet is cut over first (settings-migrate.ts), so the edit lands
// on the rows every reader then uses, not under a file that would still win.
import { failRequest, finishRequest, requestActions, type Fulfiller } from "../core/actuator.ts";
import { migrateSettings } from "../settings/settings-migrate.ts";
import { applyImport, historyOf, reset, rm, set, SettingsError, type Change, type ImportPick, type ImportSource } from "../settings/settings.ts";
import type { Store } from "../core/store.ts";

type P = { file?: string; history?: number; key?: string; value?: string | null; role?: string; reset?: boolean; agent?: string; model?: string; spawn?: string; effort?: string; fallbacks?: string; plan?: string };

export const BOARD_ACTOR = "board";

// The settings call for one edit and what it ran, or null when the payload doesn't say enough.
function edit(kind: string, project: string, p: P): { ran: string; go: (s: Store) => Change[] } | null {
  if (kind === "limits") {
    if (!p.key) return null;
    const key = p.key;
    if (p.value == null) return { ran: `rm ${project} limits.conf ${key}`, go: (s) => rm(s, project, "limits.conf", key, BOARD_ACTOR) };
    const value = String(p.value);
    return { ran: `set ${project} limits.conf ${key} ${value}`, go: (s) => set(s, project, "limits.conf", key, value, BOARD_ACTOR) };
  }
  if (kind === "config-undo") {
    if (!p.key || !p.history || (p.file !== "limits.conf" && p.file !== "roles.conf")) return null;
    const { file, key, history } = { file: p.file, key: p.key, history: p.history };
    return { ran: `undo ${project} ${file} ${key}`, go: (s) => {
      const last = historyOf(s, project, file, key).at(-1);
      if (!last || last.id !== history) throw new SettingsError(`${key} changed since the board showed it; reload and try again`);
      if (last.actor === "migration") throw new SettingsError(`${key} was imported; there is nothing before it to go back to`);
      return last.old_value == null ? rm(s, project, file, key, BOARD_ACTOR) : set(s, project, file, key, last.old_value, BOARD_ACTOR);
    } };
  }
  if (!p.role) return null;
  const role = p.role;
  if (p.reset) return { ran: `reset ${project} roles.conf ${role}`, go: (s) => reset(s, project, "roles.conf", role, BOARD_ACTOR) };
  if (!p.agent || !p.model || !p.spawn) return null;
  // An empty field is `-`, so a later one keeps its place; an absent plan keeps the row's own.
  const value = [p.agent, p.model, p.spawn, p.effort || "-", p.fallbacks || "-", ...(p.plan === undefined ? [] : [p.plan || "-"])].join(" ");
  return { ran: `set ${project} roles.conf ${role} ${value}`, go: (s) => set(s, project, "roles.conf", role, value, BOARD_ACTOR) };
}

// The board's import: the source is another project's rows or the export text the dialog sent.
function importOf(project: string, p: { text?: string; from?: string; name?: string; picks?: unknown[] }) {
  const src: ImportSource | null = p.from ? { project: p.from } : typeof p.text === "string" ? { text: p.text, name: p.name } : null;
  if (!src || !Array.isArray(p.picks)) return null;
  const picks = p.picks as ImportPick[];
  return { ran: `import ${project} from ${"project" in src ? src.project : src.name || "file"}`, go: (s: Store) => applyImport(s, project, src, picks, BOARD_ACTOR, { board: true }) };
}

const config: Fulfiller = {
  name: "config",
  scope: "host",
  kinds: ["limits", "roles", "config-undo", "settings-import"],
  run: (ctx) => requestActions(ctx, ["limits", "roles", "config-undo", "settings-import"]),
  async exec(a, x) {
    if (a.kind === "settings-import") {
      const im = a.project ? importOf(a.project, (a.payload ?? {}) as { text?: string; from?: string; name?: string; picks?: unknown[] }) : null;
      if (!im) return { failed: "a settings-import needs a project, a source (from or text) and picks" };
      try {
        migrateSettings(x.store);
        const r = im.go(x.store);
        finishRequest(x.store, a, { ok: true, ran: im.ran, changed: r.written.length, written: r.written.map((c) => ({ file: c.file, key: c.key })), skipped: r.skipped, stale: r.stale }, x.now);
        return { done: true };
      } catch (err) {
        if (err instanceof SettingsError) return { failed: err.message };
        throw err;
      }
    }
    const e = a.project ? edit(a.kind, a.project, (a.payload ?? {}) as P) : null;
    if (!e) return { failed: `a ${a.kind} edit needs a project and ${a.kind === "limits" ? "a key" : a.kind === "config-undo" ? "a file (limits.conf or roles.conf), a key and a history id" : "a role, agent, model and spawn"}` };
    let changes: Change[];
    try { migrateSettings(x.store); changes = e.go(x.store); } catch (err) {
      if (err instanceof SettingsError) return { failed: err.message };
      throw err;
    }
    finishRequest(x.store, a, { ok: true, ran: e.ran, changed: changes.length }, x.now);
    return { done: true };
  },
  giveUp: failRequest,
};
export default config;
