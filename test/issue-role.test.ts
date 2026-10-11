import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandDefinition } from "../src/discord/commands.ts";
import type { Interaction } from "../src/discord/types.ts";
import { featureContext } from "../src/features/context.ts";
import { issueRole } from "../src/features/issue-role/index.ts";
import { testEnv } from "./env.ts";
import { type Reply, stubFetch } from "./stub-fetch.ts";

/**
 * The command's half of `/issue-role`: the refusals a person can fix by typing
 * again, the hand-over to the run's Durable Object, and the presses the
 * screens carry — the role select, the amount select and modal, 実行, and the
 * two buttons on a run in flight. What the run then does — progress, the
 * approval wait, the issuing — is `issue-run.test.ts`, driven by the object's
 * own alarms.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const CURRENCY = "GET /api/v2/currencies";
const ROLES = "GET /api/v10/guilds/900/roles";

/** The guild's currency, as the screens read it. */
function currency(): Reply {
  return {
    status: 200,
    body: {
      total_amount: "1000",
      name: null,
      unit: "nyan",
      guild: "900",
      pool_amount: "1000",
    },
  };
}

/** The guild's roles, as the amount select's labels read them. */
function roles(): Reply {
  return {
    status: 200,
    body: [
      { id: "700", name: "Member" },
      { id: "701", name: "Veteran" },
    ],
  };
}

function theCommand(): CommandDefinition {
  const command = issueRole.commands?.[0];
  if (command === undefined) {
    throw new Error("issue-role has no command");
  }
  return command;
}

function interaction(
  overrides: {
    id?: string;
    permissions?: string;
    roleId?: string | null;
    amount?: number | null;
  } = {},
): Interaction {
  const options: { name: string; type: number; value: string | number }[] = [];
  if (overrides.roleId !== null) {
    options.push({ name: "role", type: 8, value: overrides.roleId ?? "700" });
  }
  if (overrides.amount !== null) {
    options.push({ name: "amount", type: 4, value: overrides.amount ?? 10 });
  }
  return {
    id: overrides.id ?? "i-1",
    application_id: "1",
    type: 2,
    token: "interaction-token",
    guild_id: "900",
    member: { user: { id: "100" }, permissions: overrides.permissions ?? "8" },
    data: { name: "issue-role", options },
  };
}

/** A press of something on a screen. */
function press(
  customId: string,
  options: { userId?: string; values?: string[]; componentType?: number } = {},
): Interaction {
  return {
    id: "c-1",
    application_id: "1",
    type: 3,
    token: "component-token",
    guild_id: "900",
    member: { user: { id: options.userId ?? "100" } },
    data: {
      custom_id: customId,
      component_type: options.componentType ?? 2,
      ...(options.values === undefined ? {} : { values: options.values }),
    },
  };
}

/** A submission of the amount modal. */
function modalSubmit(
  customId: string,
  value: string,
  userId = "100",
): Interaction {
  return {
    id: "m-1",
    application_id: "1",
    type: 5,
    token: "modal-token",
    guild_id: "900",
    member: { user: { id: userId } },
    data: {
      custom_id: customId,
      components: [{ component: { custom_id: "amount", value } }],
    },
  };
}

async function handle(interactionValue: Interaction): Promise<Response> {
  return theCommand().handle(featureContext(testEnv()), interactionValue);
}

async function pressButton(
  customId: string,
  options: { userId?: string; values?: string[]; componentType?: number } = {},
): Promise<Response> {
  const handler = issueRole.handleComponent;
  if (handler === undefined) {
    throw new Error("issue-role has no component handler");
  }
  return handler(featureContext(testEnv()), press(customId, options), customId);
}

async function submitModal(
  customId: string,
  value: string,
  userId = "100",
): Promise<Response> {
  const handler = issueRole.handleModal;
  if (handler === undefined) {
    throw new Error("issue-role has no modal handler");
  }
  return handler(
    featureContext(testEnv()),
    modalSubmit(customId, value, userId),
    customId,
  );
}

async function storedRun(runId: string): Promise<unknown> {
  return runInDurableObject(
    testEnv().ISSUE_RUNS.getByName(runId),
    (_instance, state) => state.storage.get("run"),
  );
}

describe("the issue-role command", () => {
  it("refuses someone who is not an administrator, without asking anything", async () => {
    const service = stubFetch({});

    const response = await handle(interaction({ permissions: "0" }));
    const body = (await response.json()) as {
      type: number;
      data: { content: string };
    };

    expect(body.type).toBe(4);
    expect(body.data.content).toContain("管理者権限");
    expect(service.calls).toHaveLength(0);
  });

  it("refuses `@everyone`, which cannot be counted", async () => {
    const service = stubFetch({});

    const response = await handle(interaction({ roleId: "900" }));
    const body = (await response.json()) as { data: { content: string } };

    expect(body.data.content).toContain("@everyone");
    expect(service.calls).toHaveLength(0);
  });

  it("opens an empty settings screen when the command has no options", async () => {
    const service = stubFetch({});

    const response = await handle(
      interaction({ id: "i-empty", roleId: null, amount: null }),
    );

    expect(((await response.json()) as { type: number }).type).toBe(5);
    expect(service.calls).toHaveLength(0);
    expect(await storedRun("i-empty")).toMatchObject({
      runId: "i-empty",
      guildId: "900",
      roleIds: [],
      amounts: {},
      defaultAmount: 0,
      phase: "settings",
      outcome: "running",
    });
  });

  it("pre-fills the settings screen from the options", async () => {
    stubFetch({});

    await handle(interaction({ id: "i-prefilled", roleId: "700", amount: 25 }));

    expect(await storedRun("i-prefilled")).toMatchObject({
      roleIds: ["700"],
      amounts: { "700": 25 },
      defaultAmount: 25,
      phase: "settings",
    });
  });

  it("shows the settings screen through 更新, with the pool re-read", async () => {
    const service = stubFetch({ [CURRENCY]: currency(), [ROLES]: roles() });
    await handle(interaction({ id: "i-panel", roleId: null, amount: null }));

    const response = await pressButton("issue-role:refresh:i-panel");
    const body = (await response.json()) as {
      type: number;
      data: { content: string; components: unknown[] };
    };

    expect(body.type).toBe(7);
    expect(body.data.content).toContain("ロールへの一斉発行");
    expect(body.data.content).toContain("プール: 1000");
    // The role select and the button row — no amount select, because no role
    // is chosen yet.
    expect(body.data.components).toHaveLength(2);
    // The press refreshed what it shows: the pool and the role names.
    expect(service.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      CURRENCY,
      ROLES,
    ]);
  });

  it("takes the roles from the picker", async () => {
    stubFetch({ [CURRENCY]: currency(), [ROLES]: roles() });
    await handle(interaction({ id: "i-roles", roleId: null, amount: null }));

    const response = await pressButton("issue-role:roles:i-roles", {
      componentType: 6,
      values: ["701", "702", "701"],
    });
    const body = (await response.json()) as {
      type: number;
      data: { content: string; components: unknown[] };
    };

    expect(body.type).toBe(7);
    expect(body.data.content).toContain("<@&701>");
    expect(body.data.content).toContain("<@&702>");
    // The roles row, the amount select, and the buttons.
    expect(body.data.components).toHaveLength(3);
    // The amount select calls a role by its name, not its id.
    const amountSelect = (
      body.data.components[1] as {
        components: { options: { label: string; value: string }[] }[];
      }
    ).components[0];
    expect(amountSelect?.options[0]).toMatchObject({
      label: "Veteran",
      value: "701",
      description: "未設定",
    });

    expect(await storedRun("i-roles")).toMatchObject({
      roleIds: ["701", "702"],
    });
  });

  it("opens the amount modal for a role, and takes the amount it submits", async () => {
    stubFetch({ [CURRENCY]: currency(), [ROLES]: roles() });
    await handle(interaction({ id: "i-amount" }));

    const modal = await pressButton("issue-role:amount:i-amount", {
      componentType: 3,
      values: ["700"],
    });
    const modalBody = (await modal.json()) as {
      type: number;
      data: { custom_id: string; components: { label?: string }[] };
    };
    expect(modalBody.type).toBe(9);
    // The modal carries the role it is about.
    expect(modalBody.data.custom_id).toBe("issue-role:amount:i-amount:700");
    expect(modalBody.data.components[0]?.label).toBe("Member");

    const response = await submitModal("issue-role:amount:i-amount:700", "25");
    const body = (await response.json()) as { type: number };
    expect(body.type).toBe(7);
    expect(await storedRun("i-amount")).toMatchObject({
      amounts: { "700": 25 },
    });
  });

  it("refuses an amount for a role that is not selected", async () => {
    stubFetch({ [CURRENCY]: currency(), [ROLES]: roles() });
    await handle(interaction({ id: "i-wrong-role" }));

    const response = await submitModal(
      "issue-role:amount:i-wrong-role:999",
      "5",
    );
    const body = (await response.json()) as {
      type: number;
      data: { content: string };
    };

    expect(body.type).toBe(4);
    expect(body.data.content).toContain("選ばれていません");
  });

  it("refuses an amount that is not a whole positive number", async () => {
    stubFetch({ [CURRENCY]: currency(), [ROLES]: roles() });
    await handle(interaction({ id: "i-bad-amount" }));

    const response = await submitModal(
      "issue-role:amount:i-bad-amount:700",
      "abc",
    );
    const body = (await response.json()) as {
      type: number;
      data: { content: string };
    };

    expect(body.type).toBe(4);
    expect(body.data.content).toContain("金額");
    expect(await storedRun("i-bad-amount")).toMatchObject({
      amounts: { "700": 10 },
    });
  });

  it("refuses 実行 until the roles and the amount are there", async () => {
    stubFetch({});
    await handle(interaction({ id: "i-unset", roleId: null, amount: null }));

    const response = await pressButton("issue-role:run:i-unset");
    const body = (await response.json()) as {
      type: number;
      data: { content: string };
    };

    expect(body.type).toBe(4);
    expect(body.data.content).toContain("先にロール");
  });

  it("starts the run when 実行 is pressed", async () => {
    stubFetch({});
    await handle(interaction({ id: "i-run" }));

    const response = await pressButton("issue-role:run:i-run");
    const body = (await response.json()) as {
      type: number;
      data: { content: string };
    };

    expect(body.type).toBe(7);
    expect(body.data.content).toContain("集計しています");
    expect(await storedRun("i-run")).toMatchObject({ phase: "scan" });
  });

  it("refuses a press from anyone but the person who started the run", async () => {
    stubFetch({});
    await handle(interaction({ id: "i-stranger", roleId: null, amount: null }));

    const response = await pressButton("issue-role:refresh:i-stranger", {
      userId: "999",
    });
    const body = (await response.json()) as {
      type: number;
      data: { content: string };
    };

    expect(body.type).toBe(4);
    expect(body.data.content).toContain("実行した人だけ");
  });

  it("refuses a custom_id that is not one of its controls", async () => {
    stubFetch({});

    const response = await pressButton("issue-role:explode:i-1");

    expect(response.status).toBe(400);
  });
});
