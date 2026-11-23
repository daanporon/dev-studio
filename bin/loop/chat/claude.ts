// chat/claude.ts — the Claude reader: turns from a member's JSONL transcript (observed_transcripts,
// never an `sdk-cli` one). Only `user` and `assistant` lines count, and not a sub-agent's
// (isSidechain) or a harness meta line (isMeta). Text blocks become turns, a tool_use one line,
// and a tool_result (tool output), thinking and every other line kind are dropped.
import type { Store } from "../core/store.ts";
import { epoch, harnessText, jsonLines, textTurn, toolTurn, type Turn } from "./turns.ts";

export const agent = "claude";

export function pathFor(store: Store, project: string, wt: string): string | null {
  const r = store.db.query(`SELECT path FROM observed_transcripts WHERE project = ? AND wt = ?
    AND COALESCE(entrypoint, '') != 'sdk-cli' ORDER BY mtime DESC LIMIT 1`).get(project, wt) as { path: string } | null;
  return r?.path ?? null;
}

export function parse(text: string): Turn[] {
  const out: Turn[] = [];
  for (const j of jsonLines(text)) {
    if ((j.type !== "user" && j.type !== "assistant") || j.isSidechain === true || j.isMeta === true
      || j.isCompactSummary === true || j.isVisibleInTranscriptOnly === true) continue;
    const m = j.message as { content?: unknown } | undefined, at = epoch(j.timestamp);
    const role = j.type as "user" | "assistant";
    const blocks = typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : [];
    // A user message whose text blocks have image blocks between them (the TUI's native attachment) is one
    // line: join its text blocks so textTurn sees the typed suffix whole.
    const texts = role === "user" ? (blocks as Record<string, unknown>[]).filter((b) => b?.type === "text" && typeof b.text === "string") : [];
    const joined = texts.length > 1 && texts.length < blocks.length && !texts.some((b) => harnessText(String(b.text)));
    let done = false;
    for (const b of blocks as Record<string, unknown>[]) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") {
        if (joined) {
          if (done) continue;
          done = true;
          const t = textTurn(role, texts.map((x) => String(x.text)).join(""), at);
          if (t) out.push(t);
          continue;
        }
        if (role === "user" && harnessText(b.text)) continue;
        const t = textTurn(role, b.text, at);
        if (t) out.push(t);
      } else if (b.type === "tool_use" && role === "assistant" && typeof b.name === "string") {
        out.push(toolTurn(b.name, b.input, at));
      }
    }
  }
  return out;
}
