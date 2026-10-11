import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRest } from "../src/discord/rest.ts";
import {
  holdersOf,
  MAX_GUILD_MEMBERS,
  readRoleHolders,
  tooLarge,
} from "../src/features/issue-role/members.ts";
import { stubFetch } from "./stub-fetch.ts";

/** The member scan: who counts as a holder, and where the scan refuses to guess. */

afterEach(() => {
  vi.unstubAllGlobals();
});

// The bot's calls go through `https://discord.com/api/v10`, which is what the
// stub's routes are keyed by.
const GUILD = "GET /api/v10/guilds/900";
const MEMBERS = "GET /api/v10/guilds/900/members";

function rest(): DiscordRest {
  return new DiscordRest("the-bot-token");
}

function member(id: string, roles: string[]): unknown {
  return { user: { id }, roles };
}

describe("who carries a role", () => {
  it("collects holders with the roles that were asked for, and skips one without a user", () => {
    expect(
      holdersOf(
        [
          member("1", ["700"]),
          { roles: ["700"] },
          member("2", ["700", "701", "999"]),
          member("3", []),
        ],
        ["700"],
      ),
    ).toEqual([
      { discordId: "1", roleIds: ["700"] },
      { discordId: "2", roleIds: ["700"] },
    ]);
  });

  it("tells each holder which of the roles they carry", () => {
    expect(
      holdersOf(
        [
          member("1", ["700"]),
          member("2", ["701"]),
          member("3", ["700", "701"]),
          member("4", []),
        ],
        ["700", "701"],
      ),
    ).toEqual([
      { discordId: "1", roleIds: ["700"] },
      { discordId: "2", roleIds: ["701"] },
      { discordId: "3", roleIds: ["700", "701"] },
    ]);
  });

  it("draws the line at the size Discord stops listing members for", () => {
    expect(tooLarge(MAX_GUILD_MEMBERS)).toBe(false);
    expect(tooLarge(MAX_GUILD_MEMBERS + 1)).toBe(true);
  });

  it("refuses a guild past that line before reading any page", async () => {
    const service = stubFetch({
      [GUILD]: {
        status: 200,
        body: { approximate_member_count: MAX_GUILD_MEMBERS + 1 },
      },
    });

    expect(await readRoleHolders(rest(), "900", ["700"])).toEqual({
      kind: "too-large",
      memberCount: MAX_GUILD_MEMBERS + 1,
    });
    expect(
      service.calls.filter((call) => call.path.endsWith("/members")),
    ).toHaveLength(0);
  });

  it("walks page by page from the last member's id, merging a holder met twice", async () => {
    const first = Array.from({ length: 1000 }, (_, index) =>
      member(String(index + 1), ["700"]),
    );
    // The roster moved between pages: the same member comes back carrying the
    // other role as well.
    const second = [member("1000", ["700", "701"]), member("2000", ["701"])];

    const service = stubFetch({
      [GUILD]: { status: 200, body: { approximate_member_count: 5000 } },
      [MEMBERS]: [
        { status: 200, body: first },
        { status: 200, body: second },
      ],
    });

    const scan = await readRoleHolders(rest(), "900", ["700", "701"]);

    expect(scan.kind).toBe("holders");
    const holders = scan.kind === "holders" ? scan.holders : [];
    expect(holders).toHaveLength(1001);
    expect(holders.find((holder) => holder.discordId === "1000")).toEqual({
      discordId: "1000",
      roleIds: ["700", "701"],
    });

    const pages = service.calls.filter(
      (call) => call.path === "/api/v10/guilds/900/members",
    );
    expect(pages[0]?.url).toContain("limit=1000");
    expect(pages[0]?.url).not.toContain("after=");
    expect(pages[1]?.url).toContain("after=1000");
  });

  it("refuses a full page with no id to page from", async () => {
    const page = Array.from({ length: 1000 }, () => ({ roles: ["700"] }));
    stubFetch({
      [GUILD]: { status: 200, body: { approximate_member_count: 5000 } },
      [MEMBERS]: { status: 200, body: page },
    });

    await expect(readRoleHolders(rest(), "900", ["700"])).rejects.toThrow();
  });
});
