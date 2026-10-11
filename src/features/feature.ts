import type { CommandDefinition } from "../discord/commands.ts";
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
 * offer the convenience the core refuses, because the core hands it the tools
 * it needs: contracts a user approves in the core bot, a webhook that says what
 * happened, and — for a guild's own pool — a grant an administrator gives once.
 * What a feature may not do is move money the core would not: a bot outside the
 * core has no more authority than any other application, which is the property
 * that keeps this repository honest.
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
 * `docs/features.md` is the guide; the list in `index.ts` is where a feature is
 * added.
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
