// start-framing.ts — the board Start's brief as a file (board-actions-as-wishes U6): `framings/board-start-<request>.md`
// with its attached files, written by the loop's `squad-start` fulfiller and by the Studio fulfiller for a `studio`
// start filed before the deploy. Named by the request, so a replay writes the same file in place.
import { closeSync, constants as fsc, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHAT_FILE_NAME, chatFileDir, chatFileGone, chatFileKind, START_TOPIC } from "../chat/files.ts";

// chat-image-upload U4: the files a board start carries, uploaded to `chat-files/_start/`, are copied (never
// moved) into `framings/board-start-<request>/` so they last as long as the brief, and listed at the brief's
// end: images under `## Attached images`, text files and PDFs under `## Attached files` (never pasted into the
// brief: it is the squad's framing on the board, and a long document would bury it). Plain files in plain
// folders only, never through a symlink; copies are 0600. A copy already there with the upload's size, or
// whose upload is gone, is kept, so a replay copies nothing twice. Returns the lines to list ([] when no name
// passes the rule: the board files none, a forged row names no path).
// `strict` (the squad-start fulfiller): a file neither uploaded nor already copied throws, naming it.
const isDir = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
export class GoneFile extends Error {}
function copyAttached(root: string, label: string, fdir: string, request: number, names: string[], strict: boolean): string[] {
  const src = chatFileDir(root, label, START_TOPIC), dst = join(fdir, `board-start-${request}`);
  const srcOk = isDir(join(root, label, "chat-files")) && isDir(src);
  const gone = (n: string) => {
    if (strict) throw new GoneFile(chatFileGone(n));
    return `- ${n} (removed before the squad started)`;
  };
  const lines: string[] = [];
  for (const n of names) {
    if (!CHAT_FILE_NAME.test(n)) continue;
    const to = join(dst, n), have = lstatSync(to, { throwIfNoEntry: false });
    const from = srcOk ? lstatSync(join(src, n), { throwIfNoEntry: false }) : undefined;
    const up = from?.isFile() ? from : undefined;
    if (have?.isFile() && (!up || up.size === have.size)) { lines.push(`- ${resolve(to)}`); continue; }
    if (!up) { lines.push(gone(n)); continue; }
    let fd = -1, bytes: Buffer;
    try { fd = openSync(join(src, n), fsc.O_RDONLY | fsc.O_NOFOLLOW); bytes = readFileSync(fd); }
    catch { lines.push(gone(n)); continue; }
    finally { if (fd >= 0) closeSync(fd); }
    mkdirSync(dst, { recursive: true, mode: 0o700 });
    if (!isDir(dst)) throw new Error(`${dst} is not a plain folder`);
    const tmp = join(dst, `.${n}.${process.pid}.tmp`);
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, to);
    lines.push(`- ${resolve(to)}`);
  }
  return lines;
}
function attachFiles(root: string, label: string, fdir: string, request: number, names: string[], strict: boolean): string {
  const valid = names.filter((n) => CHAT_FILE_NAME.test(n));
  const images = copyAttached(root, label, fdir, request, valid.filter((n) => chatFileKind(n) === "image"), strict);
  const docs = copyAttached(root, label, fdir, request, valid.filter((n) => chatFileKind(n) !== "image"), strict);
  const section = (what: string, verb: string, lines: string[]) => lines.length
    ? `\n## Attached ${what}\n\nThe operator attached these ${what} to the brief. ${verb} each with your file-reading tool:\n${lines.join("\n")}\n`
    : "";
  return section("images", "Open", images) + section("files", "Read", docs);
}

/** Write `<root>/<label>/framings/board-start-<request>.md` (the brief's bytes, then its attached files) and return its path. */
export function writeStartFraming(root: string, label: string, request: number, framing: string, files: string[] | undefined, o: { strict?: boolean } = {}): string {
  const fdir = join(root, label, "framings"), ff = join(fdir, `board-start-${request}.md`);
  mkdirSync(fdir, { recursive: true });
  const attached = files?.length ? attachFiles(root, label, fdir, request, files, o.strict === true) : "";
  // tmp+rename: a reader in the same instant never sees half a brief.
  writeFileSync(`${ff}.tmp`, attached ? `${framing}${framing.endsWith("\n") ? "" : "\n"}${attached}` : framing);
  renameSync(`${ff}.tmp`, ff);
  return ff;
}
