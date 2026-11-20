// no-broad-kill-hook-ts.ts — bin/hooks/no-broad-kill-hook.sh, ported (U274): the PreToolUse guard (matcher
// Bash) that blocks host-wide process kills from a role terminal. The shell hook runs it (U193: the only body).
// Same stdin, same block/allow result, reason text and exit codes (2 to block, 0 to allow),
// and it fails open: input it does not understand exits 0.
import { writeErr } from "../lib/shared";

export const help = "no-broad-kill-hook-ts — the kill guard PreToolUse hook (bin/hooks/no-broad-kill-hook.sh); hook JSON on stdin";

const reason = (name: string): string =>
  `Blocked: host-wide process kill (${name}) — every squad shares this host, so pkill/killall (or kill fed by pgrep/pidof) can take down other Builders' work. Stop only processes you started: ds stop-mine <pattern> [--dry-run] (scope: your worktree), or kill <PID> for a PID you recorded.`;

/** `jq -r '<path> // empty'` over one value: a string as is, null/false/missing as "", anything else as jq prints it. */
function jqRawOrEmpty(v: unknown): string {
  if (v === undefined || v === null || v === false) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

/** The shell body's split_segments: quote-aware shell segments, one per line. Single-quoted text is
 *  dropped, double quotes become blanks, $(…) and backticks stay inline as " $( ". */
function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let inS = false, inD = false, seg = "", depth = 0;
  const line = cmd + "\n";
  for (let i = 0; i < line.length; i++) {
    const c = line[i], nxt = line[i + 1] ?? "";
    if (inS) { if (c === "'") inS = false; continue; }
    if (c === "'" && !inD) { inS = true; continue; }
    if (c === '"') { inD = !inD; seg += " "; continue; }
    if (c === "$" && nxt === "(") { depth++; seg += " $( "; i++; continue; }
    if (c === "`") { if (depth > 0) depth--; else depth++; seg += " $( "; continue; }
    if (depth > 0) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      seg += c;
      continue;
    }
    if (!inD && ";&|(){}\n".includes(c)) { out.push(seg); seg = ""; continue; }
    seg += c;
  }
  out.push(seg);
  // The shell reads the printed segments back line by line.
  return out.join("\n").split("\n");
}

/** The first word of a segment, skipping sudo/command/builtin and VAR= assignments (awk's fields). */
function firstWord(seg: string): string {
  for (const f of seg.split(/[ \t\n]+/)) {
    if (f === "" || f === "sudo" || f === "command" || f === "builtin") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(f)) continue;
    return f;
  }
  return "";
}

const FEEDER = /(^|[^A-Za-z0-9_-])(pgrep|pidof|pkill|killall)([^A-Za-z0-9_-]|$)/;
const FINDER = /(^|[;&|(){}!`$ ])(pgrep|pidof)( |$|[;&|()])/m;

/** The first word that makes `cmd` a host-wide kill, or null when it is allowed. */
function blockedName(cmd: string): string | null {
  // A finder (pgrep/pidof) anywhere outside quotes (sed per line) — only the xargs shape uses it.
  const dequoted = cmd.split("\n").map((l) => l.replace(/'[^']*'/g, "").replace(/"[^"]*"/g, "")).join("\n");
  const hasFinder = FINDER.test(dequoted);
  for (const seg of splitSegments(cmd)) {
    if (seg.replace(/[ \t]/g, "") === "") continue;
    const fw = firstWord(seg);
    if (!fw) continue;
    const base = fw.slice(fw.lastIndexOf("/") + 1);
    if (base === "pkill" || base === "killall") return fw;
    if (base === "kill") {
      const rest = seg.replace(/^[^ ]* /, "");
      if (/\$\(|`/.test(rest) && FEEDER.test(rest)) return fw;
    } else if (base === "xargs") {
      if (/(^|[ ])(kill|pkill|killall)( |$)/.test(seg) && hasFinder) return fw;
    }
  }
  return null;
}

export async function run(_argv: string[]): Promise<number> {
  let payload = "";
  try { payload = await Bun.stdin.text(); } catch { return 0; }
  let doc: unknown;
  try { doc = JSON.parse(payload); } catch { return 0; } // unreadable input: never block what we can't see
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return 0;
  const d = doc as Record<string, unknown>;
  if (jqRawOrEmpty(d.tool_name) !== "Bash") return 0;
  const input = d.tool_input;
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) return 0;
  const cmd = jqRawOrEmpty((input as Record<string, unknown> | null | undefined)?.command).replace(/\n+$/, "");
  if (!cmd) return 0;
  const name = blockedName(cmd);
  if (name === null) return 0;
  writeErr(reason(name) + "\n");
  return 2;
}
