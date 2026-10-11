/**
 * Ed25519 over a hex key — the one primitive both doors verify with.
 *
 * Both protocols sign the same way (Discord's, deliberately: virtualCrypto
 * copied it): the timestamp and the body concatenated as bytes, the signature
 * as hex. What differs is only which public key verifies, which is why the
 * primitive is here and the two wrappers are the callers' own.
 */

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw new Error(`not hex: ${hex.length} characters`);
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`not hex: ${JSON.stringify(hex)}`);
    }
    bytes[i] = byte;
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Verify a signature over a message with a raw Ed25519 public key, both as hex.
 *
 * `false` rather than a throw for anything unreadable: a key or a signature
 * that cannot be parsed is a signature that does not verify, which is what both
 * callers answer `401` for. A runtime without Ed25519 in WebCrypto would land
 * here too — as a refusal, which is the safe direction.
 */
export async function verifyEd25519(
  publicKeyHex: string,
  message: Uint8Array<ArrayBufferLike>,
  signatureHex: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      "Ed25519",
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signatureHex),
      message,
    );
  } catch {
    return false;
  }
}
