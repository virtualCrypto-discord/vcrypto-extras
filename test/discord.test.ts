import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { handleDiscordInteractions } from "../src/routes/discord.ts";
import { generateTestKey, type TestKey } from "./keys.ts";

const BASE = "https://vcrypto-extras.test";

function envWith(discordPublicKey: string): Env {
  return {
    VCRYPTO_BASE_URL: "https://vc.test",
    VCRYPTO_CLIENT_ID: "the-client",
    VCRYPTO_CLIENT_SECRET: "the-secret",
    VCRYPTO_PUBLIC_KEY: "",
    DISCORD_APPLICATION_ID: "1",
    DISCORD_PUBLIC_KEY: discordPublicKey,
    DISCORD_BOT_TOKEN: "",
  };
}

/** A request signed the way Discord signs one: over `timestamp <> body`. */
async function signed(
  key: TestKey,
  body: unknown,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<Request> {
  const text = JSON.stringify(body);
  return new Request(`${BASE}/discord/interactions`, {
    method: "POST",
    headers: {
      "x-signature-ed25519": await key.sign(`${timestamp}${text}`),
      "x-signature-timestamp": String(timestamp),
    },
    body: text,
  });
}

describe("the Discord door", () => {
  it("answers a PING with a PONG", async () => {
    const key = await generateTestKey();
    const response = await handleDiscordInteractions(
      await signed(key, { type: 1 }),
      envWith(key.publicHex),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("refuses a signature made with a key that is not Discord's", async () => {
    const discord = await generateTestKey();
    const impostor = await generateTestKey();
    const response = await handleDiscordInteractions(
      await signed(impostor, { type: 1 }),
      envWith(discord.publicHex),
    );

    expect(response.status).toBe(401);
  });

  it("refuses a signature outside the window, however valid", async () => {
    const key = await generateTestKey();
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const response = await handleDiscordInteractions(
      await signed(key, { type: 1 }, stale),
      envWith(key.publicHex),
    );

    expect(response.status).toBe(401);
  });

  it("refuses a request with no signature headers at all", async () => {
    const key = await generateTestKey();
    const request = new Request(`${BASE}/discord/interactions`, {
      method: "POST",
      body: JSON.stringify({ type: 1 }),
    });
    const response = await handleDiscordInteractions(
      request,
      envWith(key.publicHex),
    );

    expect(response.status).toBe(401);
  });

  it("dispatches a command and answers its message", async () => {
    const key = await generateTestKey();
    const response = await handleDiscordInteractions(
      await signed(key, { type: 2, data: { name: "ping" } }),
      envWith(key.publicHex),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: 4,
      data: { content: "pong" },
    });
  });

  it("answers an unregistered command as one it cannot place", async () => {
    const key = await generateTestKey();
    const response = await handleDiscordInteractions(
      await signed(key, { type: 2, data: { name: "nope" } }),
      envWith(key.publicHex),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Type Not Found");
  });
});
