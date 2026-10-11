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

/**
 * Open a modal — the answer to the button that asks for a value. The payload
 * is the modal's own JSON, built where the state it is pre-filled from lives.
 */
export function openModal(modal: unknown): Response {
  return Response.json({ type: 9, data: modal });
}

/**
 * Replace the message a component is attached to — what a button press answers
 * with. `components: []` clears the buttons; omitting them leaves whatever was
 * there, which is why the difference is the caller's to make.
 */
export function updateMessage(
  content: string,
  options: { components?: unknown[] } = {},
): Response {
  return Response.json({
    type: 7,
    data: {
      content,
      ...(options.components === undefined
        ? {}
        : { components: options.components }),
    },
  });
}
