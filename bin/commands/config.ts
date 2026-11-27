// ds config — the config rows the loop keeps of conventions/*.conf and a project's settings, and
// (U255) a project's settings read and changed through bin/loop/settings/settings.ts, the one writer:
//   ds config [--project <label>] [--file <file>]          the rows: conventions ('') and that project's
//   ds config get <project> <file> <key>                   the value and where it came from (env, project, host, default)
//   ds config set <project> <file> <key> <value…>          change the project's row (one history row)
//   ds config rm <project> <file> <key>                    drop it (back to the default)
//   ds config reset <project> <file> [<key>]               a key (roles: the role) or the whole file back to the default
//   ds config export --project <label>                     the project's overrides in conf syntax (the backup's text)
//   ds config history --project <label> [--file f] [--key k]
//   ds config import --project <label> <path> [--file <file>]
//                                                          back in from a backup (U256): a settings.export
//                                                          replaces every file's rows, a renamed
//                                                          `<file>.imported-<date>` (or --file) that file's
//                                                          (--dry-run: print what it would change, write nothing)
//   ds config copy <from> <to> [--apply] [--only <file>] [--skip <key>] [--include <key>] [--replace] [--json]
//                                                          the checked copy of <from>'s settings (a project on this host
//                                                          or an export file) into <to>: prints the plan, writes with --apply
//   ds config prune <project> [--apply] [--json]           the rows whose key this dev-studio doesn't know; --apply drops them
// <file> is limits.conf, roles.conf, models.conf or ship-mode (key `mode`). A refused change exits 2. The
// rows are the only copy of a project's settings (U256): nothing reads state/<label>/<file>.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parse, print, shape } from "../loop/core/cli.ts";
import {
  applyImport, backendChangeNote, EXPORT_SECTION, exportSections, exportTransfer, get, historyOf, IMPORT_FILES, importActor, importText, planImport, previewText, prune, reset, rm, set,
  SETTINGS_FILES, SettingsError, staleRows, type Change, type ImportPick, type ImportSource, type PlanRow,
} from "../loop/settings/settings.ts";
import { openSettings } from "../loop/settings/settings-migrate.ts";

export const help = "[--project <label>] [--file <file>] | get|set|rm|reset <project> <file> <key> [<value>] | copy <from> <to> | prune <project> | export|history|import --project <label> — config rows and a project's settings (bin/loop/settings/settings.ts)";

const USAGE = "usage: ds config [--project <label>] [--file <file>] | get <project> <file> <key> | set <project> <file> <key> <value…> | rm <project> <file> <key> | reset <project> <file> [<key>] | export --project <label> | history --project <label> [--file <file>] [--key <key>] | import --project <label> <path> [--file <file>] [--dry-run] | copy <from> <to> [--apply] [--only <file>] [--skip <key>] [--include <key>] [--replace] [--json] | prune <project> [--apply] [--json]\n";

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

// --only, --skip and --include may repeat and take comma lists: pull them out before parse.
function takeLists(args: string[]): { rest: string[]; lists: Record<"only" | "skip" | "include", string[]> } {
  const lists = { only: [] as string[], skip: [] as string[], include: [] as string[] }, rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const n = args[i].slice(2);
    if (args[i].startsWith("--") && n in lists) {
      if (args[i + 1] === undefined) throw new SettingsError(`${args[i]} needs a value`);
      lists[n as keyof typeof lists].push(...args[++i].split(",").filter(Boolean));
    } else rest.push(args[i]);
  }
  return { rest, lists };
}

const cell = (v: string | null): string => (v === null ? "-" : v.length > 60 ? `${v.slice(0, 57)}...` : v);
function planLine(r: PlanRow, picked: boolean): string {
  const arrow = r.action === "remove" ? `${cell(r.current)} → (drop)` : r.action === "same" ? cell(r.value ?? r.current) : r.action === "skip" ? `${cell(r.current)} → ${cell(r.value ?? r.raw ?? null)}` : `${cell(r.current)} → ${cell(r.value)}`;
  const why = r.why ? `  (${r.why})` : r.warn ? `  (warning: ${r.warn})` : "";
  return `${picked ? "[x]" : "[ ]"} ${r.action.padEnd(6)} ${r.file.padEnd(11)} ${r.key}  ${arrow}${why}`;
}

function copy(s: ReturnType<typeof openSettings>, from: string, to: string, flag: Set<string>, lists: Record<"only" | "skip" | "include", string[]>, by: string | undefined): number {
  const isFile = existsSync(from) && statSync(from).isFile();
  const src: ImportSource = isFile ? { text: readFileSync(from, "utf8"), name: basename(from) } : { project: from };
  for (const f of lists.only) if (!(IMPORT_FILES as readonly string[]).includes(f)) throw new SettingsError(`--only ${f}: not a settings file (${IMPORT_FILES.join(", ")})`);
  const plan = planImport(s, to, src, { replace: flag.has("replace") });
  const known = new Set(plan.map((r) => r.key));
  for (const k of [...lists.skip, ...lists.include]) if (!known.has(k)) throw new SettingsError(`no row for key '${k}' in the plan`);
  const pick = new Map<PlanRow, boolean>();
  for (const r of plan) {
    let on = r.pick && (!lists.only.length || lists.only.includes(r.file)) && !lists.skip.includes(r.key);
    if (lists.include.includes(r.key) && (!lists.only.length || lists.only.includes(r.file)) && !lists.skip.includes(r.key)) {
      if (!r.can_pick) throw new SettingsError(`--include ${r.key}: can't be copied (${r.why ?? r.action})`);
      on = true;
    }
    pick.set(r, on);
  }
  const picks: ImportPick[] = plan.filter((r) => pick.get(r)).map((r) => ({ file: r.file, key: r.key, expect: r.current }));
  const res = flag.has("apply") ? applyImport(s, to, src, picks, by ? by : importActor(src), { replace: flag.has("replace") }) : null;
  if (flag.has("json")) {
    print({ from, to, applied: res !== null, plan: plan.map((r) => ({ ...r, pick: pick.get(r) })), ...(res ? { result: res } : {}) });
    return 0;
  }
  for (const r of plan) console.log(planLine(r, pick.get(r) === true));
  if (!res) { process.stderr.write(`${picks.length} of ${plan.length} rows picked; nothing written (--apply writes them)\n`); return 0; }
  for (const x of res.skipped) process.stderr.write(`not written: ${x.file} ${x.key}: ${x.why}\n`);
  for (const x of res.stale) process.stderr.write(`not written: ${x.file} ${x.key}: changed since the plan (${cell(x.current)})\n`);
  process.stderr.write(`${res.written.length} rows written to ${to}\n`);
  return 0;
}

function pruneRows(s: ReturnType<typeof openSettings>, project: string, flag: Set<string>, by: string | undefined): number {
  const rows = staleRows(s, project);
  const dropped = flag.has("apply") ? prune(s, project, by ?? "ds prune") : [];
  if (flag.has("json")) { print({ project, applied: flag.has("apply"), rows, dropped }); return 0; }
  for (const r of rows) console.log(`${flag.has("apply") ? "dropped" : "stale  "} ${r.file.padEnd(11)} ${r.key}  ${cell(r.value)}`);
  process.stderr.write(!rows.length ? "no stale rows\n" : flag.has("apply") ? `${dropped.length} rows dropped\n` : `${rows.length} stale rows; nothing written (--apply drops them)\n`);
  return 0;
}

export async function run(args: string[]): Promise<number> {
  const sub = ["get", "set", "rm", "reset", "export", "history", "import", "copy", "prune"].includes(args[0] ?? "") ? args[0] : null;
  const { rest, lists } = takeLists(sub ? args.slice(1) : args);
  const { pos, opt, flag } = parse(rest, ["project", "file", "key", "by"], ["dry-run", "apply", "replace", "json"]);
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
        { const cs = set(s, pos[0], pos[1], pos[2], pos.slice(3).join(" "), by), r = changed(cs), note = backendChangeNote(s, pos[0], cs); if (note) process.stderr.write(note + "\n"); return r; }
        case "rm":
          if (pos.length !== 3) break;
          return changed(rm(s, pos[0], pos[1], pos[2], by));
        case "reset":
          if (pos.length !== 2 && pos.length !== 3) break;
          return changed(reset(s, pos[0], pos[1], pos[2] ?? null, by));
        case "export":
          if (!opt.project || pos.length) break;
          process.stdout.write(exportTransfer(s, opt.project));
          return 0;
        case "import": {
          if (!opt.project || pos.length !== 1) break;
          const project = opt.project, files = backupFiles(pos[0], opt.file);
          if (flag.has("dry-run")) {
            const cs = files.flatMap(([f, text]) => previewText(s, project, f, text));
            print(cs);
            process.stderr.write(cs.length ? `dry run: ${cs.length} rows would change, nothing written\n` : "dry run: no change\n");
            return 0;
          }
          return changed(files.flatMap(([f, text]) => importText(s, project, f, text, by)));
        }
        case "copy":
          if (pos.length !== 2) break;
          return copy(s, pos[0], pos[1], flag, lists, opt.by);
        case "prune":
          if (pos.length !== 1) break;
          return pruneRows(s, pos[0], flag, opt.by);
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
