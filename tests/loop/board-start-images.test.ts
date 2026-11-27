// chat-image-upload U5: the Start squad dialog attaches up to 8 images (picker, paste, drop), on the real page mounted
// in happy-dom with a stubbed fetch, createImageBitmap and canvas.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const root = join(import.meta.dir, "../..");
const now = Math.floor(Date.now() / 1000);
const empty = JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8"));
const board = {
  ...empty, project: "fixture", page_version: "v1", as_of: { accounts: now },
  projects: [{ label: "fixture", studio_backend: "orca" }, { label: "other", studio_backend: "orca" }],
};
const HEX = (n: number) => n.toString(16).padStart(16, "0");

async function open() {
  const r = await mount(board, false);
  const w = r.window, doc = w.document, wait = (ms: number) => new Promise((x) => setTimeout(x, ms));
  const uploads: any[] = [], posts: any[] = [];
  let n = 0, gone: string | null = null, hold: Promise<void> | null = null;
  w.fetch = async (url: string, init?: any) => {
    const body = (b: any, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b) });
    if (String(url).startsWith("api/chat-file") && init?.method === "POST") {
      uploads.push({ url: String(url), type: init.headers["Content-Type"] });
      if (hold) await hold;
      const name = new URL(String(url), "http://x/").searchParams.get("name");
      const id = HEX(++n) + (name ? "-" + name : ".png");
      return body({ id, url: "api/chat-file?project=fixture&topic=_start&name=" + id, bytes: init.body.size });
    }
    if (String(url) === "api/request" && init?.method === "POST") {
      const b = JSON.parse(init.body); posts.push(b);
      if (gone) return body({ error: `${gone.endsWith(".png") ? "image" : "file"} ${gone} is gone — attach it again` }, 409);
      return body({ ok: true, id: 9 }, 202);
    }
    return body({});
  };
  w.createImageBitmap = async () => ({ width: 100, height: 100, close() {} });
  const file = (name: string) => new w.File([new Uint8Array(10)], name, { type: "image/png" });
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(40); };
  const until = async (f: () => any) => { for (let i = 0; i < 200 && !f(); i++) await wait(25); if (!f()) throw new Error("page never showed it"); return f(); };
  const btn = (re: RegExp) => [...doc.querySelectorAll("button")].find((b: any) => re.test(b.textContent.trim())) as any;
  await click(await until(() => btn(/^Start squad$/)));
  await until(() => doc.querySelector(".start-text"));
  const set = async (sel: string, v: string, ev = "input") => { const el = doc.querySelector(sel); el.value = v; el.dispatchEvent(new w.Event(ev, { bubbles: true })); await wait(30); };
  const pick = async (...fs: any[]) => {
    const inp = doc.querySelector('.startsq input[type="file"]');
    Object.defineProperty(inp, "files", { value: fs, configurable: true });
    inp.dispatchEvent(new w.Event("change", { bubbles: true })); await wait(80);
  };
  const paste = async (...fs: any[]) => {
    const ev = new w.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { files: fs, items: [] } });
    doc.querySelector(".start-text").dispatchEvent(ev); await wait(80); return ev;
  };
  const drop = async (...fs: any[]) => {
    const dt = { types: ["Files"], files: fs }, box = doc.querySelector('.startsq [role="dialog"]');
    for (const t of ["dragover", "drop"]) {
      const ev = new w.Event(t, { bubbles: true, cancelable: true }); Object.defineProperty(ev, "dataTransfer", { value: dt });
      box.dispatchEvent(ev); if (t === "dragover") await wait(20);
    }
    await wait(80);
  };
  const thumbs = () => [...doc.querySelectorAll(".start-imgs .chat-th")];
  return { r, w, doc, wait, click, until, btn, set, pick, paste, drop, thumbs, uploads, posts, file,
    gone: (v: string | null) => { gone = v; }, hold: (p: Promise<void> | null) => { hold = p; }, close: () => w.happyDOM.close() };
}

test("the dialog offers 📎; picker, paste and drop give four thumbnails, Start posts their names, a ninth is refused", async () => {
  const t = await open();
  try {
    const b = t.doc.querySelector(".start-attach");
    expect(b.textContent).toContain("📎");
    expect(b.getAttribute("title")).toContain("up to 8");
    expect(b.getAttribute("title")).toContain("not checked for secrets");
    await t.pick(t.file("a.png"), t.file("b.png"));
    const ev = await t.paste(t.file("c.png"));
    expect(ev.defaultPrevented).toBe(true);
    await t.drop(t.file("d.png"));
    expect(t.thumbs().length).toBe(4);
    expect(t.uploads[0].url).toBe("api/chat-file?project=fixture&topic=_start");
    await t.pick(t.file("e.png"), t.file("f.png"), t.file("g.png"), t.file("h.png"), t.file("i.png"));
    expect(t.thumbs().length).toBe(8);
    expect(t.uploads.length).toBe(8);
    expect(t.doc.querySelector(".start-imgs").textContent).toContain("Up to 8 files");
    await t.click(t.doc.querySelector(".start-imgs .chat-rm"));   // ✕ removes one
    expect(t.thumbs().length).toBe(7);
    await t.set(".start-text", "go");
    await t.click(t.btn(/^Send$/));
    expect(t.posts.length).toBe(1);
    expect(t.posts[0].files).toEqual([2, 3, 4, 5, 6, 7, 8].map((i) => HEX(i) + ".png"));
    expect(t.r.errors).toEqual([]);
  } finally { await t.close(); }
});

test("a text paste is left alone; a start with no images posts no files", async () => {
  const t = await open();
  try {
    expect((await t.paste()).defaultPrevented).toBe(false);
    await t.set(".start-text", "go");
    await t.click(t.btn(/^Send$/));
    expect(t.posts[0]).not.toHaveProperty("files");
  } finally { await t.close(); }
});

test("changing the project clears the images with a note; Start waits while an upload runs", async () => {
  const t = await open();
  try {
    await t.pick(t.file("a.png"));
    expect(t.thumbs().length).toBe(1);
    await t.set(".start-project", "other", "change");
    expect(t.thumbs().length).toBe(0);
    expect(t.doc.querySelector(".start-imgs").textContent).toContain("attachments belong to one project — attach them again");
    let release!: () => void;
    t.hold(new Promise<void>((x) => { release = x; }));
    await t.pick(t.file("b.png"));
    expect(t.uploads[1].url).toBe("api/chat-file?project=other&topic=_start");
    expect(t.btn(/^Uploading…$/).disabled).toBe(true);
    release(); await t.wait(80);
    expect(t.btn(/^Send$/).disabled).toBe(false);
    expect(t.thumbs().length).toBe(1);
  } finally { await t.close(); }
});

test("a 409 'image … is gone' drops that thumbnail, keeps the dialog and shows the error", async () => {
  const t = await open();
  try {
    await t.pick(t.file("a.png"), t.file("b.png"));
    await t.set(".start-text", "go");
    t.gone(HEX(1) + ".png");
    await t.click(t.btn(/^Send$/));
    expect(t.thumbs().length).toBe(1);
    expect(t.doc.querySelector('[role="dialog"][aria-label="Start squad"]')).not.toBeNull();
    expect(t.doc.body.textContent).toContain("is gone");
  } finally { await t.close(); }
});

test("Start takes a text file raw, refuses another kind by name, and a 409 for a gone file drops its chip and keeps the dialog", async () => {
  const t = await open();
  try {
    expect(t.doc.querySelector('.startsq input[type="file"]').getAttribute("accept")).toContain(",.md,");
    await t.pick(t.file("a.png"), new t.w.File(["# x"], "x.md", { type: "" }), new t.w.File(["z"], "a.zip", { type: "application/zip" }));
    expect(t.uploads.map((u) => u.type).sort()).toEqual(["image/png", "text/plain"]);
    expect(t.uploads.find((u) => u.type === "text/plain").url).toBe("api/chat-file?project=fixture&topic=_start&name=x.md");
    expect(t.doc.querySelector(".start-imgs").textContent).toContain("a.zip: only pictures, text files and PDFs");
    const chip = t.doc.querySelector(".start-imgs .chat-doc");
    expect([chip.querySelector(".chat-fname").textContent, chip.querySelector(".chat-fsize").textContent]).toEqual(["x.md", "3 B"]);
    await t.set(".start-text", "build it from the spec");
    await t.click(t.doc.querySelector(".start-go"));
    const ids: string[] = t.posts[0].files;
    expect(ids.length).toBe(2);
  } finally { t.close(); }
  const u = await open();
  try {
    await u.pick(u.file("a.png"), new u.w.File(["# x"], "x.md", { type: "" }));
    await u.set(".start-text", "build it from the spec");
    u.gone(u.doc.querySelector(".start-imgs a.chat-file").getAttribute("href").split("name=")[1]);
    await u.click(u.doc.querySelector(".start-go"));
    expect(u.doc.querySelector(".startsq")).not.toBeNull();
    expect(u.doc.querySelector(".start-imgs .chat-doc")).toBeNull();
    expect(u.thumbs().length).toBe(1);
  } finally { u.close(); }
});
