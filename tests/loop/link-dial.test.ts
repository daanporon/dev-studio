// side-loop-host U12: a plain ws link only dials loopback or the tailnet (the side trusts whoever answers).
import { expect, test } from "bun:test";
import { DialRefused, dialUrl, privateAddress } from "../../bin/link/client.ts";

const to = (...ips: string[]) => async () => ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

test("loopback and tailnet addresses only", () => {
  for (const ip of ["127.0.0.1", "100.64.0.1", "100.127.255.254", "::1", "fd7a:115c:a1e0::53"]) expect([ip, privateAddress(ip)]).toEqual([ip, true]);
  for (const ip of ["100.63.0.1", "100.128.0.1", "192.168.1.4", "10.0.0.2", "192.0.2.7", "fe80::1", "fd00::1"]) expect([ip, privateAddress(ip)]).toEqual([ip, false]);
});

test("a ws url dials the checked address; any other address of the name refuses it; wss passes", async () => {
  expect(await dialUrl("main-box:7790", to("fd7a:115c:a1e0::53", "100.100.1.2"))).toBe("ws://100.100.1.2:7790/link");
  await expect(dialUrl("main-box:7790", to("100.100.1.2", "192.0.2.7"))).rejects.toThrow(DialRefused);
  await expect(dialUrl("main-box:7790", to())).rejects.toThrow("cannot reach main-box:7790");
  expect(await dialUrl("https://main.example.test", to("192.0.2.7"))).toBe("wss://main.example.test/link");
});
