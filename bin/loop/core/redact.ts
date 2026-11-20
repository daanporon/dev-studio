// redact.ts — secret-shaped strings out of text before it is written to loop.db (KTD3: redaction at write
// time, so loop.db never holds an unredacted copy): observed_chat, screen tails, last replies, relayed mail.
// Each match becomes `[redacted]`; a `Bearer` keeps its word. A PEM private-key block with no END
// line (cut text) is redacted to the end, and an END line whose BEGIN was cut off (a screen's top) is
// redacted from the start.
export const REDACTED = "[redacted]";

const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SHAPES) out = out.replace(re, REDACTED);
  return out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`);
}

/** `redact` over every string in a JSON value (keys kept), so a payload stays valid JSON. */
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redact(v) as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}

/** A stored payload (JSON text or plain text) redacted: parsed and rebuilt when it is JSON, else as text. */
export function redactPayload(p: string | null): string | null {
  if (p == null) return null;
  try { return JSON.stringify(redactDeep(JSON.parse(p))); } catch { return redact(p); }
}
