import { verifyEd25519 } from "../crypto.ts";

/**
 * Verify a delivery from virtualCrypto.
 *
 * The same protocol as Discord's interactions — Ed25519 over the timestamp and
 * the body concatenated, in `X-Signature-Ed25519` as hex and
 * `X-Signature-Timestamp` as digits — signed with the **application's** private
 * key, which the service holds. The application verifies with its `public_key`,
 * and the handshake at registration is exactly this: a PING the real key signed
 * must come back `200`, and a PING a key generated for the occasion signed must
 * come back `401`, which is what says the application verifies anything at all.
 *
 * No timestamp window, unlike Discord's side: the delivery is a push with no
 * retry behind it, and refusing a slow one would lose the only copy of a
 * decision rather than replay-protect anything.
 */
export async function verifyVcDelivery(
  headers: Headers,
  body: string,
  publicKeyHex: string,
): Promise<boolean> {
  const signature = headers.get("x-signature-ed25519");
  const timestamp = headers.get("x-signature-timestamp");
  if (signature === null || timestamp === null) {
    return false;
  }

  return verifyEd25519(
    publicKeyHex,
    new TextEncoder().encode(timestamp + body),
    signature,
  );
}
