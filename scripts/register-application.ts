/**
 * Register this bot as a virtualCrypto application — run once, by hand, from a
 * checkout. The worker never does this: registration needs a **personal access
 * token**, which is the operator's and not the application's, so the PAT passes
 * through this process and nothing else.
 *
 * The registration is deliberately two steps, because the handshake a
 * `webhook_url` triggers cannot pass before the worker is deployed: the PING
 * the service sends is signed with a key the application is only told about
 * **by** the registration. So `register-application` registers without a
 * webhook (a webhook-less registration skips the handshake), and
 * `--attach-webhook` attaches it afterwards, once the deployed worker knows its
 * public key — which is also how a webhook is later moved or replaced.
 *
 * Values come from the environment or from `.env` (which `.gitignore` holds):
 *
 *   # 1. once — the PAT is made in Discord with the core bot's `/pat create name:`
 *   VC_PAT=… VCRYPTO_BASE_URL=… node scripts/register-application.ts
 *   #    → prints client_id, client_secret and public_key; set them (see README) and deploy
 *
 *   # 2. after `wrangler deploy`
 *   VCRYPTO_BASE_URL=… VCRYPTO_CLIENT_ID=… VCRYPTO_CLIENT_SECRET=… \
 *     node scripts/register-application.ts --attach-webhook \
 *     --webhook-url https://<worker>/vc/webhook
 *
 * `--dry-run` prints the registration body instead of sending it.
 */

import { loadEnvFile } from "./load-env.ts";

loadEnvFile();

const baseUrl = requireEnv("VCRYPTO_BASE_URL").replace(/\/+$/, "");
const attachWebhook = process.argv.includes("--attach-webhook");
const dryRun = process.argv.includes("--dry-run");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(
      `missing ${name} — see the comment at the top of this script`,
    );
    process.exit(1);
  }
  return value;
}

function flag(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

async function refusal(response: Response): Promise<never> {
  const body = await response.text();
  console.error(`virtualCrypto answered ${response.status}: ${body}`);
  process.exit(1);
}

/** The registration body: what this application is and what it wants delivered. */
function registrationBody(webhookUrl: string | null): Record<string, unknown> {
  return {
    client_name: process.env.CLIENT_NAME ?? "vcrypto-extras",
    ...(process.env.CLIENT_URI ? { client_uri: process.env.CLIENT_URI } : {}),
    application_type: "web",
    // No browser flow: this application never receives an authorization code.
    redirect_uris: [],
    // Rotating refresh tokens are worth having for the device flow's guild
    // tokens, which is what a role or grant run renews.
    grant_types: ["refresh_token"],
    // 2 a claim update, 3 a grant decision, 4 a contract decision — the set is
    // explicit so a later type is a decision rather than a surprise.
    subscribed_events: [2, 3, 4],
    ...(webhookUrl === null ? {} : { webhook_url: webhookUrl }),
  };
}

/** Register the application (no webhook yet) and read back the public key. */
async function register(): Promise<void> {
  const body = registrationBody(null);

  if (dryRun) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const pat = requireEnv("VC_PAT");
  const response = await fetch(`${baseUrl}/oauth2/clients`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) await refusal(response);

  const created = (await response.json()) as {
    client_id: string;
    client_secret: string;
    registration_access_token: string;
  };

  // The public key is not in the registration's own answer — it is read back
  // with the registration token, the way RFC 7592 says a client reads itself.
  const me = await fetch(`${baseUrl}/oauth2/clients/@me`, {
    headers: {
      authorization: `Bearer ${created.registration_access_token}`,
      accept: "application/json",
    },
  });
  if (!me.ok) await refusal(me);
  const application = (await me.json()) as { public_key: string };

  console.log(`
Registered "${process.env.CLIENT_NAME ?? "vcrypto-extras"}" as an application.

  VCRYPTO_CLIENT_ID     ${created.client_id}
  VCRYPTO_PUBLIC_KEY    ${application.public_key}
  VCRYPTO_CLIENT_SECRET ${created.client_secret}

No webhook was registered, deliberately: the handshake a webhook_url triggers
needs this application's public key to already be deployed. Next:

  1. put them in place —
       (wrangler.jsonc) "VCRYPTO_CLIENT_ID": "${created.client_id}"
       (wrangler.jsonc) "VCRYPTO_PUBLIC_KEY": "${application.public_key}"
       wrangler secret put VCRYPTO_CLIENT_SECRET     # paste the secret above
  2. wrangler deploy
  3. attach the webhook, and let the handshake run against the deployed worker —
       VCRYPTO_BASE_URL=${baseUrl} \\
       VCRYPTO_CLIENT_ID=${created.client_id} \\
       VCRYPTO_CLIENT_SECRET=<the secret above> \\
         node scripts/register-application.ts --attach-webhook \\
         --webhook-url https://<the worker's host>/vc/webhook
`);
}

/** Mint an application token and PATCH the webhook in — which is what runs the handshake. */
async function attach(): Promise<void> {
  const webhookUrl = flag("--webhook-url") ?? process.env.WEBHOOK_URL ?? null;
  if (webhookUrl === null) {
    console.error("--attach-webhook needs --webhook-url or WEBHOOK_URL");
    process.exit(1);
  }

  const body = { webhook_url: webhookUrl };

  if (dryRun) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const clientId = requireEnv("VCRYPTO_CLIENT_ID");
  const clientSecret = requireEnv("VCRYPTO_CLIENT_SECRET");
  const token = await fetch(`${baseUrl}/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "oauth2.register",
    }).toString(),
  });
  if (!token.ok) await refusal(token);
  const { access_token } = (await token.json()) as { access_token: string };

  const patched = await fetch(`${baseUrl}/oauth2/clients/@me`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${access_token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!patched.ok) await refusal(patched);

  console.log(`the webhook is attached and verified: ${webhookUrl}`);
}

if (attachWebhook) {
  await attach();
} else {
  await register();
}
