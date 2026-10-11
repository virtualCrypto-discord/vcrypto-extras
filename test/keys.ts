import { bytesToHex } from "../src/crypto.ts";

/**
 * An Ed25519 keypair for tests: the signing half of what both protocols verify
 * with a public one. Discord's key is a fixture (the test holds the private
 * half and puts the public one in the environment); virtualCrypto's is the
 * same shape.
 */
export interface TestKey {
  publicHex: string;
  sign(message: string): Promise<string>;
}

export async function generateTestKey(): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const raw = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey,
  )) as ArrayBuffer;

  return {
    publicHex: bytesToHex(new Uint8Array(raw)),
    async sign(message: string): Promise<string> {
      const signature = await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(message),
      );
      return bytesToHex(new Uint8Array(signature));
    },
  };
}
