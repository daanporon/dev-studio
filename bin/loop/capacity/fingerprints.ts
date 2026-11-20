// fingerprints.ts — Claude Code and Muse limit notices, as the backend recognises them (U8, Bun).
// Ported verbatim from bin/backend/orca.sh limited_scan / limit_reset at origin/main 0aa77fc
// (sweep-required U19, the sweep-required close); keep the two in step.
//
//   LIMIT_RE   a Claude notice: anchored at the line start after the `⎿` result marker (spaces or NBSP),
//              a limit word AND "resets", or an aggregator-pool 429 ("Request rejected (429)" /
//              "All credentials … cooling down"). Prose quoting a notice never starts with `⎿`.
//   CODEX_/MUSE_LIMIT_RE  the Codex and Muse shapes: each counts only on its own agent's worker
//              (scan's gate.agent; no agent = neither), so a Claude screen quoting them is no limit.
//   ENTRY_RE   a later transcript entry (⏺/●) or the "Usage limit reset" recovery line: a notice
//              followed by one no longer counts (the agent wrote on since).
//   dialog()   the "What do you want to do?" limit dialog: header, then ≥ 2 numbered options in
//              order (option 3 under any name: it has been "Add funds" and "Switch to usage
//              credits"; the loop never answers it, it spends money), then only blank lines or the
//              "Enter to confirm · Esc to cancel" footer. A narrow pane wraps an option: the rest
//              of it sits indented deeper than the option.
//   limitReset(notice, anchor, noroll) -> epoch s of the reset the notice names, or null.
//   scan(tail, gate) -> { reset, notice, dialog } | null — the backend's `limited` row for one worker.

export const LIMIT_RE = new RegExp(
  "^\\s*⎿(\\s|\\u00a0)*(((([0-9]+-hour|[a-z]+) ){0,2}limit reached|(You\\S{1,4}ve )?hit your (weekly |session |opus |sonnet )?limit|([a-z]+ ){0,2}usage limit).*resets"
  + "|Claude usage limit reached|API Error: (429|Request rejected \\(429\\))|(API Error: .*)?All credentials .*cooling down)", "i");
// Codex renders terminal errors with ■, including the Azure Responses API's 429. Counts only on a
// `codex` worker (scan's gate agent): on any other agent's screen it is quoted text.
export const CODEX_LIMIT_RE = /^\s*■\s*(You.ve hit your usage limit\b|unexpected status 429\b)/i;
// Muse renders a diamond, then a wrapped reset date; keep prose and quotes out. Counts only on a
// `muse` worker.
export const MUSE_LIMIT_RE = /^\s*◆ Usage limit reached · \/upgrade \(/;
// A billing error: the provider's exact phrase, anchored like the limit shapes, each on its own agent's
// worker only. Only Muse's is observed (2026-11-16, `◆ model failed: API error 402 … (billing_error)`);
// the Claude and Codex shapes are best guesses. A `◆` or `⎿` line that merely mentions 402 and billing
// never starts with these phrases.
export const CLAUDE_CREDITS_RE = /^\s*⎿[\s\u00a0]*(API Error: 402\b|Credit balance is too low)/;
export const MUSE_CREDITS_RE = /^\s*◆ model failed: API error 402\b/;
export const CODEX_CREDITS_RE = /^\s*■\s*.*\binsufficient_quota\b/;
// On a Muse screen every later `◆` line is agent output: a notice followed by one no longer counts.
export const MUSE_ENTRY_RE = /^\s*◆/;
export const ENTRY_RE = /^\s*(⏺|●|•|■)|^\s*⎿(\s| )*[Uu]sage limit reset([^s]|$)/;
export const WINDOW = 12;          // tail lines the sweep looks at
export const NOTICE_MAX = 160;     // the printed notice is cut here (UTF-8 bytes, as GNU `cut -c`); the reset is parsed from the full line

const indent = (l: string) => /^[ \t]*/.exec(l)![0].length;

export function dialog(lines: string[]): boolean {
  let hdr = false, n = 0, prev = 0, last = false, bad = false, at = 0;
  for (const line of lines) {
    const raw = line.replace(/[ \t]+$/, ""), l = raw.replace(/^[ \t]*[^A-Za-z0-9]*[ \t]*/, "");
    if (l === "What do you want to do?") { hdr = true; n = 0; prev = 0; last = false; bad = false; continue; }
    const num = !hdr ? 0 : /^1\. Stop and wait/.test(l) ? 1 : /^2\. Wait here/.test(l) ? 2 : n === 2 && prev === 2 && /^3\. /.test(l) ? 3 : 0;
    if (num > prev) { n++; prev = num; last = true; at = indent(raw); continue; }
    if (last && /[^ \t]/.test(raw) && !/^(Enter to confirm|Esc to cancel)/.test(l) && indent(raw) <= at) bad = true;
  }
  return hdr && n >= 2 && !bad;
}

// The UTC offset (s) of `tz` (undefined = the host zone) at epoch t.
function offset(tz: string | undefined, t: number): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000 - t;
}
// Wall time y-mo-d h:mi in `tz` -> epoch s (null for a zone Intl does not know).
function wall(tz: string | undefined, y: number, mo: number, d: number, h: number, mi: number): number | null {
  try {
    const guess = Date.UTC(y, mo - 1, d, h, mi) / 1000;
    let t = guess - offset(tz, guess);
    t = guess - offset(tz, t);
    return t;
  } catch { return null; }
}
// epoch s -> [y, mo, d] in `tz`.
function ymd(tz: string | undefined, t: number): [number, number, number] {
  const u = new Date((t + offset(tz, t)) * 1000);
  return [u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate()];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RE_ISO = /[Rr]esets? at ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?(Z|[+-][0-9]{2}:?[0-9]{2})?)/;
const RE_TIME = /[Rr]esets? (at )?(([Jj]an|[Ff]eb|[Mm]ar|[Aa]pr|[Mm]ay|[Jj]un|[Jj]ul|[Aa]ug|[Ss]ep|[Oo]ct|[Nn]ov|[Dd]ec)[A-Za-z]* ([0-9]{1,2}),? )?([0-9]{1,2})(:([0-9]{2}))? ?([AaPp][Mm])?/;
const RE_TZ = /\(([A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)+|UTC|GMT)\)/;

// The next reset after `anchor` (when the agent went quiet). ISO: the instant itself, never rolled.
// Dated ("Oct 31, 8pm"): that date in the anchor's year, rolled a year while at or before the anchor.
// Undated ("3pm", "15:00"): the anchor's date, else the next day. A dialog (noroll) keeps a past
// candidate so its expiry can fire. A "(Zone)" names the zone, else the host zone. A bare hour
// ("resets 5 hours from now") is no clock time: null.
export function limitReset(text: string, anchor: number, noroll = false): number | null {
  const iso = RE_ISO.exec(text);
  if (iso) {
    const t = Date.parse(iso[1].replace(/([+-][0-9]{2})([0-9]{2})$/, "$1:$2"));
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  const tz = RE_TZ.exec(text)?.[1];
  // Muse: "reset at Nov 9 at 1:00 AM"; normalize the second "at" for the date parser.
  const m = RE_TIME.exec(text.replace(/(resets? at [A-Za-z]+ [0-9]{1,2}) at /i, "$1 "));
  if (!m) return null;
  const [mon, day, hh, mm, ap] = [m[3], m[4], m[5], m[7], m[8]];
  if (!mm && !ap) return null;
  let h = Number(hh);
  const mi = Number(mm ?? 0);
  if (mi > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  try { offset(tz, anchor); } catch { return null; }
  if (mon) {
    const mo = MONTHS.indexOf(mon.toLowerCase()) + 1;
    for (let y = ymd(tz, anchor)[0]; ; y++) {
      const c = wall(tz, y, mo, Number(day), h, mi);
      if (c === null) return null;
      if (c > anchor || noroll) return c;
    }
  }
  const [y, mo, d] = ymd(tz, anchor);
  const c = wall(tz, y, mo, d, h, mi);
  if (c === null || c > anchor || noroll) return c;
  const [y2, mo2, d2] = ymd(tz, anchor + 86400);
  return wall(tz, y2, mo2, d2, h, mi);
}

export type Gate = { agent?: string | null; state: string; since: number | null; lastOutput: number | null; now: number; silentMin: number };
export type LimitRow = { reset: number | null; notice: string; dialog: boolean; kind?: "credits"; link?: string };

// `cut -c1-NOTICE_MAX`: GNU cut counts bytes, so a split character decodes as U+FFFD, as the
// sweep's file read back as UTF-8 does. The notice keys the sweep's imported markers.
const cut = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s).subarray(0, NOTICE_MAX));

// limited_scan for one worker. idle/done count once silent SILENT_MIN since `since`, or since their
// last output when Orca reports no state time; with neither, only a recognised dialog counts,
// anchored at now. working is anchored at its last output and counts only with the dialog on screen
// or SILENT_MIN of silence. A billing error (kind "credits") on an idle or done worker counts at once:
// the agent stopped on it, so there is nothing to wait out; a working one keeps the silence rule.
export function scan(tail: string, g: Gate): LimitRow | null {
  let anchor: number, timeless = false, recent = false;
  if (g.state === "idle" || g.state === "done") {
    const at = g.since ?? g.lastOutput;
    recent = at !== null && g.now - at < g.silentMin * 60;
    timeless = at === null;
    anchor = at ?? g.now;
  } else if (g.state === "working") {
    if (g.lastOutput === null) return null;
    anchor = g.lastOutput;
  } else return null;
  const lines = tail.replace(/\n$/, "").split("\n").slice(-WINDOW).filter((l) =>
    !/dev-studio (sweep|board)/.test(l) && !/^\s*(?:❯|•)?\s*dev-studio loop:/.test(l));
  const isCredits = (l: string) => ((!g.agent || g.agent === "claude") && CLAUDE_CREDITS_RE.test(l)) || (g.agent === "muse" && MUSE_CREDITS_RE.test(l)) || (g.agent === "codex" && CODEX_CREDITS_RE.test(l));
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (LIMIT_RE.test(lines[i]) || isCredits(lines[i]) || (g.agent === "muse" && MUSE_LIMIT_RE.test(lines[i])) || (g.agent === "codex" && CODEX_LIMIT_RE.test(lines[i]))) { at = i; break; }
  if (at < 0 || lines.slice(at + 1).some((l) => ENTRY_RE.test(l) || (g.agent === "muse" && MUSE_ENTRY_RE.test(l)))) return null;
  const credits = isCredits(lines[at]);
  if (recent && !credits) return null;
  const full = lines[at].replace(/^[^A-Za-z0-9]+/, ""), dlg = !credits && dialog(lines);
  if (timeless && !dlg && !credits) return null;
  if (g.state === "working" && !dlg && g.now - anchor < g.silentMin * 60) return null;
  // A narrow pane wraps the notice ("resets Nov 2,\n     6pm (Europe/Berlin)"): the reset is read
  // across the lines indented under it; the notice stays its first line.
  let text = full;
  for (let i = at + 1; i < lines.length && /[^ \t]/.test(lines[i]) && indent(lines[i]) > indent(lines[at]); i++) text += ` ${lines[i].trim()}`;
  if (credits) {
    // provider-billing-fallback U4: a narrow pane cuts the billing lines into rows of the pane's width,
    // anywhere (inside the link too). A row as long as the widest row in view may be such a cut: the next
    // row is joined to it with nothing between, so the link comes out whole. It is a cut when two or more
    // rows share that width (the pane's), or, a lone widest row (maybe just a long line on a wide pane),
    // only when the link goes on: the row ends in a link (or the start of one) and the next row carries
    // on in plain URL characters, or the next row starts with the link. Either way a link that ends a
    // full row is not carried onto a next row that does not go on in URL characters (a new screen row).
    // An indented row goes on the notice with a space, as above.
    const width = Math.max(...lines.map((l) => l.length));
    const wraps = lines.filter((l) => l.length === width).length >= 2;
    const urlChar = /^[A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%]/;
    const linkGoesOn = (row: string, next: string) => {
      if (/^\s*https:\/\//.test(next)) return true;
      const tok = /\S*$/.exec(row)![0];
      const inLink = !!tok && (tok.startsWith("https://") || "https://".startsWith(tok));
      return wraps ? !inLink || urlChar.test(next) : inLink && urlChar.test(next);
    };
    let raw = lines[at];
    for (let i = at + 1; i < lines.length; i++) {
      const cut = width >= 40 && lines[i - 1].length === width && linkGoesOn(raw, lines[i]);
      if (!cut && !(/[^ \t]/.test(lines[i]) && indent(lines[i]) > indent(lines[at]))) break;
      raw += cut ? lines[i] : ` ${lines[i].trim()}`;
    }
    const link = /https:\/\/[^\s<>"')]+/.exec(raw)?.[0].replace(/[.,;:]+$/, "");
    return { reset: null, notice: cut(full), dialog: false, kind: "credits", ...(link ? { link } : {}) };
  }
  return { reset: limitReset(text, anchor, dlg), notice: cut(full), dialog: dlg };
}
