// host-keys.ts — side-loop-host U1 (issue #127, KTD4): the host list and host keys. A side host proves
// itself with an Ed25519 key pair it makes itself (`node:crypto`); the private key stays in a 0600 file in
// the side state root and never travels, never lands in loop.db, an event or a log line. Main keeps the
// public key in `hosts` (migration 0060).
//   requestJoin   an unauthenticated join request (name + public key) → a `pending` row within the caps:
//                 a valid name, a frame of at most JOIN_MAX_BYTES, at most MAX_PENDING pending at once, a
//                 pending row expires after PENDING_TTL_S, an accepted name is refused
//   accept | reject | remove   the operator's answer (`ds host`, and the board's Accept in U17)
//   Challenges + verifyHello   main sends 32 fresh random bytes; the side signs them with the link version
//                 and its name; a challenge is good once, so a replayed signature fails
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { now, type Row, type Store } from "../loop/core/store.ts";
import { acceptDefaults, dropHost } from "../loop/settings/host-settings.ts";

export const LOCAL_HOST = "local";
/** What to do on main when a first join cannot reach it: `ds host list`, `ds join` and the board's join row say it. */
export const linkListenHint = (port: number): string =>
  `main's link server is not running, so a first join cannot reach it (port ${port}); turn it on with \`ds config set <project> limits.conf link_listen on\``;          // main itself (bin/backend/registry.ts); never a side host's name
export const PENDING_TTL_S = 15 * 60;
export const MAX_PENDING = 3;
export const JOIN_MAX_BYTES = 4096;
export const CHALLENGE_BYTES = 32;
export const CHALLENGE_TTL_S = 30;
export const DEFAULT_SEATS = 2;
export const HOST_STATES = ["pending", "accepted", "removed"] as const;
export type HostState = (typeof HOST_STATES)[number];

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const SPKI_ED25519_BYTES = 44;
const HELLO_TAG = "ds-link-hello";

export type Result<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; why: string };

/** A host name: 1-32 lowercase letters, digits and inner '-'; `local` is main's. Null when valid, else why not. */
export function nameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !NAME_RE.test(name)) return "a host name is 1-32 lowercase letters, digits and inner '-'";
  if (name === LOCAL_HOST) return `'${LOCAL_HOST}' is main's own name`;
  return null;
}

/** The public key as a KeyObject when `b64` is the base64 SPKI DER of an Ed25519 key, else null. */
export function parsePublicKey(b64: unknown): KeyObject | null {
  if (typeof b64 !== "string" || b64.length > 128 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return null;
  const der = Buffer.from(b64, "base64");
  if (der.length !== SPKI_ED25519_BYTES) return null;
  try {
    const k = createPublicKey({ key: der, format: "der", type: "spki" });
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch { return null; }
}

/** First 16 bytes of the SHA-256 of the raw 32-byte public key, hex in groups of 4 ("ab12:cd34:…"). */
export function fingerprint(publicKey: string | KeyObject): string {
  const k = typeof publicKey === "string" ? parsePublicKey(publicKey) : publicKey;
  if (!k) throw new Error("host-keys: not an Ed25519 public key");
  const raw = Buffer.from(String(k.export({ format: "jwk" }).x), "base64url");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32).match(/.{4}/g)!.join(":");
}

// ---------------------------------------------------------------- the side host's own key (U12 uses these)

/** A fresh key pair: the public key as base64 SPKI DER (what travels), the private key as PKCS#8 PEM (what never does). */
export function newKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: String(privateKey.export({ format: "pem", type: "pkcs8" })),
  };
}

export function hostKeyPath(root: string): string { return join(root, "link", "host.key"); }

/** The side host's key: read from `<root>/link/host.key` (0600), made there on first use. Returns only the public half. */
export function ensureHostKey(root: string): { publicKey: string; fingerprint: string; file: string } {
  const file = hostKeyPath(root);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const { privateKey } = newKeyPair();
    writeFileSync(file, privateKey, { mode: 0o600, flag: "wx" });
  }
  chmodSync(file, 0o600);
  const publicKey = createPublicKey(createPrivateKey(readFileSync(file, "utf8"))).export({ format: "der", type: "spki" }).toString("base64");
  return { publicKey, fingerprint: fingerprint(publicKey), file };
}

/** What a hello signs: a fixed tag, the link version, the host name and main's challenge. */
export function helloMessage(nonce: Buffer, linkVersion: string, name: string): Buffer {
  return Buffer.concat([Buffer.from(`${HELLO_TAG}\n${linkVersion}\n${name}\n`), nonce]);
}

/** The side's signature (base64) over main's challenge; `privateKey` is the PEM or a path-free KeyObject. */
export function signHello(privateKey: string | KeyObject, nonce: Buffer, linkVersion: string, name: string): string {
  const k = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  return sign(null, helloMessage(nonce, linkVersion, name), k).toString("base64");
}

/** True only when `signature` is `publicKey`'s signature over this challenge, version and name. */
export function verifySignature(publicKey: string, nonce: Buffer, linkVersion: string, name: string, signature: unknown): boolean {
  const k = parsePublicKey(publicKey);
  if (!k || typeof signature !== "string" || signature.length > 128) return false;
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return false;
  try { return verify(null, helloMessage(nonce, linkVersion, name), k, sig); } catch { return false; }
}

// ---------------------------------------------------------------- main's challenges (held by the link server)

/** One-time challenges, in memory: each is good for one hello by one name, within CHALLENGE_TTL_S. */
export class Challenges {
  private open = new Map<string, { name: string; until: number }>();
  constructor(private ttl = CHALLENGE_TTL_S) {}

  issue(name: string, at = now()): Buffer {
    for (const [k, c] of this.open) if (c.until < at) this.open.delete(k);
    const nonce = randomBytes(CHALLENGE_BYTES);
    this.open.set(nonce.toString("base64"), { name, until: at + this.ttl });
    return nonce;
  }

  /** Takes the challenge: true once for an open, unexpired challenge issued to `name`; spent either way. */
  take(name: string, nonce: Buffer, at = now()): boolean {
    const k = nonce.toString("base64"), c = this.open.get(k);
    this.open.delete(k);
    return !!c && c.name === name && c.until >= at;
  }

  get size(): number { return this.open.size; }
}

export type Hello = { name: string; nonce: Buffer; linkVersion: string; signature: string };

/** Main's check of a hello: the challenge is spent first (a wrong or replayed signature burns it), then only an
 *  `accepted` host whose stored key made the signature gets through. */
export function verifyHello(s: Store, challenges: Challenges, h: Hello, at = now()): Result<{ host: Row }> {
  if (!challenges.take(h.name, h.nonce, at)) return { ok: false, why: "no open challenge for this hello" };
  const host = s.get("hosts", { name: h.name });
  if (!host || host.status !== "accepted" || !host.public_key) return { ok: false, why: `host ${h.name} is not accepted` };
  if (!verifySignature(String(host.public_key), h.nonce, h.linkVersion, h.name, h.signature)) return { ok: false, why: "bad signature" };
  return { ok: true, host };
}

// ---------------------------------------------------------------- the host list on main

/** Pending rows older than PENDING_TTL_S go away (one `host_join_expired` each). Returns their names. */
export function expirePending(s: Store, at = now()): string[] {
  return s.tx(() => {
    const gone = (s.db.query("SELECT name, fingerprint FROM hosts WHERE status = 'pending' AND requested_at <= ? ORDER BY name").all(at - PENDING_TTL_S) as { name: string; fingerprint: string }[]);
    for (const g of gone) {
      s.db.run("DELETE FROM hosts WHERE name = ? AND status = 'pending'", [g.name]);
      s.fact("host_join_expired", [], { payload: { name: g.name, fingerprint: g.fingerprint } });
    }
    return gone.map((g) => g.name);
  });
}

/** A join frame off the wire: refused over JOIN_MAX_BYTES before it is parsed; else `{name, public_key}`. */
export function parseJoinFrame(raw: string | Uint8Array): Result<{ name: string; public_key: string }> {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (bytes > JOIN_MAX_BYTES) return { ok: false, why: `a join request is at most ${JOIN_MAX_BYTES} bytes` };
  let v: unknown;
  try { v = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")); } catch { return { ok: false, why: "a join request is JSON" }; }
  const o = v as { name?: unknown; public_key?: unknown } | null;
  if (!o || typeof o !== "object" || typeof o.name !== "string" || typeof o.public_key !== "string") return { ok: false, why: "a join request has a name and a public_key" };
  return { ok: true, name: o.name, public_key: o.public_key };
}

/** An unauthenticated join request → a `pending` host. The same key asking again while pending is the same
 *  request (`created` false); another key for a pending or accepted name is refused; a removed name may ask again. */
export function requestJoin(s: Store, req: { name: unknown; public_key: unknown }, at = now()): Result<{ name: string; fingerprint: string; created: boolean }> {
  const bad = nameProblem(req.name);
  if (bad) return { ok: false, why: bad };
  const name = req.name as string;
  const key = parsePublicKey(req.public_key);
  if (!key) return { ok: false, why: "public_key is the base64 SPKI DER of an Ed25519 key" };
  const public_key = key.export({ format: "der", type: "spki" }).toString("base64");
  const fp = fingerprint(key);
  expirePending(s, at);
  return s.tx(() => {
    const row = s.get("hosts", { name });
    if (row?.status === "accepted") return { ok: false as const, why: `host ${name} is already accepted (remove it first to change its key)` };
    if (row?.status === "pending") {
      if (row.public_key === public_key) return { ok: true as const, name, fingerprint: fp, created: false };
      return { ok: false as const, why: `a join request for ${name} is already waiting` };
    }
    const pending = Number((s.db.query("SELECT COUNT(*) AS n FROM hosts WHERE status = 'pending'").get() as { n: number }).n);
    if (pending >= MAX_PENDING) return { ok: false as const, why: `${MAX_PENDING} join requests are already waiting` };
    if (row) s.db.run("UPDATE hosts SET status = 'pending', public_key = ?, fingerprint = ?, requested_at = ?, accepted_at = NULL, accepted_by = NULL, removed_at = NULL, removed_by = NULL WHERE name = ?",
      [public_key, fp, at, name]);
    else s.db.run("INSERT INTO hosts (name, status, public_key, fingerprint, requested_at) VALUES (?, 'pending', ?, ?, ?)", [name, public_key, fp, at]);
    s.fact("host_join_requested", [], { payload: { name, fingerprint: fp } });
    return { ok: true as const, name, fingerprint: fp, created: true };
  });
}

/** `seen` is the fingerprint the operator answered (the board's card): another key under that name is not it. */
const otherKey = (row: Row, seen?: string): string | null =>
  seen && row.fingerprint !== seen ? `host ${row.name} now asks with another key (${row.fingerprint}), not ${seen}: check it and answer again` : null;

/** The operator accepts a pending host with `seats` Builder seats (default 2). */
export function accept(s: Store, name: string, opts: { seats?: number; by?: string; fingerprint?: string } = {}, at = now()): Result<{ host: Row }> {
  const seats = opts.seats ?? DEFAULT_SEATS;
  if (!Number.isInteger(seats) || seats < 0) return { ok: false, why: "seats is a whole number, 0 or more" };
  expirePending(s, at);
  return s.tx(() => {
    const row = s.get("hosts", { name });
    if (!row) return { ok: false as const, why: `no host ${name} (a join request expires after ${PENDING_TTL_S / 60} minutes)` };
    if (row.status !== "pending") return { ok: false as const, why: `host ${name} is ${row.status}, not pending` };
    const stale = otherKey(row, opts.fingerprint);
    if (stale) return { ok: false as const, why: stale };
    const by = opts.by ?? "ds";
    s.db.run("UPDATE hosts SET status = 'accepted', seats = ?, accepted_at = ?, accepted_by = ? WHERE name = ?", [seats, at, by, name]);
    acceptDefaults(s, name, seats, `accept by ${by}`, at);   // U25, KTD16: its seats and its brake on, as host overrides
    s.fact("host_accepted", [], { payload: { name, fingerprint: String(row.fingerprint), seats, by } });
    return { ok: true as const, host: s.get("hosts", { name })! };
  });
}

/** Reject (a pending host) or remove (any host not removed yet): the key is deleted, the row stays as `removed`. */
function drop(s: Store, verb: "reject" | "remove", name: string, by: string, at: number, seen?: string): Result<{ host: Row }> {
  return s.tx(() => {
    const row = s.get("hosts", { name });
    if (!row || row.status === "removed") return { ok: false as const, why: `no host ${name}` };
    if (verb === "reject" && row.status !== "pending") return { ok: false as const, why: `host ${name} is ${row.status}: remove it instead` };
    const stale = otherKey(row, seen);
    if (stale) return { ok: false as const, why: stale };
    s.db.run("UPDATE hosts SET status = 'removed', public_key = NULL, removed_at = ?, removed_by = ? WHERE name = ?", [at, by, name]);
    dropHost(s, name, `${verb} by ${by}`, at);   // U25: a rejoin starts from the side defaults again
    s.fact(verb === "reject" ? "host_rejected" : "host_removed", [], { payload: { name, fingerprint: String(row.fingerprint), was: String(row.status), by } });
    return { ok: true as const, host: s.get("hosts", { name })! };
  });
}

export function reject(s: Store, name: string, opts: { by?: string; fingerprint?: string } = {}, at = now()): Result<{ host: Row }> {
  expirePending(s, at);
  return drop(s, "reject", name, opts.by ?? "ds", at, opts.fingerprint);
}

export function remove(s: Store, name: string, opts: { by?: string } = {}, at = now()): Result<{ host: Row }> {
  return drop(s, "remove", name, opts.by ?? "ds", at);
}

/** The host list, by name; removed hosts only with `all`. Pending rows past their expiry are left out. */
export function listHosts(s: Store, opts: { all?: boolean } = {}, at = now()): Row[] {
  const rows = s.db.query("SELECT * FROM hosts ORDER BY name").all() as Row[];
  return rows.filter((r) => (opts.all || r.status !== "removed") && !(r.status === "pending" && Number(r.requested_at) <= at - PENDING_TTL_S));
}

/** One line per host for `ds host list`. */
export function hostLine(r: Row, at = now()): string {
  const parts = [String(r.name).padEnd(16), String(r.status).padEnd(8)];
  if (r.fingerprint) parts.push(String(r.fingerprint));
  if (r.status === "accepted") parts.push(`seats ${r.seats}${Number(r.drain) ? ", draining" : ""}`, r.last_seen_at ? `seen ${Math.max(0, at - Number(r.last_seen_at))}s ago` : "never seen");
  if (r.status === "pending") parts.push(`expires in ${Math.max(0, Math.ceil((Number(r.requested_at) + PENDING_TTL_S - at) / 60))} min`);
  return parts.join("  ");
}
