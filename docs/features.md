# Adding a feature

A feature is one of the things the core deliberately does not do. It gets the
same authority every application has — contracts a user approves, the webhook
that says what happened — and nothing more. That boundary is the feature of
this architecture: whatever gets built here can never move money the core
would not.

## The shape

`src/features/index.ts` is the whole of the interface:

```ts
export interface Feature {
  name: string;                       // and the namespace of its custom_ids
  commands?: readonly CommandDefinition[];
  handleComponent?(ctx, interaction, customId): Promise<Response> | Response;
  handleModal?(ctx, interaction, customId): Promise<Response> | Response;
  handleVcEvent?(ctx, event): Promise<void> | void;
}
```

Add the feature to the `features` list there and its pieces are wired: its
commands are registered with Discord by `scripts/register-commands.ts`, its
components are routed by the namespace before the first `:` in their
`custom_id` (`"subscription:approve:42"`), and its `handleVcEvent` is called
for every delivery.

Every handler is handed a `FeatureContext`: `env`, a `vc` client (tokens,
contracts, the device flow), a `discord` client (DM channel, message), and
`waitUntil` for work that outlives the response.

## Rules and habits

- **Answer inside Discord's window.** An interaction wants an answer within
  three seconds; anything slower is a `deferred()` answer plus a follow-up, or
  `ctx.waitUntil` behind an immediate acknowledgement.
- **A delivery has no retry.** `dispatchVcEvent` runs every feature and logs a
  failure rather than stopping the others, so a handler that throws loses its
  own event and nothing else. Treat events as notifications of state, not as
  records: read the contract back when the state matters, and design the
  first-then-repeat call paths to be idempotent.
- **Keys name the operation.** A charge's `Idempotency-Key` is quoted and
  belongs to the use, not the attempt — `${contractId}:${useNumber}`, not a
  fresh UUID per try. A retry then reads the first answer instead of charging
  twice, which is the whole point of sending one.
- **The money's source of truth is virtualCrypto.** A feature's own rows (a
  subscription, a round of a game) are bookkeeping about contracts; anything
  kept must stay reconstructible from the API and the webhook.
- **Descriptions are in Japanese**, the way the core bot's commands are.

## The first candidate: renewal

The core records it as *"the first thing anybody asks a metered application
for"* (`docs/renewal.md` there). What stands today is a contract per period and
an approval per period — the answer that keeps the property *nobody is ever
charged for a period they did not agree to*. A feature here can automate the
tedium around it without touching the property:

1. **Propose the next period** when one is ending: `vc.createContract` with a
   fresh `expires_in` and the same parties. The core's answer to "renew"
   becomes a proposal the subscriber already has.
2. **Say it is waiting**: `discord.createDm` + `sendMessage` to the
   subscriber, pointing at the core bot's `/contract list` where the approval
   actually happens. (Or defer to the reply of a `/subscribe` command, so
   nothing is sent unprompted.)
3. **Track the state** from `type: 4` deliveries — each carries the contract
   and every party as they are now, so "the new period is active" and "the
   period was refused and the old money came home" are one event each.
4. **Lapse honestly**: a refusal, an expiry, or a period whose charge failed
   for `not_enough_amount` ends the subscription's run, and the record says
   why.

What it needs that the scaffold does not have yet: a **store** for
subscriptions (who, which unit, how much per period, how long a period,
which contract is current) and a **clock** — a Cron Trigger (`scheduled` in
`src/index.ts`) or a Durable Object alarm — to decide when the next proposal
is due. A Durable Object per subscription gets both (state + alarm) and a
single writer for the decision; D1 + cron is the flatter alternative. Either
way, the write that matters goes through a contract, and the subscriber's
approval is what makes it real.

## Other shapes that fit

- **Pay-per-use anything** — the shape `vc-demo-app`'s `demo-billing` already
  shows from outside: one contract, drawn down a charge at a time. A feature
  here would be the Discord front door for exactly that.
- **Guild-side rewards** — distributions from a guild's pool, which is the
  device-flow half of the client: the ask, the administrator's approval with
  `/grant approve`, and a guild token that issues. Useful where a guild wants
  to pay role holders, event winners, or voters without an administrator
  typing `/issue` for each one.
- **Screens the core does not have** — the core's own answer to management
  UIs is "every operation is one a command can do"; a feature is free to make
  a different, extra screen out of the API, as long as it does not become the
  only way to do something.
