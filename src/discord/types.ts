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
  /**
   * The member's effective permissions, as the decimal string Discord sends —
   * all 64 bits of it, which is why it is a string and why it is read as one.
   */
  permissions?: string;
  roles?: string[];
}

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: CommandOption[];
  focused?: boolean;
}

/** One submitted input of a modal: a Label (or an old action row) around a field. */
export interface ModalComponent {
  component?: {
    custom_id?: string;
    value?: string;
  };
}

export interface InteractionData {
  id?: string;
  name?: string;
  custom_id?: string;
  component_type?: number;
  options?: CommandOption[];
  /** A select menu's chosen values — a role select's role ids, among others. */
  values?: string[];
  /** A modal submission's inputs, down to the fields that carry `custom_id` and `value`. */
  components?: ModalComponent[];
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

/**
 * Whether the member has Discord's `ADMINISTRATOR` bit — the check the core
 * bot's own administrator-only commands make (`is_administrator/1`, the one bit
 * `0x8`), and the one an issuance spends a guild's pool on the strength of.
 *
 * An interaction without a member — a DM — is not an administrator anywhere.
 */
export function isAdministrator(interaction: Interaction): boolean {
  const permissions = interaction.member?.permissions;
  if (permissions === undefined) {
    return false;
  }
  try {
    return (BigInt(permissions) & 0x8n) === 0x8n;
  } catch {
    return false;
  }
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

/**
 * A modal submission's text field, by the `custom_id` it was given — `null`
 * when the modal carried no such field or it was left empty.
 */
export function modalValue(
  data: InteractionData | undefined,
  customId: string,
): string | null {
  for (const entry of data?.components ?? []) {
    if (entry.component?.custom_id === customId) {
      const value = entry.component.value;
      return typeof value === "string" ? value : null;
    }
  }
  return null;
}
