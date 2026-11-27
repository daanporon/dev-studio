// chat/files.ts — the shared contract for files attached to a board chat (chat-image-upload; text files and
// PDFs: markdown-file-upload-support). The board server stores each upload once under
// `<state root>/<label>/chat-files/<topic>/<name>` (topic: a squad name, or `_studio`); a `chat` request row
// holds file NAMES only, never a path, and whoever reads the row resolves each name inside that folder for the
// row's own project and squad, so a forged row can never name another file. board-server.ts imports the rule
// from here.
import { join } from "node:path";

// Three kinds share one store. The extension decides a stored file's kind; SVG, office files and archives are
// never one (an SVG can carry script).
export type ChatFileKind = "image" | "text" | "pdf";
export const IMAGE_EXTS = ["png", "jpg", "webp", "gif"] as const;
export const TEXT_EXTS = ["md", "markdown", "txt", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "conf",
  "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp",
  "hpp", "sh", "bash", "zsh", "sql", "diff", "patch"] as const;
export const PDF_EXTS = ["pdf"] as const;
export const KIND_EXTS: Record<ChatFileKind, readonly string[]> = { image: IMAGE_EXTS, text: TEXT_EXTS, pdf: PDF_EXTS };
// The largest stored file of each kind, in bytes.
export const KIND_MAX: Record<ChatFileKind, number> = { image: 5 * 1024 * 1024, text: 1024 * 1024, pdf: 10 * 1024 * 1024 };
export const CHAT_FILE_MAX_ANY = Math.max(...Object.values(KIND_MAX));

// The first 16 hex characters of the file's sha256, then the extension: an image's of its sniffed type (JPEG:
// .jpg), a text file's or PDF's lowercased from its own name. Only a text file or a PDF carries `-<stem>` (its
// own name, cleaned: see storedChatName). The extension is the rule's only group.
const STEM = "-[A-Za-z0-9][A-Za-z0-9._-]{0,47}";
const NAMED = [...TEXT_EXTS, ...PDF_EXTS].join("|");
export const CHAT_FILE_NAME = new RegExp(`^[0-9a-f]{16}(?:${STEM}(?=\\.(?:${NAMED})$))?\\.(${[...IMAGE_EXTS, NAMED].join("|")})$`);

// The kind a stored name says, or null for a name that fails the rule.
export function chatFileKind(name: string): ChatFileKind | null {
  const ext = CHAT_FILE_NAME.exec(name)?.[1];
  if (!ext) return null;
  return (IMAGE_EXTS as readonly string[]).includes(ext) ? "image" : ext === "pdf" ? "pdf" : "text";
}
// The stored name's extension (the rule's group), or null.
export const chatFileExt = (name: string): string | null => CHAT_FILE_NAME.exec(name)?.[1] ?? null;
// The name the operator sees: the stem plus the extension, or the whole stored name when it has no stem.
export function chatFileShown(name: string): string {
  const m = /^[0-9a-f]{16}-(.+)$/.exec(name);
  return m && chatFileKind(name) ? m[1] : name;
}

// A text file's or PDF's stored name from its hash and the name it was uploaded under: `<hash16>-<stem>.<ext>`.
// The stem is the name without its extension, each character outside [A-Za-z0-9._-] made `-`, runs of `-` made
// one, leading characters outside [A-Za-z0-9] and trailing `-` trimmed, cut to 48 and trimmed again. A stem that
// ends up empty, or a name the rule would still refuse, gives `<hash16>.<ext>`: nothing is ever stored that the
// rule refuses (it could not be sent, served or pruned). An image's name is always `<hash16>.<ext>`.
export function storedChatName(hash16: string, ext: string, original = ""): string {
  const plain = `${hash16}.${ext}`;
  if ((IMAGE_EXTS as readonly string[]).includes(ext)) return plain;
  const dot = original.lastIndexOf(".");
  const tidy = (s: string) => s.replace(/^[^A-Za-z0-9]+/, "").replace(/-+$/, "");
  const stem = tidy(tidy((dot > 0 ? original.slice(0, dot) : "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-")).slice(0, 48));
  const named = stem ? `${hash16}-${stem}.${ext}` : plain;
  return CHAT_FILE_NAME.test(named) ? named : plain;
}

export const CHAT_FILES_MAX = 4;
// What the loop types after the text: the images mark, then the files mark (text files and PDFs). The transcript
// reader looks for them to split the attachments off again.
export const IMAGES_MARK = "[images attached; open each with your file-reading tool: ";
export const FILES_MARK = "[files attached; read each with your file-reading tool: ";

// The answer for an attachment that is no longer stored: an image keeps its old wording.
export const chatFileGone = (name: string) => `${chatFileKind(name) === "image" ? "image" : "file"} ${name} is gone — attach it again`;

// Files sent with a squad start (chat-image-upload U4) wait in `chat-files/_start/` while the board's Start
// squad dialog is open: there is no squad yet, and `_start` can never be a squad name (a squad name starts
// with a letter or digit). The start copies them next to the brief (squad/start-framing.ts).
export const START_TOPIC = "_start";
export const START_FILES_MAX = 8;

export const chatFileDir =(root: string, label: string, topic: string) => join(root, label, "chat-files", topic);

// null for a name that fails the rule, so `..`, a slash or an uppercase name never reaches the disk.
export function chatFilePath(root: string, label: string, topic: string, name: string): string | null {
  return CHAT_FILE_NAME.test(name) ? join(chatFileDir(root, label, topic), name) : null;
}

// `api/chat-file?project=…&topic=…&name=…`, the url the board serves a stored file at.
export const chatFileUrl = (project: string, topic: string, name: string) =>
  `api/chat-file?project=${encodeURIComponent(project)}&topic=${encodeURIComponent(topic)}&name=${encodeURIComponent(name)}`;
