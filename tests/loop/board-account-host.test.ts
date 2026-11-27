// board-account-host.test.ts — side-loop-host U20 (issue #127): the board's Add account takes a host. The board is
// built from fixture state (a loop.db with one online and one offline accepted host and an add open on the online
// one) and mounted: the dialog lists main and the hosts (an offline one disabled), a picked host hides the folder box
// and is posted; the open add shows where it logs in. The real route refuses a host whose link is down and a host
// with a folder, and files the add with its host.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoard } from "../../bin/board/board-data.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { mount } from "./board-mount.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = Math.floor(Date.now() / 1000);
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zzboardaccthost-"));
  temps.push(root);
  const s = open(root);
  stores.push(s);
  s.upsert("projects", { label: "fx" }, { studio_wt: "wt-studio", observed_at: T });
  const host = (name: string, down: boolean) => s.db.run(
    "INSERT INTO hosts (name, status, public_key, fingerprint, seats, requested_at, accepted_at, last_seen_at, unreachable_since) VALUES (?, 'accepted', 'a2V5', 'aaaa', 2, ?, ?, ?, ?)",
    [name, T, T, T, down ? T : null]);
  host("side-a", false);
  host("side-b", true);
  s.db.run("INSERT INTO hosts (name, status, public_key, fingerprint, seats, requested_at) VALUES ('side-c', 'pending', 'a2V5', 'cccc', 1, ?)", [T]);
  s.requestAny("account-add", { agent: "claude", name: "realp", project: "fx", host: "side-a" }, { project: "fx", by: "cli" });
  s.db.run("UPDATE requests SET result = ? WHERE kind = 'account-add'", [JSON.stringify({ state: "waiting_login", flow: "paste", url: "https://example.test/login" })]);
  return { s, root };
}

const texts = (el: any, sel: string) => [...el.querySelectorAll(sel)].map((n: any) => n.textContent.trim());

test("Add account: main and the accepted hosts, an offline one disabled; a picked host hides the folder and is posted", async () => {
  const { root } = fixture();
  const b = buildBoard("fx", "", root) as any;
  expect(b.account_hosts).toEqual([{ name: "side-a", online: true }, { name: "side-b", online: false }]);
  expect(b.account_adds).toEqual([expect.objectContaining({ name: "realp", host: "side-a", state: "waiting_login" })]);

  const r = await mount(b, false, { "api/limits": { limits: [], groups: [] } });
  const w = r.window, doc = w.document, posts: [string, any][] = [];
  try {
    w.fetch = async (url: string, init?: any) => {
      if (!init?.body) return { ok: true, status: 200, json: async () => (String(url).startsWith("board.json") ? b : { limits: [], groups: [] }), text: async () => "{}" };
      posts.push([String(url), JSON.parse(init.body)]);
      return { ok: true, status: 202, json: async () => ({ ok: true, id: 9 }), text: async () => "{}" };
    };
    const wait = (ms = 30) => new Promise((x) => setTimeout(x, ms));
    w.location.hash = "#settings/accounts";
    for (let k = 0; k < 80 && !doc.querySelector(".acct-pane"); k++) await wait(25);
    // The open add says where it logs in.
    expect(texts(doc.querySelector(".acct-pane"), ".bdg.where")).toContain("on side-a");

    doc.querySelector(".acct-add").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await wait();
    const dlg = doc.querySelector(".acct-dlg form") as any;
    const sel = dlg.querySelector(".add-host");
    expect(texts(sel, "option")).toEqual(["main", "side-a", "side-b (offline)"]);
    expect([...sel.querySelectorAll("option")].map((o: any) => o.disabled)).toEqual([false, false, true]);
    expect(dlg.querySelector(".add-dir")).not.toBeNull();   // main: the folder box is there

    sel.value = "side-a";
    sel.dispatchEvent(new w.Event("change", { bubbles: true }));
    await wait();
    expect(dlg.querySelector(".add-dir")).toBeNull();
    const name = dlg.querySelector(".add-name");
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(name, "work");
    name.dispatchEvent(new w.Event("input", { bubbles: true }));
    await wait();
    dlg.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    await wait();
    expect(posts).toEqual([["api/account-add", { project: "fx", agent: "claude", name: "work", host: "side-a" }]]);
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); }
});

test("Add account with no accepted host shows no host choice", async () => {
  const { s, root } = fixture();
  s.db.run("DELETE FROM hosts");
  const b = buildBoard("fx", "", root) as any;
  expect(b.account_hosts).toEqual([]);
  const r = await mount(b, false, { "api/limits": { limits: [], groups: [] } });
  const w = r.window, doc = w.document;
  try {
    const wait = (ms = 30) => new Promise((x) => setTimeout(x, ms));
    w.location.hash = "#settings/accounts";
    for (let k = 0; k < 80 && !doc.querySelector(".acct-pane"); k++) await wait(25);
    doc.querySelector(".acct-add").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await wait();
    expect(doc.querySelector(".acct-dlg .add-host")).toBeNull();
    expect(doc.querySelector(".acct-dlg .add-dir")).not.toBeNull();
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); }
});

test("the route: a host whose link is down, an unknown host and a host with a folder are refused; an online host is filed", async () => {
  const { s, root } = fixture();
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port; probe.stop(true);
  const url = `http://127.0.0.1:${port}`;
  const p = Bun.spawn([process.execPath, join(ROOT, "bin/board/board-server.ts"), "127.0.0.1", String(port),
    join(ROOT, "web/board.html"), join(ROOT, "bin/board/board-data.ts"), "fx"], { env: { ...process.env, DS_STATE_ROOT: root }, stdout: "ignore", stderr: "pipe" });
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch(url + "/healthz")).ok) break; } catch { /* not up yet */ } await Bun.sleep(20); }
    const post = async (body: unknown) => {
      const res = await fetch(url + "/api/account-add", { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, error: ((await res.json()) as any).error as string | undefined };
    };
    expect(await post({ project: "fx", agent: "claude", name: "two", host: "side-b" })).toEqual({ status: 409, error: "host side-b is not online: add it once its link is up" });
    expect(await post({ project: "fx", agent: "claude", name: "two", host: "side-c" })).toEqual({ status: 409, error: "no accepted host 'side-c'" });
    expect(await post({ project: "fx", agent: "claude", name: "two", host: "side-a", dir: "/tmp" })).toMatchObject({ status: 400, error: expect.stringContaining("leave it out to log in on side-a") });
    expect(await post({ project: "fx", agent: "claude", name: "two", host: "side-a" })).toMatchObject({ status: 202 });
    const rows = s.db.query("SELECT payload FROM requests WHERE kind = 'account-add' ORDER BY id").all() as Row[];
    expect(rows.map((x) => JSON.parse(String(x.payload)))).toEqual([
      expect.objectContaining({ name: "realp", host: "side-a" }),
      expect.objectContaining({ name: "two", host: "side-a", by: "board" }),
    ]);
  } finally { p.kill(); await p.exited; }
});
