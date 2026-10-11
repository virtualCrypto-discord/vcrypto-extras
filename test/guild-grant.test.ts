import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { VcClient } from "../src/vc/client.ts";
import { guildToken, pollGuildGrants } from "../src/vc/guild-grant.ts";
import { clearGrants, grantRow, seedGrant, storeTokens } from "./grants.ts";
import { type Reply, stubFetch } from "./stub-fetch.ts";

/**
 * The guild grant, against a scripted service and the real (local) database:
 * the ask an administrator answers, the pair the answer produces, the rotation
 * that keeps the pair alive, and the clock that takes up approvals nobody came
 * back for.
 */

const DB = (env as unknown as Env).DB;

const vc = new VcClient({
  baseUrl: "https://vc.test",
  clientId: "the-client",
  clientSecret: "the-secret",
});

beforeEach(async () => {
  await clearGrants();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ASK = "POST /oauth2/clients/@me/grant-requests";
const TOKEN = "POST /oauth2/token";

/** What `requestGuildGrant`'s own client-credentials call needs; the isolate's cache may or may not use it. */
const appToken: Reply = {
  status: 200,
  body: { access_token: "app-token", token_type: "Bearer", expires_in: 3600 },
};

const stillPending: Reply = {
  status: 400,
  body: {
    error: "authorization_pending",
    error_description: "authorization_pending",
  },
};

function granted(accessToken: string, refreshToken: string): Reply {
  return {
    status: 200,
    body: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
    },
  };
}

describe("the guild grant", () => {
  it("asks when the guild has never answered", async () => {
    stubFetch({
      [TOKEN]: [appToken, appToken],
      [ASK]: {
        status: 200,
        body: { device_code: "dc-1", user_code: "ABCD-1234", expires_in: 600 },
      },
    });

    const grant = await guildToken(vc, DB, "900");

    expect(grant).toEqual({
      kind: "approval",
      userCode: "ABCD-1234",
      expiresIn: 600,
    });
    expect((await grantRow("900"))?.device_code).toBe("dc-1");
  });

  it("reports an ask that is still waiting", async () => {
    await seedGrant({
      guildId: "901",
      deviceCode: "dc-2",
      userCode: "PEND-0001",
      askExpiresAt: Date.now() + 600_000,
    });
    stubFetch({ [TOKEN]: [stillPending] });

    const grant = await guildToken(vc, DB, "901");

    expect(grant.kind).toBe("approval");
    expect(grant.kind === "approval" ? grant.userCode : "").toBe("PEND-0001");
    expect((await grantRow("901"))?.device_code).toBe("dc-2");
  });

  it("takes up an approved ask: the pair is stored and the ask is forgotten", async () => {
    await seedGrant({
      guildId: "902",
      deviceCode: "dc-3",
      userCode: "OK-0001",
      askExpiresAt: Date.now() + 600_000,
    });
    stubFetch({ [TOKEN]: [granted("access-1", "refresh-1")] });

    const grant = await guildToken(vc, DB, "902");

    expect(grant).toEqual({ kind: "token", token: "access-1" });
    const row = await grantRow("902");
    expect(row?.refresh_token).toBe("refresh-1");
    expect(row?.device_code).toBeNull();
    expect(row?.user_code).toBeNull();
  });

  it("uses a live access token without touching the network", async () => {
    await seedGrant({
      guildId: "903",
      accessToken: "live",
      accessExpiresAt: Date.now() + 3_600_000,
      refreshToken: "refresh-live",
    });
    const service = stubFetch({});

    const grant = await guildToken(vc, DB, "903");

    expect(grant).toEqual({ kind: "token", token: "live" });
    expect(service.calls).toHaveLength(0);
  });

  it("renews from the refresh token and writes down the rotation", async () => {
    await seedGrant({
      guildId: "904",
      accessToken: "stale",
      accessExpiresAt: Date.now() - 1000,
      refreshToken: "refresh-old",
    });
    const service = stubFetch({
      [TOKEN]: [granted("access-2", "refresh-new")],
    });

    const grant = await guildToken(vc, DB, "904");

    expect(grant).toEqual({ kind: "token", token: "access-2" });
    expect((await grantRow("904"))?.refresh_token).toBe("refresh-new");
    expect(service.calls[0]?.body).toBe(
      "grant_type=refresh_token&refresh_token=refresh-old",
    );
    expect(service.calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("starts over with a new ask when the refresh token is dead", async () => {
    await seedGrant({
      guildId: "905",
      accessExpiresAt: Date.now() - 1000,
      refreshToken: "dead",
    });
    stubFetch({
      [TOKEN]: [
        {
          status: 400,
          body: { error: "invalid_grant", error_info: "invalid_refresh_token" },
        },
        appToken,
        appToken,
      ],
      [ASK]: {
        status: 200,
        body: { device_code: "dc-4", user_code: "NEW-0001", expires_in: 600 },
      },
    });

    const grant = await guildToken(vc, DB, "905");

    expect(grant).toEqual({
      kind: "approval",
      userCode: "NEW-0001",
      expiresIn: 600,
    });
    const row = await grantRow("905");
    expect(row?.refresh_token).toBeNull();
    expect(row?.device_code).toBe("dc-4");
  });

  it("does not turn a refusal that is not the ask's fault into a new ask", async () => {
    await seedGrant({
      guildId: "906",
      deviceCode: "dc-5",
      userCode: "X",
      askExpiresAt: Date.now() + 600_000,
    });
    stubFetch({
      [TOKEN]: [{ status: 500, body: { error: "server_error" } }],
    });

    await expect(guildToken(vc, DB, "906")).rejects.toThrow();
    // The ask survives a service fault: it was not the ask that failed.
    expect((await grantRow("906"))?.device_code).toBe("dc-5");
  });

  it("takes up the approved asks on the clock, oldest first, leaving the rest", async () => {
    await seedGrant({
      guildId: "907",
      deviceCode: "dc-6",
      userCode: "A",
      askExpiresAt: Date.now() + 600_000,
      updatedAt: 1000,
    });
    await seedGrant({
      guildId: "908",
      deviceCode: "dc-7",
      userCode: "B",
      askExpiresAt: Date.now() + 600_000,
      updatedAt: 2000,
    });
    stubFetch({
      [TOKEN]: [granted("access-7", "refresh-7"), stillPending],
    });

    const taken = await pollGuildGrants(vc, DB);

    expect(taken).toBe(1);
    expect((await grantRow("907"))?.access_token).toBe("access-7");
    expect((await grantRow("908"))?.device_code).toBe("dc-7");
  });

  it("leaves an expired ask to the command that will replace it", async () => {
    await seedGrant({
      guildId: "909",
      deviceCode: "dc-8",
      userCode: "C",
      askExpiresAt: Date.now() - 1000,
    });
    const service = stubFetch({});

    expect(await pollGuildGrants(vc, DB)).toBe(0);
    expect(service.calls).toHaveLength(0);
  });

  it("takes up the pair another poller stored while this one's code was being refused", async () => {
    await seedGrant({
      guildId: "910",
      deviceCode: "dc-race",
      userCode: "R",
      askExpiresAt: Date.now() + 600_000,
    });
    // The other poller wins the race in the moment between this poller's read
    // and its poll's answer: the reply writes the pair down, then refuses the
    // code as consumed. The ask must not be read as dead — an approval being
    // answered must never turn into another ask.
    stubFetch({
      [TOKEN]: async () => {
        await storeTokens({
          guildId: "910",
          accessToken: "won",
          accessExpiresAt: Date.now() + 3_600_000,
          refreshToken: "refresh-won",
        });
        return {
          status: 400,
          body: { error: "invalid_grant", error_info: "invalid_device_code" },
        };
      },
    });

    const grant = await guildToken(vc, DB, "910");

    expect(grant).toEqual({ kind: "token", token: "won" });
    // No new ask: the ASK route is not stubbed, so one would have thrown.
    expect((await grantRow("910"))?.device_code).toBeNull();
  });
});
