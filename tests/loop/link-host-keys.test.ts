// link-host-keys.test.ts — side-loop-host U1 (issue #127, KTD4): a join request (name + Ed25519 public key)
// makes a `pending` host within the caps (valid name, at most 3 pending, 15-minute expiry, size cap);
// `ds host accept|reject|remove|list` work on main; a signature over main's challenge verifies only for an
// accepted host's key, and a replayed or wrong signature fails; no private key ever reaches loop.db or events.
// U12b: main's own key (made once, 0600), its signature over the side's nonce, and the side's pin.
import { afterEach, describe, expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import {
  accept, Challenges, ensureHostKey, expirePending, fingerprint, JOIN_MAX_BYTES, listHosts, MAX_PENDING, nameProblem,
  newKeyPair, parseJoinFrame, PENDING_TTL_S, reject, remove, requestJoin, signHello, verifyHello, verifySignature,
  ensureMainKey, mainFingerprint, mainPinPath, pinMainKey, readMainPin, signMain, verifyMain,
} from "../../bin/link/host-keys.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const T0 = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(): string { const d = mkdtempSync(join(tmpdir(), "zzhk-")); temps.push(d); return d; }
function store(root = temp()): Store { const s = open(root); stores.push(s); return s; }
const host = (s: Store, name: string): Row | null => s.get("hosts", { name });
const events = (s: Store, kind: string): Row[] => s.db.query("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[];

function ds(root: string, ...args: string[]): { code: number; out: string; err: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DS_MEMBER|DS_WT|DS_GEN|DS_NOW|DS_WHO)$/.test(k)) env[k] = v;
  const r = Bun.spawnSync([DS, "host", ...args], { env: { ...env, DS_STATE_ROOT: root }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("join requests", () => {
  test("a valid name and key make one pending host with the key's fingerprint", () => {
    const s = store(), k = newKeyPair();
    const r = requestJoin(s, { name: "box-2", public_key: k.publicKey }, T0);
    expect(r).toEqual({ ok: true, name: "box-2", fingerprint: fingerprint(k.publicKey), created: true });
    expect(fingerprint(k.publicKey)).toMatch(/^[0-9a-f]{4}(:[0-9a-f]{4}){7}$/);
    const h = host(s, "box-2")!;
    expect(h).toMatchObject({ status: "pending", public_key: k.publicKey, seats: 2, requested_at: T0 });
    expect(events(s, "host_join_requested").length).toBe(1);
  });

  test("names: lowercase letters, digits and inner '-', at most 32, never local", () => {
    for (const ok of ["a", "box2", "side-host-1", "x".repeat(32)]) expect(nameProblem(ok)).toBeNull();
    for (const bad of ["", "Box", "-a", "a-", "a_b", "a.b", "x".repeat(33), "local", "a b", "../a", 7, null]) expect(nameProblem(bad)).not.toBeNull();
    const s = store(), k = newKeyPair();
    expect(requestJoin(s, { name: "local", public_key: k.publicKey }, T0).ok).toBe(false);
    expect(requestJoin(s, { name: "Bad Name", public_key: k.publicKey }, T0).ok).toBe(false);
    expect(s.db.query("SELECT COUNT(*) AS n FROM hosts").get()).toEqual({ n: 0 });
  });

  test("only an Ed25519 SPKI key is taken", () => {
    const s = store();
    for (const key of ["", "not base64!", Buffer.alloc(44).toString("base64"), Buffer.alloc(32, 1).toString("base64"), "A".repeat(4000), 12])
      expect(requestJoin(s, { name: "box", public_key: key }, T0).ok).toBe(false);
    expect(host(s, "box")).toBeNull();
  });

  test("at most 3 pending at once; the same key again is the same request; another key for a waiting name is refused", () => {
    const s = store();
    const keys = Array.from({ length: MAX_PENDING + 1 }, () => newKeyPair());
    for (let i = 0; i < MAX_PENDING; i++) expect(requestJoin(s, { name: `h${i}`, public_key: keys[i].publicKey }, T0 + i).ok).toBe(true);
    const full = requestJoin(s, { name: "h9", public_key: keys[MAX_PENDING].publicKey }, T0 + 5);
    expect(full.ok).toBe(false);
    expect(host(s, "h9")).toBeNull();
    expect(requestJoin(s, { name: "h0", public_key: keys[0].publicKey }, T0 + 6)).toMatchObject({ ok: true, created: false });
    expect(host(s, "h0")!.requested_at).toBe(T0);   // asking again does not extend the expiry
    const swap = requestJoin(s, { name: "h1", public_key: keys[MAX_PENDING].publicKey }, T0 + 7);
    expect(swap).toMatchObject({ ok: false });
    expect(host(s, "h1")!.public_key).toBe(keys[1].publicKey);
    expect(events(s, "host_join_requested").length).toBe(MAX_PENDING);
  });

  test("a pending request expires after 15 minutes and frees its place", () => {
    const s = store();
    for (let i = 0; i < MAX_PENDING; i++) requestJoin(s, { name: `h${i}`, public_key: newKeyPair().publicKey }, T0);
    expect(listHosts(s, {}, T0 + PENDING_TTL_S - 1).length).toBe(MAX_PENDING);
    expect(listHosts(s, {}, T0 + PENDING_TTL_S).length).toBe(0);   // shown as gone at once, even before the sweep
    expect(requestJoin(s, { name: "late", public_key: newKeyPair().publicKey }, T0 + PENDING_TTL_S).ok).toBe(true);
    expect(host(s, "h0")).toBeNull();
    expect(events(s, "host_join_expired").map((e) => JSON.parse(String(e.payload)).name)).toEqual(["h0", "h1", "h2"]);
    expect(accept(s, "h1", {}, T0 + PENDING_TTL_S + 1)).toMatchObject({ ok: false });
    expect(expirePending(s, T0 + PENDING_TTL_S + 2)).toEqual([]);
  });

  test("an accepted name is refused; a removed name may ask again", () => {
    const s = store(), k = newKeyPair(), k2 = newKeyPair();
    requestJoin(s, { name: "box", public_key: k.publicKey }, T0);
    expect(accept(s, "box", { seats: 3, by: "op" }, T0 + 1)).toMatchObject({ ok: true });
    expect(requestJoin(s, { name: "box", public_key: k2.publicKey }, T0 + 2)).toMatchObject({ ok: false });
    expect(requestJoin(s, { name: "box", public_key: k.publicKey }, T0 + 2)).toMatchObject({ ok: false });
    expect(host(s, "box")).toMatchObject({ status: "accepted", public_key: k.publicKey, seats: 3, accepted_by: "op" });
    remove(s, "box", { by: "op" }, T0 + 3);
    expect(requestJoin(s, { name: "box", public_key: k2.publicKey }, T0 + 4)).toMatchObject({ ok: true, created: true });
    expect(host(s, "box")).toMatchObject({ status: "pending", public_key: k2.publicKey, accepted_at: null, removed_at: null });
  });

  test("a join frame over the size cap is refused before it is parsed", () => {
    const k = newKeyPair();
    expect(parseJoinFrame(JSON.stringify({ name: "box", public_key: k.publicKey }))).toEqual({ ok: true, name: "box", public_key: k.publicKey });
    expect(parseJoinFrame(JSON.stringify({ name: "box", public_key: k.publicKey, pad: "x".repeat(JOIN_MAX_BYTES) }))).toMatchObject({ ok: false });
    expect(parseJoinFrame(new Uint8Array(JOIN_MAX_BYTES + 1))).toMatchObject({ ok: false });
    expect(parseJoinFrame("{not json")).toMatchObject({ ok: false });
    expect(parseJoinFrame(JSON.stringify({ name: "box" }))).toMatchObject({ ok: false });
  });
});

describe("accept, reject, remove", () => {
  test("accept takes only a pending host; reject only a pending one; remove deletes the key", () => {
    const s = store();
    requestJoin(s, { name: "a", public_key: newKeyPair().publicKey }, T0);
    requestJoin(s, { name: "b", public_key: newKeyPair().publicKey }, T0);
    expect(accept(s, "nope", {}, T0)).toMatchObject({ ok: false });
    expect(accept(s, "a", { seats: -1 }, T0)).toMatchObject({ ok: false });
    expect(accept(s, "a", {}, T0 + 1)).toMatchObject({ ok: true, host: { status: "accepted", seats: 2 } });
    expect(accept(s, "a", {}, T0 + 2)).toMatchObject({ ok: false });
    expect(reject(s, "a", {}, T0 + 2)).toMatchObject({ ok: false });
    expect(reject(s, "b", { by: "op" }, T0 + 2)).toMatchObject({ ok: true, host: { status: "removed", public_key: null, removed_by: "op" } });
    expect(reject(s, "b", {}, T0 + 3)).toMatchObject({ ok: false });
    expect(remove(s, "a", {}, T0 + 3)).toMatchObject({ ok: true, host: { status: "removed", public_key: null } });
    expect(remove(s, "a", {}, T0 + 4)).toMatchObject({ ok: false });
    expect(listHosts(s, {}, T0 + 4)).toEqual([]);
    expect(listHosts(s, { all: true }, T0 + 4).map((r) => r.name)).toEqual(["a", "b"]);
    expect([events(s, "host_accepted").length, events(s, "host_rejected").length, events(s, "host_removed").length]).toEqual([1, 1, 1]);
  });

  test("ds host list, accept, reject and remove on a state root", () => {
    const root = temp(), s = store(root), k = newKeyPair();
    requestJoin(s, { name: "side-1", public_key: k.publicKey });
    requestJoin(s, { name: "side-2", public_key: newKeyPair().publicKey });
    let r = ds(root, "list");
    expect(r.code).toBe(0);
    expect(r.out).toContain("side-1");
    expect(r.out).toContain(fingerprint(k.publicKey));
    expect(r.out).toContain("pending");
    expect(ds(root, "accept", "side-1", "--seats", "x").code).toBe(2);
    r = ds(root, "accept", "side-1", "--seats", "4");
    expect(r.code).toBe(0);
    expect(r.out).toContain("accepted with 4 seats");
    expect(r.out).toContain(`main's key fingerprint ${ensureMainKey(root).fingerprint}`);   // U12b
    expect(ds(root, "key").out).toContain(`main's key fingerprint ${ensureMainKey(root).fingerprint}`);
    expect(ds(root, "key", "extra").code).toBe(2);
    expect(ds(root, "accept", "side-1").code).toBe(1);
    expect(ds(root, "reject", "side-2").code).toBe(0);
    r = ds(root, "list", "--json");
    expect(JSON.parse(r.out).map((h: Row) => [h.name, h.status, h.seats])).toEqual([["side-1", "accepted", 4]]);
    expect(ds(root, "remove", "side-1").code).toBe(0);
    expect(ds(root, "list").out).toContain("no side hosts");
    expect(JSON.parse(ds(root, "list", "--all", "--json").out).map((h: Row) => h.status)).toEqual(["removed", "removed"]);
    expect(ds(root, "bogus").code).toBe(2);
    expect(ds(root, "remove").code).toBe(2);
    expect(ds(root, "reject", "side-2", "--seats", "1").code).toBe(2);
    expect(ds(root).code).toBe(2);
  });
});

describe("main's key (U12b)", () => {
  test("main's key is made once, 0600, and the board can read its fingerprint without making one", () => {
    const root = temp();
    expect(mainFingerprint(root)).toBeNull();
    const a = ensureMainKey(root), b = ensureMainKey(root);
    expect(b).toEqual(a);
    expect(statSync(a.file).mode & 0o777).toBe(0o600);
    expect(mainFingerprint(root)).toBe(a.fingerprint);
  });

  test("main's signature binds the side's nonce, main's challenge, the version and the host name", () => {
    const k = newKeyPair(), side = Buffer.alloc(32, 1), ch = Buffer.alloc(32, 2);
    const sig = signMain(k.privateKey, side, ch, "1", "box");
    expect(verifyMain(k.publicKey, side, ch, "1", "box", sig)).toBe(true);
    expect(verifyMain(k.publicKey, Buffer.alloc(32, 3), ch, "1", "box", sig)).toBe(false);
    expect(verifyMain(k.publicKey, side, Buffer.alloc(32, 3), "1", "box", sig)).toBe(false);
    expect(verifyMain(k.publicKey, side, ch, "2", "box", sig)).toBe(false);
    expect(verifyMain(k.publicKey, side, ch, "1", "other", sig)).toBe(false);
    expect(verifyMain(newKeyPair().publicKey, side, ch, "1", "box", sig)).toBe(false);
    // A side's hello signature is not main's: the tags differ.
    expect(verifyMain(k.publicKey, side, ch, "1", "box", signHello(k.privateKey, Buffer.concat([side, ch]), "1", "box"))).toBe(false);
  });

  test("the side pins main's public key; a non-key is refused and an unreadable pin reads as none", () => {
    const root = temp(), k = newKeyPair();
    expect(readMainPin(root)).toBeNull();
    expect(pinMainKey(root, "not a key").ok).toBe(false);
    const r = pinMainKey(root, k.publicKey);
    expect(r).toEqual({ ok: true, fingerprint: fingerprint(k.publicKey), file: mainPinPath(root) });
    expect(readMainPin(root)).toBe(k.publicKey);
    expect(readdirSync(join(root, "link"))).toEqual(["main.pub"]);
    writeFileSync(mainPinPath(root), "garbage");
    expect(readMainPin(root)).toBeNull();
  });
});

describe("the hello signature", () => {
  function joined(s: Store, name = "box"): { privateKey: string; publicKey: string } {
    const k = newKeyPair();
    requestJoin(s, { name, public_key: k.publicKey }, T0);
    return k;
  }
  const VERSION = "1";

  test("verifies only for an accepted host's own key over main's challenge", () => {
    const s = store(), ch = new Challenges(), k = joined(s);
    let nonce = ch.issue("box", T0);
    expect(verifyHello(s, ch, { name: "box", nonce, linkVersion: VERSION, signature: signHello(k.privateKey, nonce, VERSION, "box") }, T0)).toMatchObject({ ok: false });   // pending
    accept(s, "box", {}, T0);
    nonce = ch.issue("box", T0);
    const good = verifyHello(s, ch, { name: "box", nonce, linkVersion: VERSION, signature: signHello(k.privateKey, nonce, VERSION, "box") }, T0 + 1);
    expect(good).toMatchObject({ ok: true, host: { name: "box", status: "accepted" } });
    expect(ch.size).toBe(0);
  });

  test("a replayed, wrong or misbound signature fails", () => {
    const s = store(), ch = new Challenges(), k = joined(s), other = newKeyPair();
    joined(s, "peer");
    accept(s, "box", {}, T0);
    accept(s, "peer", {}, T0);
    const nonce = ch.issue("box", T0), sig = signHello(k.privateKey, nonce, VERSION, "box");
    expect(verifyHello(s, ch, { name: "box", nonce, linkVersion: VERSION, signature: sig }, T0).ok).toBe(true);
    // Replay: the same challenge and signature a second time.
    expect(verifyHello(s, ch, { name: "box", nonce, linkVersion: VERSION, signature: sig }, T0)).toMatchObject({ ok: false });
    // An old signature against a fresh challenge.
    const n2 = ch.issue("box", T0);
    expect(verifyHello(s, ch, { name: "box", nonce: n2, linkVersion: VERSION, signature: sig }, T0)).toMatchObject({ ok: false, why: "bad signature" });
    expect(ch.take("box", n2, T0)).toBe(false);   // a failed hello spends its challenge too
    // Another key, another version, another name, garbage.
    const tries: [string, string, string][] = [[other.privateKey, VERSION, "box"], [k.privateKey, "2", "box"], [k.privateKey, VERSION, "peer"]];
    for (const [pk, v, n] of tries) {
      const c = ch.issue("box", T0);
      expect(verifyHello(s, ch, { name: "box", nonce: c, linkVersion: VERSION, signature: signHello(pk, c, v, n) }, T0)).toMatchObject({ ok: false });
    }
    for (const junk of ["", "AAAA", "x".repeat(200)]) {
      const c = ch.issue("box", T0);
      expect(verifyHello(s, ch, { name: "box", nonce: c, linkVersion: VERSION, signature: junk }, T0)).toMatchObject({ ok: false });
    }
    // A challenge issued to one host is no good for another, and one past its time is no good at all.
    const forBox = ch.issue("box", T0);
    expect(verifyHello(s, ch, { name: "peer", nonce: forBox, linkVersion: VERSION, signature: signHello(k.privateKey, forBox, VERSION, "peer") }, T0)).toMatchObject({ ok: false });
    const old = ch.issue("box", T0);
    expect(verifyHello(s, ch, { name: "box", nonce: old, linkVersion: VERSION, signature: signHello(k.privateKey, old, VERSION, "box") }, T0 + 31)).toMatchObject({ ok: false });
    // A made-up challenge main never issued.
    const fake = Buffer.alloc(32, 7);
    expect(verifyHello(s, ch, { name: "box", nonce: fake, linkVersion: VERSION, signature: signHello(k.privateKey, fake, VERSION, "box") }, T0)).toMatchObject({ ok: false });
    expect(verifySignature(k.publicKey, fake, VERSION, "box", signHello(k.privateKey, fake, VERSION, "box"))).toBe(true);
  });

  test("a removed host's signature no longer verifies", () => {
    const s = store(), ch = new Challenges(), k = joined(s);
    accept(s, "box", {}, T0);
    remove(s, "box", {}, T0 + 1);
    const nonce = ch.issue("box", T0 + 2);
    expect(verifyHello(s, ch, { name: "box", nonce, linkVersion: VERSION, signature: signHello(k.privateKey, nonce, VERSION, "box") }, T0 + 2)).toMatchObject({ ok: false });
  });
});

describe("private keys stay on the side host", () => {
  test("the side's key file is 0600 and stable; only its public half comes back", () => {
    const root = temp();
    const a = ensureHostKey(root), b = ensureHostKey(root);
    expect(a).toEqual(b);
    expect(statSync(a.file).mode & 0o777).toBe(0o600);
    expect(Object.keys(a).sort()).toEqual(["file", "fingerprint", "publicKey"]);
    expect(a.fingerprint).toBe(fingerprint(a.publicKey));
  });

  test("no private key in loop.db, its events or the command's output", () => {
    const root = temp(), side = temp(), s = store(root);
    const mine = ensureHostKey(side), pem = readFileSync(mine.file, "utf8");
    const raw = Buffer.from(String(createPrivateKey(pem).export({ format: "jwk" }).d), "base64url");
    expect(requestJoin(s, { name: "box", public_key: mine.publicKey }).ok).toBe(true);
    const outs = [ds(root, "list", "--json"), ds(root, "accept", "box"), ds(root, "list"), ds(root, "remove", "box")].map((r) => r.out + r.err);
    const ch = new Challenges(), nonce = ch.issue("box");
    verifyHello(s, ch, { name: "box", nonce, linkVersion: "1", signature: signHello(pem, nonce, "1", "box") });
    s.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const hay = [JSON.stringify(s.db.query("SELECT * FROM hosts").all()), JSON.stringify(s.db.query("SELECT * FROM events").all()), ...outs];
    for (const f of readdirSync(root).filter((f) => f.startsWith("loop.db"))) hay.push(readFileSync(join(root, f)).toString("latin1"));
    for (const h of hay) {
      expect(h.includes(body)).toBe(false);
      expect(h.includes("PRIVATE KEY")).toBe(false);
      expect(h.includes(raw.toString("base64"))).toBe(false);
      expect(h.includes(raw.toString("latin1"))).toBe(false);
    }
  });
});
