/**
 * Everything the worker is configured with.
 *
 * The public halves — the base URL, the two ids and the two public keys — are
 * `vars` in wrangler.jsonc; the two secrets (`VCRYPTO_CLIENT_SECRET`,
 * `DISCORD_BOT_TOKEN`) are `wrangler secret put` values. See docs/operations.md
 * for how each one is obtained.
 */
export interface Env {
  /** Where the virtualCrypto service lives, with no trailing slash. */
  VCRYPTO_BASE_URL: string;
  /** The application's `client_id`, as `POST /oauth2/clients` answered it. */
  VCRYPTO_CLIENT_ID: string;
  /** The application's `client_secret`; a secret, because it is the application's whole identity. */
  VCRYPTO_CLIENT_SECRET: string;
  /**
   * The application's public key, lowercase hex — the key virtualCrypto signs
   * its deliveries with, and the one registration answered with (`GET
   * /oauth2/clients/@me` reads it back).
   */
  VCRYPTO_PUBLIC_KEY: string;
  /** The Discord application id, for registering commands. */
  DISCORD_APPLICATION_ID: string;
  /** Discord's public key for this application, hex — what interactions are signed with. */
  DISCORD_PUBLIC_KEY: string;
  /** The bot token, for the REST calls a feature makes outside an interaction. */
  DISCORD_BOT_TOKEN: string;
}
