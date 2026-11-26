// permission.ts — may the board answer a Claude safety-check prompt, and with which key (permission-prompt-needs-you U2).
// The hook (bin/lib/permission-prompt.ts) asks `checkable` before it marks an entry answerable; the answer fulfiller
// (fulfil/answer.ts) asks `permissionKey` on a fresh screen right before it presses anything.
import { claudePrompt } from "./menu.ts";
import { redact, REDACTED } from "../core/redact.ts";

export const FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const CUT = "\n… (cut)";

/** Was the shown text cut at its cap (shownText's "(cut)" line)? */
export const isCut = (shown: string): boolean => shown.endsWith(CUT);

/** Does the card hide part of the prompt behind `[redacted]`? The board never takes an answer for what it did not
 *  show (D5), and a redaction could hide more than the secret, so such a prompt is answered in the terminal. */
export const isHidden = (shown: string): boolean => redact(shown).includes(REDACTED);

/** The file a file tool's prompt is about, from its shown text: Edit and Write show the path on the first line,
 *  the others their input as JSON. "" when there is none. */
export function shownPath(tool: string, shown: string): string {
  if (tool === "Edit" || tool === "Write") return shown.split("\n")[0].trim();
  if (!FILE_TOOLS.includes(tool)) return "";
  try { const j = JSON.parse(shown); return String(j?.file_path ?? j?.notebook_path ?? "").trim(); } catch { return ""; }
}
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? "";

/** Can the screen check tie this prompt down: a Bash command or a file change shown in full, nothing hidden? Other tools
 *  (a read outside the tree, a fetch) show their input as JSON, which the dialog never prints. */
export function checkable(tool: string, input: any, shown: string): boolean {
  if (isCut(shown) || isHidden(shown)) return false;
  if (tool === "Bash") return typeof input?.command === "string" && input.command.trim() !== "";
  return FILE_TOOLS.includes(tool) && base(shownPath(tool, shown)) !== "";
}

// Whitespace and box-drawing characters go on both sides: the dialog wraps and indents a long command.
const squash = (s: string) => s.replace(/[\s─-╿]+/g, "");

/** Does the dialog show exactly this command? It must fill whole lines from the dialog's first or second
 *  non-blank line (the one under its " Bash command" header) and the next non-blank line must start the call's
 *  description, so neither a longer command (`git push --force` for `git push`) nor a second line after it
 *  (`git push` then `rm -rf x`) passes. Without a description the command's end can't be told: false. */
export function showsCommand(dialog: string, command: string, description: string): boolean {
  const cmd = squash(command), desc = squash(description);
  if (!cmd || !desc) return false;
  const lines = dialog.split("\n").map(squash);
  const starts = lines.flatMap((l, i) => (l ? [i] : [])).slice(0, 2);
  return starts.some((s) => {
    let acc = "", i = s;
    for (; i < lines.length && acc.length < cmd.length; i++) acc += lines[i];
    if (acc !== cmd) return false;
    return lines.slice(i).join("").startsWith(desc);
  });
}

/** The digit to press for `answer` ("Yes" or "No") on this screen, or why nothing may be pressed: the screen must
 *  show Claude's "Do you want to …?" menu, its dialog must show the call's whole command, then its description
 *  (showsCommand; `command` and `description` come from the transcript's tool_use, else `shown`) or, for a file
 *  change, the question line the file's name, and exactly one option must read exactly `answer`. Never any
 *  other option ("Yes, and don't ask again"). */
export function permissionKey(screen: string, entry: { tool: string; shown: string; command?: string; description?: string }, answer: string): { digit: number } | { why: string } {
  if (answer !== "Yes" && answer !== "No") return { why: "only Yes or No is pressed on a permission prompt" };
  if (isCut(entry.shown)) return { why: "the command was too long to show in full" };
  if (isHidden(entry.shown)) return { why: "the card hides a secret in it" };
  const p = claudePrompt(screen);
  if (!p) return { why: "the screen shows no permission prompt" };
  if (entry.tool === "Bash") {
    if (!entry.description?.trim()) return { why: "the tool call has no description to tell where its command ends" };
    if (p.dialog === null || !showsCommand(p.dialog, entry.command ?? entry.shown, entry.description)) return { why: "the screen shows a different command" };
  } else {
    const name = base(shownPath(entry.tool, entry.shown));
    if (!name || !p.question.includes(name)) return { why: "the screen asks about a different file" };
  }
  const at = p.options.flatMap((o, i) => (o === answer ? [i] : []));
  if (at.length !== 1) return { why: `the menu has ${at.length ? "more than one" : "no"} option reading exactly ${answer}` };
  if (at[0] >= 9) return { why: "the option is past 9" };
  return { digit: at[0] + 1 };
}
