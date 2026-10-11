/**
 * The wire shapes of the virtualCrypto API, as the service answers them.
 *
 * Ids and amounts travel as **strings** — a Discord snowflake does not fit in a
 * JSON number — and timestamps are the family's `…Z` form. The fields named
 * here are the ones a feature reads; the service adds fields without breaking
 * anything, so unknown ones are ignored.
 */

/** What `POST /oauth2/token` answers: an application token, or a guild one. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scopes?: string[];
}

/**
 * A currency, read by exactly one of `id` / `guild` / `name` / `unit`.
 *
 * `pool_amount` is what a guild may still issue from, and **an empty pool
 * travels as `""`** rather than as zero; `name` and `unit` can be null, because
 * the service leaves them optional.
 */
export interface Currency {
  total_amount: string;
  name: string | null;
  unit: string | null;
  guild: string;
  pool_amount: string;
}

/** What a device-flow ask (`POST /oauth2/clients/@me/grant-requests`) answers. */
export interface GrantRequest {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval?: number;
}

export interface ContractParty {
  discord_id: string;
  amount: string;
  remaining: string;
  status: "pending" | "approved" | "refused" | "withdrawn" | string;
}

/** A contract, from creation and from `GET /api/v2/contracts/{id}`. */
export interface Contract {
  id: string;
  unit: string;
  guild_id?: string;
  status: "pending" | "active" | "canceled" | "expired" | string;
  receiver_discord_id?: string | null;
  expires_at?: string | null;
  /** What the contract as a whole still holds. */
  remaining?: string;
  parties?: ContractParty[];
}

/** What one charge moved, and what is left — the answer to a contract payment. */
export interface ContractPayment {
  amount: string;
  unit?: string | null;
  /** What the contract as a whole still holds. */
  remaining?: string;
  /** What the charged party has left, when the charge named one. */
  party_remaining?: string | null;
}

/**
 * One row of a contract's statement (`GET /api/v2/contracts/{id}/payments`),
 * newest first. `event` tells a lock and a return from a charge, and the rest
 * of the row — which party it came out of, the receiver, when — is for a reader
 * that shows it rather than sums it.
 */
export interface StatementEntry {
  id: string;
  event: "lock" | "charge" | "return" | string;
  amount: string;
}

/** What `POST /api/v2/currencies/issue` answers. */
export interface Issuance {
  amount: string;
  pool_amount: string;
  unit: string;
}

/**
 * What virtualCrypto pushes to the application's webhook.
 *
 * The protocol is Discord's, deliberately: `1` is the handshake's PING, and the
 * rest carry a decision's state. Unknown types must be ignored, which is what
 * makes adding a type a non-breaking change.
 */
export type VcEvent =
  | { type: 1 }
  /** A claim update: the claim is what the body carries. */
  | { type: 2; data: unknown }
  /** A grant decision. */
  | { type: 3; data: unknown }
  /** A decision about a contract: the contract and its parties, as they are now. */
  | { type: 4; data: ContractDecision };

/** The `type: 4` body: the state, not the change — a ping rather than a record. */
export interface ContractDecision {
  contract: Contract;
  parties: ContractParty[];
}
