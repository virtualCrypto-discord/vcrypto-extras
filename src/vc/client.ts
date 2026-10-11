import type { Env } from "../env.ts";
import { sleep } from "../sleep.ts";
import {
  isAuthorizationPending,
  type VcApiError,
  vcErrorFrom,
} from "./errors.ts";
import type {
  Contract,
  ContractPayment,
  Currency,
  GrantRequest,
  Issuance,
  StatementEntry,
  TokenResponse,
} from "./types.ts";

/**
 * The application side of virtualCrypto.
 *
 * Everything here is the service's own documented half of an application: an
 * application token to ask with (`client_credentials`), a guild token to issue
 * with (the device flow), and the contract endpoints that move a user's money
 * once that user has approved. Nothing in here touches a balance directly,
 * because nothing may: the scope says the application may *ask*, and the
 * parties' approvals are what let it spend (`docs/contracts.md` in the core
 * service).
 */

/** A `kind: app` token's scopes — what an application may ask to do. */
export type AppScope =
  | "vc.pay"
  | "vc.claim"
  | "vc.contract"
  | "oauth2.register";

/** How long before expiry a cached token is treated as due for replacement. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** How many times a request is sent in total, retries included. */
const MAX_ATTEMPTS = 3;

/** A retry longer than this is not waited out here; the caller is told instead. */
const MAX_WAIT_MS = 10_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * An application token per (service, client, scope), shared across requests in
 * one isolate. Isolation is per process and every isolate mints its own, which
 * is a handful of extra token calls and no correctness anywhere.
 */
const tokens = new Map<string, CachedToken>();

/** What one poll of the device flow found. */
export type GrantPoll =
  | { kind: "pending" }
  | { kind: "granted"; token: TokenResponse }
  | { kind: "failed"; error: VcApiError };

export interface VcClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

interface RequestOptions {
  method?: string;
  /** The scope whose application token to send. */
  scope?: AppScope;
  /** A token to send instead of the application's own — a guild token. */
  token?: string;
  body?: unknown;
  /** Quoted and sent as `Idempotency-Key`, the way a retry is made the same charge. */
  idempotencyKey?: string;
}

export class VcClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(options: VcClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
  }

  static fromEnv(env: Env): VcClient {
    return new VcClient({
      baseUrl: env.VCRYPTO_BASE_URL,
      clientId: env.VCRYPTO_CLIENT_ID,
      clientSecret: env.VCRYPTO_CLIENT_SECRET,
    });
  }

  /** An application token for `scope`, from the cache or the token endpoint. */
  async appToken(scope: AppScope): Promise<string> {
    const key = this.tokenKey(scope);
    const cached = tokens.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const response = await fetch(`${this.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope,
      }).toString(),
    });
    if (!response.ok) {
      throw await vcErrorFrom(response);
    }

    const token = (await response.json()) as TokenResponse;
    const expiresIn = token.expires_in ?? 3600;
    tokens.set(key, {
      value: token.access_token,
      expiresAt: Date.now() + expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS,
    });
    return token.access_token;
  }

  // ---- Reads ---------------------------------------------------------------

  /** A currency, by exactly one of its id / guild / name / unit. Public: no token. */
  async currency(query: {
    id?: string;
    guild?: string;
    name?: string;
    unit?: string;
  }): Promise<Currency> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, value);
    }
    return this.json<Currency>(`/api/v2/currencies?${search.toString()}`);
  }

  /** A contract, as the application that wrote it reads it. */
  async contract(contractId: string): Promise<Contract> {
    return this.json<Contract>(`/api/v2/contracts/${contractId}`, {
      scope: "vc.contract",
    });
  }

  /**
   * A contract's statement, newest first. The service answers a full page when
   * there is more behind it, so `next` is the row to resume from — `null` when
   * this page was the last.
   */
  async contractPayments(
    contractId: string,
    options: { limit?: number; next?: string } = {},
  ): Promise<{ payments: StatementEntry[]; next: string | null }> {
    const limit = options.limit ?? 200;
    const search = new URLSearchParams({ limit: String(limit) });
    if (options.next !== undefined) {
      search.set("next", options.next);
    }

    const payments = await this.json<StatementEntry[]>(
      `/api/v2/contracts/${contractId}/payments?${search.toString()}`,
      { scope: "vc.contract" },
    );
    const last = payments.at(-1);
    return {
      payments,
      next: payments.length === limit && last !== undefined ? last.id : null,
    };
  }

  // ---- Money ---------------------------------------------------------------

  /**
   * Ask users to lock an amount under a contract.
   *
   * Nothing is locked yet — each party approves separately, in the core bot's
   * own `/contract list` — and the application is told over its webhook when
   * the answer lands (`type: 4`). `expiresIn` is what makes it a period, and a
   * period the application cannot end early: at the deadline what is left goes
   * home on its own.
   */
  async createContract(input: {
    unit: string;
    parties: { discordId: string; amount: string }[];
    receiverDiscordId?: string;
    expiresIn?: number;
  }): Promise<Contract> {
    return this.json<Contract>("/api/v2/contracts", {
      method: "POST",
      scope: "vc.contract",
      body: {
        unit: input.unit,
        parties: input.parties.map((party) => ({
          discord_id: party.discordId,
          amount: party.amount,
        })),
        ...(input.receiverDiscordId !== undefined
          ? { receiver_discord_id: input.receiverDiscordId }
          : {}),
        ...(input.expiresIn !== undefined
          ? { expires_in: input.expiresIn }
          : {}),
      },
    });
  }

  /**
   * Charge the contract one amount, under an idempotency key.
   *
   * The key is the caller's word for "this charge, once": a retry carrying the
   * same key is answered with the first charge's answer rather than charging
   * twice, so it has to name the use rather than the moment — a contract id and
   * a use number, not a fresh UUID per attempt.
   */
  async payContract(
    contractId: string,
    input: {
      amount: string;
      receiverDiscordId?: string;
      partyDiscordId?: string;
    },
    idempotencyKey: string,
  ): Promise<ContractPayment> {
    return this.json<ContractPayment>(
      `/api/v2/contracts/${contractId}/payments`,
      {
        method: "POST",
        scope: "vc.contract",
        idempotencyKey,
        body: {
          amount: input.amount,
          ...(input.receiverDiscordId !== undefined
            ? { receiver_discord_id: input.receiverDiscordId }
            : {}),
          ...(input.partyDiscordId !== undefined
            ? { party_discord_id: input.partyDiscordId }
            : {}),
        },
      },
    );
  }

  // ---- The device flow (a guild's pool) ------------------------------------

  /**
   * Ask a guild for the permission to issue (the ask half of the device flow).
   * The answer's `user_code` is what an administrator approves in the guild,
   * with the core bot's `/grant approve code:`.
   */
  async requestGuildGrant(input: {
    guildId: string;
    scopes?: string[];
  }): Promise<GrantRequest> {
    return this.json<GrantRequest>("/oauth2/clients/@me/grant-requests", {
      method: "POST",
      scope: "oauth2.register",
      body: { guild_id: input.guildId, scopes: input.scopes ?? ["vc.issue"] },
    });
  }

  /**
   * Poll the ask, the way RFC 8628 says a device polls: the same `device_code`
   * until the guild answers, and `pending` meaning "not yet". A granted poll
   * answers the guild token — opaque and revocable, not a JWT — which is what
   * `issueFromPool` spends.
   */
  async pollGuildGrant(deviceCode: string): Promise<GrantPoll> {
    const response = await fetch(`${this.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      }).toString(),
    });

    if (response.ok) {
      return {
        kind: "granted",
        token: (await response.json()) as TokenResponse,
      };
    }

    const error = await vcErrorFrom(response);
    return isAuthorizationPending(error)
      ? { kind: "pending" }
      : { kind: "failed", error };
  }

  /**
   * Issue from the guild's pool, with the guild token the poll answered.
   *
   * This moves the guild's money and nobody has to approve each issuance — the
   * grant was the approval — so an `Idempotency-Key` is worth carrying even
   * where the call is a single round trip.
   */
  async issueFromPool(
    guildToken: string,
    input: {
      receiverDiscordId: string;
      amount: string;
      idempotencyKey?: string;
    },
  ): Promise<Issuance> {
    return this.json<Issuance>("/api/v2/currencies/issue", {
      method: "POST",
      token: guildToken,
      body: {
        receiver_discord_id: input.receiverDiscordId,
        amount: input.amount,
      },
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    });
  }

  // ---- The plumbing --------------------------------------------------------

  private tokenKey(scope: AppScope): string {
    return `${this.baseUrl}|${this.clientId}|${scope}`;
  }

  /** Drop a cached token, so the next send mints a fresh one. */
  private forget(scope: AppScope): void {
    tokens.delete(this.tokenKey(scope));
  }

  private async json<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.send(path, options);
    if (!response.ok) {
      throw await vcErrorFrom(response);
    }
    return (await response.json()) as T;
  }

  /**
   * One request, with the three things the service asks of a client:
   *
   * - a `401` renews the application token and retries once, keeping the body
   *   and the key;
   * - a `429`, and a `409` that says a key is being used right now, are waited
   *   out inside a bound — `Retry-After` from the headers, unlike Discord's
   *   body — and a wait longer than the bound is the caller's to answer;
   * - an `Idempotency-Key` is sent quoted, which is the spelling the service
   *   accepts and the one a retry has to keep.
   */
  private async send(
    path: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    let renewed = false;

    for (let attempt = 1; ; attempt += 1) {
      const headers = new Headers({ accept: "application/json" });
      if (options.body !== undefined) {
        headers.set("content-type", "application/json");
      }
      if (options.token !== undefined) {
        headers.set("authorization", `Bearer ${options.token}`);
      } else if (options.scope !== undefined) {
        headers.set(
          "authorization",
          `Bearer ${await this.appToken(options.scope)}`,
        );
      }
      if (options.idempotencyKey !== undefined) {
        headers.set("idempotency-key", `"${options.idempotencyKey}"`);
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      if (response.status === 401 && options.scope !== undefined && !renewed) {
        renewed = true;
        this.forget(options.scope);
        continue;
      }

      if (
        attempt < MAX_ATTEMPTS &&
        (response.status === 429 || response.status === 409) &&
        response.headers.get("retry-after") !== null
      ) {
        const seconds = Number.parseInt(
          response.headers.get("retry-after") ?? "",
          10,
        );
        if (
          Number.isInteger(seconds) &&
          seconds >= 0 &&
          seconds * 1000 <= MAX_WAIT_MS
        ) {
          await sleep(seconds * 1000);
          continue;
        }
      }

      return response;
    }
  }
}
