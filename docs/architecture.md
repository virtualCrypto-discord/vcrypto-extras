# How the pieces fit, and the rules each one keeps

## Why this is outside the core

virtualCrypto's core has invariants it does not trade away:

- **nothing is locked without an agreement that says so** — money moves out of
  a user's balance only into a contract that user approved;
- **a period is approved as a period** — a temporary contract cannot be
  withdrawn from while it runs, and neither side can end it early;
- **an application cannot change a contract or end it early** — what it wants
  differently, it asks for differently.

The consequence is that things people ask for ("renew me automatically",
"charge me monthly") have no small implementation in the core, and are not
supposed to. This repository is where the convenience answer lives: a program
that does the *asking* — proposes the next contract, nudges the subscriber,
watches the webhook — while the approval itself stays exactly where the core
put it.

## The three credentials

| | | |
| --- | --- | --- |
| **PAT** | operator's, made in Discord with `/pat create name:` | used once, by `scripts/register-application.ts`, and never stored in the worker. Scopes: `oauth2.register`, `vc.pay`, `vc.claim`. |
| **application token** | `client_credentials` at `POST /oauth2/token`, Basic auth with the client id and secret | what the worker sends on every call. Scopes asked for: `vc.contract` (contracts), `oauth2.register` (grant requests and self-management). A JWT, one hour. |
| **guild token** | the device flow: ask with `POST /oauth2/clients/@me/grant-requests`, a guild's administrator approves, poll `POST /oauth2/token` | the only credential that may issue from a guild's pool. Opaque and revocable — a row, not a JWT. |

The client caches application tokens in module scope (per isolate), keyed by
service + client + scope, and renews one minute before expiry; a `401` also
drops the cache and retries the request once, keeping its body and its
idempotency key. Registration asks for `grant_types: ["refresh_token"]`, which
is what makes a guild token renewable (`grant_type=refresh_token`) — the
rotating refresh token is worth more to a bot than to a one-shot CLI.

## The two doors

Both protocols sign the same way — Discord's, deliberately: Ed25519 over
`X-Signature-Timestamp <> body` concatenated as bytes, signature hex in
`X-Signature-Ed25519`. Both are implemented once, in `src/crypto.ts`.

**`POST /discord/interactions`** verifies with Discord's public key and adds
the window the core service keeps: a signed request is accepted for five
minutes, with thirty seconds of forward clock skew. PING (`type: 1`) is
answered before anything is built; `type: 2/3/4/5` are dispatched to the
features; anything else — and an unparsable body whose signature verified — is
answered `400 Type Not Found`, the core's own spelling.

**`POST /vc/webhook`** verifies with the application's public key (the
`public_key` registration answered with, lowercase hex). There is **no
timestamp window**, unlike Discord's side: a delivery is a push with no retry
behind it, and refusing a slow one would lose the only copy of a decision
rather than replay-protect anything. PING is answered `200 {"type": 1}`;
everything else is handed to the features, and unknown types pass through —
the delivery protocol says unknown types must be ignored, which is what makes
adding one a non-breaking change.

### The handshake, and why registration is two steps

At registration — and when a webhook URL is changed — the core sends **two**
PINGs: one signed with the application's real key, which must come back `200`,
and one signed with a keypair generated for the occasion, which must come back
`401`. Both fall out of this endpoint for free: verifying first and answering
second makes the first a `200` and the second a refusal, which is exactly what
the check is looking for.

That is also why `scripts/register-application.ts` is two steps. The handshake
needs the application's public key to be reachable **at the deployed worker**,
and the public key is produced *by* the registration itself — so the script
registers without a `webhook_url` first (a webhook-less registration skips the
handshake), prints the three values, and `--attach-webhook` adds the URL later,
once the worker is deployed and configured. The `PATCH` that attaches it runs
the handshake with the key the application already has.

Deliveries may arrive directly or through the core's own proxy (when it is
configured with one); either way they are a `POST` to `/vc/webhook` with the
same two signature headers, so the verifier never has to know which path was
taken.

## Money: contracts, and nothing else

The client can do exactly what an application may:

- **`createContract`** — name a unit, parties with amounts, optionally a
  receiver and a period (`expires_in`). Nothing is locked yet: this is a
  proposal, and each party approves it separately in the core bot's
  `/contract list` screen.
- **`contract` / `contractPayments`** — read the contract's own numbers
  (`remaining`, per-party `remaining`) and its statement, newest first. A full
  page (200 rows is the ceiling) means there is more, and `next` resumes.
- **`payContract`** — spend what the contract holds. The amount is the only
  thing the application decides; the scope (`vc.contract`) says it may ask,
  the parties' approvals are what let it spend.
- **`requestGuildGrant` / `pollGuildGrant` / `refreshGuildToken` /
  `issueFromPool`** — the guild side: the device-flow ask an administrator
  answers once, the token pair that answer produces (renewed from its rotating
  refresh token), and issuances from the pool. It is the machinery a feature
  uses when it distributes rather than moves a user's money.

Two habits are built into the client because the service expects them:

- **every charge carries an idempotency key, quoted.** `Idempotency-Key:
  "…"` — a key that is not a quoted string is refused before anything is
  charged. The key belongs to the *operation*, not the attempt: a contract id
  and a use number, so a retry after a lost answer reads the first answer
  instead of charging twice. The client retries `429`, and `409 processing`
  with a `Retry-After`, only inside a bound (ten seconds, three attempts); a
  wait longer than that is thrown as `VcApiError.retryAfterSeconds`, because a
  request-answering worker must not sit on a minute-long wait — that is a
  queue's job, and a feature that needs one should say so.
- **only `error` / `error_info` and the status are read.** The service
  documents `error_description` as out of scope, so nothing branches on it.

## State

Three things are kept, and all of them are small:

- **Application tokens** live in a module-scope cache per isolate. An isolate's
  cache is a cache; a few extra token calls are the cost, and correctness is
  nowhere's.
- **Guild grants** live in D1 (`migrations/0001_guild_grants.sql`,
  `src/vc/guild-grant.ts`). This was the first feature's need — a permission an
  administrator approves once has to outlive the request that asked for it —
  and its shape is the one to copy: one row per guild, overwritten in place,
  nothing that is a ledger, and the rotating refresh token written down when it
  rotates.
- **A run** lives in a Durable Object (`src/features/issue-role/run.ts`), one
  per invocation, with its progress and its alarm. This is where long work
  goes: a Worker answers within seconds and `waitUntil` buys it a few more, so
  anything longer than that — a distribution of any size, a wait for an
  approval, a rate limit to sit out — is a state machine with a clock, and a
  Durable Object is exactly that. One object per run is also the single writer
  for "who has been paid", which is what keeps two ticks of the same run from
  disagreeing.

A feature that needs its own rows chooses its own store (KV, D1, or a Durable
Object), and keeps the same rule: the money's source of truth stays inside
virtualCrypto, and the feature's rows must be reconstructible from the API, the
deliveries, and the clock.

## The map

| | |
| --- | --- |
| `src/index.ts` | the router (`/discord/interactions`, `/vc/webhook`, `/health`), the scheduled handler that polls pending guild grants, and the `IssueRun` export the runtime finds the run class through |
| `src/routes/` | the two doors: verify, parse, dispatch |
| `src/discord/` | Discord's signature verification, response builders, interaction types, and the bot REST client (DM, message, member list) |
| `src/vc/` | the virtualCrypto client, the guild-grant store and device flow, delivery verification, the wire types |
| `src/features/` | the `Feature` interface, the registry, the context each handler is handed (`env`, `vc`, `discord`, `waitUntil`) — and the features themselves: `issue-role/` (its command, its member scan, and `run.ts`, the Durable Object a run lives in) |
| `migrations/` | D1 migrations, applied per deployment, per local dev, and per test run |
| `scripts/` | one-shot operators' scripts, run by Node 24 (which runs the TypeScript directly) |
| `test/` | the suite: inside workerd, against scripted services and generated Ed25519 keys |
