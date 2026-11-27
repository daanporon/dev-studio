// link-seal.test.ts — side-loop-host U12b: the link's frames are sealed with keys from the X25519 exchange main
// signed. Both ends derive the same keys; a frame opens once, in order, untampered, and only from the other end.
import { describe, expect, test } from "bun:test";
import { b64Bytes, KX_BYTES, newKx, sealer, type Sealer } from "../../bin/link/seal.ts";

const nonce = Buffer.alloc(32, 1), challenge = Buffer.alloc(32, 2);
function pair(): { side: Sealer; main: Sealer } {
  const s = newKx(), m = newKx();
  return { side: sealer(s.privateKey, Buffer.from(m.share, "base64"), nonce, challenge, "side")!, main: sealer(m.privateKey, Buffer.from(s.share, "base64"), nonce, challenge, "main")! };
}

describe("sealed frames", () => {
  test("each end opens the other's frames, in order", () => {
    const { side, main } = pair();
    for (const at of [1, 2, 3]) expect(JSON.parse(main.open(side.seal({ t: "ping", at }))!)).toEqual({ t: "ping", at });
    expect(JSON.parse(side.open(main.seal({ t: "welcome" }))!)).toEqual({ t: "welcome" });
  });

  test("a replayed, reordered, tampered, reflected or foreign frame does not open", () => {
    const { side, main } = pair();
    const a = side.seal({ t: "ping", at: 1 }), b = side.seal({ t: "ping", at: 2 });
    expect(main.open(b)).toBeNull();                                   // out of order
    expect(main.open(a.replace('"at":1', '"at":9'))).toBeNull();       // tampered
    expect(main.open(a)).not.toBeNull();
    expect(main.open(a)).toBeNull();                                   // replayed
    expect(side.open(side.seal({ t: "ping" }))).toBeNull();            // its own frame sent back
    expect(pair().main.open(pair().side.seal({ t: "ping" }))).toBeNull();   // another link's keys
    expect(main.open('{"t":"ping"}')).toBeNull();                      // not sealed at all
  });

  test("an unusable share gives no sealer; a share is exactly 32 bytes", () => {
    expect(sealer(newKx().privateKey, Buffer.alloc(KX_BYTES), nonce, challenge, "side")).toBeNull();   // low order
    expect(b64Bytes(newKx().share, KX_BYTES)?.length).toBe(KX_BYTES);
    expect(b64Bytes(Buffer.alloc(31).toString("base64"), KX_BYTES)).toBeNull();
    expect(b64Bytes("not base64!", KX_BYTES)).toBeNull();
    expect(b64Bytes(7, KX_BYTES)).toBeNull();
  });
});
