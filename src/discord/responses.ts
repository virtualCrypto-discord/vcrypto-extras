/** The interaction responses, and the one refusal the dispatcher answers with. */

/** Discord's flag for "only the invoker sees this". */
const EPHEMERAL = 1 << 6;

/**
 * A plain refusal for an interaction the dispatcher cannot place, in the core
 * service's own spelling. Discord only sends registered commands and its own
 * components, so this is unreachable in practice and is written down anyway.
 */
export function typeNotFound(): Response {
  return new Response("Type Not Found", {
    status: 400,
    headers: { "content-type": "text/plain" },
  });
}

/** The answer to Discord's PING. */
export function pong(): Response {
  return Response.json({ type: 1 });
}

/** A message, now. */
export function reply(
  content: string,
  options: { ephemeral?: boolean } = {},
): Response {
  return Response.json({
    type: 4,
    data: {
      content,
      ...(options.ephemeral ? { flags: EPHEMERAL } : {}),
    },
  });
}

/**
 * An acknowledgement, with the real answer to come later through the
 * interaction's follow-up URL (`POST /webhooks/{application_id}/{token}` —
 * `DiscordRest` is where a feature would send it).
 */
export function deferred(options: { ephemeral?: boolean } = {}): Response {
  return Response.json({
    type: 5,
    data: {
      ...(options.ephemeral ? { flags: EPHEMERAL } : {}),
    },
  });
}
