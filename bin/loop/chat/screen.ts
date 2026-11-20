// chat/screen.ts — the fallback for any agent without a transcript reader (muse, a future one) or a
// member whose transcript is not found yet: one `screen` turn from the agent terminal's rendered
// screen bottom as the Orca observer last read it (observed_workers.tail, else said), redacted and capped.
import type { Row } from "../core/store.ts";
import { redact } from "./redact.ts";
import { capTurns, textTurn, type Turn } from "./turns.ts";

export function screenTurns(w: Row | null): Turn[] {
  const raw = typeof w?.tail === "string" && w.tail.trim() ? w.tail : typeof w?.said === "string" ? w.said : "";
  const tail = redact(raw);   // before the cut, so a secret across it is not left half in clear
  const at = w?.tail_at != null ? Number(w.tail_at) : w?.observed_at != null ? Number(w.observed_at) : null;
  // The screen's bottom is what matters: keep its last lines when it is long.
  const t = textTurn("screen", tail.length > 4000 ? tail.slice(-3999) : tail, at);
  return t ? capTurns([t]) : [];
}
