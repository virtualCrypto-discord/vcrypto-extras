import type { Env } from "./env.ts";
import { handleDiscordInteractions } from "./routes/discord.ts";
import { handleVcWebhook } from "./routes/vc.ts";
import { VcClient } from "./vc/client.ts";
import { pollGuildGrants } from "./vc/guild-grant.ts";

// The Durable Object a `/issue-role` run lives in — it drives its own alarms,
// so it only has to exist here for the runtime to find it.
export { IssueRun } from "./features/issue-role/run.ts";

/**
 * The worker's doors, and nothing else:
 *
 * - `/discord/interactions` — Discord's, verified with Discord's public key
 *   and dispatched to the features' commands;
 * - `/vc/webhook` — virtualCrypto's, verified with the application's public
 *   key: the handshake, and the events a feature subscribes to;
 * - `/health` — what a deploy checks.
 *
 * And the clock, which is one job: a guild grant that an administrator has
 * approved becomes usable even when nobody re-runs the command that asked for
 * it (`wrangler.jsonc` says how often).
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/discord/interactions") {
      return handleDiscordInteractions(request, env, ctx);
    }
    if (request.method === "POST" && pathname === "/vc/webhook") {
      return handleVcWebhook(request, env, ctx);
    }
    if (pathname === "/health") {
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await pollGuildGrants(VcClient.fromEnv(env), env.DB);
  },
} satisfies ExportedHandler<Env>;
