// seal.ts — side-loop-host U12b: the link's frames are bound to the handshake that proved main. The side's hello
// carries an ephemeral X25519 share, main's challenge carries its own, and main signs both (with the side's nonce
// and its challenge) with the key the side pinned. Each end derives a key per direction from the shared secret
// (HKDF-SHA256, salted with the nonce and the challenge), and every frame after the challenge travels sealed:
// `<seq>.<mac>.<json>`, the mac an HMAC-SHA256 over the sequence number and the JSON. Something relaying the
// handshake to the real main cannot read the shares' secret, so it can neither forge, replay, reorder nor drop a
// frame unnoticed. The link still adds no encryption: frames are readable on the wire (KTD4, the tailnet hides them).
import { createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, timingSafeEqual, type KeyObject } from "node:crypto";
import type { Frame } from "./protocol.ts";

export const KX_BYTES = 32;
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");

/** A fresh ephemeral X25519 key pair: the raw 32-byte public share (base64) and its private key. */
export function newKx(): { share: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { share: (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-KX_BYTES).toString("base64"), privateKey };
}

/** A frame's base64 field as exactly `len` bytes, else null. */
export function b64Bytes(v: unknown, len: number): Buffer | null {
  if (typeof v !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(v)) return null;
  const b = Buffer.from(v, "base64");
  return b.length === len ? b : null;
}

const mac = (key: Buffer, seq: number, body: string) => createHmac("sha256", key).update(`${seq}.${body}`).digest("base64url");

/** One link's sealing: `seal` numbers and signs outgoing frames, `open` takes only the next frame from the peer. */
export class Sealer {
  private out = 0;
  private in = 0;
  constructor(private readonly sendKey: Buffer, private readonly recvKey: Buffer) {}

  seal(f: Frame): string {
    const seq = this.out++, body = JSON.stringify(f);
    return `${seq}.${mac(this.sendKey, seq, body)}.${body}`;
  }

  /** The frame's JSON when it is the peer's next frame with a good mac, else null (the caller closes the link). */
  open(raw: string): string | null {
    const a = raw.indexOf("."), b = a < 0 ? -1 : raw.indexOf(".", a + 1);
    if (b < 0 || raw.slice(0, a) !== String(this.in)) return null;
    const body = raw.slice(b + 1), got = Buffer.from(raw.slice(a + 1, b)), want = Buffer.from(mac(this.recvKey, this.in, body));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    this.in++;
    return body;
  }
}

/** This end's Sealer from its own private share and the peer's raw share, or null when the share is unusable. */
export function sealer(own: KeyObject, peerShare: Buffer, sideNonce: Buffer, challenge: Buffer, end: "side" | "main"): Sealer | null {
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: own, publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI, peerShare]), format: "der", type: "spki" }) });
  } catch { return null; }
  if (shared.every((x) => x === 0)) return null;   // a low-order share: no secret at all
  const salt = Buffer.concat([sideNonce, challenge]);
  const key = (dir: string) => Buffer.from(hkdfSync("sha256", shared, salt, `ds-link ${dir}`, 32));
  const toMain = key("side>main"), toSide = key("main>side");
  return end === "side" ? new Sealer(toMain, toSide) : new Sealer(toSide, toMain);
}
