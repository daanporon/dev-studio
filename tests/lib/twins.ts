// twins.ts — the TypeScript twins of the helpers U274 moved from the shared shell library to TypeScript, under their old shell
// names, so a shell test keeps its cases and now checks the TS side: `bun tests/lib/twins.ts <name> <args…>`
// prints what the shell function printed and exits with its status. tests/lib/twins.sh defines the
// shell functions that call it. Each case imports only its own module: a test calls this once per case.
const [name, ...a] = process.argv.slice(2);
const out = (s: string) => process.stdout.write(s);
const at = (i: number) => a[i] ?? "";
const lib = () => import("../../bin/lib/lib");
const operator = () => import("../../bin/lib/operator");
// The settings readers read `config` rows (U257): first import the test's project conf files, as the loop's
// config observer would (tests/lib/observe-config.ts). Only in a test's own state root.
if (["ds_limit", "ds_limit_src", "ds_compact_window", "ds_ship_mode", "ds_role_row", "pr_health"].includes(name) && process.env.DS_STATE_ROOT) {
  (await import("./observe-config.ts")).observeConfig(process.env.DS_STATE_ROOT);
}

switch (name) {
  case "ds_limit": out((await lib()).dsLimit(at(0), at(1)) + "\n"); break;
  case "ds_limit_src": { const [v, src] = (await operator()).limitSrc(at(0), at(1)); out(`${v}\t${src}\n`); break; }
  case "ds_compact_window": out((await lib()).compactWindowOf(at(0), at(1)) + "\n"); break;
  case "ds_ship_mode": out((await operator()).shipMode(at(0), at(1))); break;
  case "ds_muse_resolve": out((await import("../../bin/loop/capacity/pick")).museResolve(at(0))); break;
  case "ds_notes_note": out((await import("../../bin/loop/squad/handoff")).notesNote({ project: at(0), role: at(1) })); break;
  case "ds_role_spec": out((await import("../../bin/loop/reconcilers/requests")).roleSpec(at(0), at(1), at(2), at(3), at(4), at(5), at(6))); break;
  case "ds_loop_key": out((await lib()).loopKey(a) + "\n"); break;
  case "ds_role_brief": out((await lib()).roleBrief(at(0), at(1), at(2), at(3))); break;
  case "ds_role_row": out((await lib()).roleRow(at(0), at(1))); break;
  case "wt_probe": { const p = await (await import("../../bin/loop/io/wt-probe")).wtProbe(at(0), 120_000); out(p.out); process.exit(p.code); }
  case "pr_health": { const h = await (await lib()).prHealthLine(at(0), at(1), at(2)); out(h.line + "\n"); process.exit(h.ok ? 0 : 1); }
  default: process.stderr.write(`twins: unknown helper '${name}'\n`); process.exit(2);
}
