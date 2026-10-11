import { DiscordRest } from "../discord/rest.ts";
import type { Env } from "../env.ts";
import { VcClient } from "../vc/client.ts";

/** The shape the worker's fetch handler is given, narrowed to what this uses. */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** What every feature handler is handed: the two clients, and the request's lifetime. */
export interface FeatureContext {
  env: Env;
  /** The application's own client: tokens, contracts, the device flow. */
  vc: VcClient;
  /** The bot's REST calls, for what happens outside an interaction — a DM, a notice. */
  discord: DiscordRest;
  /** Work that outlives the response but not the request. */
  waitUntil(promise: Promise<unknown>): void;
}

export function featureContext(
  env: Env,
  ctx?: ExecutionContextLike,
): FeatureContext {
  return {
    env,
    vc: VcClient.fromEnv(env),
    discord: new DiscordRest(env.DISCORD_BOT_TOKEN),
    waitUntil: (promise) => {
      if (ctx) {
        ctx.waitUntil(promise);
      } else {
        void promise.catch((error) =>
          console.error("waitUntil without a context", error),
        );
      }
    },
  };
}
