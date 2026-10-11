import type { Env } from "./env.ts";
import { handleDiscordInteractions } from "./routes/discord.ts";
import { handleVcWebhook } from "./routes/vc.ts";

/**
 * The worker's doors, and nothing else:
 *
 * - `/discord/interactions` — Discord's, verified with Discord's public key
 *   and dispatched to the features' commands;
 * - `/vc/webhook` — virtualCrypto's, verified with the application's public
 *   key: the handshake, and the events a feature subscribes to;
 * - `/health` — what a deploy checks.
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
} satisfies ExportedHandler<Env>;
