import { sleep } from "../sleep.ts";

/**
 * The bot's own REST calls — what a feature needs beyond answering an
 * interaction: reaching a user it is not talking to (a DM), and the follow-up
 * to a deferred one.
 *
 * The token is a secret and the calls are few, so this is deliberately small:
 * the two calls the features in this repository's line of work need, with
 * Discord's `429` waited out the same bounded way the virtualCrypto client
 * waits out its own.
 */

const API = "https://discord.com/api/v10";
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 5_000;

export class DiscordError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Discord answered ${status}: ${body}`);
    this.name = "DiscordError";
    this.status = status;
    this.body = body;
  }
}

export class DiscordRest {
  private readonly botToken: string;

  constructor(botToken: string) {
    this.botToken = botToken;
  }

  /** Open (or find) the DM channel with a user, which is where a bot may message them. */
  async createDm(recipientId: string): Promise<{ id: string }> {
    return (await this.call("POST", "/users/@me/channels", {
      recipient_id: recipientId,
    })) as { id: string };
  }

  /** Send a message a feature initiates — a reminder, a notice — rather than one it answers. */
  async sendMessage(
    channelId: string,
    message: { content?: string; embeds?: unknown[]; components?: unknown[] },
  ): Promise<unknown> {
    return this.call("POST", `/channels/${channelId}/messages`, message);
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.botToken}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        const wait = await retryAfterMs(response);
        if (wait !== null && wait <= MAX_WAIT_MS) {
          await sleep(wait);
          continue;
        }
      }

      if (!response.ok) {
        throw new DiscordError(response.status, await response.text());
      }

      return response.status === 204 ? null : response.json();
    }
  }
}

/** Discord's `429` body carries `retry_after` in seconds, as a float. */
async function retryAfterMs(response: Response): Promise<number | null> {
  try {
    const body = (await response.json()) as { retry_after?: unknown };
    if (
      typeof body.retry_after !== "number" ||
      !Number.isFinite(body.retry_after)
    ) {
      return null;
    }
    return Math.ceil(body.retry_after * 1000);
  } catch {
    return null;
  }
}
