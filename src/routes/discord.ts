import { pong, typeNotFound } from "../discord/responses.ts";
import { verifyDiscordSignature } from "../discord/signature.ts";
import type { Interaction } from "../discord/types.ts";
import type { Env } from "../env.ts";
import {
  type ExecutionContextLike,
  featureContext,
} from "../features/context.ts";
import {
  dispatchAutocomplete,
  dispatchCommand,
  dispatchComponent,
  dispatchModal,
} from "../features/index.ts";

/**
 * `POST /discord/interactions` — Discord's door.
 *
 * The signature is verified before the body is read as anything, and it is the
 * whole of the authentication: there is no token Discord sends, and none it
 * accepts. What is verified is checked before what is dispatched, which is the
 * order both this service and the core service keep.
 */
export async function handleDiscordInteractions(
  request: Request,
  env: Env,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const body = await request.text();

  if (
    !(await verifyDiscordSignature(
      request.headers,
      body,
      env.DISCORD_PUBLIC_KEY,
    ))
  ) {
    return new Response("invalid request signature", { status: 401 });
  }

  let interaction: Interaction;
  try {
    interaction = JSON.parse(body) as Interaction;
  } catch {
    // The signature already passed, so the request is genuinely Discord's —
    // a body it could not have sent is a type that cannot be found.
    return typeNotFound();
  }

  // PING is answered before anything is built: it is the handshake Discord's
  // endpoint URL is checked with, and it must not depend on the rest.
  if (interaction.type === 1) {
    return pong();
  }

  const context = featureContext(env, ctx);
  switch (interaction.type) {
    case 2:
      return dispatchCommand(context, interaction);
    case 3:
      return dispatchComponent(context, interaction);
    case 4:
      return dispatchAutocomplete(context, interaction);
    case 5:
      return dispatchModal(context, interaction);
    default:
      return typeNotFound();
  }
}
