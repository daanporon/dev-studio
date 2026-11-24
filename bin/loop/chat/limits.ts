// One rule for the size and content of a board chat (chat-multiline-send-fails U2), used by the board server
// (POST /api/chat, 400) and the chat fulfiller (a request that still fails there) with the same words; the
// page (web/board.html) repeats the count rule in its own `chatText`/counter, which tests/loop/board-chat-page.test.ts pins.
//
// Count: code points (`Array.from`), of the text after CR LF / CR → LF and trim.

export const CHAT_MAX = 2000;

// Control characters a chat may not hold: all of C0, DEL and C1 except tab (\x09) and line feed (\x0a).
export const CHAT_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

export const chatNormal = (s: string): string => s.replace(/\r\n?/g, "\n").trim();
export const chatCount = (s: string): number => Array.from(chatNormal(s)).length;

// The 1-based line of the first control character other than a tab or line break, else null.
export function chatControlLine(s: string): number | null {
  const t = s.replace(/\r\n?/g, "\n"), m = CHAT_CONTROL.exec(t);
  return m ? t.slice(0, m.index).split("\n").length : null;
}

// Why this text may not be sent, or null: the control rule first, then the length rule.
export function chatProblem(s: string): string | null {
  const line = chatControlLine(s);
  if (line != null) return `a chat may hold line breaks and tabs, but no other control character (line ${line})`;
  const n = chatCount(s);
  return n > CHAT_MAX ? `a chat is at most ${CHAT_MAX} characters; this one has ${n}` : null;
}
