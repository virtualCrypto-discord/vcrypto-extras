import type { DiscordRest } from "../../discord/rest.ts";

/**
 * Who carries the roles.
 *
 * Discord answers this only by enumeration — walking `GET /guilds/{id}/members`
 * a page at a time and reading each member's `roles` — which is why the scan
 * has the guards it has, all of them the ones `vc-demo-app`'s `demo-issue`
 * learned the hard way: a guild past the size Discord stops listing (75,000,
 * the figure its own gateway documentation writes down) is refused rather than
 * paid from a partial list, and a full page with no id to page from is an error
 * rather than a guess.
 *
 * Several roles are one scan against a **set**, and what a holder is handed
 * back with is *which* of the roles they carry: the run pays each role's own
 * amount, so a member holding three of them carries three amounts, and the
 * scan is the only place the pairing is known.
 */

/** The size at which Discord stops handing over a member list, so the size a scan refuses past. */
export const MAX_GUILD_MEMBERS = 75_000;

/** One page is Discord's own ceiling for the member list. */
const MEMBER_PAGE = 1000;

/** A member of the guild who carries at least one of the roles being paid, and which ones. */
export interface RoleHolder {
  discordId: string;
  roleIds: string[];
}

export type MemberScan =
  | { kind: "holders"; holders: RoleHolder[] }
  | { kind: "too-large"; memberCount: number };

/**
 * The members carrying any of `roleIds`, in the order Discord sent them, each
 * with the roles of `roleIds` they carry.
 *
 * `@everyone`'s id is never written into a member's `roles` — passing it finds
 * nobody, which is what the caller refuses on rather than an error here.
 */
export function holdersOf(
  members: readonly unknown[],
  roleIds: readonly string[],
): RoleHolder[] {
  const wanted = new Set(roleIds);
  const holders: RoleHolder[] = [];
  for (const member of members) {
    if (typeof member !== "object" || member === null) continue;
    const record = member as Record<string, unknown>;

    const roles = record.roles;
    if (!Array.isArray(roles)) continue;
    const carried = roles.filter(
      (role): role is string => typeof role === "string" && wanted.has(role),
    );
    if (carried.length === 0) continue;

    const id = userId(member);
    if (id !== undefined) holders.push({ discordId: id, roleIds: carried });
  }
  return holders;
}

/** The member's user id, when Discord sent one — a member without a user is not payable. */
export function userId(member: unknown): string | undefined {
  if (typeof member !== "object" || member === null) return undefined;
  const user = (member as Record<string, unknown>).user;
  if (typeof user !== "object" || user === null) return undefined;
  const id = (user as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

export function tooLarge(memberCount: number): boolean {
  return memberCount > MAX_GUILD_MEMBERS;
}

/**
 * Walk the guild's members and collect the roles' holders.
 *
 * The guild's own size is checked first, against Discord's `approximate_member_count`,
 * and the scan guard afterwards is what refuses when that number was missing or
 * stale: a list walked past the limit is a partial list, and issuing from one
 * would pay some holders and not others.
 */
export async function readRoleHolders(
  rest: DiscordRest,
  guildId: string,
  roleIds: readonly string[],
): Promise<MemberScan> {
  const guild = await rest.guild(guildId);
  const memberCount = guild.approximate_member_count;
  if (typeof memberCount === "number" && tooLarge(memberCount)) {
    return { kind: "too-large", memberCount };
  }

  const holders: RoleHolder[] = [];
  const at = new Map<string, RoleHolder>();
  let scanned = 0;
  let after: string | undefined;

  for (;;) {
    const page = await rest.guildMemberPage(guildId, after);
    scanned += page.length;
    if (tooLarge(scanned)) {
      return { kind: "too-large", memberCount: scanned };
    }

    for (const holder of holdersOf(page, roleIds)) {
      // A member met twice — pages can overlap when the roster moves — keeps
      // one entry, with every role merged into it.
      const seen = at.get(holder.discordId);
      if (seen === undefined) {
        at.set(holder.discordId, holder);
        holders.push(holder);
        continue;
      }
      for (const roleId of holder.roleIds) {
        if (!seen.roleIds.includes(roleId)) {
          seen.roleIds.push(roleId);
        }
      }
    }

    if (page.length < MEMBER_PAGE) {
      return { kind: "holders", holders };
    }

    // A full page means there is more, so the cursor has to be there —
    // stopping without one would pay from a list that stopped early.
    const last = userId(page.at(-1));
    if (last === undefined) {
      throw new Error(
        "Discord sent a full page of members with no id to page from",
      );
    }
    after = last;
  }
}
