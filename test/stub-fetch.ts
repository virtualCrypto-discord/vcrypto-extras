import { vi } from "vitest";

/**
 * A scripted service, for both origins this repository talks to.
 *
 * Routes are keyed by `METHOD /path` (the query is not part of the key — the
 * full URL is on the call, for tests that want to read it) and answer with the
 * replies they have left, in order, so a test can script a sequence — a token
 * that dies and is renewed, a rate limit followed by a success. A request with
 * no reply left is an error rather than a silent `200`: the point of the stub
 * is that every call a test provokes is one the test asked for.
 */

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Call {
  method: string;
  origin: string;
  path: string;
  url: string;
  headers: Headers;
  body: string | null;
}

/**
 * A fixed reply, a queue of them, or a function of the request — the last for
 * a test that has to change something *around* the reply, like another poller
 * writing its winnings down in the moment a refusal is being answered.
 */
export type ReplySource =
  | Reply
  | Reply[]
  | ((request: Request) => Reply | Promise<Reply>);

export function stubFetch(routes: Record<string, ReplySource>): {
  calls: Call[];
} {
  const calls: Call[] = [];

  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        origin: url.origin,
        path: url.pathname,
        url: request.url,
        headers: request.headers,
        body: typeof init?.body === "string" ? init.body : null,
      });

      const route = routes[`${request.method} ${url.pathname}`];
      const reply =
        typeof route === "function"
          ? await route(request)
          : Array.isArray(route)
            ? route.shift()
            : route;
      if (reply === undefined) {
        throw new Error(`unstubbed request: ${request.method} ${url.pathname}`);
      }

      return new Response(
        reply.body === undefined ? null : JSON.stringify(reply.body),
        {
          status: reply.status,
          headers: { "content-type": "application/json", ...reply.headers },
        },
      );
    },
  );

  return { calls };
}
