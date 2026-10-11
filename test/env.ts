import { env } from "cloudflare:test";
import type { Env } from "../src/env.ts";

/**
 * The environment the tests hand to handlers: the miniflare bindings (so the
 * D1 binding is the real, local one) with the plain values spelled out, so a
 * test reads what a handler will see.
 */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    VCRYPTO_BASE_URL: "https://vc.test",
    VCRYPTO_CLIENT_ID: "the-client",
    VCRYPTO_CLIENT_SECRET: "the-secret",
    VCRYPTO_PUBLIC_KEY: "",
    DISCORD_APPLICATION_ID: "1",
    DISCORD_PUBLIC_KEY: "",
    DISCORD_BOT_TOKEN: "the-bot-token",
    DB: (env as unknown as Env).DB,
    ISSUE_RUNS: (env as unknown as Env).ISSUE_RUNS,
    ...overrides,
  };
}
