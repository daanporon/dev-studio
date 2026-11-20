// settings-files.ts — a project settings file that reappears after the cut-over (U256). After the state
// root's mark (settings-mark.ts) a project's limits, roles, models and ship mode are its `config` rows,
// and state/<label>/{limits,roles,models}.conf and ship-mode are never read: an old script, a restored
// backup or a hand edit that writes one changes nothing. So the operator hears of it, once: one Studio
// alert per file and version (episode `<file>@<mtime>`), which says how to apply it (`ds config import`)
// and clears when the file goes. The file is not read, moved or deleted here.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { alertId } from "../core/actuator.ts";
import { PROJECT_FILES } from "../db/import-config.ts";
import type { Action, Reconciler } from "../core/plugins.ts";
import { settingsMigrated } from "../settings/settings-mark.ts";

export const SUBJECT = "settings-file:";

const settingsFiles: Reconciler = {
  name: "settings-files",
  run({ store, project: P }) {
    if (!settingsMigrated(store.root)) return [];
    const actions: Action[] = [];
    const claim = (subject: string, kind: string) => store.get("episodes", { project: P, subject, kind: `action:${kind}` })?.episode_key;
    for (const file of PROJECT_FILES) {
      const subject = `${SUBJECT}${file}`, path = join(store.root, P, file);
      const sent = claim(subject, "alert"), up = typeof sent === "string" && claim(subject, "alert-clear") !== `cleared@${sent}` ? sent : null;
      if (!existsSync(path)) {
        if (up) actions.push({ project: P, squad: null, member: null, subject, kind: "alert-clear", episode: `cleared@${up}`, payload: { target: "project", id: alertId(subject, up) } });
        continue;
      }
      const ep = `${file}@${Math.floor(statSync(path).mtimeMs / 1000)}`;
      if (up && up !== ep) actions.push({ project: P, squad: null, member: null, subject, kind: "alert-clear", episode: `cleared@${up}`, payload: { target: "project", id: alertId(subject, up) } });
      actions.push({ project: P, squad: null, member: null, subject, kind: "alert", episode: ep, payload: {
        title: `${P}: ${file} is not read`,
        text: `state/${P}/${file} appeared, but ${P}'s settings live in loop.db since the settings cut-over, so it changes nothing. ` +
          `Apply it with \`ds config import --project ${P} ${path}\`, or change a setting with \`ds config set\` or the board's Settings; then remove the file.`,
        card: "settings_file" } });
    }
    return actions;
  },
};
export default settingsFiles;
