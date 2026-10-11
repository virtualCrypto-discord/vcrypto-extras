import {
  builtinCommands,
  type CommandDefinition,
  commandJson,
} from "../discord/commands.ts";
import { typeNotFound } from "../discord/responses.ts";
import type { Interaction } from "../discord/types.ts";
import type { VcEvent } from "../vc/types.ts";
import type { FeatureContext } from "./context.ts";

/**
 * A feature: one of the things virtualCrypto deliberately keeps out of its own
 * core, living out here as an application.
 *
 * The core has answers it does not want to give up — nothing is locked without
 * an agreement that says so, every period is approved as a period, a contract
 * its parties did not agree to cannot happen — and those answers are what makes
 * a feature like "renew without asking again" a no there. An application can
 * offer the convenience the core refuses, because the core hands it the two
 * tools it needs: contracts, which a user approves in the core bot, and a
 * webhook that says what happened. What a feature may not do is move money the
 * core would not: a bot outside the core has no more authority than any other
 * application, which is the property that keeps this repository honest.
 *
 * A feature's pieces, all optional:
 *
 * - `commands` — slash commands, registered by name;
 * - `handleComponent` / `handleModal` — the buttons and forms it put in
 *   messages, routed by the namespace of their `custom_id` (`"<name>:…"`);
 * - `handleVcEvent` — the deliveries from virtualCrypto. `type: 4` is a
 *   contract decision, which is how a feature learns that an approval landed
 *   or a period ended.
 *
 * `docs/features.md` is the guide; the list below is where a feature is added.
 */
export interface Feature {
  /** Stable name, and the namespace of its component ids. */
  name: string;
  commands?: readonly CommandDefinition[];
  handleComponent?(
    context: FeatureContext,
    interaction: Interaction,
    customId: string,
  ): Promise<Response> | Response;
  handleModal?(
    context: FeatureContext,
    interaction: Interaction,
    customId: string,
  ): Promise<Response> | Response;
  handleVcEvent?(context: FeatureContext, event: VcEvent): Promise<void> | void;
}

/**
 * Every feature. Nothing is here yet, on purpose: this repository is the
 * foundation a feature plugs into, and the first candidate — a renewal that
 * asks for the next period before the last one ends, which the core service
 * documents as "the first thing anybody asks a metered application for" — is
 * described in docs/features.md.
 */
export const features: readonly Feature[] = [];

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
