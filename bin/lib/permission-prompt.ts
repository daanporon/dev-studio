// permission-prompt.ts — what a Claude safety-check prompt asks, from its PermissionRequest hook input:
// the text the board shows, the card title, and the prompt's tool_use_id (the hook input carries none,
// so it is read back from the transcript). Used by `picker-hook.sh permission`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../loop/core/redact.ts";

export const SHOWN_CAP = 2000;
const FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** The first `n` codepoints. */
export const head = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

/** The text the prompt is about, redacted, then cut at SHOWN_CAP with a "(cut)" line. */
export function shownText(tool: string, input: any): string {
  let text = JSON.stringify(input ?? {}, null, 2);
  if (tool === "Bash" && str(input?.command)) text = input.command;
  else if (tool === "Edit" && str(input?.file_path)) text = `${input.file_path}\n${str(input.new_string)}`;
  else if (tool === "Write" && str(input?.file_path)) text = `${input.file_path}\n${str(input.content)}`;
  // Redacted before the cut, so a cut never leaves half a secret. Control characters would drive the
  // operator's terminal on the text board.
  text = redact(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "�");
  return Array.from(text).length > SHOWN_CAP ? `${head(text, SHOWN_CAP)}\n… (cut)` : text;
}

export function promptTitle(role: string, tool: string): string {
  const ask = tool === "Bash" ? "run this command?" : FILE_TOOLS.includes(tool) ? "change this file?" : `use ${head(tool, 30)}?`;
  const tail = ` asks: ${ask}`;
  return `${head(role, 80 - Array.from(tail).length)}${tail}`;
}

/** The question: the shown text as a fenced block (a fence longer than any in the text), then the cwd. */
export function promptQuestion(shown: string, cwd: string): string {
  const longest = Math.max(2, ...(shown.match(/`+/g) ?? []).map((f) => f.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${shown}\n${fence}${cwd ? `\n\nin ${redact(cwd)}` : ""}`;
}

/** The transcript the prompt's tool call is written to: a helper agent has its own beside the session's. */
export function promptTranscript(transcript: string, agentId: string): string {
  if (!transcript || !agentId) return transcript;
  return join(transcript.replace(/\.jsonl$/, ""), "subagents", `agent-${agentId.replace(/[^A-Za-z0-9_-]/g, "")}.jsonl`);
}

// The fields that name one call. Claude Code may add defaults to the hook's copy of an input.
const KEYS: Record<string, string[]> = { Bash: ["command"], Edit: ["file_path", "old_string", "new_string"], Write: ["file_path", "content"] };
function sameInput(tool: string, a: any, b: any): boolean {
  const keys = KEYS[tool];
  return keys ? keys.every((k) => a?.[k] === b?.[k]) : Bun.deepEquals(a, b);
}

/** The newest `tool_use` of this tool and input that has no `tool_result`; "" when none (or no file). */
export function findToolUse(transcript: string, tool: string, input: unknown): string {
  let text = "";
  try { text = readFileSync(transcript, "utf8"); } catch { return ""; }
  const ids: string[] = [], done = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_use')) continue;
    let content: unknown;
    try { content = JSON.parse(line)?.message?.content; } catch { continue; }
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "tool_result") done.add(str(c.tool_use_id));
      else if (c?.type === "tool_use" && c.name === tool && str(c.id) && sameInput(tool, c.input, input)) ids.push(c.id);
    }
  }
  return ids.reverse().find((id) => !done.has(id)) ?? "";
}
