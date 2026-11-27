// chat-files.test.ts — chat-image-upload U2: the shared file-name contract (chat/files.ts) pinned to the
// plan's literal rule, and the board's chat sends listing each send's files with a serving url.
// markdown-file-upload-support U1: one rule for images, text files and PDFs; a stem only on text and PDF names.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_FILE_NAME, FILES_MARK, IMAGES_MARK, TEXT_EXTS, chatFileDir, chatFileGone, chatFileKind, chatFilePath, chatFileShown, chatFileUrl, storedChatName } from "../../bin/loop/chat/files.ts";
import { chatJson } from "../../bin/board/board-data.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

test("the rule is the plan's directional regex: a stem only before a text or PDF extension", () => {
  const named = [...TEXT_EXTS, "pdf"].join("|");
  expect(CHAT_FILE_NAME.source).toBe(`^[0-9a-f]{16}(?:-[A-Za-z0-9][A-Za-z0-9._-]{0,47}(?=\\.(?:${named})$))?\\.(png|jpg|webp|gif|${named})$`);
  expect(IMAGES_MARK).toBe("[images attached; open each with your file-reading tool: ");
  expect(FILES_MARK).toBe("[files attached; read each with your file-reading tool: ");
});

test("chatFileKind names each kind and refuses a stem on an image, an SVG, an empty or a symbol stem", () => {
  const h = "0123456789abcdef";
  expect([`${h}.png`, `${h}.jpg`, `${h}.md`, `${h}-spec.md`, `${h}-v1.2-spec.md`, `${h}.pdf`, `${h}-My-Spec-v2.pdf`, `${h}-x.json`].map(chatFileKind))
    .toEqual(["image", "image", "text", "text", "text", "pdf", "pdf", "text"]);
  for (const bad of [`${h}-a.png`, `${h}.svg`, `${h}-.md`, `${h}--a.md`, `${h}-_a.md`, `${h}-a b.md`, `${h}-a/b.md`, `${h}-${"a".repeat(49)}.md`, `${h}.MD`, `${h}.docx`, `${h}.zip`])
    expect([bad, chatFileKind(bad)]).toEqual([bad, null]);
  expect(chatFileKind(`${h}-${"a".repeat(48)}.md`)).toBe("text");
});

test("storedChatName cleans the stem and never builds a name the rule refuses", () => {
  const h = "0123456789abcdef";
  const cases: [string, string, string][] = [
    ["md", "My Spec (v2).md", `${h}-My-Spec-v2.md`], ["md", "_notes.md", `${h}-notes.md`], ["md", "v1.2-spec.md", `${h}-v1.2-spec.md`],
    ["md", ".md", `${h}.md`], ["pdf", "%%%.pdf", `${h}.pdf`], ["md", "README", `${h}.md`], ["md", "éé--x--.md", `${h}-x.md`],
    ["md", `${"a".repeat(47)} b.md`, `${h}-${"a".repeat(47)}.md`], ["png", "photo.png", `${h}.png`], ["json", "a/../b.json", `${h}-a-..-b.json`],
  ];
  for (const [ext, orig, want] of cases) {
    expect([orig, storedChatName(h, ext, orig)]).toEqual([orig, want]);
    expect(CHAT_FILE_NAME.test(want)).toBe(true);
  }
  expect(chatFileShown(`${h}-My-Spec-v2.md`)).toBe("My-Spec-v2.md");
  expect(chatFileShown(`${h}.pdf`)).toBe(`${h}.pdf`);
  expect(chatFileGone(`${h}.png`)).toBe(`image ${h}.png is gone — attach it again`);
  expect(chatFileGone(`${h}-a.md`)).toBe(`file ${h}-a.md is gone — attach it again`);
});

test("chatFilePath resolves a good name inside the squad's folder and refuses the rest", () => {
  expect(chatFileDir("/st", "p", "sq")).toBe("/st/p/chat-files/sq");
  expect(chatFilePath("/st", "p", "sq", "0123456789abcdef.png")).toBe("/st/p/chat-files/sq/0123456789abcdef.png");
  expect(chatFilePath("/st", "p", "sq", "0123456789abcdef-spec.md")).toBe("/st/p/chat-files/sq/0123456789abcdef-spec.md");
  for (const bad of ["../../x.png", "../0123456789abcdef.png", "a/0123456789abcdef.png", "0123456789ABCDEF.png", "0123456789abcdef.jpeg", "0123456789abcdef.svg", "0123456789abcde.png", "",
    "0123456789abcdef-../x.md", "0123456789abcdef-a/b.md", "0123456789ABCDEF-a.md"])
    expect(chatFilePath("/st", "p", "sq", bad)).toBeNull();
});

test("chatJson lists each send's files with a serving url and drops a bad name", () => {
  const d = mkdtempSync(join(tmpdir(), "zzchatfiles-")); temps.push(d);
  const s = open(d); stores.push(s);
  const wt = "0a1b2c3d-0000-4000-8000-00000000d3a0::/w/ds-demo-builder-a";
  s.db.run("INSERT INTO members (project, squad, wt, role, suffix, agent, status, observed_at, updated_at) VALUES ('demo', 'sq', ?, 'builder', '', 'claude', 'running', 1, 1)", [wt]);
  s.request("chat", { text: "look", via: "board", files: ["0123456789abcdef.png", "../../x.png", "0123456789abcdef-spec.md", "fedcba9876543210.pdf"] }, { project: "demo", squad: "sq", member: wt });
  s.request("chat", { text: "plain", via: "board" }, { project: "demo", squad: "sq", member: wt });
  const r = chatJson({ project: "demo", topic: "sq", wt }, d) as any;
  expect(r.sends[0].files).toEqual([
    { name: "0123456789abcdef.png", kind: "image", url: chatFileUrl("demo", "sq", "0123456789abcdef.png") },
    { name: "0123456789abcdef-spec.md", kind: "text", url: chatFileUrl("demo", "sq", "0123456789abcdef-spec.md") },
    { name: "fedcba9876543210.pdf", kind: "pdf", url: chatFileUrl("demo", "sq", "fedcba9876543210.pdf") },
  ]);
  expect(r.sends[0].files[0].url).toBe("api/chat-file?project=demo&topic=sq&name=0123456789abcdef.png");
  expect(r.sends[1].files).toEqual([]);
});
