/**
 * Tell Discord about this bot's commands.
 *
 * A bulk overwrite: what is registered replaces what was there, so a command
 * removed from the tree goes away in the same call. Without `--guild` the
 * commands are global and Discord may take up to an hour to show them; with a
 * guild id they are that guild's immediately, which is what development wants.
 *
 * Values come from the environment or from `.env` (which `.gitignore` holds):
 *
 *   DISCORD_BOT_TOKEN=… DISCORD_APPLICATION_ID=… \
 *     node scripts/register-commands.ts [--guild <guild id>]
 */

import { commandDefinitions } from "../src/features/index.ts";
import { loadEnvFile } from "./load-env.ts";

loadEnvFile();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`missing ${name}`);
    process.exit(1);
  }
  return value;
}

const botToken = requireEnv("DISCORD_BOT_TOKEN");
const applicationId = requireEnv("DISCORD_APPLICATION_ID");

const at = process.argv.indexOf("--guild");
const guildId = at === -1 ? null : (process.argv[at + 1] ?? null);

const path =
  guildId === null
    ? `/applications/${applicationId}/commands`
    : `/applications/${applicationId}/guilds/${guildId}/commands`;

const response = await fetch(`https://discord.com/api/v10${path}`, {
  method: "PUT",
  headers: {
    authorization: `Bot ${botToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commandDefinitions()),
});

if (!response.ok) {
  console.error(
    `Discord answered ${response.status}: ${await response.text()}`,
  );
  process.exit(1);
}

const registered = (await response.json()) as unknown[];
console.log(
  `registered ${registered.length} command(s)` +
    (guildId === null ? " globally" : ` in guild ${guildId}`),
);
