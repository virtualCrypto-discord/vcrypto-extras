-- The guild tokens a guild-side feature issues with, and the device-flow asks
-- that produce them.
--
-- One row per guild, and it holds at most two things: an ask an administrator
-- has not answered yet (`device_code` / `user_code` / `ask_expires_at`), or the
-- token pair an approval produced — and the pair is what lets the ask be
-- forgotten, because the refresh token is what saves the guild from approving
-- again.
--
-- Nothing here is a ledger: the row is overwritten in place, and the money's
-- source of truth is the issuance or the contract inside virtualCrypto itself.
-- The two columns are epoch milliseconds — this is a clock's bookkeeping, and
-- SQLite has no date type worth pretending otherwise with.
CREATE TABLE IF NOT EXISTS guild_grants (
    guild_id          TEXT PRIMARY KEY,
    access_token      TEXT,
    access_expires_at INTEGER,
    refresh_token     TEXT,
    device_code       TEXT,
    user_code         TEXT,
    ask_expires_at    INTEGER,
    updated_at        INTEGER NOT NULL
);
