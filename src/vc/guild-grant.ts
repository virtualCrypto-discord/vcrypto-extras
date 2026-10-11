import type { VcClient } from "./client.ts";
import { VcApiError } from "./errors.ts";
import type { GrantRequest, TokenResponse } from "./types.ts";

/**
 * A guild's issuing permission, as this application holds it.
 *
 * A guild's pool is spent with a guild token, and a guild token comes from the
 * device flow: the application asks, an administrator approves in the guild
 * (with the core bot's `/grant approve code:`), and the poll answers a token
 * pair. The pair is what this module keeps — the access token for an hour, and
 * the refresh token that mints the next one — because the ask is the part the
 * guild should only ever answer once.
 *
 * The row is one per guild and lives in D1 (`migrations/0001_guild_grants.sql`):
 * either an ask nobody has answered yet, or the pair an approval produced.
 * `guildToken` is the read for a command run, `pollGuildGrants` is the cron's,
 * and both write through the same small set of statements so the two can race
 * without inventing states.
 */

/** An access token is treated as due this long before it truly expires. */
const ACCESS_MARGIN_MS = 60_000;

/** One tick takes at most this many asks ... */
const POLL_LIMIT = 20;

/** What a command run gets: a token to issue with, or the ask it owes an administrator. */
export type GuildToken =
  | { kind: "token"; token: string }
  | { kind: "approval"; userCode: string; expiresIn: number };

interface Row {
  guild_id: string;
  access_token: string | null;
  access_expires_at: number | null;
  refresh_token: string | null;
  device_code: string | null;
  user_code: string | null;
  ask_expires_at: number | null;
}

/**
 * The guild's token, from wherever it is: the row's access token, the row's
 * refresh token, the row's pending ask, or a new ask — in that order, because
 * each earlier source is cheaper than the one after it and none of them asks
 * the guild anything twice.
 */
export async function guildToken(
  vc: VcClient,
  db: D1Database,
  guildId: string,
): Promise<GuildToken> {
  const now = Date.now();
  const row = await load(db, guildId);

  if (row !== null) {
    const stored = await tokenFromRow(vc, db, row, now);
    if (stored !== null) return stored;
  }

  if (row?.device_code && (row.ask_expires_at ?? 0) > now) {
    const polled = await vc.pollGuildGrant(row.device_code);
    if (polled.kind === "granted") {
      await saveTokens(db, guildId, polled.token, now);
      return { kind: "token", token: polled.token.access_token };
    }
    if (polled.kind === "pending") {
      return {
        kind: "approval",
        userCode: row.user_code ?? "",
        expiresIn: Math.max(
          0,
          Math.ceil(((row.ask_expires_at ?? now) - now) / 1000),
        ),
      };
    }
    // Everything the poll refuses with that is an `invalid_grant` is the
    // documented dead end — unknown, expired, consumed, revoked — and the next
    // step is a new ask. A refusal that is not (a bad client, a service fault)
    // is not the ask's fault and must not be swallowed into one.
    if (polled.error.error !== "invalid_grant") {
      throw polled.error;
    }
    // A consumed code is also what this poller sees when *another* one won the
    // race for the same ask — the clock's tick, or a second run's. Whoever won
    // wrote the pair down, so the row is read again before the ask is called
    // dead: asking a guild for a permission it has just granted is the one
    // mistake this ordering exists to avoid.
    const fresh = await load(db, guildId);
    if (fresh !== null) {
      const stored = await tokenFromRow(vc, db, fresh, now);
      if (stored !== null) return stored;
    }
    await clearAsk(db, guildId, now);
  }

  const ask = await vc.requestGuildGrant({ guildId });
  await saveAsk(db, guildId, ask, now);
  return {
    kind: "approval",
    userCode: ask.user_code,
    expiresIn: ask.expires_in,
  };
}

/**
 * The pair a row already holds, as a token: the access token when it is live,
 * and a renewal from the refresh token otherwise. `null` when the row has
 * neither left — a refresh token the service refuses is one the guild will have
 * to grant again, so it is cleared on the way out.
 */
async function tokenFromRow(
  vc: VcClient,
  db: D1Database,
  row: Row,
  now: number,
): Promise<GuildToken | null> {
  if (
    row.access_token !== null &&
    (row.access_expires_at ?? 0) > now + ACCESS_MARGIN_MS
  ) {
    return { kind: "token", token: row.access_token };
  }

  if (row.refresh_token === null) {
    return null;
  }

  try {
    const renewed = await vc.refreshGuildToken(row.refresh_token);
    await saveTokens(db, row.guild_id, renewed, now);
    return { kind: "token", token: renewed.access_token };
  } catch (error) {
    // A refresh token the service will not take is a grant to ask for again —
    // "the device must start over with a new ask" — where anything else (the
    // service unreachable, credentials misconfigured) is worth saying instead
    // of quietly asking an administrator to approve over and over.
    if (!(error instanceof VcApiError) || error.status !== 400) {
      throw error;
    }
    await clearTokens(db, row.guild_id, now);
    return null;
  }
}

/**
 * The clock's half: every tick, poll the asks that are still waiting, bounded
 * like everything else on a clock (`POLL_LIMIT` a tick), so an approval is
 * harvested even when the administrator does not come back to re-run the
 * command. Returns how many grants were taken up.
 *
 * A row that fails is logged and skipped rather than stopping the tick — the
 * next tick tries it again — because one guild's ask has nothing to do with
 * another's.
 */
export async function pollGuildGrants(
  vc: VcClient,
  db: D1Database,
  limit = POLL_LIMIT,
): Promise<number> {
  const now = Date.now();
  const rows = await db
    .prepare(
      `SELECT guild_id, device_code
         FROM guild_grants
        WHERE device_code IS NOT NULL AND ask_expires_at > ?1
        ORDER BY updated_at
        LIMIT ?2`,
    )
    .bind(now, limit)
    .all<{ guild_id: string; device_code: string | null }>();

  let granted = 0;
  for (const row of rows.results) {
    if (row.device_code === null) continue;
    try {
      const polled = await vc.pollGuildGrant(row.device_code);
      if (polled.kind === "granted") {
        await saveTokens(db, row.guild_id, polled.token, now);
        granted += 1;
      } else if (
        polled.kind === "failed" &&
        polled.error.error === "invalid_grant"
      ) {
        await clearAsk(db, row.guild_id, now);
      }
      // Still pending — or a failure that is not the ask's — is the next tick's.
    } catch (error) {
      console.error(
        `the grant ask for guild ${row.guild_id} could not be polled`,
        error,
      );
    }
  }
  return granted;
}

// ---- The row, in four statements -------------------------------------------

async function load(db: D1Database, guildId: string): Promise<Row | null> {
  return db
    .prepare(
      `SELECT guild_id, access_token, access_expires_at, refresh_token,
              device_code, user_code, ask_expires_at
         FROM guild_grants
        WHERE guild_id = ?1`,
    )
    .bind(guildId)
    .first<Row>();
}

/**
 * Store a token pair, and forget the ask it came from. The refresh token
 * written is the answer's, falling back to the one already stored when the
 * answer carries none — a refresh that does not rotate is still a refresh.
 */
async function saveTokens(
  db: D1Database,
  guildId: string,
  token: TokenResponse,
  now: number,
): Promise<void> {
  const expiresAt = now + (token.expires_in ?? 3600) * 1000;
  await db
    .prepare(
      `INSERT INTO guild_grants
         (guild_id, access_token, access_expires_at, refresh_token, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(guild_id) DO UPDATE SET
         access_token = excluded.access_token,
         access_expires_at = excluded.access_expires_at,
         refresh_token = COALESCE(excluded.refresh_token, guild_grants.refresh_token),
         device_code = NULL,
         user_code = NULL,
         ask_expires_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(
      guildId,
      token.access_token,
      expiresAt,
      token.refresh_token ?? null,
      now,
    )
    .run();
}

/** Store an ask, leaving whatever tokens the row already holds untouched. */
async function saveAsk(
  db: D1Database,
  guildId: string,
  ask: GrantRequest,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO guild_grants
         (guild_id, device_code, user_code, ask_expires_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(guild_id) DO UPDATE SET
         device_code = excluded.device_code,
         user_code = excluded.user_code,
         ask_expires_at = excluded.ask_expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      guildId,
      ask.device_code,
      ask.user_code,
      now + ask.expires_in * 1000,
      now,
    )
    .run();
}

async function clearTokens(
  db: D1Database,
  guildId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE guild_grants
          SET access_token = NULL, access_expires_at = NULL, refresh_token = NULL,
              updated_at = ?2
        WHERE guild_id = ?1`,
    )
    .bind(guildId, now)
    .run();
}

async function clearAsk(
  db: D1Database,
  guildId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE guild_grants
          SET device_code = NULL, user_code = NULL, ask_expires_at = NULL,
              updated_at = ?2
        WHERE guild_id = ?1`,
    )
    .bind(guildId, now)
    .run();
}
