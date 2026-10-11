# vcrypto-extras

The features virtualCrypto deliberately keeps out of its core — as a Discord
bot that is also a virtualCrypto application, running on Cloudflare Workers.

The core service says "no" to some requests on purpose: nothing is locked
without an agreement that says so, a subscription is a contract per period and
an approval per period, an application cannot end a period early. Those answers
are what make the core what it is, so the convenience versions of them live
here — as an **application**, with no more authority than any other: it asks
for contracts, the user approves them in the core bot, and the webhook tells it
what happened.

This repository is the foundation, not a feature. It wires the two integrations
a bot of this kind needs, and stops there.

## What is here

| | |
| --- | --- |
| **Discord door** | `POST /discord/interactions` — the signature is verified with Discord's public key (Ed25519 over `timestamp <><body>`), PING is answered, and commands / buttons / modals are dispatched to the features' handlers. |
| **virtualCrypto door** | `POST /vc/webhook` — deliveries are verified with the application's own public key; the handshake's PING is answered `{"type": 1}`, and `type: 2/3/4` events are handed to features. |
| **virtualCrypto client** | application tokens (`client_credentials`, cached per isolate, renewed on `401`), contracts (create, read, charge, statement), the device flow for guild issuance, and the bounded waits the service asks for (`429 Retry-After`, `409 processing`). |
| **Discord client** | what a feature needs outside an interaction: a DM channel and a message. |
| **Feature registry** | where a feature adds commands, components and event handlers — `src/features/index.ts`, described in [docs/features.md](docs/features.md). |
| **`/issue-role`** | the first feature: a **settings screen** where a guild picks the roles (several at once) and **an amount for each** — the union is paid once per member, each holder receiving the sum of their roles' amounts — then a live progress screen — 更新 and 再開 — and a run that continues by itself: rate limits are waited out, an approval is noticed, a hiccup is retried, a stop is resumed by the button. The permission is asked for once (an administrator approves with the core bot) and remembered in D1. Manual: [docs/issue-role.md](docs/issue-role.md). |
| **Tooling** | `scripts/register-application.ts` (registers the application with virtualCrypto, PAT in hand) and `scripts/register-commands.ts` (Discord's bulk overwrite). |

The candidates that are *not* here yet — renewal first, which the core service
records as "the first thing anybody asks a metered application for" — are
described in [docs/features.md](docs/features.md).

## The shape

```text
             Discord                                        virtualCrypto
                │                                                 │
   interactions │ signed door                      webhook door  │ signed deliveries
                ▼                                                 ▼
        ┌─────────────────────────  vcrypto-extras  ─────────────────────────┐
        │  routes → features        commands, components, vc events         │
        │  vc client       ──────────────────────────►  virtualCrypto API   │
        │  discord client  ──────────────────────────►  Discord API         │
        └────────────────────────────────────────────────────────────────────┘
```

The core bot stays the only place a person answers: contracts are approved in
its own `/contract` screens, and this bot is told the outcome. That is the
whole design — the extra features are flows on top of that approval, never a
way around it.

## Getting it running

Node 24 and a Cloudflare account. The full walkthrough — Discord application,
deploy, registration, secrets — is [docs/operations.md](docs/operations.md);
the short form:

```sh
npm install
npm run check                 # lint, typecheck, tests (in workerd), dry-run build
wrangler d1 create vcrypto-extras             # once; paste the id into wrangler.jsonc
wrangler d1 migrations apply vcrypto-extras --remote
wrangler deploy               # needs the vars and secrets from docs/operations.md
node scripts/register-application.ts          # once, with a PAT in VC_PAT
node scripts/register-commands.ts             # tell Discord about the commands
```

## Layout

```text
src/
  index.ts              the router: the two doors and /health
  env.ts                everything the worker is configured with
  crypto.ts             Ed25519 over hex — the primitive both doors verify with
  routes/               the two doors, each: verify, parse, dispatch
  discord/              signature, responses, interaction types, bot REST client
  vc/                   virtualCrypto client, guild grants, wire types
  features/             the registry, and the features themselves (`issue-role/`)
migrations/             D1: the guild grants a guild-side feature needs
scripts/                the one-shot operators' scripts (run under Node)
test/                   the suite, inside workerd, against scripted services
```

## Docs

- [docs/architecture.md](docs/architecture.md) — how the pieces fit, and the
  rules each one keeps.
- [docs/operations.md](docs/operations.md) — Discord application, database,
  registration, deployment, secrets.
- [docs/issue-role.md](docs/issue-role.md) — the first feature's manual: the
  grant, `label`, and the bounds a run lives inside.
- [docs/features.md](docs/features.md) — how to add another feature, and what
  the candidates are.
