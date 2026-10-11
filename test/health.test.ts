import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { testEnv } from "./env.ts";

// The router reads nothing from the environment on these paths, but the test
// hands it the same one every other test uses.
const env = testEnv();

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
