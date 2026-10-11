import {
  builtinCommands,
  type CommandDefinition,
  commandJson,
} from "../discord/commands.ts";
import { typeNotFound } from "../discord/responses.ts";
import type { Interaction } from "../discord/types.ts";
import type { VcEvent } from "../vc/types.ts";
import type { FeatureContext } from "./context.ts";
import type { Feature } from "./feature.ts";
import { issueRole } from "./issue-role/index.ts";

export type { Feature } from "./feature.ts";

/**
 * Every feature: one line per thing this repository does that the core
 * deliberately does not. Add one here, and its commands go out with
 * `scripts/register-commands.ts`, its components route by their `custom_id`
 * namespace, and its `handleVcEvent` sees every delivery.
 *
 * - `issue-role` — a guild's pool pays everyone who carries a role
 *   (`src/features/issue-role/`, and `docs/issue-role.md` for the manual).
 *
 * The candidates that are not here yet — renewal first, which the core service
 * records as "the first thing anybody asks a metered application for" — are
 * described in `docs/features.md`.
 */
export const features: readonly Feature[] = [issueRole];

// ---- The registry ----------------------------------------------------------

const commands = new Map<string, CommandDefinition>();
for (const command of [
  ...builtinCommands,
  ...features.flatMap((feature) => [...(feature.commands ?? [])]),
]) {
  if (commands.has(command.name)) {
    // A duplicate is a mistake to fail on, not to resolve: Discord keeps one
    // command per name, so silently dropping one would remove a command from a
    // feature without saying so.
    throw new Error(`duplicate command: ${command.name}`);
  }
  commands.set(command.name, command);
}

/** Every command to register with Discord — the built-ins', then the features'. */
export function commandDefinitions(): ReturnType<typeof commandJson>[] {
  return [...commands.values()].map(commandJson);
}

/** The feature a `custom_id` belongs to, by the namespace before its first colon. */
function featureOf(customId: string): Feature | undefined {
  const namespace = customId.split(":", 1)[0];
  return features.find((feature) => feature.name === namespace);
}

export async function dispatchCommand(
  context: FeatureContext,
  interaction: Interaction,
): Promise<Response> {
  const name = interaction.data?.name;
  const command = name === undefined ? undefined : commands.get(name);
  return command === undefined
    ? typeNotFound()
    : command.handle(context, interaction);
}

export async function dispatchAutocomplete(
  context: FeatureContext,
  interaction: Interaction,
): Promise<Response> {
  const name = interaction.data?.name;
  const command = name === undefined ? undefined : commands.get(name);
  if (command?.handleAutocomplete === undefined) {
    return typeNotFound();
  }
  return command.handleAutocomplete(context, interaction);
}

export async function dispatchComponent(
  context: FeatureContext,
  interaction: Interaction,
): Promise<Response> {
  const customId = interaction.data?.custom_id ?? "";
  const feature = featureOf(customId);
  if (feature?.handleComponent === undefined) {
    return typeNotFound();
  }
  return feature.handleComponent(context, interaction, customId);
}

export async function dispatchModal(
  context: FeatureContext,
  interaction: Interaction,
): Promise<Response> {
  const customId = interaction.data?.custom_id ?? "";
  const feature = featureOf(customId);
  if (feature?.handleModal === undefined) {
    return typeNotFound();
  }
  return feature.handleModal(context, interaction, customId);
}

/**
 * Hand a delivery to every feature that wants it.
 *
 * A delivery has no retry behind it, so one feature's failure is logged and the
 * rest still run — a broken handler must not eat another feature's event, and
 * there is nobody on the other side to tell anyway.
 */
export async function dispatchVcEvent(
  context: FeatureContext,
  event: VcEvent,
): Promise<void> {
  for (const feature of features) {
    if (feature.handleVcEvent === undefined) continue;
    try {
      await feature.handleVcEvent(context, event);
    } catch (error) {
      console.error(`feature ${feature.name} failed on a vc event`, error);
    }
  }
}
