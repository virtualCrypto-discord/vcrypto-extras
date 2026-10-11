import { afterEach, describe, expect, it, vi } from "vitest";
import { VcClient } from "../src/vc/client.ts";
import { VcApiError } from "../src/vc/errors.ts";

/**
 * The client against a scripted service: what virtualCrypto promises a client
 * — one token reused, a 401 renewed once, the bounded waits, the quoted key —
 * is what these pin.
 *
 * The stub is `vi.stubGlobal("fetch", …)`, which works in workerd the same way
 * it does anywhere: the client resolves `fetch` when it sends, so a stubbed
 * global is the one it finds.
 */

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Call {
  method: string;
  path: string;
  headers: Headers;
}

/** A scripted service: each route answers with the replies it has left, in order. */
function stubService(routes: Record<string, Reply[]>): { calls: Call[] } {
  const calls: Call[] = [];

  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      calls.push({
        method: request.method,
        path: pathname,
        headers: request.headers,
      });

      const reply = routes[`${request.method} ${pathname}`]?.shift();
      if (reply === undefined) {
        throw new Error(`unstubbed request: ${request.method} ${pathname}`);
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

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOKEN = "POST /oauth2/token";
const CONTRACT = "GET /api/v2/contracts/12";
const PAYMENT = "POST /api/v2/contracts/12/payments";

/** A fresh client per test, so one test's token cache is not another's. */
function client(name: string): VcClient {
  return new VcClient({
    baseUrl: "https://vc.test",
    clientId: name,
    clientSecret: "the-secret",
  });
}

function token(accessToken: string): Reply {
  return {
    status: 200,
    body: { access_token: accessToken, token_type: "Bearer", expires_in: 3600 },
  };
}

function contract(status: string): Reply {
  return { status: 200, body: { id: "12", unit: "nyan", status } };
}

describe("the virtualCrypto client", () => {
  it("mints one application token and reuses it", async () => {
    const service = stubService({
      [TOKEN]: [token("token-1")],
      [CONTRACT]: [contract("pending"), contract("active")],
    });

    const vc = client("client-1");
    expect((await vc.contract("12")).status).toBe("pending");
    expect((await vc.contract("12")).status).toBe("active");
    expect(
      service.calls.filter((call) => `${call.method} ${call.path}` === TOKEN),
    ).toHaveLength(1);
  });

  it("renews the token on a 401 and retries the request once", async () => {
    const service = stubService({
      [TOKEN]: [token("token-old"), token("token-new")],
      [CONTRACT]: [
        { status: 401, body: { error: "invalid_token" } },
        contract("active"),
      ],
    });

    const vc = client("client-2");
    expect((await vc.contract("12")).status).toBe("active");
    expect(
      service.calls.filter((call) => `${call.method} ${call.path}` === TOKEN),
    ).toHaveLength(2);
  });

  it("sends the idempotency key as the quoted string the service takes", async () => {
    const service = stubService({
      [TOKEN]: [token("token-1")],
      [PAYMENT]: [{ status: 201, body: { amount: "25", remaining: "275" } }],
    });

    const vc = client("client-3");
    const charged = await vc.payContract("12", { amount: "25" }, "use-1");

    expect(charged).toEqual({ amount: "25", remaining: "275" });
    const call = service.calls.find(
      (call) => `${call.method} ${call.path}` === PAYMENT,
    );
    expect(call?.headers.get("idempotency-key")).toBe('"use-1"');
  });

  it("waits out a short rate limit and sends the request again", async () => {
    const service = stubService({
      [TOKEN]: [token("token-1")],
      [CONTRACT]: [
        {
          status: 429,
          body: { error: "too_many_requests" },
          headers: { "retry-after": "1" },
        },
        contract("active"),
      ],
    });

    const vc = client("client-4");
    expect((await vc.contract("12")).status).toBe("active");
    expect(
      service.calls.filter(
        (call) => `${call.method} ${call.path}` === CONTRACT,
      ),
    ).toHaveLength(2);
  });

  it("refuses a rate limit it would have to wait too long for, and says when to come back", async () => {
    const service = stubService({
      [TOKEN]: [token("token-1")],
      [CONTRACT]: [
        {
          status: 429,
          body: { error: "too_many_requests" },
          headers: { "retry-after": "61" },
        },
      ],
    });

    const vc = client("client-5");
    const refusal: unknown = await vc
      .contract("12")
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(VcApiError);
    expect((refusal as VcApiError).status).toBe(429);
    expect((refusal as VcApiError).retryAfterSeconds).toBe(61);
    expect(
      service.calls.filter(
        (call) => `${call.method} ${call.path}` === CONTRACT,
      ),
    ).toHaveLength(1);
  });
});
