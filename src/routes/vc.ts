import type { Env } from "../env.ts";
import {
  type ExecutionContextLike,
  featureContext,
} from "../features/context.ts";
import { dispatchVcEvent } from "../features/index.ts";
import type { VcEvent } from "../vc/types.ts";
import { verifyVcDelivery } from "../vc/webhook.ts";

/**
 * `POST /vc/webhook` — virtualCrypto's door.
 *
 * The handshake at registration is this endpoint answering two things: a PING
 * the application's real key signed must come back `200 {"type": 1}`, and one a
 * key generated for the occasion signed must come back `401`. Both fall out of
 * verifying first and answering second — there is no special case for either.
 */
export async function handleVcWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const body = await request.text();

  if (
    !(await verifyVcDelivery(request.headers, body, env.VCRYPTO_PUBLIC_KEY))
  ) {
    // What the handshake is checking: a signature this application did not
    // receive from the service is a signature it refuses.
    return new Response("not verified", { status: 401 });
  }

  let event: VcEvent;
  try {
    event = JSON.parse(body) as VcEvent;
  } catch {
    // Verified and unreadable: nothing to hand anywhere, and nobody to tell.
    return Response.json({});
  }

  // The handshake's PING, answered with the PONG it is looking for.
  if (event.type === 1) {
    return Response.json({ type: 1 });
  }

  // Types a feature knows are dispatched; types nobody knows — the protocol
  // says they must be ignored — pass through the same way and answer the same.
  await dispatchVcEvent(featureContext(env, ctx), event);
  return Response.json({});
}
