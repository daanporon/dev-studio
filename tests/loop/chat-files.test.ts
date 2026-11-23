// chat-files.test.ts — chat-image-upload U2: the shared file-name contract (chat/files.ts) pinned to the
// plan's literal rule, and the board's chat sends listing each send's files with a serving url.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_FILE_NAME, IMAGES_MARK, chatFileDir, chatFilePath, chatFileUrl } from "../../bin/loop/chat/files.ts";
import { chatJson } from "../../bin/board/board-data.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

test("the rule is the plan's literal regex", () => {
  expect(CHAT_FILE_NAME.source).toBe("^[0-9a-f]{16}\\.(png|jpg|webp|gif)$");
  expect(IMAGES_MARK).toBe("[images attached; open each with your file-reading tool: ");
});

test("chatFilePath resolves a good name inside the squad's folder and refuses the rest", () => {
  expect(chatFileDir("/st", "p", "sq")).toBe("/st/p/chat-files/sq");
  expect(chatFilePath("/st", "p", "sq", "0123456789abcdef.png")).toBe("/st/p/chat-files/sq/0123456789abcdef.png");
  for (const bad of ["../../x.png", "../0123456789abcdef.png", "a/0123456789abcdef.png", "0123456789ABCDEF.png", "0123456789abcdef.jpeg", "0123456789abcdef.svg", "0123456789abcde.png", ""])
    expect(chatFilePath("/st", "p", "sq", bad)).toBeNull();
});

test("chatJson lists each send's files with a serving url and drops a bad name", () => {
  const d = mkdtempSync(join(tmpdir(), "zzchatfiles-")); temps.push(d);
  const s = open(d); stores.push(s);
  const wt = "0a1b2c3d-0000-4000-8000-00000000d3a0::/w/ds-demo-builder-a";
  s.db.run("INSERT INTO members (project, squad, wt, role, suffix, agent, status, observed_at, updated_at) VALUES ('demo', 'sq', ?, 'builder', '', 'claude', 'running', 1, 1)", [wt]);
  s.request("chat", { text: "look", via: "board", files: ["0123456789abcdef.png", "../../x.png"] }, { project: "demo", squad: "sq", member: wt });
  s.request("chat", { text: "plain", via: "board" }, { project: "demo", squad: "sq", member: wt });
  const r = chatJson({ project: "demo", topic: "sq", wt }, d) as any;
  expect(r.sends[0].files).toEqual([{ name: "0123456789abcdef.png", url: chatFileUrl("demo", "sq", "0123456789abcdef.png") }]);
  expect(r.sends[0].files[0].url).toBe("api/chat-file?project=demo&topic=sq&name=0123456789abcdef.png");
  expect(r.sends[1].files).toEqual([]);
});
