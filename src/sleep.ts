/**
 * A wait, as a promise.
 *
 * What the two clients need when either service asks to be called again
 * (a `429` with `Retry-After`, or virtualCrypto's `409 processing`), and
 * nothing else in here does.
 */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
