// menu.ts — the numbered menu at the bottom of an agent's screen: the board chat reads it (board-data.ts), and
// the loop spots a permission prompt in it (reconcilers/alerts.ts).

function scan(tail: string): { lines: string[]; run: { mark: boolean; label: string; at: number }[] } {
  const lines = tail.split("\n").filter((l) => l.trim() !== "").slice(-25);
  let run: { mark: boolean; label: string; at: number }[] = [];
  let last: typeof run = [];
  lines.forEach((l, at) => {
    const m = /^\s*([❯>›▶»])?\s*(\d{1,2})\.\s+(\S.*)$/.exec(l);
    if (!m) return;
    if (Number(m[2]) === 1) run = [];
    if (Number(m[2]) === run.length + 1) { run.push({ mark: !!m[1], label: m[3].trim(), at }); last = run.slice(); }
  });
  return { lines, run: last.length >= 2 && last.some((o) => o.mark) ? last : [] };
}

const above = (lines: string[], at: number, n: number) => lines.slice(Math.max(0, at - n), at).map((l) => l.trim());

// Board chat U19b: the option count of a numbered menu at the bottom of a screen (a Claude permission prompt,
// the folder-trust prompt), else 0. The last run of option lines numbered 1, 2, 3… within the last 25 non-blank
// lines counts, and only when one of them carries the selection marker; a numbered list in plain output has none.
export function menuOptions(tail: string): number { return menuText(tail).count; }

// The same scan with the menu's text (the Question view): `options` are the last run's labels with the marker and
// number stripped, `prompt` the up to 4 non-blank lines just above the run (the question the menu asks).
export function menuText(tail: string): { count: number; prompt: string[]; options: string[] } {
  const { lines, run } = scan(tail);
  if (!run.length) return { count: 0, prompt: [], options: [] };
  return { count: run.length, prompt: above(lines, run[0].at, 4), options: run.map((o) => o.label) };
}

// Is the menu a permission prompt, and what does it show? Claude asks "Do you want to …?" just above its
// options. Codex (0.167) asks "Would you like to …" above its reason and command lines, so it is looked for
// higher up. `prompt` runs from there (Claude: the 4 lines menuText keeps) down to the options.
const CLAUDE_ASKS = /^Do you want to .*\?$/;
const CODEX_ASKS = /^Would you like to (run the following command|make the following edits|grant these permissions|send input to terminal)\b/;
const CODEX_ABOVE = 15;

// Claude's permission dialog on a screen (fulfil/answer.ts presses Yes or No only after reading it): the
// "Do you want to …?" line among the 4 non-blank lines above the menu, the dialog's lines between it and the
// nearest line above that opens the dialog or belongs to the conversation (a rule or a corner, or a line that
// starts with ● ⏺ ⎿ ❯ ✻ ✢: a pending tool call is shown there, maybe another call's command), and the options.
// A side border (│) is no boundary.
// Border characters at either end of a line are dropped. `dialog` is null when no such boundary is on screen.
const BOX = /^[\s─-╿]+|[\s─-╿]+$/g;
const unbox = (l: string) => l.replace(BOX, "");
const BOUNDARY = /^[─━═┄┅┈┉╌╍╭╮╰╯┌┐└┘●⏺⎿❯✻✢]/;
export function claudePrompt(tail: string): { question: string; dialog: string | null; options: string[] } | null {
  const all = tail.split("\n").filter((l) => l.trim() !== "");
  const { lines, run } = scan(tail);
  if (!run.length) return null;
  const first = all.length - lines.length + run[0].at;
  let q = first - 1;
  while (q >= Math.max(0, first - 4) && !CLAUDE_ASKS.test(unbox(all[q]))) q--;
  if (q < Math.max(0, first - 4)) return null;
  let top = q - 1;
  while (top >= 0 && !BOUNDARY.test(all[top].trim())) top--;
  return { question: unbox(all[q]), dialog: top < 0 ? null : all.slice(top + 1, q).join("\n"), options: run.map((o) => unbox(o.label)) };
}

export function permissionMenu(tail: string): { prompt: string[]; options: string[] } | null {
  const { lines, run } = scan(tail);
  if (!run.length) return null;
  const options = run.map((o) => o.label), near = above(lines, run[0].at, 4);
  if (near.some((l) => CLAUDE_ASKS.test(l))) return { prompt: near, options };
  const far = above(lines, run[0].at, CODEX_ABOVE), i = far.findLastIndex((l) => CODEX_ASKS.test(l));
  return i < 0 ? null : { prompt: far.slice(i), options };
}
