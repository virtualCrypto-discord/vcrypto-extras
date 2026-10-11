import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, verifyEd25519 } from "../src/crypto.ts";
import { generateTestKey } from "./keys.ts";

describe("the Ed25519 primitive", () => {
  it("round-trips hex", () => {
    const bytes = new Uint8Array([0x00, 0xab, 0xff, 0x10]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it("refuses hex it cannot read", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
    expect(() => hexToBytes("")).toThrow();
  });

  it("verifies a real signature and refuses a tampered one", async () => {
    const key = await generateTestKey();
    const message = new TextEncoder().encode('1759999999{"type":1}');
    const signature = await key.sign('1759999999{"type":1}');

    expect(await verifyEd25519(key.publicHex, message, signature)).toBe(true);

    const tampered = new TextEncoder().encode('1759999999{"type":2}');
    expect(await verifyEd25519(key.publicHex, tampered, signature)).toBe(false);
  });

  it("answers false rather than throwing for a signature that is not hex", async () => {
    const key = await generateTestKey();
    const message = new TextEncoder().encode("anything");

    expect(await verifyEd25519(key.publicHex, message, "not hex")).toBe(false);
    expect(await verifyEd25519("not hex", message, "ab")).toBe(false);
  });
});
