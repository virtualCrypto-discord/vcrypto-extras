import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testEnv } from "./env.ts";
import { clearGrants, seedGrant } from "./grants.ts";
import { type Call, type Reply, stubFetch } from "./stub-fetch.ts";

/**
 * One `/issue-role` run, driven by the Durable Object's own alarms: the
 * settings screen that opens it (roles and an amount per role), the pressing
 * of 実行, the progress screen and its buttons, the approval wait, the rate
 * limit that is waited out, and the report — none of it needing a person to
 * re-run anything.
 *
 * `runDurableObjectAlarm` fires an alarm immediately whatever time it was set
 * for, which is what makes a test of "wait 61 seconds and continue" instant.
 */

beforeEach(async () => {
  await clearGrants();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CURRENCY = "GET /api/v2/currencies";
const GUILD = "GET /api/v10/guilds/900";
const ROLES = "GET /api/v10/guilds/900/roles";
const MEMBERS = "GET /api/v10/guilds/900/members";
const ISSUE = "POST /api/v2/currencies/issue";
const EDIT = "PATCH /api/v10/webhooks/1/interaction-token/messages/@original";
const TOKEN = "POST /oauth2/token";
const ASK = "POST /oauth2/clients/@me/grant-requests";
const DM = "POST /api/v10/users/@me/channels";
const DM_MESSAGE = "POST /api/v10/channels/dm-1/messages";

/**
 * Start a run whose id is its name, so the buttons' custom_ids are
 * predictable. The settings are pre-filled unless a test says otherwise —
 * pressing 実行 is `begin`.
 */
async function start(
  runId: string,
  overrides: { roleIds?: string[]; amount?: number } = {},
): Promise<DurableObjectStub> {
  const stub = testEnv().ISSUE_RUNS.getByName(runId);
  const response = await stub.fetch("https://issue-run/start", {
    method: "POST",
    body: JSON.stringify({
      runId,
      guildId: "900",
      roleIds: overrides.roleIds ?? ["700"],
      amount: overrides.amount ?? 10,
      applicationId: "1",
      interactionToken: "interaction-token",
      invokerId: "100",
    }),
  });
  expect(response.status).toBe(200);
  return stub;
}

/** Press 実行 and expect it to have been taken. */
async function begin(stub: DurableObjectStub): Promise<void> {
  const answer = await press(stub, "run");
  expect(answer.ok).toBe(true);
}

/** Run alarms until the run stops scheduling them. */
async function drive(stub: DurableObjectStub, max = 80): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (!(await runDurableObjectAlarm(stub))) return;
  }
  throw new Error("the run never stopped scheduling alarms");
}

/** A press of something on the screen, as the worker would deliver it. */
async function press(
  stub: DurableObjectStub,
  action: string,
  body: Record<string, unknown> = {},
): Promise<{
  ok: boolean;
  content?: string;
  components?: unknown[];
  modal?: {
    custom_id?: string;
    components?: { component?: { custom_id?: string } }[];
  };
  reason?: string;
}> {
  const response = await stub.fetch(`https://issue-run/${action}`, {
    method: "POST",
    body: JSON.stringify({ presserId: "100", ...body }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    ok: boolean;
    content?: string;
    components?: unknown[];
    modal?: {
      custom_id?: string;
      components?: { component?: { custom_id?: string } }[];
    };
    reason?: string;
  };
}

/** Every edit the run made to its own message, parsed. */
function editBodies(
  calls: Call[],
): { content: string; components?: unknown[] }[] {
  return calls
    .filter(
      (call) =>
        call.method === "PATCH" && call.path.endsWith("/messages/@original"),
    )
    .map((call) => {
      const body = JSON.parse(call.body ?? "{}") as {
        content?: string;
        components?: unknown[];
      };
      return { content: body.content ?? "", components: body.components };
    });
}

function edits(calls: Call[]): string[] {
  return editBodies(calls).map((body) => body.content);
}

function issueCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.path === "/api/v2/currencies/issue");
}

function paidAmounts(calls: Call[]): string[] {
  return issueCalls(calls).map(
    (call) =>
      (JSON.parse(call.body ?? "{}") as { amount?: string }).amount ?? "",
  );
}

function currency(pool: string): Reply {
  return {
    status: 200,
    body: {
      total_amount: "1000",
      name: null,
      unit: "nyan",
      guild: "900",
      pool_amount: pool,
    },
  };
}

/** The guild's roles, as the amount select's labels read them. */
const roles: Reply = {
  status: 200,
  body: [
    { id: "700", name: "Member" },
    { id: "701", name: "Veteran" },
    { id: "702", name: "Guest" },
  ],
};

function member(id: string, memberRoles: string[]): unknown {
  return { user: { id }, roles: memberRoles };
}

const edited: Reply = { status: 200, body: {} };
const appToken: Reply = {
  status: 200,
  body: { access_token: "app-token", token_type: "Bearer", expires_in: 3600 },
};
const pending: Reply = {
  status: 400,
  body: { error: "authorization_pending" },
};

async function seedLiveGrant(): Promise<void> {
  await seedGrant({
    guildId: "900",
    accessToken: "guild-token",
    accessExpiresAt: Date.now() + 3_600_000,
    refreshToken: "refresh-1",
  });
}

describe("the settings screen", () => {
  it("comes up from the first tick, with 実行 disabled until it is set", async () => {
    const service = stubFetch({
      [CURRENCY]: currency("1000"),
      [ROLES]: roles,
      [EDIT]: edited,
    });

    const stub = await start("settings-1", { roleIds: [], amount: 0 });
    await drive(stub);

    const screen = editBodies(service.calls).at(-1);
    expect(screen?.content).toContain("ロールへの一斉発行");
    expect(screen?.content).toContain("ロール: （未選択）");

    const rows = screen?.components as {
      type: number;
      components: { type: number; custom_id?: string; disabled?: boolean }[];
    }[];
    // The role select and the button row — no amount select, because no role
    // is chosen yet.
    expect(rows).toHaveLength(2);
    const select = rows[0]?.components[0];
    expect(select?.type).toBe(6);
    expect(select?.custom_id).toBe("issue-role:roles:settings-1");
    const buttons = rows[1]?.components ?? [];
    const run = buttons.find((button) => button.custom_id?.includes(":run:"));
    expect(run?.disabled).toBe(true);
  });

  it("takes roles per name, and an amount per role", async () => {
    stubFetch({ [CURRENCY]: currency("1000"), [ROLES]: roles, [EDIT]: edited });
    const stub = await start("settings-2", { roleIds: [], amount: 0 });

    const picked = await press(stub, "roles", {
      values: ["701", "702", "900", "701"],
    });
    expect(picked.ok).toBe(true);
    expect(picked.content).toContain("<@&701>");
    expect(picked.content).toContain("<@&702>");
    // `@everyone` is dropped rather than counted.
    expect(picked.content).not.toContain("<@&900>");
    expect(picked.content).toContain("（金額未設定）");
    expect(picked.components).toHaveLength(3);

    // The amount select calls each role by its name, and says what it has.
    const amountRow = picked.components?.[1] as {
      components: { options: { label: string; value: string }[] }[];
    };
    expect(amountRow.components[0]?.options[0]).toMatchObject({
      label: "Veteran",
      value: "701",
      description: "未設定",
    });

    const modal = await press(stub, "amount-modal", { roleId: "702" });
    expect(modal.ok).toBe(true);
    expect(modal.modal?.custom_id).toBe("issue-role:amount:settings-2:702");
    expect(modal.modal?.components?.[0]?.component?.custom_id).toBe("amount");

    const amount = await press(stub, "amount", { roleId: "702", value: "25" });
    expect(amount.ok).toBe(true);
    expect(amount.content).toContain("<@&702> — 25 nyan");
    expect(amount.content).toContain("<@&701> — （金額未設定）");

    const bad = await press(stub, "amount", { roleId: "702", value: "0" });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("金額");

    const wrongRole = await press(stub, "amount", {
      roleId: "999",
      value: "5",
    });
    expect(wrongRole.ok).toBe(false);
    expect(wrongRole.reason).toContain("選ばれていません");

    // Leave the run's clock quiet: one tick puts the panel up and stops.
    await drive(stub);
  });

  it("refuses 実行 until it is set, and starts the run when it is", async () => {
    await seedLiveGrant();
    const service = stubFetch({
      [CURRENCY]: currency("1000"),
      [ROLES]: roles,
      [GUILD]: { status: 200, body: { approximate_member_count: 1 } },
      [MEMBERS]: { status: 200, body: [member("100", ["700"])] },
      [ISSUE]: [
        {
          status: 201,
          body: { amount: "10", pool_amount: "990", unit: "nyan" },
        },
      ],
      [EDIT]: edited,
    });

    const stub = await start("settings-3", { roleIds: [], amount: 0 });
    const withoutRoles = await press(stub, "run");
    expect(withoutRoles.ok).toBe(false);
    expect(withoutRoles.reason).toContain("先にロール");

    await press(stub, "roles", { values: ["700"] });
    const withoutAmount = await press(stub, "run");
    expect(withoutAmount.ok).toBe(false);
    expect(withoutAmount.reason).toContain("金額が未設定");

    await press(stub, "amount", { roleId: "700", value: "10" });
    const begun = await press(stub, "run");
    expect(begun.ok).toBe(true);
    expect(begun.content).toContain("集計しています");

    // And 実行 set the clock: nobody presses anything else.
    await drive(stub);
    expect(issueCalls(service.calls)).toHaveLength(1);
    expect(edits(service.calls).at(-1)).toContain(
      "1人全員に 合計 10 nyan を発行しました",
    );
  });
});

describe("an issue-role run", () => {
  it("issues to every holder, showing progress, and reports the pool left", async () => {
    await seedLiveGrant();
    const service = stubFetch({
      [CURRENCY]: currency("1000"),
      [GUILD]: { status: 200, body: { approximate_member_count: 3 } },
      [MEMBERS]: {
        status: 200,
        body: [
          member("100", ["700"]),
          member("200", ["700"]),
          member("300", []),
        ],
      },
      [ISSUE]: [
        {
          status: 201,
          body: { amount: "10", pool_amount: "980", unit: "nyan" },
        },
        {
          status: 201,
          body: { amount: "10", pool_amount: "970", unit: "nyan" },
        },
      ],
      [EDIT]: edited,
    });

    const stub = await start("run-1");
    await begin(stub);
    await drive(stub);

    const issued = issueCalls(service.calls);
    expect(issued).toHaveLength(2);
    expect(issued[0]?.headers.get("idempotency-key")).toBe(
      '"issue-role:run-1:100"',
    );
    expect(issued[1]?.headers.get("idempotency-key")).toBe(
      '"issue-role:run-1:200"',
    );

    const messages = editBodies(service.calls);
    expect(
      messages.some((message) => message.content.includes("集計しています")),
    ).toBe(true);
    expect(messages.at(-1)?.content).toContain(
      "2人全員に 合計 20 nyan を発行しました",
    );
    expect(messages.at(-1)?.content).toContain("プール残高: 970 nyan");
    // A finished run offers no buttons.
    expect(messages.at(-1)?.components).toEqual([]);

    // And `再開` on it answers with the report rather than starting anything.
    const answer = await press(stub, "resume");
    expect(answer.ok).toBe(true);
    expect(answer.content).toContain("2人全員に 合計 20 nyan を発行しました");
    expect(answer.components).toEqual([]);
    expect(issueCalls(service.calls)).toHaveLength(2);
  });

  it("pays the union with each role's own amount, summing a member holding both", async () => {
    await seedLiveGrant();
    const service = stubFetch({
      [CURRENCY]: currency("1000"),
      [ROLES]: roles,
      [GUILD]: { status: 200, body: { approximate_member_count: 4 } },
      [MEMBERS]: {
        status: 200,
        body: [
          member("100", ["700"]),
          member("200", ["701"]),
          member("300", ["700", "701"]),
          member("400", []),
        ],
      },
      [ISSUE]: [
        {
          status: 201,
          body: { amount: "10", pool_amount: "990", unit: "nyan" },
        },
        {
          status: 201,
          body: { amount: "50", pool_amount: "940", unit: "nyan" },
        },
        {
          status: 201,
          body: { amount: "60", pool_amount: "880", unit: "nyan" },
        },
      ],
      [EDIT]: edited,
    });

    const stub = await start("run-union", {
      roleIds: ["700", "701"],
      amount: 0,
    });
    await press(stub, "amount", { roleId: "700", value: "10" });
    await press(stub, "amount", { roleId: "701", value: "50" });
    await begin(stub);
    await drive(stub);

    const receivers = issueCalls(service.calls).map(
      (call) =>
        (JSON.parse(call.body ?? "{}") as { receiver_discord_id?: string })
          .receiver_discord_id,
    );
    expect(receivers.sort()).toEqual(["100", "200", "300"]);
    // 100 carries 700 → 10; 200 carries 701 → 50; 300 carries both → 60.
    expect(paidAmounts(service.calls).sort()).toEqual(["10", "50", "60"]);
    expect(edits(service.calls).at(-1)).toContain(
      "<@&700> <@&701> の 3人全員に 合計 120 nyan を発行しました",
    );
  });

  it("runs two distributions in one guild at the same time", async () => {
    await seedLiveGrant();
    const service = stubFetch({
      [CURRENCY]: currency("1000"),
      [GUILD]: { status: 200, body: { approximate_member_count: 2 } },
      [MEMBERS]: {
        status: 200,
        body: [member("100", ["700"]), member("200", ["701"])],
      },
      [ISSUE]: {
        status: 201,
        body: { amount: "10", pool_amount: "980", unit: "nyan" },
      },
      [EDIT]: edited,
    });

    const a = await start("run-a");
    const b = await start("run-b", { roleIds: ["701"] });

    // Both tick while the other is in flight: nothing here is one at a time.
    await begin(a);
    await begin(b);
    expect(await runDurableObjectAlarm(a)).toBe(true);
    expect(await runDurableObjectAlarm(b)).toBe(true);
    await drive(a);
    await drive(b);

    const keys = issueCalls(service.calls)
      .map((call) => call.headers.get("idempotency-key"))
      .sort();
    expect(keys).toEqual(['"issue-role:run-a:100"', '"issue-role:run-b:200"']);
    expect(
      edits(service.calls).filter((m) => m.includes("1人全員に 合計 10 nyan")),
    ).toHaveLength(2);
  });

  it("waits for the approval and continues by itself, with nobody re-running anything", async () => {
    const service = stubFetch({
      [CURRENCY]: currency("1000"),
      [GUILD]: { status: 200, body: { approximate_member_count: 2 } },
      [MEMBERS]: {
        status: 200,
        body: [member("100", ["700"]), member("200", ["700"])],
      },
      [TOKEN]: [
        appToken,
        pending,
        pending,
        {
          status: 200,
          body: {
            access_token: "guild-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-1",
          },
        },
      ],
      [ASK]: {
        status: 200,
        body: { device_code: "dc-1", user_code: "KODO-0001", expires_in: 600 },
      },
      [ISSUE]: [
        {
          status: 201,
          body: { amount: "10", pool_amount: "990", unit: "nyan" },
        },
        {
          status: 201,
          body: { amount: "10", pool_amount: "980", unit: "nyan" },
        },
      ],
      [EDIT]: edited,
    });

    const stub = await start("run-2");
    await begin(stub);
    await drive(stub);

    const messages = edits(service.calls);
    expect(
      messages.some((message) =>
        message.includes("/grant approve code:KODO-0001"),
      ),
    ).toBe(true);
    expect(messages.at(-1)).toContain("2人全員に 合計 20 nyan を発行しました");
    expect(issueCalls(service.calls)).toHaveLength(2);
  });

  it("waits out a rate limit on its own clock and finishes the run", async () => {
    await seedLiveGrant();
    const service = stubFetch({
      [CURRENCY]: currency("1000"),
      [GUILD]: { status: 200, body: { approximate_member_count: 3 } },
      [MEMBERS]: {
        status: 200,
        body: [
          member("100", ["700"]),
          member("200", ["700"]),
          member("300", ["700"]),
        ],
      },
      [ISSUE]: [
        {
          status: 201,
          body: { amount: "10", pool_amount: "990", unit: "nyan" },
        },
        {
          status: 429,
          body: { error: "too_many_requests" },
          headers: { "retry-after": "61" },
        },
        {
          status: 201,
          body: { amount: "10", pool_amount: "980", unit: "nyan" },
        },
        {
          status: 201,
          body: { amount: "10", pool_amount: "970", unit: "nyan" },
        },
      ],
      [EDIT]: edited,
    });

    const stub = await start("run-3");
    await begin(stub);
    await drive(stub);

    expect(issueCalls(service.calls)).toHaveLength(4);
    const messages = edits(service.calls);
    expect(
      messages.some((message) => message.includes("自動で再開します")),
    ).toBe(true);
    expect(messages.at(-1)).toContain("3人全員に 合計 30 nyan を発行しました");
  });

  it("stops on a pool that cannot pay, with the buttons still on the screen", async () => {
    const service = stubFetch({
      [CURRENCY]: currency("5"),
      [GUILD]: { status: 200, body: { approximate_member_count: 2 } },
      [MEMBERS]: {
        status: 200,
        body: [member("100", ["700"]), member("200", ["700"])],
      },
      [EDIT]: edited,
    });

    const stub = await start("run-4");
    await begin(stub);
    await drive(stub);

    const last = editBodies(service.calls).at(-1);
    expect(last?.content).toContain("プールが足りません");
    expect(last?.content).toContain("「再開」ボタン");
    expect(last?.components).toHaveLength(1);
    expect(
      service.calls.filter(
        (call) => call.path === "/oauth2/clients/@me/grant-requests",
      ),
    ).toHaveLength(0);
  });

  it("resumes a stopped run from the 再開 button, without paying twice", async () => {
    await seedLiveGrant();
    const service = stubFetch({
      // The pool is short on the first look, and enough when the stopped run is
      // asked to go on.
      [CURRENCY]: [currency("5"), currency("1000")],
      [GUILD]: { status: 200, body: { approximate_member_count: 2 } },
      [MEMBERS]: {
        status: 200,
        body: [member("100", ["700"]), member("200", ["700"])],
      },
      [ISSUE]: [
        {
          status: 201,
          body: { amount: "10", pool_amount: "980", unit: "nyan" },
        },
        {
          status: 201,
          body: { amount: "10", pool_amount: "970", unit: "nyan" },
        },
      ],
      [EDIT]: edited,
    });

    const stub = await start("run-5");
    await begin(stub);
    await drive(stub);
    expect(edits(service.calls).at(-1)).toContain("プールが足りません");

    const answer = await press(stub, "resume");
    expect(answer.ok).toBe(true);
    expect(answer.content).toContain("集計しています");

    // Nobody re-runs the command: the button set the clock, and the run
    // continues by itself.
    await drive(stub);

    expect(issueCalls(service.calls)).toHaveLength(2);
    expect(edits(service.calls).at(-1)).toContain(
      "2人全員に 合計 20 nyan を発行しました",
    );
  });

  it("answers 更新 with the screen as it is, buttons included", async () => {
    await seedLiveGrant();
    stubFetch({
      [CURRENCY]: currency("1000"),
      [GUILD]: { status: 200, body: { approximate_member_count: 1 } },
      [MEMBERS]: { status: 200, body: [member("100", ["700"])] },
      [ISSUE]: [
        {
          status: 201,
          body: { amount: "10", pool_amount: "990", unit: "nyan" },
        },
      ],
      [EDIT]: edited,
    });
    const stub = await start("run-6");
    await begin(stub);

    const answer = await press(stub, "status");

    expect(answer.ok).toBe(true);
    expect(answer.content).toContain("集計しています");
    expect(answer.components).toHaveLength(1);

    await drive(stub);
  });

  it("refuses a press that is not the starter's", async () => {
    stubFetch({ [CURRENCY]: currency("1000"), [ROLES]: roles, [EDIT]: edited });
    const stub = await start("run-7", { roleIds: [], amount: 0 });

    const answer = await press(stub, "status", { presserId: "999" });

    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain("実行した人だけ");

    // The refusal changed nothing; the panel's own tick still runs, and stops.
    await drive(stub);
  });

  it("keeps working when the screen is gone, and delivers the report by DM", async () => {
    await seedLiveGrant();
    const service = stubFetch({
      [CURRENCY]: currency("1000"),
      [GUILD]: { status: 200, body: { approximate_member_count: 2 } },
      [MEMBERS]: {
        status: 200,
        body: [member("100", ["700"]), member("200", ["700"])],
      },
      [ISSUE]: [
        {
          status: 201,
          body: { amount: "10", pool_amount: "990", unit: "nyan" },
        },
        {
          status: 201,
          body: { amount: "10", pool_amount: "980", unit: "nyan" },
        },
      ],
      [EDIT]: { status: 404, body: { message: "Unknown Webhook" } },
      [DM]: { status: 200, body: { id: "dm-1" } },
      [DM_MESSAGE]: { status: 200, body: {} },
    });

    const stub = await start("run-8");
    await begin(stub);
    await drive(stub);

    expect(issueCalls(service.calls)).toHaveLength(2);
    const delivered = service.calls.filter(
      (call) => call.path === "/api/v10/channels/dm-1/messages",
    );
    expect(delivered).toHaveLength(1);
    const body = JSON.parse(delivered[0]?.body ?? "{}") as {
      content?: string;
      components?: unknown[];
    };
    expect(body.content).toContain("2人全員に 合計 20 nyan を発行しました");
    // A finished run has nothing to offer, DM or not.
    expect(body.components).toEqual([]);
  });

  it("stops a run the retries cannot save — by DM, buttons included", async () => {
    await seedLiveGrant();
    const service = stubFetch({
      [CURRENCY]: currency("1000"),
      [GUILD]: { status: 200, body: { approximate_member_count: 2 } },
      [MEMBERS]: {
        status: 200,
        body: [member("100", ["700"]), member("200", ["700"])],
      },
      // The first member is paid; the second's issuance never stops failing.
      [ISSUE]: [
        {
          status: 201,
          body: { amount: "10", pool_amount: "990", unit: "nyan" },
        },
        { status: 500, body: { error: "server_error" } },
        { status: 500, body: { error: "server_error" } },
        { status: 500, body: { error: "server_error" } },
        { status: 500, body: { error: "server_error" } },
      ],
      [EDIT]: { status: 404, body: { message: "Unknown Webhook" } },
      [DM]: { status: 200, body: { id: "dm-1" } },
      [DM_MESSAGE]: { status: 200, body: {} },
    });

    const stub = await start("run-9");
    await begin(stub);
    await drive(stub);

    expect(issueCalls(service.calls)).toHaveLength(5);
    const delivered = service.calls.filter(
      (call) => call.path === "/api/v10/channels/dm-1/messages",
    );
    expect(delivered).toHaveLength(1);
    const body = JSON.parse(delivered[0]?.body ?? "{}") as {
      content?: string;
      components?: unknown[];
    };
    expect(body.content).toContain("再試行しても失敗しました");
    // The stop went to the DM with its buttons: it is resumable from there.
    expect(body.components).toHaveLength(1);
  });
});
