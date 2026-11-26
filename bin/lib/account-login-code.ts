// account-login-code.ts — the pasted login code's one way from the board to the login terminal (issue #125, U6,
// KTD10). The code is a secret: it never goes into loop.db (no request row, event or result), a chat file or a
// log. The board writes it to a drop file, the add's fulfiller reads and removes it and types it.
//
//   loginCodeProblem(code)          why a pasted code is refused, or null (one line, 1-512 printable characters)
//   dropLoginCode(root, id, code)   <root>/account-login/<id>, mode 0600 in a 0700 directory (a newer code replaces it)
//   takeLoginCode(root, id)         the dropped code, removed as it is read; null when none
//   clearLoginCode(root, id)        remove a code nobody took (the add ended)
//
// No message here ever carries the code: a refusal names the rule, not the text.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_CODE = 512;

const dirOf = (root: string) => join(root, "account-login");
export const loginCodeFile = (root: string, id: number | string): string => join(dirOf(root), String(id));

/** The code as it is typed: surrounding whitespace (a paste's newline) trimmed. */
const cleanCode = (code: unknown): string => typeof code === "string" ? code.trim() : "";

export function loginCodeProblem(code: unknown): string | null {
  const c = cleanCode(code);
  if (!c) return "the code is empty";
  if (c.length > MAX_CODE) return `the code is longer than ${MAX_CODE} characters`;
  if (!/^[\x20-\x7e]+$/.test(c)) return "the code must be one line of printable characters";
  return null;
}

export function dropLoginCode(root: string, id: number | string, code: string): void {
  const dir = dirOf(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const f = loginCodeFile(root, id), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, cleanCode(code), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, f);
}

export function takeLoginCode(root: string, id: number | string): string | null {
  const f = loginCodeFile(root, id);
  let code: string;
  try { code = readFileSync(f, "utf8"); } catch { return null; }   // none dropped
  rmSync(f, { force: true });
  return loginCodeProblem(code) ? null : cleanCode(code);
}

export function clearLoginCode(root: string, id: number | string): void {
  rmSync(loginCodeFile(root, id), { force: true });
}
