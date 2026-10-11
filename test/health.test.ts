import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";

// The router reads nothing from the environment on these paths, so the test
// hands it the emptiest one there is.
const env: Env = {
  VCRYPTO_BASE_URL: "https://vc.test",
  VCRYPTO_CLIENT_ID: "",
  VCRYPTO_CLIENT_SECRET: "",
  VCRYPTO_PUBLIC_KEY: "",
  DISCORD_APPLICATION_ID: "",
  DISCORD_PUBLIC_KEY: "",
  DISCORD_BOT_TOKEN: "",
};

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

describe("the router", () => {
  it("answers a health check", async () => {
    const response = await worker.fetch(
      new Request("https://vcrypto-extras.test/health"),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers nothing else as a door", async () => {
    const response = await worker.fetch(
      new Request("https://vcrypto-extras.test/"),
      env,
      ctx,
    );

    expect(response.status).toBe(404);
  });
});
