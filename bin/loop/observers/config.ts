// config.ts — the config observer (U4): the shipped conventions/*.conf into `config` rows (project
// ''), as import-config.ts parses them. The files are the truth for those rows (KTD1): a file is
// re-read when its mtime or size moved, its rows then replaced (a removed line or file drops its rows);
// a file that stood still only has its rows confirmed.
//
// A project's settings (limits, roles, models, ship mode) are not read from files (U256): before its
// first read the observer runs the one-time cut-over (settings-migrate.ts), which imports each
// project's override files into rows and renames them; from then on bin/loop/settings/settings.ts is their
// only writer and the rows their only copy, so nothing here drops them, even when a project's folder
// goes missing. A file that reappears is not read; reconcilers/settings-files.ts raises one alert.
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { confirm, Gate, replace, sig } from "../core/gate.ts";
import { CONF_FILES, confRows } from "../db/import-config.ts";
import type { Observer } from "../core/plugins.ts";
import { settingsMigrated } from "../settings/settings-mark.ts";
import { migrateSettings } from "../settings/settings-migrate.ts";
import { ROOT, type Row } from "../core/store.ts";

export function configObserver(conventions = join(ROOT, "conventions")): Observer {
  const gate = new Gate();
  let catalogAt = -Infinity;
  return {
    name: "config",
    scope: "host",
    run({ store, now }) {
      // The board stays read-only: snapshot the CLI's bundled catalog here. No
      // provider request or inference is made, and older CLIs use models.conf.
      if (now - catalogAt >= 300) {
        const out = spawnSync(join(ROOT, "bin/lib/codex-models.sh"), { encoding: "utf8", timeout: 6000 });
        if (out.status === 0) {
          const rows = out.stdout.trim().split("\n").filter(Boolean).map((line) => {
            const c = JSON.parse(line) as { agent: string; model: string; label: string; efforts: string[] };
            return { table: "config", key: { project: "", file: "codex-models", key: `${c.agent}|${c.model}` },
              set: { value: `${c.label} | ${c.efforts.join(",") || "-"}`, observed_at: now } };
          });
          store.tx(() => replace(store, rows, now, [["config", { project: "", file: "codex-models" }]]));
        }
        catalogAt = now;
      }
      if (!settingsMigrated(store.root)) {
        try {
          const done = migrateSettings(store, store.root, undefined, { now });
          if (done?.length) console.error(`config: settings cut over: ${done.map((m) => `${m.project}/${m.file} (${m.rows} rows)`).join(", ")}`);
        } catch (e) { console.error(`config: settings cut-over failed, tried again next tick: ${(e as Error).message}`); }
      }
      // One transaction per file, as in documents.ts.
      for (const file of CONF_FILES) {
        const path = join(conventions, file), scope: [string, Row][] = [["config", { project: "", file }]];
        store.tx(() => gate.run(file, sig(path), () => replace(store, confRows("", file, path), now, scope), () => confirm(store, now, scope)));
      }
      store.tx(() => gate.keep(CONF_FILES));
    },
  };
}

export default configObserver();
