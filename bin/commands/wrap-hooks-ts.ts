// ds wrap-hooks-ts — undo the old settings.json gate of the lavish-axi, gh-axi and chrome-devtools-axi SessionStart hooks
// (U272): what bin/host/wrap-hooks.sh runs. --unwrap (default) rewrites every account's settings.json that is still
// wrapped; --check says per account "plain" or "wrapped (stale)" and exits 1 when one is stale.
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backend, writeErr, writeOut } from "../lib/shared";

export const help = `[--unwrap|--check] — undo the old settings.json gate of the axi SessionStart hooks (wrap-hooks.sh)`;

// A wrapped command: "<ds> hook-gate <name> -- <name>".
const WRAPPED = /^.* hook-gate (lavish-axi|gh-axi|chrome-devtools-axi) -- (lavish-axi|gh-axi|chrome-devtools-axi)$/;

/** The command objects of .hooks.SessionStart[].hooks[] (jq's `?` skips what is not an array). */
function hookEntries(doc: any): any[] {
  const out: any[] = [];
  const hooks = doc.hooks;
  if (hooks === null || hooks === undefined) return out;
  if (typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("hooks is not an object");
  const ss = hooks.SessionStart;
  if (!Array.isArray(ss)) return out;
  for (const s of ss) {
    if (s === null || typeof s !== "object") continue;
    if (Array.isArray(s)) throw new Error("array entry");
    if (Array.isArray(s.hooks)) out.push(...s.hooks);
  }
  return out;
}

function unwrapDoc(doc: any): void {
  for (const h of hookEntries(doc)) {
    if (h !== null && typeof h === "object" && !Array.isArray(h) && "command" in h && typeof h.command === "string" && WRAPPED.test(h.command)) h.command = h.command.replace(/^.* -- /, "");
  }
}

function countWrapped(doc: any): number {
  let n = 0;
  for (const h of hookEntries(doc)) {
    if (h === null || typeof h !== "object" || Array.isArray(h)) throw new Error("not an object");
    const c = h.command;
    if (c === null || c === undefined || c === false) continue;
    if (typeof c !== "string") throw new Error("command is not a string");
    if (WRAPPED.test(c)) n++;
  }
  return n;
}

/** jq -S: keys sorted at every level. */
function sorted(v: any): any {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
  return v;
}

/** targets: [label, config dir] per account, de-duplicated by dir. */
async function targets(): Promise<[string, string][]> {
  const seen = new Set<string>(); const out: [string, string][] = [];
  const emit = (label: string, dir: string): void => { if (seen.has(dir)) return; seen.add(dir); out.push([label, dir]); };
  emit("system", process.env.CLAUDE_SYSTEM_DIR || join(process.env.HOME ?? "", ".claude"));
  if (process.env.CLAUDE_CONFIG_DIR) emit("env", process.env.CLAUDE_CONFIG_DIR);
  // install.sh hands over the rows it already read (DS_WRAP_ACCOUNTS: "<account>\t<config dir>"); alone, one
  // backend start (`preflight`) reads the runtime and every account's config dir.
  let rows: string;
  if (process.env.DS_WRAP_ACCOUNTS !== undefined) rows = process.env.DS_WRAP_ACCOUNTS;
  else {
    const r = await backend(["preflight"]);
    rows = r.out.split("\n").map((l) => l.split("\t")).filter((f) => f[0] === "claude" && f[1] && f[3]).map((f) => `${f[1]}\t${f[3]}`).join("\n");
  }
  for (const line of rows.split("\n")) {
    const [acct, cfg] = line.split("\t");
    if (acct && cfg) emit(acct, cfg);
  }
  return out;
}

export async function run(argv: string[]): Promise<number> {
  let check = false;
  const a = argv[0] ?? "";
  if (a === "--check") check = true;
  else if (a !== "" && a !== "--unwrap") { writeErr("usage: wrap-hooks.sh [--unwrap|--check]\n"); return 2; }

  let stale = false;
  for (const [label, dir] of await targets()) {
    const cfg = join(dir, "settings.json"), bak = `${cfg}.ds-hooks-backup`;
    if (!existsSync(cfg) || !statSync(cfg).isFile()) { writeOut(`wrap-hooks: ${label}: no ${cfg} — plain\n`); continue; }
    let n = -1;
    try { n = countWrapped(JSON.parse(readFileSync(cfg, "utf8"))); } catch { n = -1; }
    if (n < 0) { writeErr(`wrap-hooks: ${label}: ${cfg} is not readable JSON — left alone\n`); continue; }
    if (n === 0) { writeOut(`wrap-hooks: ${label}: plain (${cfg})\n`); continue; }
    if (check) { writeOut(`wrap-hooks: ${label}: wrapped (stale) — ${n} hook(s) in ${cfg}; run bin/host/wrap-hooks.sh\n`); stale = true; continue; }
    // The backup restores byte for byte only while settings.json is still exactly as wrapped.
    let same = false;
    if (existsSync(bak)) {
      try { const d = JSON.parse(readFileSync(cfg, "utf8")); unwrapDoc(d); same = JSON.stringify(sorted(d)) === JSON.stringify(sorted(JSON.parse(readFileSync(bak, "utf8")))); } catch { same = false; }
    }
    if (same) {
      copyFileSync(bak, cfg); try { chmodSync(cfg, statSync(bak).mode & 0o7777); } catch { /* keep */ }
      writeOut(`wrap-hooks: ${label}: restored ${cfg} from its backup\n`);
    } else {
      const d = JSON.parse(readFileSync(cfg, "utf8")); unwrapDoc(d);
      const tmp = `${cfg}.${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n", { mode: 0o600 });
      try { chmodSync(tmp, statSync(cfg).mode & 0o7777); } catch { /* keep */ }
      renameSync(tmp, cfg);
      writeOut(`wrap-hooks: ${label}: unwrapped the gated start hooks in ${cfg}\n`);
    }
    rmSync(bak, { force: true });
  }
  return stale ? 1 : 0;
}
