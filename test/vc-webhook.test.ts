import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { handleVcWebhook } from "../src/routes/vc.ts";
import { generateTestKey, type TestKey } from "./keys.ts";

const BASE = "https://vcrypto-extras.test";

function envWith(vcryptoPublicKey: string): Env {
  return {
    VCRYPTO_BASE_URL: "https://vc.test",
    VCRYPTO_CLIENT_ID: "the-client",
    VCRYPTO_CLIENT_SECRET: "the-secret",
    VCRYPTO_PUBLIC_KEY: vcryptoPublicKey,
    DISCORD_APPLICATION_ID: "1",
    DISCORD_PUBLIC_KEY: "",
    DISCORD_BOT_TOKEN: "",
  };
}

/** A delivery signed the way virtualCrypto signs one: over `timestamp <> body`. */
async function delivered(key: TestKey, body: unknown): Promise<Request> {
  const text = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request(`${BASE}/vc/webhook`, {
    method: "POST",
    headers: {
      "x-signature-ed25519": await key.sign(`${timestamp}${text}`),
      "x-signature-timestamp": String(timestamp),
    },
    body: text,
  });
}

describe("the virtualCrypto door", () => {
  it("answers the handshake's PING", async () => {
    const key = await generateTestKey();
    const response = await handleVcWebhook(
      await delivered(key, { type: 1 }),
      envWith(key.publicHex),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("refuses a PING signed with a key generated for the occasion", async () => {
    // Half of the handshake: a keypair generated just to check that this
    // application verifies anything at all must be refused.
    const application = await generateTestKey();
    const invented = await generateTestKey();
    const response = await handleVcWebhook(
      await delivered(invented, { type: 1 }),
      envWith(application.publicHex),
    );

    expect(response.status).toBe(401);
  });

  it("ignores a type nobody knows", async () => {
    const key = await generateTestKey();
    const response = await handleVcWebhook(
      await delivered(key, { type: 99, data: {} }),
      envWith(key.publicHex),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  it("hands a contract decision to a delivery nobody is listening for yet", async () => {
    const key = await generateTestKey();
    const event = {
      type: 4,
      data: {
        contract: {
          id: "12",
          unit: "nyan",
          status: "active",
          remaining: "300",
        },
        parties: [
          {
            discord_id: "100",
            amount: "300",
            remaining: "300",
            status: "approved",
          },
        ],
      },
    };
    const response = await handleVcWebhook(
      await delivered(key, event),
      envWith(key.publicHex),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });
});
