import { env } from "cloudflare:test";
import type { Env } from "../src/env.ts";

/** The guild-grant row, for tests that want one before they start. */
const DB = (env as unknown as Env).DB;

export async function seedGrant(row: {
  guildId: string;
  accessToken?: string;
  accessExpiresAt?: number;
  refreshToken?: string;
  deviceCode?: string;
  userCode?: string;
  askExpiresAt?: number;
  updatedAt?: number;
}): Promise<void> {
  await DB.prepare(
    `INSERT INTO guild_grants
       (guild_id, access_token, access_expires_at, refresh_token,
        device_code, user_code, ask_expires_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      row.guildId,
      row.accessToken ?? null,
      row.accessExpiresAt ?? null,
      row.refreshToken ?? null,
      row.deviceCode ?? null,
      row.userCode ?? null,
      row.askExpiresAt ?? null,
      row.updatedAt ?? Date.now(),
    )
    .run();
}

export async function grantRow(
  guildId: string,
): Promise<Record<string, unknown> | null> {
  return DB.prepare("SELECT * FROM guild_grants WHERE guild_id = ?1")
    .bind(guildId)
    .first<Record<string, unknown>>();
}

/**
 * Write a token pair into a row the way another poller would have — for the
 * test that has to simulate one winning a race mid-flight.
 */
export async function storeTokens(row: {
  guildId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
}): Promise<void> {
  await DB.prepare(
    `UPDATE guild_grants
        SET access_token = ?2, access_expires_at = ?3, refresh_token = ?4,
            device_code = NULL, user_code = NULL, ask_expires_at = NULL
      WHERE guild_id = ?1`,
  )
    .bind(row.guildId, row.accessToken, row.accessExpiresAt, row.refreshToken)
    .run();
}

/**
 * Empty the table. The local database is not reset between tests, so a test
 * that cares what is in it says so first — and the rows are the only state a
 * handler keeps, so emptying them is the whole of the reset.
 */
export async function clearGrants(): Promise<void> {
  await DB.prepare("DELETE FROM guild_grants").run();
}
