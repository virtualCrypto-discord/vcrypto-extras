import {
  deferred,
  openModal,
  reply,
  typeNotFound,
  updateMessage,
} from "../../discord/responses.ts";
import {
  type Interaction,
  integerOption,
  interactionUser,
  isAdministrator,
  modalValue,
  stringOption,
} from "../../discord/types.ts";
import type { FeatureContext } from "../context.ts";
import type { Feature } from "../feature.ts";
import type { IssueRunStart } from "./run.ts";

/**
 * `/issue-role` — the guild's pool pays everyone who carries a role.
 *
 * The core bot's `/issue` pays one user at a time, by an administrator's
 * hand; this pays a role at once — or several, as the union, because a member
 * holding three of them is one person — which is the shape a guild actually
 * wants for rewards, event payouts and distributions. What it must not be is a
 * way around the core's answers, and it is not: the money is the guild's pool,
 * the administrator of the guild gives the permission once (the device flow's
 * grant, approved with the core bot's `/grant approve`), and each issuance is
 * an ordinary `POST /api/v2/currencies/issue` that the core applies its own
 * checks to.
 *
 * The command refuses only what a person can fix by typing again, and hands
 * the run to its own Durable Object (`run.ts`) — where the **settings screen**
 * lives (the roles and an amount per role, 実行), where the progress screen
 * then lives, and where the run continues by itself: through rate limits,
 * through the wait for an approval, and past any single invocation. Nothing
 * asks to be named: the run has its own id, and the screen's buttons are the
 * whole of the interaction a person needs with it after starting it.
 *
 * - `role` and `amount` are **pre-fills**: given, the settings screen opens
 *   with them — the amount as the starting amount of the roles the command
 *   named, and the default for ones picked later; omitted, it opens empty.
 * - **更新** answers with the run's state as it is now; **再開** asks the same
 *   run to go on, from a stop or a wait — under its own keys, so members
 *   already paid are only answered again.
 * - The **amount flow** is two interactions: the select that names the role
 *   (`issue-role:amount:<runId>` with the role as its value) asks the run for
 *   the modal, and the modal's submission carries the role in its own
 *   `custom_id` (`…:<runId>:<roleId>`) — which is why the parse keeps the
 *   fourth part. The field it builds is read back by the id `run.ts` and this
 *   file share (`AMOUNT_FIELD` there).
 */

export const issueRole: Feature = {
  name: "issue-role",
  commands: [
    {
      name: "issue-role",
      description:
        "ロールに一斉発行します。画面でロール（複数可）と金額を決めて実行します。管理者権限が必要です。",
      options: [
        {
          type: 8,
          name: "role",
          description: "発行先のロールです（初期値。画面でも選べます）。",
          required: false,
        },
        {
          type: 4,
          name: "amount",
          description:
            "各ロールの初期金額です（画面でロールごとに調整できます）。",
          required: false,
          min_value: 1,
        },
      ],
      handle: handleIssueRole,
    },
  ],
  handleComponent: handleIssueRoleComponent,
  handleModal: handleIssueRoleModal,
};

async function handleIssueRole(
  context: FeatureContext,
  interaction: Interaction,
): Promise<Response> {
  // The cheap refusals answer directly — nothing is deferred that a user can
  // fix by typing again.
  const guildId = interaction.guild_id;
  if (guildId === undefined || interaction.member === undefined) {
    return reply("このコマンドはサーバー内で実行してください。", {
      ephemeral: true,
    });
  }
  if (!isAdministrator(interaction)) {
    return reply("このコマンドには管理者権限が必要です。", { ephemeral: true });
  }

  const options = interaction.data?.options;
  const roleId = stringOption(options, "role");
  const amount = integerOption(options, "amount");

  if (amount !== null && amount <= 0) {
    return reply("`amount` は 1 以上にしてください。", { ephemeral: true });
  }
  if (roleId === guildId) {
    // `@everyone`'s role id is the guild's own id, and Discord never lists it
    // in a member's `roles` — so the scan would find nobody, and this is the
    // real answer rather than an empty list.
    return reply("`@everyone` には発行できません。ロールを指定してください。", {
      ephemeral: true,
    });
  }

  // One run, one Durable Object, named by the interaction — which is unique per
  // invocation, so a replayed interaction finds the run it already started, and
  // running the command again deliberately is a new distribution. The run's own
  // id is what its issuances are keyed by (`run.ts`).
  const start: IssueRunStart = {
    runId: interaction.id,
    guildId,
    roleIds: roleId === null ? [] : [roleId],
    amount: amount ?? 0,
    applicationId: interaction.application_id,
    interactionToken: interaction.token,
    invokerId: interactionUser(interaction)?.id ?? "",
  };

  try {
    const started = await context.env.ISSUE_RUNS.getByName(
      interaction.id,
    ).fetch("https://issue-run/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(start),
    });
    if (!started.ok) {
      throw new Error(`the run refused to start (${started.status})`);
    }
  } catch (error) {
    console.error("issue-role could not start a run", error);
    return reply("実行を開始できませんでした。もう一度試してください。", {
      ephemeral: true,
    });
  }

  return deferred({ ephemeral: true });
}

/**
 * A press of something on the screen: the role select, the amount button, 実行,
 * or the two buttons a running run carries. The run answers with the screen to
 * show — or with the modal to open — and this turns that into the interaction
 * callback.
 */
async function handleIssueRoleComponent(
  context: FeatureContext,
  interaction: Interaction,
  customId: string,
): Promise<Response> {
  const parsed = parseCustomId(customId);
  if (parsed === null) {
    return typeNotFound();
  }

  // `amount` is the select that names the role whose amount is being set — it
  // opens the modal, and the modal's own submission arrives as a different
  // interaction type, which `handleIssueRoleModal` is where that one lands.
  const endpoint =
    parsed.action === "refresh"
      ? "status"
      : parsed.action === "amount"
        ? "amount-modal"
        : parsed.action;
  const answer = await askRun(context, parsed.runId, endpoint, {
    presserId: interactionUser(interaction)?.id ?? "",
    token: interaction.token,
    ...(parsed.action === "roles"
      ? { values: interaction.data?.values ?? [] }
      : {}),
    ...(parsed.action === "amount"
      ? { roleId: interaction.data?.values?.[0] ?? "" }
      : {}),
  });
  return render(answer);
}

/**
 * The amount modal's submission. The field is the one `run.ts` builds; the
 * value goes back to the run, which is where the number means something.
 */
async function handleIssueRoleModal(
  context: FeatureContext,
  interaction: Interaction,
  customId: string,
): Promise<Response> {
  const parsed = parseCustomId(customId);
  if (parsed === null || parsed.action !== "amount") {
    return typeNotFound();
  }

  const answer = await askRun(context, parsed.runId, "amount", {
    presserId: interactionUser(interaction)?.id ?? "",
    token: interaction.token,
    roleId: parsed.roleId ?? "",
    value: modalValue(interaction.data, "amount") ?? "",
  });
  return render(answer);
}

/**
 * The custom ids this feature answers, in one place:
 * `issue-role:<action>:<runId>` — and for the amount modal, one more part,
 * the role it is about.
 */
function parseCustomId(
  customId: string,
): { action: string; runId: string; roleId?: string } | null {
  const [namespace, action, runId, roleId] = customId.split(":");
  if (
    namespace !== "issue-role" ||
    action === undefined ||
    runId === undefined
  ) {
    return null;
  }
  const known = ["refresh", "resume", "roles", "amount", "run"];
  if (!known.includes(action)) {
    return null;
  }
  return {
    action,
    runId,
    ...(roleId === undefined ? {} : { roleId }),
  };
}

interface RunAnswer {
  ok: boolean;
  content?: string;
  components?: unknown[];
  modal?: unknown;
  reason?: string;
}

async function askRun(
  context: FeatureContext,
  runId: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<RunAnswer | null> {
  try {
    const response = await context.env.ISSUE_RUNS.getByName(runId).fetch(
      `https://issue-run/${endpoint}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(`the run answered ${response.status}`);
    }
    return (await response.json()) as RunAnswer;
  } catch (error) {
    console.error("issue-role could not reach its run", error);
    return null;
  }
}

function render(answer: RunAnswer | null): Response {
  if (answer === null) {
    return reply("実行の状態を読めませんでした。もう一度押してみてください。", {
      ephemeral: true,
    });
  }
  if (!answer.ok) {
    return reply(answer.reason ?? "このボタンは押せません。", {
      ephemeral: true,
    });
  }
  if (answer.modal !== undefined) {
    return openModal(answer.modal);
  }
  return updateMessage(answer.content ?? "", {
    components: answer.components ?? [],
  });
}
