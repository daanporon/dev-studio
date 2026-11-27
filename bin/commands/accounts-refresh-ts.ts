// ds accounts-refresh-ts — bin/lib/accounts-refresh.sh, ported (U274): rewrite state/accounts.tsv (the picker's
// and the board's view of every account) from the account list + the backend's account-usage + limited, with the
// limit episodes in .accounts.episodes beside it. The header comment of bin/lib/accounts-refresh.sh describes the
// columns and the episode rules.
// Issue #125 (U1): the list is loop.db's accounts table plus Orca's host profiles, whatever the backend, and
// the refresh writes accounts-orca.tsv and account-folders.tsv beside accounts.tsv for the state observer
// (bin/lib/accounts-list.ts). It never writes loop.db.
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountSkillsCheck, claudePlan, skillsCell } from "../lib/account-skills";
import { hostBackendPath, globJson, readIfs, run as runCmd, stateRoot, writeErr } from "../lib/shared";
import { globNames } from "../lib/install";
import { accountList } from "../lib/accounts-list";
import { claude } from "../lib/account-kinds/claude.ts";
import { systemJsonDir } from "../loop/drivers/claude-launch.ts";
import { dbPath, open } from "../loop/core/store.ts";
import { contractLimited } from "../loop/capacity/contract-limited.ts";

export const help = `[--limited <file>] [--max-age <s>] — rewrite state/accounts.tsv from the backend's accounts, usage and limits (accounts-refresh.sh)`;

const HEADER = "agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\tskills\tplan\tresets\n";
const POOL = /Request rejected \(429\)|All credentials.*cooling down|Usage limit reset|Continuing automatically/s;

const mtime = (p: string): number => { try { return Math.floor(statSync(p).mtimeMs / 1000); } catch { return 0; } };
const lines = (s: string): string[] => s.split("\n");
const stripNl = (s: string): string => s.replace(/\n+$/, "");
const isInt = (s: string): boolean => /^[0-9]+$/.test(s);

/** awk's `a > b`: numeric when both look like numbers, else a string compare. */
const isNum = (s: string): boolean => /^[ \t]*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?[ \t]*$/.test(s);
function awkGt(a: string, b: string): boolean {
  return isNum(a) && isNum(b) ? Number(a) > Number(b) : a > b;
}

/** `<agent>\t<account>` of the member on worktree `wt` in any squad state file; "" when it isn't found or
 *  has no recorded account (no guessing a default login). */
function memberOf(root: string, wt: string): string {
  let row: string | null = null;
  outer: for (const label of globNames(root)) {
    for (const f of globJson(join(root, label, "squads"))) {
      let d: any;
      try { d = JSON.parse(readFileSync(f, "utf8")); } catch { break outer; } // jq stops at a file it can't parse
      const ms = d && typeof d === "object" && !Array.isArray(d) ? d.members : undefined;
      if (!ms || typeof ms !== "object") continue;
      for (const m of Object.values(ms as object)) {
        if (m !== null && (typeof m !== "object" || Array.isArray(m))) break; // jq errors out of this file
        if (!m || (m as any).wt !== wt) continue;
        const cell = (v: unknown) => v === null || v === undefined || v === false ? "" : typeof v === "string"
          ? v.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r") : String(v);
        row = `${cell((m as any).agent)}\t${cell((m as any).account)}`;
        break outer;
      }
    }
  }
  if (!row) return "";
  let [agent, acct] = readIfs(row, 2, "\t");
  if (!agent) agent = "claude";
  return acct ? `${agent}\t${acct}` : "";
}

export async function run(argv: string[]): Promise<number> {
  const root = stateRoot();
  const now = process.env.DS_NOW || String(Math.floor(Date.now() / 1000));
  const OUT = join(root, "accounts.tsv"), EPI = join(root, ".accounts.episodes");
  let limitedFile = "", maxAge = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limited") { limitedFile = argv[++i] ?? ""; continue; }
    if (argv[i] === "--max-age") { maxAge = argv[++i] ?? ""; continue; }
    writeErr(`accounts-refresh: unknown argument '${argv[i]}'\n`);
    return 2;
  }
  const fallback = Number(process.env.DS_ACCOUNTS_LIMIT_S || 3600);
  mkdirSync(root, { recursive: true });
  if (maxAge && existsSync(OUT) && Number(now) - mtime(OUT) < Number(maxAge)) return 0;
  const LOCK = join(root, ".accounts-refresh.lock");
  if (existsSync(LOCK) && Math.floor(Date.now() / 1000) - mtime(LOCK) > 600) { try { rmdirSync(LOCK); } catch { /* taken */ } }
  try { mkdirSync(LOCK); } catch { return 0; }
  try {
    const be = hostBackendPath();
    const out = async (args: string[]) => stripNl((await runCmd([be, ...args])).out);
    // Issue #125: the list is loop.db's accounts table plus this run's Orca profiles, never the backend's
    // account-list. A table that cannot be read keeps last run's files.
    const listed = await accountList(root);
    if (!listed) return 0;
    const LIST = listed.join("\n");
    const USAGE = await out(["account-usage"]);
    // account-free-resets U3: each account's free resets (`<agent>\t<account>\t<json>`); a failed call is `-` for every row.
    const RESETS = await out(["account-resets"]);
    let LIM: string;
    if (limitedFile) { try { LIM = stripNl(readFileSync(limitedFile, "utf8")); } catch { LIM = ""; } }
    else {
      LIM = await out(["limited"]);
      // U35: the squads off Orca (tmux, herdr): the same screen match over their members' tails the contract observer keeps.
      if (existsSync(dbPath())) {
        try {
          const st = open();
          try { LIM = stripNl(`${LIM}\n${contractLimited(st, Number(now), Number(process.env.DS_SWEEP_SILENT_MIN || "10"))}`).replace(/^\n+/, ""); } finally { st.close(); }
        } catch { /* no readable loop.db: Orca's rows stand */ }
      }
    }

    // Episodes: key (wt|notice) \t until \t agent \t account — set once per episode, kept until it passes.
    let epiText: string | null = null;
    try { epiText = readFileSync(EPI, "utf8"); } catch { /* none yet */ }
    const epiLines = epiText === null ? [] : epiText.split("\n").slice(0, epiText.endsWith("\n") ? -1 : undefined);
    const fresh: string[] = [], seen = new Set<string>();
    for (const l of lines(LIM)) {
      const [wt, reset, notice, , kind] = readIfs(l, 5, "\t");
      if (!wt) continue;
      const key = `${wt}|${notice}`;
      seen.add(key);
      const old = epiLines.find((e) => e.split("\t")[0] === key);
      if (old) { fresh.push(old); continue; }
      // Not a limit on a known account (pool 429, ended limit, no recorded account, a billing error, an ended login): the
      // episode still records its timing so the sweep can bound a dialog on it, but names no account.
      let who = memberOf(root, wt) || "-\t-";
      if (kind === "credits" || kind === "login" || POOL.test(notice)) who = "-\t-";
      const until = isInt(reset) ? reset : String(Number(now) + fallback);
      fresh.push(`${key}\t${until}\t${who}`);
    }
    // Carry over episodes whose notice is gone but whose time hasn't passed.
    for (const l of epiLines) {
      const [key, until, rest] = readIfs(l, 3, "\t");
      if (!key || seen.has(key)) continue;
      if (/^-?[0-9]+$/.test(until) && /^-?[0-9]+$/.test(now) && Number(until) > Number(now)) fresh.push(`${key}\t${until}\t${rest}`);
    }
    writeFileSync(`${EPI}.tmp`, fresh.map((l) => l + "\n").join(""));
    renameSync(`${EPI}.tmp`, EPI);

    // Per-account skills verdict: "<account>\t<ok|broken|warn>\t<reason>".
    let SKILLS = "";
    const claudes = lines(LIST).map((l) => l.split("\t")).filter((f) => f[0] === "claude" && f[1])
      .map((f) => ({ account: f[1], dir: f[3] || claude.systemDir(process.env) }));
    accountSkillsCheck(true, { out: (s) => { SKILLS += s; }, err: () => {} }, claudes);
    // Per-account plan: "<agent>\t<account>\t<plan>" for the accounts that have one, from each login folder.
    const plans: string[] = []; // awk reads them as `printf '%s\n' "$PLANS"`: none is one empty line
    for (const l of lines(LIST)) {
      const [pa, pc, , dir] = l.split("\t");
      if (pa !== "claude" || !pc) continue;
      const p = claudePlan(join(pc === "system" ? systemJsonDir(process.env) : dir, ".claude.json"));
      if (p) plans.push(`${pa}\t${pc}\t${p}`);
    }

    const lim = new Map<string, string>();
    for (const l of fresh) {
      const e = l.split("\t");
      const k = `${e[2] ?? ""}\t${e[3] ?? ""}`, u = e[1] ?? "";
      // awk's unset lim[k] is 0 against a number and "" against a string
      if (awkGt(u, now) && (lim.has(k) ? awkGt(u, lim.get(k)!) : isNum(u) ? Number(u) > 0 : u !== "")) lim.set(k, u);
    }
    const sk = new Map<string, string>();
    for (const l of lines(stripNl(SKILLS))) {
      const f = l.split("\t");
      if (f[1] === "ok" || f[1] === "broken" || f[1] === "warn") sk.set(f[0], skillsCell(f[1], f[2]));
    }
    const usage = new Map<string, string>(), note = new Map<string, string>();
    for (const l of lines(USAGE)) {
      const f = l.split("\t"), k = `${f[0]}\t${f[1] ?? ""}`;
      usage.set(k, [f[2], f[3], f[4], f[5]].map((x) => x ?? "").join("\t"));
      note.set(k, (f[6] ?? "") !== "" ? f[6] : "-");
    }
    const pl = new Map<string, string>();
    for (const l of plans.length ? plans : [""]) { const f = l.split("\t"); pl.set(`${f[0]}\t${f[1] ?? ""}`, f[2] ?? ""); }
    const rs = new Map<string, string>();
    for (const l of lines(RESETS)) {
      const f = l.split("\t");
      if (f.length >= 3 && f[0] && f[1]) rs.set(`${f[0]}\t${f[1]}`, f.slice(2).join(" ").replace(/[\t\r\n]/g, " "));
    }
    let text = HEADER;
    for (const l of lines(LIST)) {
      const f = l.split("\t"), a = f[0], c = f[1] ?? "", k = `${a}\t${c}`;
      const limit = lim.has(k) && awkGt(lim.get(k)!, "0") ? lim.get(k)! : "-";
      text += [a, c, usage.get(k) ?? "-\t-\t-\t-", limit, now, (f[2] ?? "") !== "" ? f[2] : c, note.get(k) ?? "-",
        a === "claude" && sk.has(c) ? sk.get(c)! : "-", pl.get(k) ?? "-", rs.get(k) || "-"].join("\t") + "\n";
    }
    writeFileSync(`${OUT}.tmp`, text);
    renameSync(`${OUT}.tmp`, OUT);
    return 0;
  } finally {
    try { rmdirSync(LOCK); } catch { /* gone */ }
  }
}
