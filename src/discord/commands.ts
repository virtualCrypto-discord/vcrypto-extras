import type { FeatureContext } from "../features/context.ts";
import { reply } from "./responses.ts";
import type { Interaction } from "./types.ts";

/**
 * A slash command: the definition Discord is told about, and the handler it
 * dispatches to. A feature's commands are collected into the registry at the
 * bottom of `src/features/index.ts`, and `scripts/register-commands.ts`
 * registers every one of them with Discord.
 */
export interface CommandDefinition {
  name: string;
  description: string;
  /** Discord's own options JSON, passed through as written. */
  options?: readonly unknown[];
  handle(
    context: FeatureContext,
    interaction: Interaction,
  ): Promise<Response> | Response;
  /** Fills the choices for a focused option; absent means no command here autocompletes. */
  handleAutocomplete?(
    context: FeatureContext,
    interaction: Interaction,
  ): Promise<Response> | Response;
}

/** A definition as Discord's bulk overwrite takes it. */
export function commandJson(command: CommandDefinition): {
  name: string;
  description: string;
  options?: readonly unknown[];
} {
  return {
    name: command.name,
    description: command.description,
    ...(command.options === undefined ? {} : { options: command.options }),
  };
}

/**
 * The one command this repository ships before any feature exists: a smoke
 * test that the Discord half is wired end to end — a signed request verifies,
 * dispatch finds a handler, and an answer reaches Discord. Descriptions are in
 * Japanese, the way the core bot's own commands are.
 */
export const builtinCommands: readonly CommandDefinition[] = [
  {
    name: "ping",
    description: "Botが動いているか確認します。",
    handle: () => reply("pong"),
  },
];
