import { verifyEd25519 } from "../crypto.ts";

/**
 * Discord signs every interaction it sends: Ed25519 over the timestamp and the
 * body concatenated, in `X-Signature-Ed25519` as hex and
 * `X-Signature-Timestamp` as digits. There is no token; the signature is the
 * whole of the authentication.
 */

/**
 * Accept a signed request for only five minutes, with thirty seconds of
 * forward clock skew — the window the core service verifies interactions with,
 * kept the same here so a replayed request ages out the same way in both.
 */
const MAX_AGE_SECONDS = 300;
const MAX_SKEW_SECONDS = 30;

export async function verifyDiscordSignature(
  headers: Headers,
  body: string,
  publicKeyHex: string,
): Promise<boolean> {
  const signature = headers.get("x-signature-ed25519");
  const timestamp = headers.get("x-signature-timestamp");
  if (signature === null || timestamp === null) {
    return false;
  }

  const signedAt = Number.parseInt(timestamp, 10);
  if (!Number.isInteger(signedAt)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (signedAt < now - MAX_AGE_SECONDS || signedAt > now + MAX_SKEW_SECONDS) {
    return false;
  }

  return verifyEd25519(
    publicKeyHex,
    new TextEncoder().encode(timestamp + body),
    signature,
  );
}
