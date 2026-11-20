// ds config — the config rows the loop keeps of conventions/*.conf and a project's settings, and
// (U255) a project's settings read and changed through bin/loop/settings/settings.ts, the one writer:
//   ds config [--project <label>] [--file <file>]          the rows: conventions ('') and that project's
//   ds config get <project> <file> <key>                   the value and where it came from (env, project, default)
//   ds config set <project> <file> <key> <value…>          change the project's row (one history row)
//   ds config rm <project> <file> <key>                    drop it (back to the default)
//   ds config reset <project> <file> [<key>]               a key (roles: the role) or the whole file back to the default
//   ds config export --project <label>                     the project's overrides in conf syntax (the backup's text)
//   ds config history --project <label> [--file f] [--key k]
//   ds config import --project <label> <path> [--file <file>]
//                                                          back in from a backup (U256): a settings.export
//                                                          replaces every file's rows, a renamed
//                                                          `<file>.imported-<date>` (or --file) that file's
// <file> is limits.conf, roles.conf, models.conf or ship-mode (key `mode`). A refused change exits 2. The
// rows are the only copy of a project's settings (U256): nothing reads state/<label>/<file>.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse, print, shape } from "../loop/core/cli.ts";
import { EXPORT_SECTION, exportSections, exportText, get, historyOf, importText, reset, rm, set, SETTINGS_FILES, SettingsError, type Change } from "../loop/settings/settings.ts";
import { openSettings } from "../loop/settings/settings-migrate.ts";

export const help = "[--project <label>] [--file <file>] | get|set|rm|reset <project> <file> <key> [<value>] | export|history|import --project <label> — config rows and a project's settings (bin/loop/settings/settings.ts)";

const USAGE = "usage: ds config [--project <label>] [--file <file>] | get <project> <file> <key> | set <project> <file> <key> <value…> | rm <project> <file> <key> | reset <project> <file> [<key>] | export --project <label> | history --project <label> [--file <file>] [--key <key>] | import --project <label> <path> [--file <file>]\n";

function changed(cs: Change[]): number {
  print(cs);
  if (!cs.length) process.stderr.write("no change\n");
  return 0;
}

// The files a backup at `path` holds: an export's sections (a file it lacks has no overrides), else the
// one file named by --file or by the path's name (`limits.conf.imported-2026-11-17` is limits.conf).
function backupFiles(path: string, file: string | undefined): [string, string][] {
  const text = readFileSync(path, "utf8");
  if (text.split("\n").some((l) => l.startsWith(EXPORT_SECTION))) {
    const parts = exportSections(text);
    // skills.conf only when the export has that section: a backup from before skills were exported
    // leaves the skills rows alone.
    return [...SETTINGS_FILES.map((f): [string, string] => [f, parts[f] ?? ""]), ...(parts["skills.conf"] !== undefined ? [["skills.conf", parts["skills.conf"]] as [string, string]] : [])];
  }
  const f = file ?? SETTINGS_FILES.find((n) => { const b = basename(path); return b === n || b.startsWith(`${n}.imported-`); });
  if (!f) throw new SettingsError(`can't tell which settings file ${path} is: pass --file <file>`);
  return [[f, text]];
}

export async function run(args: string[]): Promise<number> {
  const sub = ["get", "set", "rm", "reset", "export", "history", "import"].includes(args[0] ?? "") ? args[0] : null;
  const { pos, opt } = parse(sub ? args.slice(1) : args, ["project", "file", "key", "by"]);
  const s = openSettings();
  try {
    const by = opt.by ?? "ds";
    try {
      switch (sub) {
        case "get":
          if (pos.length !== 3) break;
          print(get(s, pos[0], pos[1], pos[2]));
          return 0;
        case "set":
          if (pos.length < 4) break;
          return changed(set(s, pos[0], pos[1], pos[2], pos.slice(3).join(" "), by));
        case "rm":
          if (pos.length !== 3) break;
          return changed(rm(s, pos[0], pos[1], pos[2], by));
        case "reset":
          if (pos.length !== 2 && pos.length !== 3) break;
          return changed(reset(s, pos[0], pos[1], pos[2] ?? null, by));
        case "export":
          if (!opt.project || pos.length) break;
          process.stdout.write(exportText(s, opt.project));
          return 0;
        case "import": {
          if (!opt.project || pos.length !== 1) break;
          const project = opt.project;
          return changed(backupFiles(pos[0], opt.file).flatMap(([f, text]) => importText(s, project, f, text, by)));
        }
        case "history":
          if (!opt.project || pos.length) break;
          print(historyOf(s, opt.project, opt.file, opt.key));
          return 0;
        default: {
          if (pos.length) break;
          const rows = s.db.query("SELECT * FROM config WHERE project IN ('', ?) AND (? IS NULL OR file = ?) ORDER BY project, file, key")
            .all(opt.project ?? "", opt.file ?? null, opt.file ?? null) as Record<string, unknown>[];
          print(rows.map((r) => shape(r)));
          return 0;
        }
      }
    } catch (e) {
      if (!(e instanceof SettingsError)) throw e;
      process.stderr.write(`ds config: ${e.message}\n`);
      return 2;
    }
    process.stderr.write(USAGE);
    return 2;
  } finally { s.close(); }
}
