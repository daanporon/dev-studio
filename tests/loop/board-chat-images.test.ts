// chat-image-upload U3: the Chat panel attaches, shrinks and shows images, on the real page mounted in happy-dom
// with a stubbed fetch, createImageBitmap and canvas (no browser, no network).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const root = join(import.meta.dir, "../..");
const now = Math.floor(Date.now() / 1000);
const empty = JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8"));
const board = {
  ...empty, project: "fixture", page_version: "v1", as_of: { accounts: now },
  squads: [{
    label: "fixture", topic: "sq", status: "running", display_status: "running", topic_plan: null, plans: [],
    members: [{ role: "builder", label: "builder-u6", wt: "wt-b", state: "working" }],
    units: [{ slug: "u6", state: "working", title: "Building unit", about: null, done_text: null, check_text: null, plan: null, plan_unit: null, deps: [], dependents: [], ext_deps: [],
      builder_wt: "wt-b", builder: { model_label: "m" }, tier: "std", pr: null, held: false }],
  }],
  flow: { ...empty.flow, cards: [{ key: "fixture/sq/u6", project: "fixture", squad: "sq", slug: "u6", stage: "building", needs_you: false, ask: null, stuck: false, slow: false, group: null }], merged: [] },
};
const CREW = [
  { wt: "wt-lead", label: "lead", role: "lead", unread: 0, reply_due: 0, reply_at: null },
  { wt: "wt-b", label: "builder-u6", role: "builder", unread: 0, reply_due: 0, reply_at: null },
];
const chatKey = (wt: string) => "api/chat?project=fixture&topic=sq&wt=" + encodeURIComponent(wt);
const HEX = (n: number) => n.toString(16).padStart(16, "0");

async function open(opts: { agent?: string; source?: string; turns?: any[]; sends?: any[] } = {}) {
  const chat: Record<string, any> = {
    "wt-b": { agent: opts.agent ?? "claude", source: opts.source ?? "transcript", working: false, updated_at: 1, turns: opts.turns ?? [], sends: opts.sends ?? [], crew: CREW },
    "wt-lead": { agent: "claude", source: "transcript", working: false, updated_at: 1, turns: [], sends: [], crew: CREW },
  };
  const fixtures: Record<string, any> = { [chatKey("wt-b")]: chat["wt-b"], [chatKey("wt-lead")]: chat["wt-lead"] };
  const r = await mount(board, false, fixtures);
  const w = r.window, doc = w.document, wait = (ms: number) => new Promise((x) => setTimeout(x, ms));
  w.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const uploads: any[] = [], posts: any[] = [], canvases: any[] = [];
  let n = 0, refuse: string | null = null, gone: string | null = null;
  const dims: Record<string, [number, number]> = {};
  const base = w.fetch;
  w.fetch = async (url: string, init?: any) => {
    const body = (b: any, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b) });
    if (String(url).startsWith("api/chat-file") && init?.method === "POST") {
      uploads.push({ url: String(url), type: init.headers["Content-Type"], size: init.body.size });
      if (refuse) return body({ error: refuse }, 415);
      const id = HEX(++n) + ".png";
      return body({ id, url: "api/chat-file?project=fixture&topic=sq&name=" + id, bytes: init.body.size });
    }
    if (String(url) === "api/chat" && init?.method === "POST") {
      const b = JSON.parse(init.body); posts.push(b);
      if (gone) return body({ error: `image ${gone} is gone — attach it again` }, 409);
      return body({ ok: true, id: 7 }, 202);
    }
    return base(url, init);
  };
  w.createImageBitmap = async (f: any) => { const d = dims[f.name] ?? [100, 100]; return { width: d[0], height: d[1], close() {} }; };
  const mk = doc.createElement.bind(doc);
  doc.createElement = (t: string, o?: any) => {
    if (t !== "canvas") return mk(t, o);
    const c: any = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {}, fillStyle: "" }) };
    c.toBlob = (cb: any, type: string, q: number) => { canvases.push({ w: c.width, h: c.height, type, q }); cb(new w.Blob(["jpeg"], { type })); };
    return c;
  };
  const file = (name: string, type = "image/png", size = 10) => new w.File([new Uint8Array(size)], name, { type });
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(40); };
  const until = async (f: () => any) => { for (let i = 0; i < 200 && !f(); i++) await wait(25); if (!f()) throw new Error("page never showed it"); return f(); };
  (await until(() => doc.getElementById("flow"))).open = true;
  await click(await until(() => [...doc.querySelectorAll(".fcard")].find((c: any) => c.querySelector(".t").textContent.trim() === "u6")));
  await click(await until(() => doc.querySelector(".ud-chat")));
  await until(() => doc.querySelector(".chat-in"));
  const pick = async (...fs: any[]) => {
    const inp = doc.querySelector('.chat-modal input[type="file"]');
    Object.defineProperty(inp, "files", { value: fs, configurable: true });
    inp.dispatchEvent(new w.Event("change", { bubbles: true })); await wait(80);
  };
  const paste = async (...fs: any[]) => {
    const ev = new w.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { files: fs, items: [] } });
    doc.querySelector(".chat-in").dispatchEvent(ev); await wait(80); return ev;
  };
  const drop = async (...fs: any[]) => {
    const dt = { types: ["Files"], files: fs }, mbox = doc.querySelector(".mbox.chat");
    for (const t of ["dragover", "drop"]) {
      const ev = new w.Event(t, { bubbles: true, cancelable: true }); Object.defineProperty(ev, "dataTransfer", { value: dt });
      mbox.dispatchEvent(ev); if (t === "dragover") await wait(20);
    }
    await wait(80);
  };
  const thumbs = () => [...doc.querySelectorAll(".chat-strip .chat-th")];
  return { w, doc, wait, click, until, pick, paste, drop, thumbs, uploads, posts, canvases, dims, chat, file, urls: r.urls,
    refuse: (v: string | null) => { refuse = v; }, gone: (v: string | null) => { gone = v; }, close: () => w.happyDOM.close() };
}

test("the panel offers 📎, and attaching by picker, paste and drop shows four thumbnails; a fifth is refused", async () => {
  const t = await open();
  try {
    const btn = t.doc.querySelector(".chat-attach");
    expect(btn.getAttribute("aria-label")).toBe("Attach images");
    expect(btn.querySelector("svg").getAttribute("aria-hidden")).toBe("true");
    expect(btn.textContent).not.toContain("📎");
    expect(btn.getAttribute("title")).toContain("not checked for secrets");
    expect(t.doc.querySelector('.chat-modal input[type="file"]').getAttribute("accept")).toBe("image/*");
    await t.pick(t.file("a.png"), t.file("b.png"));
    const ev = await t.paste(t.file("c.png"));
    expect(ev.defaultPrevented).toBe(true);
    await t.drop(t.file("d.png"));
    expect(t.thumbs().length).toBe(4);
    expect(t.uploads.map((u) => u.type)).toEqual(["image/png", "image/png", "image/png", "image/png"]);
    expect(t.uploads[0].url).toBe("api/chat-file?project=fixture&topic=sq&wt=wt-b");
    await t.pick(t.file("e.png"));
    expect(t.thumbs().length).toBe(4);
    expect(t.uploads.length).toBe(4);
    expect(t.doc.querySelector(".qfoot").textContent).toContain("Up to 4 images");
  } finally { t.close(); }
});

test("a text paste is left alone; a non-image file dropped is ignored", async () => {
  const t = await open();
  try {
    const ev = await t.paste();
    expect(ev.defaultPrevented).toBe(false);
    await t.drop(t.file("x.txt", "text/plain"));
    expect(t.uploads.length).toBe(0);
    expect(t.thumbs().length).toBe(0);
  } finally { t.close(); }
});

test("a big image is redrawn at 2000 px as JPEG before upload; a small one goes as it is; an unreadable one is refused on its thumbnail", async () => {
  const t = await open();
  try {
    t.dims["big.png"] = [4000, 3000]; t.dims["huge.png"] = [800, 600];
    await t.pick(t.file("big.png"), t.file("small.png"), t.file("huge.png", "image/png", 4 * 1024 * 1024));
    expect(t.canvases).toEqual([{ w: 2000, h: 1500, type: "image/jpeg", q: 0.85 }, { w: 800, h: 600, type: "image/jpeg", q: 0.85 }]);
    expect(t.uploads.map((u) => u.type).sort()).toEqual(["image/jpeg", "image/jpeg", "image/png"]);
    t.dims["heic.heic"] = [0, 0];
    await t.pick(t.file("heic.heic", "image/heic"));
    const bad = t.doc.querySelector(".chat-strip .chat-th.bad");
    expect(bad.textContent).toContain("can't read this image");
    expect(t.uploads.length).toBe(3);
    await t.click(bad.querySelector(".chat-rm"));
    expect(t.doc.querySelector(".chat-th.bad")).toBeNull();
  } finally { t.close(); }
});

test("a refusal from the server shows on the thumbnail and attaches nothing", async () => {
  const t = await open();
  try {
    t.refuse("not a png");
    await t.pick(t.file("a.png"));
    expect(t.doc.querySelector(".chat-th.bad").textContent).toContain("not a png");
    expect(t.thumbs().length).toBe(1);
    expect(t.doc.querySelectorAll(".chat-strip img").length).toBe(0);
  } finally { t.close(); }
});

test("✕ removes one, and the three survive a member switch (ids only in the draft)", async () => {
  const t = await open();
  try {
    await t.pick(t.file("a.png"), t.file("b.png"), t.file("c.png"));
    await t.click(t.thumbs()[1].querySelector(".chat-rm"));
    expect(t.thumbs().length).toBe(2);
    await t.pick(t.file("d.png"));
    expect(t.thumbs().length).toBe(3);
    const draft = JSON.parse(t.w.sessionStorage.getItem("b:chat-draft:fixture/sq/wt-b"));
    expect(draft.files.map((f: any) => Object.keys(f).sort())).toEqual([["id", "name", "url"], ["id", "name", "url"], ["id", "name", "url"]]);
    const tabs = [...t.doc.querySelectorAll('.chat-tabs [role="tab"]')];
    await t.click(tabs.find((x: any) => x.getAttribute("title") === "lead"));
    expect(t.thumbs().length).toBe(0);
    await t.click([...t.doc.querySelectorAll('.chat-tabs [role="tab"]')].find((x: any) => x.getAttribute("title") === "builder-u6"));
    expect(t.thumbs().length).toBe(3);
  } finally { t.close(); }
});

test("a send with no text posts the ids, clears the draft and shows a pending bubble with the thumbnails; the turn replaces it once", async () => {
  const t = await open();
  try {
    await t.pick(t.file("a.png"), t.file("b.png"), t.file("c.png"));
    const send = t.doc.querySelector(".qfoot .btn.pri");
    expect(send.disabled).toBe(false);
    const ids = [HEX(1) + ".png", HEX(2) + ".png", HEX(3) + ".png"];
    t.chat["wt-b"].sends = [{ id: 7, text: "", files: ids.map((name) => ({ name, url: "api/chat-file?project=fixture&topic=sq&name=" + name })), at: now, state: "queued", why: "working" }];
    await t.click(send);
    await t.until(() => t.doc.querySelector(".chat-turn.op .chat-imgs"));
    expect(t.posts).toEqual([{ project: "fixture", topic: "sq", wt: "wt-b", text: "", files: ids.sort() }].map((p) => ({ ...p, files: t.posts[0].files })));
    expect([...t.posts[0].files].sort()).toEqual(ids);
    expect(t.thumbs().length).toBe(0);
    expect(t.w.sessionStorage.getItem("b:chat-draft:fixture/sq/wt-b")).toBeNull();
    expect(t.doc.querySelectorAll(".chat-turn.op .chat-img").length).toBe(3);
    // The observer's turn arrives: images by name, same text. One bubble, the send's urls.
    t.chat["wt-b"].turns = [{ role: "user", from: "operator", text: "", at: now + 1, images: ids }];
    t.chat["wt-b"].sends[0].state = "turn started";
    await t.wait(3300);
    expect(t.doc.querySelectorAll(".chat-turn.op").length).toBe(1);
    expect(t.doc.querySelectorAll(".chat-turn.op .chat-img").length).toBe(3);
    expect([...t.doc.querySelectorAll(".chat-turn.op .chat-img")].map((i: any) => i.getAttribute("src"))).toEqual(ids.map((n) => "api/chat-file?project=fixture&topic=sq&name=" + n));
  } finally { t.close(); }
}, 15000);

test("a send clears the image-limit note together with the thumbnails", async () => {
  const t = await open();
  try {
    await t.pick(t.file("a.png"), t.file("b.png"), t.file("c.png"), t.file("d.png"));
    await t.pick(t.file("e.png"));
    expect(t.doc.querySelector(".qfoot").textContent).toContain("Up to 4 images");
    await t.click(t.doc.querySelector(".qfoot .btn.pri"));
    await t.until(() => t.posts.length === 1);
    await t.until(() => t.thumbs().length === 0);
    expect(t.doc.querySelector(".qfoot").textContent).not.toContain("Up to 4 images");
  } finally { t.close(); }
}, 15000);

test("text with images posts both; a 409 'gone' drops that thumbnail only and shows the error", async () => {
  const t = await open();
  try {
    await t.pick(t.file("a.png"), t.file("b.png"));
    const ta = t.doc.querySelector(".chat-in");
    ta.value = "look"; ta.dispatchEvent(new t.w.Event("input", { bubbles: true })); await t.wait(30);
    t.gone(HEX(1) + ".png");
    await t.click(t.doc.querySelector(".qfoot .btn.pri"));
    expect(t.posts[0].text).toBe("look");
    expect(t.posts[0].files.length).toBe(2);
    await t.until(() => t.doc.querySelector(".qfoot .err"));
    expect(t.doc.querySelector(".qfoot .err").textContent).toContain("is gone");
    expect(t.thumbs().length).toBe(1);
    expect(t.doc.querySelector(".chat-in").value).toBe("look");
  } finally { t.close(); }
});

test("Send waits while an upload runs, and a send with nothing to say or attach is disabled", async () => {
  const t = await open();
  try {
    expect(t.doc.querySelector(".qfoot .btn.pri").disabled).toBe(true);
    let release: any;
    const gate = new Promise((x) => { release = x; });
    const f = t.w.fetch;
    t.w.fetch = async (u: string, i?: any) => { if (String(u).startsWith("api/chat-file") && i?.method === "POST") await gate; return f(u, i); };
    await t.pick(t.file("a.png"));
    expect(t.doc.querySelector(".chat-th .spin")).not.toBeNull();
    expect(t.doc.querySelector(".qfoot .btn.pri").disabled).toBe(true);
    release(); await t.until(() => t.thumbs().length === 1 && !t.doc.querySelector(".chat-th .spin"));
    expect(t.doc.querySelector(".qfoot .btn.pri").disabled).toBe(false);
  } finally { t.close(); }
});

test("an old bubble whose file was pruned says image removed; a native attachment is a muted chip; a turn alone builds its url from the name", async () => {
  const name = HEX(9) + ".png";
  const t = await open({ turns: [{ role: "user", from: "operator", text: "look", at: now - 5, images: [name, null] }] });
  try {
    const imgs = [...t.doc.querySelectorAll(".chat-turn.op .chat-img")];
    expect(imgs.map((i: any) => i.getAttribute("src"))).toEqual(["api/chat-file?project=fixture&topic=sq&name=" + name]);
    expect(t.doc.querySelector(".chat-turn.op .chat-imgchip").textContent).toBe("image");
    imgs[0].dispatchEvent(new t.w.Event("error"));
    await t.wait(40);
    expect(t.doc.querySelector(".chat-turn.op").textContent).toContain("image removed");
    expect(t.doc.querySelector(".chat-turn.op a")).toBeNull();
  } finally { t.close(); }
});

test("a click on a bubble image opens the full file in a new tab", async () => {
  const name = HEX(9) + ".png";
  const t = await open({ turns: [{ role: "user", from: "operator", text: "look", at: now - 5, images: [name] }] });
  try {
    const a = t.doc.querySelector(".chat-turn.op a");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("href")).toBe("api/chat-file?project=fixture&topic=sq&name=" + name);
  } finally { t.close(); }
});

test("a Muse member, or a screen-tail chat, warns that it may not see images; a Claude transcript does not", async () => {
  for (const [o, warn] of [[{ agent: "muse", source: "screen" }, true], [{ agent: "codex", source: "screen" }, true], [{}, false]] as const) {
    const t = await open(o);
    try {
      const has = (t.doc.querySelector(".qfoot .chat-note")?.textContent ?? "").includes("may not see images");
      expect(has).toBe(warn);
    } finally { t.close(); }
  }
});
