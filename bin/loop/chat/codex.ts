// chat/codex.ts — the Codex reader: turns from a member's rollout (observed_rollouts, by its
// worktree as cwd, never a headless originator's, not older than the agent's start). Only
// `response_item` lines count: user and assistant messages (not developer ones, nor the
// instructions and environment blocks Codex puts in user messages) and each tool call as one line.
// Every *_output item (tool output), reasoning and event line is dropped.
import { HEADLESS } from "../observers/codex.ts";
import { wtPath } from "../observers/orca.ts";
import type { Store } from "../core/store.ts";
import { epoch, harnessText, jsonLines, textTurn, toolTurn, type Turn } from "./turns.ts";

export const agent = "codex";

export function pathFor(store: Store, project: string, wt: string): string | null {
  const w = store.get("observed_workers", { project, wt });
  const r = store.db.query(`SELECT path FROM observed_rollouts WHERE cwd = ? AND host = 'local'
    AND COALESCE(originator, '') NOT IN (SELECT value FROM json_each(?)) AND mtime >= ? ORDER BY mtime DESC LIMIT 1`)
    .get(wtPath(wt) ?? wt, JSON.stringify([...HEADLESS]), Number(w?.started_at ?? 0)) as { path: string } | null;
  return r?.path ?? null;
}

const textOf = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .filter((c): c is { text: string } => !!c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => c.text).join("\n");

function args(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

// A custom tool's input is code (`text(await tools.exec_command({cmd:"ls"}))`): its command when it
// names one, else the code itself.
function innerCmd(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const m = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
  if (!m) return input;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

export function parse(text: string): Turn[] {
  const out: Turn[] = [];
  for (const j of jsonLines(text)) {
    if (j.type !== "response_item") continue;
    const p = (j.payload ?? {}) as Record<string, unknown>, at = epoch(j.timestamp);
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const body = textOf(p.content);
      if (p.role === "user" && harnessText(body)) continue;
      const t = textTurn(p.role, body, at);
      if (t) out.push(t);
    } else if (p.type === "function_call" && typeof p.name === "string") {
      out.push(toolTurn(p.name, args(p.arguments), at));
    } else if (p.type === "custom_tool_call" && typeof p.name === "string") {
      out.push(toolTurn(p.name, innerCmd(p.input), at));
    } else if (p.type === "local_shell_call") {
      out.push(toolTurn("shell", (p.action as Record<string, unknown> | undefined)?.command, at));
    }
  }
  return out;
}
