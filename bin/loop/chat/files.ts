// chat/files.ts — the shared contract for images attached to a board chat (chat-image-upload).
// The board server stores each upload once under `<state root>/<label>/chat-files/<topic>/<name>`
// (topic: a squad name, or `_studio`); a `chat` request row holds file NAMES only, never a path, and
// whoever reads the row resolves each name inside that folder for the row's own project and squad, so
// a forged row can never name another file. board-server.ts keeps its own copy of the rule, pinned to
// this one by a test, until the popup unit switches it to import this module.
import { join } from "node:path";

// The first 16 hex characters of the file's sha256, then the extension of its sniffed type (JPEG: .jpg).
export const CHAT_FILE_NAME = /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/;
export const CHAT_FILES_MAX = 4;
// What the loop types after the text; the transcript reader looks for it to split the images off again.
export const IMAGES_MARK = "[images attached; open each with your file-reading tool: ";

// Images sent with a squad start (chat-image-upload U4) wait in `chat-files/_start/` while the board's Start
// squad dialog is open: there is no squad yet, and `_start` can never be a squad name (a squad name starts
// with a letter or digit). The Studio's start copies them next to the brief (fulfil/studio.ts).
export const START_TOPIC = "_start";
export const START_FILES_MAX = 8;

export const chatFileDir =(root: string, label: string, topic: string) => join(root, label, "chat-files", topic);

// null for a name that fails the rule, so `..`, a slash or an uppercase name never reaches the disk.
export function chatFilePath(root: string, label: string, topic: string, name: string): string | null {
  return CHAT_FILE_NAME.test(name) ? join(chatFileDir(root, label, topic), name) : null;
}

// `api/chat-file?project=…&topic=…&name=…`, the url the board serves a stored image at.
export const chatFileUrl = (project: string, topic: string, name: string) =>
  `api/chat-file?project=${encodeURIComponent(project)}&topic=${encodeURIComponent(topic)}&name=${encodeURIComponent(name)}`;
