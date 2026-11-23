// The Squads table's one order rule (squad-table-ordering U1), shared by the board JSON, the web page and
// the text board (they all walk the same sorted `squads` array). A squad's band is the first match of:
// done/failed (8) → suspended/on-hold (7) → needs you (1) → starred (2) → paused (6) → wrapping up (4)
// → parked (5) → running (3). Inside a band the keys are listed in `squadRank`; the last is always project,
// then topic, so equal rows never swap. Only work facts are keys (units, questions, star, pause, status),
// never live worker state, so a plain refresh never reorders the table. Every field is read defensively:
// the `broken()` row has no `focus`, `pause` or `progress`, and a throw here would blank the board.

export type SquadRank = { band: number; keys: number[]; label: string; topic: string };

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Share of units done, cancelled units left out; null for a squad with no units yet (or a broken row).
function share(s: any): { share: number; done: number } | null {
  const p = s?.progress;
  if (!p || typeof p !== "object") return null;
  const total = num(p.total) - num(p.cancelled);
  if (total <= 0) return null;
  return { share: num(p.done) / total, done: num(p.done) };
}

export function squadRank(s: any): SquadRank {
  const status = String(s?.status ?? "");
  const key = String(s?.display_key ?? "");
  const asking = (Array.isArray(s?.questions) ? s.questions.length : 0) > 0 || status === "blocked";
  const pause = String(s?.pause?.state ?? "");
  let band: number;
  if (status === "done" || status === "failed") band = 8;
  else if (status === "suspended" || status === "on-hold") band = 7;
  else if (asking) band = 1;
  else if (s?.focus === true) band = 2;
  else if (pause === "pausing" || pause === "paused") band = 6;
  else if (key === "wrapping-up") band = 4;
  else if (key === "held-only") band = 5;
  else band = 3;
  const sh = share(s);
  // Needs-you and running order by share done (highest first), then more units done; no units after those,
  // a broken row last. Other bands have no work key.
  let keys: number[] = [];
  if (band === 1 || band === 3) keys = s?.error === true ? [2, 0, 0] : sh ? [0, -sh.share, -sh.done] : [1, 0, 0];
  return { band, keys, label: String(s?.label ?? ""), topic: String(s?.topic ?? "") };
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareSquads(a: any, b: any): number {
  const x = squadRank(a), y = squadRank(b);
  if (x.band !== y.band) return x.band - y.band;
  for (let i = 0; i < Math.max(x.keys.length, y.keys.length); i++) {
    const d = (x.keys[i] ?? 0) - (y.keys[i] ?? 0);
    if (d) return d;
  }
  return cmpStr(x.label, y.label) || cmpStr(x.topic, y.topic);
}
