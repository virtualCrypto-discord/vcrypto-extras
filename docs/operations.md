# Operations: Discord application, deployment, registration

Node 24, a Cloudflare account, and — for the registration step — a virtualCrypto
account that may run the core bot's `/pat create` (the operator's own is fine).

## 1. The Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications),
create an application and turn it into a bot. Three values come from here:

| From | Where it goes |
| --- | --- |
| **Application ID** (General Information) | `DISCORD_APPLICATION_ID` — a var in `wrangler.jsonc` |
| **Public Key** (General Information) | `DISCORD_PUBLIC_KEY` — a var |
| **Bot token** (Bot → Reset Token) | `DISCORD_BOT_TOKEN` — a secret |

A Discord application is also created with **Interaction Endpoint URL** empty,
which is where the worker's first URL goes once it is deployed:

```
https://<worker host>/discord/interactions
```

Discord PINGs that URL when it is saved — twice: first with a signature it
knows is wrong, where a 401 is the pass, and then for real, where a 200 is. A
save that sticks therefore means the worker is answering Discord. (`wrangler
tail` shows both.)

Invite the bot where it should work — `applications.commands` is the scope
commands need, and a bot the features DM needs no guild at all.

**SERVER MEMBERS INTENT** (Bot → Privileged Gateway Intents) should be on: it
is what lets `/issue-role` read a guild's member list, and Discord refuses the
read without it. A guild where the bot is not a member is refused the same way
— the invite is the other half.

## 2. Configure and deploy

The public values live in `wrangler.jsonc`'s `vars`; the two secrets are
`wrangler secret put`, and the database is one D1 below them:

```sh
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put VCRYPTO_CLIENT_SECRET      # after step 3

# the database: once, and again whenever a migration is added
wrangler d1 create vcrypto-extras              # paste the id it answers with into wrangler.jsonc
wrangler d1 migrations apply vcrypto-extras --remote

wrangler deploy
```

The Cron Trigger in `wrangler.jsonc` deploys with the worker; it is what picks
up guild grants an administrator has approved (`docs/issue-role.md`). Local
`wrangler dev` uses a database of its own — give it the schema with `wrangler
d1 migrations apply vcrypto-extras --local`.

`npm run build` is the same build as a dry run (`wrangler deploy --dry-run`) —
what CI runs. This `wrangler deploy` is the **first** one; after it, a deploy
is a release, and a tag is what starts one — see [Releases](#releases).

## 3. Register with virtualCrypto

Registration is two steps, because the handshake a webhook URL triggers needs
this application's public key to already be deployed — and the public key is
what registration produces (the whole reason is in
[architecture.md](architecture.md#the-handshake-and-why-registration-is-two-steps)).

**Make a PAT, in Discord**, with the core bot:

```
/pat create name:vcrypto-extras
```

It is shown once, and it is what the next command authenticates with. The PAT
never goes near the worker.

### 3a. Register, without a webhook

```sh
VC_PAT=<the token> VCRYPTO_BASE_URL=https://<the service> \
  node scripts/register-application.ts
```

It registers the application and prints the three values. (`--dry-run` prints
the body instead of sending it.) **The scripts read `.env` when there is
one** — which `.gitignore` holds — so `VC_PAT` and the service's address can
live there instead of on the command line. Put the answers in place:

- `wrangler.jsonc`: `VCRYPTO_CLIENT_ID`, `VCRYPTO_PUBLIC_KEY`
- `wrangler secret put VCRYPTO_CLIENT_SECRET`

and deploy:

```sh
wrangler deploy
```

### 3b. Attach the webhook — this is where the handshake runs

```sh
VCRYPTO_BASE_URL=https://<the service> \
VCRYPTO_CLIENT_ID=<the client id> \
VCRYPTO_CLIENT_SECRET=<the secret> \
  node scripts/register-application.ts --attach-webhook \
  --webhook-url https://<worker host>/vc/webhook
```

This PATCHes the webhook URL in, and the service verifies it in the same
request. A success means the two PINGs passed; a refusal says whose failure it
was:

- `webhook_verification_failed` — the URL answered wrongly, or did not answer:
  check that the worker is deployed at that URL with the right
  `VCRYPTO_PUBLIC_KEY`, and that nothing in front of it rewrites the body.
- `server_error` — the service could not reach its own delivery proxy. Not
  this application's problem; try again later.

The handshake is rate-limited per application (once per 3 seconds, 20 per hour,
50 per day), so a retry storm answers `rate_limit_exceeded` with a
`Retry-After`.

Re-running the same command is also how the webhook is **moved**: a PATCH whose
URL differs from the stored one runs the handshake again, with the key the
application already has.

## 4. Register the commands

```sh
DISCORD_BOT_TOKEN=<token> DISCORD_APPLICATION_ID=<id> \
  node scripts/register-commands.ts            # global — Discord may take an hour
DISCORD_BOT_TOKEN=<token> DISCORD_APPLICATION_ID=<id> \
  node scripts/register-commands.ts --guild <guild id>   # that guild, immediately
```

A bulk overwrite: what the tree defines is what Discord ends up with. Run it
again after adding a feature's commands.

## Releases

A deploy is a **tag**: pushing `v*` starts
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which runs
the gates (`npm run check`), applies the D1 migrations, deploys the worker, and
registers the commands with Discord — a bulk overwrite, so what Discord ends up
with is what the tag defines. `git tag v0.1.0 && git push origin v0.1.0` is a
release; `workflow_dispatch` is the same run by hand.

It needs three repository secrets and one variable:

| Where | What |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` (secret) | a Cloudflare API token that may edit Workers and D1 — the "Edit Cloudflare Workers" template is the one |
| `CLOUDFLARE_ACCOUNT_ID` (secret) | the account the worker and its database live in |
| `DISCORD_BOT_TOKEN` (secret) | the bot token; the same value step 2 holds as the worker's own secret |
| `DISCORD_APPLICATION_ID` (variable) | the application id — public, it is in every command's answer |

The worker's own secrets are **not** the release's to set: `wrangler secret
put` is a one-time move (step 2), and a release that rewrote a secret from a
GitHub value that had gone missing would take the running worker down with it.

The first release on a fresh account fails at the migrations step until
`wrangler d1 create vcrypto-extras` has happened and the id it answers with is
in `wrangler.jsonc` — that is the honest place for it to fail.

## Local development

`.dev.vars` (git-ignored; copy `.dev.vars.example`) carries local values —
a development Discord application's keys, and either the staging service or a
local one. `npm run dev` starts `wrangler dev` on `http://localhost:8787`;
Discord needs a public https URL, which a tunnel provides:

```sh
cloudflared tunnel --url http://localhost:8787
```

Point the development Discord application's Interaction Endpoint URL at the
tunnel, and register that application as its own virtualCrypto application
(step 3) so its webhook is the tunnel too. Two environments should be two
registrations and two configurations; nothing is shared.

## Rotating and checking

- **Bot token**: reset it in the portal, then `wrangler secret put
  DISCORD_BOT_TOKEN` and deploy.
- **Client secret**: the core bot's application screens (`/application`) can
  rotate it (`client_secret: true` in a PATCH); afterwards update
  `VCRYPTO_CLIENT_SECRET` and deploy. The old secret stops authenticating
  immediately.
- **Whether the webhook is alive**: the service re-checks every webhook about
  once a week and records it. `GET /oauth2/clients/@me` answers
  `webhook_verified_at` / `webhook_failed_at`; `null` means "not checked since
  registration", which is every application until the job first reaches it. A
  failing webhook is *recorded, not disabled* — deliveries keep coming, which
  is why a feature's handler must treat a delivery it cannot use as something
  to log rather than to assume away.
