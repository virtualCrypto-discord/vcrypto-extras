/**
 * As much of a Discord interaction as this repository reads.
 *
 * Discord sends more — locales, entitlements, resolved data — and the fields
 * that are here are the ones something in the tree consults. Unknown fields
 * are ignored, which is what the delivery contract says about exactly this.
 */

export interface InteractionUser {
  id: string;
  username?: string;
  global_name?: string | null;
}

export interface InteractionMember {
  user: InteractionUser;
}

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: CommandOption[];
  focused?: boolean;
}

export interface InteractionData {
  id?: string;
  name?: string;
  custom_id?: string;
  component_type?: number;
  options?: CommandOption[];
}

export interface Interaction {
  id: string;
  application_id: string;
  /** 1 PING, 2 command, 3 component, 4 autocomplete, 5 modal. */
  type: number;
  token: string;
  data?: InteractionData;
  /** Present when the interaction happened in a guild. */
  member?: InteractionMember;
  /** Present when it happened in a DM. */
  user?: InteractionUser;
  guild_id?: string;
  channel_id?: string;
}

/** The user an interaction came from: the member's in a guild, the top-level one in a DM. */
export function interactionUser(
  interaction: Interaction,
): InteractionUser | null {
  return interaction.member?.user ?? interaction.user ?? null;
}

export function findOption(
  options: readonly CommandOption[] | undefined,
  name: string,
): CommandOption | undefined {
  return options?.find((option) => option.name === name);
}

/** A string option's value, or `null` when it is absent or not a string. */
export function stringOption(
  options: readonly CommandOption[] | undefined,
  name: string,
): string | null {
  const value = findOption(options, name)?.value;
  return typeof value === "string" ? value : null;
}

/** An integer option's value, or `null` when it is absent or not an integer. */
export function integerOption(
  options: readonly CommandOption[] | undefined,
  name: string,
): number | null {
  const value = findOption(options, name)?.value;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** A boolean option's value, or `null` when it is absent or not a boolean. */
export function booleanOption(
  options: readonly CommandOption[] | undefined,
  name: string,
): boolean | null {
  const value = findOption(options, name)?.value;
  return typeof value === "boolean" ? value : null;
}
