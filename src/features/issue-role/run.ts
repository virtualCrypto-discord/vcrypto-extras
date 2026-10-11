import { DiscordError, DiscordRest } from "../../discord/rest.ts";
import type { Env } from "../../env.ts";
import { VcClient } from "../../vc/client.ts";
import { VcApiError } from "../../vc/errors.ts";
import { guildToken } from "../../vc/guild-grant.ts";
import { MAX_GUILD_MEMBERS, readRoleHolders } from "./members.ts";

/**
 * One `/issue-role` run, as a Durable Object: the settings, the clock, the
 * screen, and everything on it.
 *
 * A run begins as a **settings screen** — the roles (a multi-select, up to
 * Discord's own ceiling of 25 of them), **an amount per role** (a modal, one
 * role at a time), and 実行 — and the work starts when 実行 is pressed. A
 * member holding several of the chosen roles is paid the **sum** of their
 * amounts, in one issuance: every amount the operator gave a role reaches the
 * people who carry it, and nobody is paid twice for the same role. From then
 * on every step happens on an **alarm**, and the alarm is what makes the run
 * continue by itself:
 *
 * - the issuing loop works in bounded ticks (a Worker invocation's worth) and
 *   re-arms, so a distribution larger than one invocation is simply more ticks
 *   — not a person re-running the command;
 * - the service's rate limit is *waited out*, on an alarm set to its
 *   `Retry-After`, rather than reported as a reason to come back;
 * - a wait for the issuing permission re-polls every few seconds, so approving
 *   with the core bot is the whole of the interactive half — the run notices
 *   and continues (and if the ask expires unanswered, it asks again, and says
 *   so on the same screen);
 * - and a transient failure — a network hiccup, a 5xx — is retried a few times
 *   before it is worth telling anyone about.
 *
 * The screen is the interaction's own message, edited in place: the settings
 * while they are being made, then progress with **更新** (the state as it is
 * now) and **再開** (the same run, asked to go on). The run is its own
 * identity: its keys are `issue-role:<runId>:<member>`, so resuming needs no
 * name to remember, and two deliberate distributions never collide.
 *
 * Every press hands this object a **fresh interaction token**, and it adopts
 * it: the screen is edited through the most recent interaction that touched
 * it, which is what keeps a panel someone left open — or a run still working —
 * editable after the token that opened it would have expired. Discord keeps
 * its tokens alive for fifteen minutes; a run that outlives its screen keeps
 * working — the money is the point, the screen is a courtesy — and its final
 * report goes to the invoker's DM, buttons included.
 */

/** How much of one invocation a tick may use before it re-arms. */
const TICK_BUDGET_MS = 20_000;

/** The screen is edited no more often than Discord's webhook limits comfortably allow. */
const EDIT_INTERVAL_MS = 5_000;

/** While waiting for an approval, the ask is polled this often. */
const GRANT_POLL_MS = 10_000;

/** Waiting for an approval ends with the interaction token's own lifetime. */
const GRANT_DEADLINE_MS = 15 * 60 * 1000;

/** A transient failure is retried this many times. */
const MAX_FAILURES = 3;
const RETRY_AFTER_MS = 15_000;

/** The modal field `index.ts` reads by this id, and this builds. */
const AMOUNT_FIELD = "amount";

/** One member of the run: what they are owed, which is their roles' amounts summed. */
interface Payout {
  discordId: string;
  amount: number;
}

interface RunState {
  runId: string;
  guildId: string;
  roleIds: string[];
  /** Per role, in whole units; a role without an entry has no amount yet. */
  amounts: Record<string, number>;
  /** What a newly picked role starts at — the command's `amount`, or 0 for none. */
  defaultAmount: number;
  /** What the guild calls its roles — a select's labels cannot be mentions. */
  roleNames: Record<string, string>;
  applicationId: string;
  /** The newest interaction that touched the screen; see the note above. */
  interactionToken: string;
  invokerId: string;
  /** Where the work stands. */
  phase: "settings" | "scan" | "grant" | "issue";
  /** How it ended, if it has: the screen's answers come from this. */
  outcome: "running" | "stopped" | "done";
  stoppedReason: string;
  unit: string;
  holders: Payout[];
  total: number;
  /** Every holder's amount summed, as the API writes numbers. */
  totalAmount: string;
  /** The amounts actually issued so far, the same way. */
  issuedAmount: string;
  next: number;
  issued: number;
  poolLeft: string;
  userCode: string;
  askExpiresAt: number;
  grantDeadlineAt: number;
  lastEditAt: number;
  messageDead: boolean;
  failures: number;
  token: string;
}

/** What the command hands over. */
export interface IssueRunStart {
  runId: string;
  guildId: string;
  roleIds: string[];
  /** The starting amount for the roles the command named, and the default for later ones. */
  amount: number;
  applicationId: string;
  interactionToken: string;
  invokerId: string;
}

/** What the screen says, and what it offers. `components` is Discord's own JSON. */
interface Screen {
  content: string;
  components: unknown[];
}

/** A press: a button, one of the selects, or the modal one of them opened. */
type PressAction =
  | "status"
  | "resume"
  | "roles"
  | "amount-modal"
  | "amount"
  | "run";

interface PressBody {
  presserId?: string;
  token?: string;
  values?: string[];
  value?: string;
  /** Which role an amount press is about. */
  roleId?: string;
}

export class IssueRun {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/start":
        return this.start(request);
      case "/status":
        return this.press(request, "status");
      case "/resume":
        return this.press(request, "resume");
      case "/roles":
        return this.press(request, "roles");
      case "/amount-modal":
        return this.press(request, "amount-modal");
      case "/amount":
        return this.press(request, "amount");
      case "/run":
        return this.press(request, "run");
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  private async start(request: Request): Promise<Response> {
    // Starting twice is not two runs: a replayed interaction finds the run it
    // already started.
    if ((await this.ctx.storage.get<RunState>("run")) === undefined) {
      const start = (await request.json()) as IssueRunStart;
      const amounts: Record<string, number> = {};
      if (start.amount > 0) {
        for (const roleId of start.roleIds) {
          amounts[roleId] = start.amount;
        }
      }
      const state: RunState = {
        runId: start.runId,
        guildId: start.guildId,
        roleIds: start.roleIds,
        amounts,
        defaultAmount: start.amount,
        roleNames: {},
        applicationId: start.applicationId,
        interactionToken: start.interactionToken,
        invokerId: start.invokerId,
        phase: "settings",
        outcome: "running",
        stoppedReason: "",
        unit: "",
        holders: [],
        total: 0,
        totalAmount: "0",
        issuedAmount: "0",
        next: 0,
        issued: 0,
        poolLeft: "",
        userCode: "",
        askExpiresAt: 0,
        grantDeadlineAt: Date.now() + GRANT_DEADLINE_MS,
        lastEditAt: 0,
        messageDead: false,
        failures: 0,
        token: "",
      };
      await this.ctx.storage.put("run", state);
      // The first tick waits a moment: the deferred answer Discord shows is
      // what this run edits, and it is registered when the command's response
      // arrives, which is now.
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }

    return Response.json({ ok: true });
  }

  /**
   * Everything a person does to a screen, in one place: the role select and
   * the two amount screens while it is being set up, 実行 which starts it, and
   * the two buttons a run in flight carries.
   *
   * The answer is always the screen to show — or, for an amount press, the
   * modal to open — and the worker turns that into the interaction callback.
   */
  private async press(
    request: Request,
    action: PressAction,
  ): Promise<Response> {
    const body = (await request.json()) as PressBody;
    const state = await this.ctx.storage.get<RunState>("run");
    if (state === undefined) {
      return Response.json({
        ok: false,
        reason: "この配布の記録は残っていません。",
      });
    }
    if (state.invokerId !== "" && state.invokerId !== body.presserId) {
      return Response.json({
        ok: false,
        reason: "このボタンは、実行した人だけが押せます。",
      });
    }

    const alreadyBegun = () =>
      Response.json({
        ok: false,
        reason: "この実行はもう始まっています。",
      });
    const notChosen = () =>
      Response.json({
        ok: false,
        reason: "そのロールは選ばれていません。",
      });
    let armIn = 0;
    /** The role the modal is about, when this press is the one that opens it. */
    let modalFor: string | null = null;

    switch (action) {
      case "amount-modal": {
        if (state.phase !== "settings") return alreadyBegun();
        const roleId = body.roleId ?? "";
        if (!state.roleIds.includes(roleId)) return notChosen();
        // Built after the guild is re-read below, so the modal's label is the
        // role's name even on the very first press — and so this press counts
        // as one the screen may be edited through.
        modalFor = roleId;
        break;
      }

      case "roles": {
        if (state.phase !== "settings") return alreadyBegun();
        // `@everyone` is never written into a member's roles, so it cannot be
        // counted — a selection of nothing else is not a selection.
        const picked = [
          ...new Set((body.values ?? []).filter((id) => id !== state.guildId)),
        ];
        if (picked.length === 0) {
          return Response.json({
            ok: false,
            reason:
              "`@everyone` は数えられないため、個別のロールを指定してください。",
          });
        }
        // A role picked up for the first time starts at the command's amount,
        // so the common "everyone gets the same" stays two presses.
        for (const roleId of picked) {
          if (state.amounts[roleId] === undefined && state.defaultAmount > 0) {
            state.amounts[roleId] = state.defaultAmount;
          }
        }
        state.roleIds = picked;
        break;
      }

      case "amount": {
        if (state.phase !== "settings") return alreadyBegun();
        const roleId = body.roleId ?? "";
        if (!state.roleIds.includes(roleId)) return notChosen();
        const parsed = parseAmount(body.value ?? "");
        if (parsed === null) {
          return Response.json({
            ok: false,
            reason: "金額は1以上の整数で入力してください。",
          });
        }
        state.amounts[roleId] = parsed;
        break;
      }

      case "run": {
        if (state.phase !== "settings") return alreadyBegun();
        if (state.roleIds.length === 0) {
          return Response.json({
            ok: false,
            reason: "先にロールを選んでください。",
          });
        }
        const unset = state.roleIds.filter(
          (roleId) => (state.amounts[roleId] ?? 0) <= 0,
        );
        if (unset.length > 0) {
          return Response.json({
            ok: false,
            reason:
              "金額が未設定のロールがあります。下の「金額を設定」で決めてください。",
          });
        }
        state.phase = "scan";
        state.grantDeadlineAt = Date.now() + GRANT_DEADLINE_MS;
        armIn = 1_000;
        break;
      }

      case "status": {
        break;
      }

      case "resume": {
        if (state.phase === "settings") {
          return Response.json({
            ok: false,
            reason: "実行はまだ始まっていません。「実行」を押してください。",
          });
        }
        if (state.outcome === "done") {
          break;
        }
        // Whatever the run stopped at, the person pressing this is asking for
        // the same run to go on from where it stood — so the counters that
        // gave up are cleared, the approval window starts over, and the clock
        // is set again.
        state.outcome = "running";
        state.stoppedReason = "";
        state.failures = 0;
        state.grantDeadlineAt = Date.now() + GRANT_DEADLINE_MS;
        armIn = 1_000;
        break;
      }
    }

    // Adopt the press's interaction: the screen is edited through the most
    // recent one that touched it, and a press is a fresh fifteen minutes. When
    // the clock is re-armed it is a beat out, not now — the press's own answer
    // is the screen's newest word, and an alarm underneath it would race it.
    if (typeof body.token === "string" && body.token !== "") {
      state.interactionToken = body.token;
      state.messageDead = false;
    }
    if (state.phase === "settings") {
      await this.refreshGuild(state);
    }
    await this.ctx.storage.put("run", state);
    if (armIn > 0) {
      await this.ctx.storage.setAlarm(Date.now() + armIn);
    }

    if (modalFor !== null) {
      return Response.json({
        ok: true,
        modal: this.amountModal(state, modalFor),
      });
    }

    const screen = this.screen(state);
    return Response.json({
      ok: true,
      content: screen.content,
      components: screen.components,
    });
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<RunState>("run");
    if (state === undefined) return;
    if (state.outcome !== "running") return;

    try {
      await this.tick(state);
    } catch (error) {
      await this.onFailure(state, error);
    }
  }

  // ---- The tick ------------------------------------------------------------

  private async tick(state: RunState): Promise<void> {
    const vc = VcClient.fromEnv(this.env);

    if (state.phase === "settings") {
      // The panel waits for a person; this tick only puts it up.
      await this.refreshGuild(state);
      await this.ctx.storage.put("run", state);
      await this.message(state, this.settingsScreen(state).content, true);
      return;
    }

    if (state.phase === "scan") {
      await this.message(state, this.scanningScreen(state), true);

      let unit: string;
      let pool: bigint;
      try {
        const currency = await vc.currency({ guild: state.guildId });
        unit = currency.unit ?? "";
        pool = toAmount(currency.pool_amount);
      } catch (error) {
        if (error instanceof VcApiError && error.status === 404) {
          await this.stop(
            state,
            "このサーバーにはまだ通貨がありません（VirtualCryptoの `/create` で作れます）",
          );
          return;
        }
        throw error;
      }

      const scan = await readRoleHolders(
        this.rest(),
        state.guildId,
        state.roleIds,
      );
      if (scan.kind === "too-large") {
        await this.stop(
          state,
          `このサーバーは約${scan.memberCount}人で、Discordがメンバー一覧を渡す上限（${MAX_GUILD_MEMBERS}人）を超えています`,
        );
        return;
      }
      if (scan.holders.length === 0) {
        await this.stop(
          state,
          state.roleIds.length > 1
            ? `${this.roleMentions(state)} のいずれかを持つメンバーが見つかりませんでした`
            : `${this.roleMentions(state)} を持つメンバーが見つかりませんでした`,
        );
        return;
      }

      // Every holder's amount: the amounts of the roles they carry, summed —
      // the pairing only the scan knows.
      const holders = scan.holders.map((holder) => ({
        discordId: holder.discordId,
        amount: holder.roleIds.reduce(
          (sum, roleId) => sum + (state.amounts[roleId] ?? 0),
          0,
        ),
      }));
      const totalAmount = holders.reduce(
        (sum, holder) => sum + BigInt(holder.amount),
        0n,
      );
      if (totalAmount > pool) {
        await this.stop(
          state,
          `プールが足りません（合計 ${totalAmount} ${unit} 必要、プールは ${pool} ${unit}）`,
        );
        return;
      }

      state.unit = unit;
      state.holders = holders;
      state.total = holders.length;
      state.totalAmount = totalAmount.toString();
      state.issuedAmount = "0";
      state.poolLeft = pool.toString();
      state.phase = "grant";
      await this.ctx.storage.put("run", state);
    }

    if (state.phase === "grant") {
      const granted = await guildToken(vc, this.env.DB, state.guildId);

      if (granted.kind === "approval") {
        const changed = state.userCode !== granted.userCode;
        state.userCode = granted.userCode;
        state.askExpiresAt = Date.now() + granted.expiresIn * 1000;
        await this.ctx.storage.put("run", state);
        if (changed) {
          await this.message(state, this.approvalScreen(state), true);
        }
        if (Date.now() > state.grantDeadlineAt) {
          await this.stop(
            state,
            "発行権限が承認されないまま、待ち時間が過ぎました",
          );
          return;
        }
        await this.ctx.storage.setAlarm(Date.now() + GRANT_POLL_MS);
        return;
      }

      state.token = granted.token;
      state.phase = "issue";
      await this.ctx.storage.put("run", state);
    }

    const deadline = Date.now() + TICK_BUDGET_MS;
    while (state.next < state.total) {
      if (Date.now() > deadline) {
        await this.message(state, this.progressScreen(state), false);
        await this.ctx.storage.put("run", state);
        await this.ctx.storage.setAlarm(Date.now() + 500);
        return;
      }

      const holder = state.holders[state.next];
      if (holder === undefined) {
        break;
      }

      let poolLeft: string;
      try {
        const answer = await vc.issueFromPool(state.token, {
          receiverDiscordId: holder.discordId,
          amount: String(holder.amount),
          idempotencyKey: issueKey(state, holder.discordId),
        });
        poolLeft = answer.pool_amount;
      } catch (error) {
        if (error instanceof VcApiError && error.status === 429) {
          // The service's rate limit is a wait, not a refusal: the run re-arms
          // for when it is over and picks up at the same member.
          const wait = (error.retryAfterSeconds ?? 60) * 1000;
          await this.message(
            state,
            `${this.progressScreen(state)}\nレート制限にかかりました。約${Math.ceil(wait / 1000)}秒後に自動で再開します。`,
            true,
          );
          await this.ctx.storage.put("run", state);
          await this.ctx.storage.setAlarm(Date.now() + wait + 1_000);
          return;
        }
        throw error;
      }

      state.issued += 1;
      state.next += 1;
      state.issuedAmount = (
        BigInt(state.issuedAmount) + BigInt(holder.amount)
      ).toString();
      state.poolLeft = poolLeft;
      state.failures = 0;
      await this.ctx.storage.put("run", state);
      await this.message(state, this.progressScreen(state), false);
    }

    await this.done(state);
  }

  // ---- Failures ------------------------------------------------------------

  private async onFailure(state: RunState, error: unknown): Promise<void> {
    if (error instanceof DiscordError && error.status === 403) {
      await this.stop(
        state,
        "メンバー一覧を取得できませんでした（Developer Portalの「SERVER MEMBERS INTENT」を有効にしてください）",
      );
      return;
    }

    // A 4xx that is not a rate limit is the service's answer, not a hiccup: the
    // run reports it, and the 再開 button is how a person asks the same run
    // again once the answer may have changed. Everything else — 5xx, a network
    // failure, Discord stumbling — is retried a few times first.
    const answered =
      error instanceof VcApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429;
    if (answered) {
      await this.stop(state, describe(error));
      return;
    }

    state.failures += 1;
    if (state.failures <= MAX_FAILURES) {
      await this.ctx.storage.put("run", state);
      await this.message(
        state,
        `${state.phase === "issue" ? `${this.progressScreen(state)}\n` : ""}一時的なエラー（${describe(error)}）が起きたため、自動で再試行します（${state.failures}/${MAX_FAILURES}）。`,
        true,
      );
      await this.ctx.storage.setAlarm(Date.now() + RETRY_AFTER_MS);
      return;
    }
    await this.stop(state, `再試行しても失敗しました（${describe(error)}）`);
  }

  // ---- The screen ----------------------------------------------------------

  private screen(state: RunState): Screen {
    if (state.outcome === "done") {
      return { content: this.report(state), components: [] };
    }
    if (state.outcome === "stopped") {
      return {
        content: this.partialReport(state),
        components: this.buttons(state),
      };
    }
    if (state.phase === "settings") {
      return this.settingsScreen(state);
    }
    return {
      content: this.runningScreen(state),
      components: this.buttons(state),
    };
  }

  private settingsScreen(state: RunState): Screen {
    const unit = state.unit === "" ? "—" : state.unit;
    const pool = state.poolLeft === "" ? "—" : state.poolLeft;
    const lines = ["⚙️ ロールへの一斉発行", `通貨: ${unit}（プール: ${pool}）`];

    if (state.roleIds.length === 0) {
      lines.push("ロール: （未選択）");
    } else {
      lines.push("ロールと金額:");
      for (const roleId of state.roleIds) {
        const amount = state.amounts[roleId] ?? 0;
        lines.push(
          `　<@&${roleId}> — ${amount > 0 ? `${amount} ${unit}` : "（金額未設定）"}`,
        );
      }
      lines.push("1人が複数のロールを持つときは、合計額を1回で受け取ります。");
    }
    lines.push("「実行」で開始します。");

    return {
      content: lines.join("\n"),
      components: [
        {
          type: 1,
          components: [
            {
              type: 6,
              custom_id: `issue-role:roles:${state.runId}`,
              placeholder: "発行先のロール（複数選べます）",
              min_values: 1,
              max_values: 25,
              ...(state.roleIds.length === 0
                ? {}
                : {
                    default_values: state.roleIds.map((id) => ({
                      id,
                      type: "role",
                    })),
                  }),
            },
          ],
        },
        ...(state.roleIds.length === 0
          ? []
          : [
              {
                type: 1,
                components: [
                  {
                    type: 3,
                    custom_id: `issue-role:amount:${state.runId}`,
                    placeholder: "金額を設定するロールを選ぶ",
                    min_values: 1,
                    max_values: 1,
                    options: state.roleIds.map((roleId) => ({
                      label: this.roleLabel(state, roleId),
                      value: roleId,
                      description:
                        (state.amounts[roleId] ?? 0) > 0
                          ? `現在: ${state.amounts[roleId]}`
                          : "未設定",
                    })),
                  },
                ],
              },
            ]),
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              custom_id: `issue-role:run:${state.runId}`,
              label: "実行",
              disabled: !(
                state.roleIds.length > 0 &&
                state.roleIds.every(
                  (roleId) => (state.amounts[roleId] ?? 0) > 0,
                )
              ),
            },
            {
              type: 2,
              style: 2,
              custom_id: `issue-role:refresh:${state.runId}`,
              label: "更新",
            },
          ],
        },
      ],
    };
  }

  private amountModal(state: RunState, roleId: string): unknown {
    const current = state.amounts[roleId] ?? 0;
    return {
      custom_id: `issue-role:amount:${state.runId}:${roleId}`,
      title: "金額の設定",
      components: [
        {
          type: 18,
          label: this.roleLabel(state, roleId),
          description: "1以上の整数です。",
          component: {
            type: 4,
            custom_id: AMOUNT_FIELD,
            style: 1,
            required: true,
            max_length: 18,
            placeholder: "10",
            ...(current > 0 ? { value: String(current) } : {}),
          },
        },
      ],
    };
  }

  private runningScreen(state: RunState): string {
    if (state.phase === "grant") return this.approvalScreen(state);
    if (state.phase === "scan") return this.scanningScreen(state);
    return this.progressScreen(state);
  }

  private scanningScreen(state: RunState): string {
    return `対象メンバーを集計しています…（${this.roleMentions(state)}）`;
  }

  private approvalScreen(state: RunState): string {
    const remaining = Math.max(
      0,
      Math.ceil((state.askExpiresAt - Date.now()) / 1000),
    );
    return [
      "⏳ 発行権限の承認待ちです（1回だけです）。",
      `VirtualCryptoで \`/grant approve code:${state.userCode}\` を実行してください（残り約${remaining}秒）。`,
      "承認を検知すると、自動で発行を続けます。実行し直す必要はありません。",
      `対象: ${state.total}人（合計 ${state.totalAmount} ${state.unit}）`,
    ].join("\n");
  }

  private progressScreen(state: RunState): string {
    const bar = progressBar(state.issued, state.total);
    return [
      `発行中… ${bar} ${state.issued}/${state.total}人`,
      `残り ${state.total - state.issued}人 · プール残高: ${state.poolLeft} ${state.unit}`,
    ].join("\n");
  }

  private report(state: RunState): string {
    return [
      `${this.roleMentions(state)} の ${state.total}人全員に 合計 ${state.totalAmount} ${state.unit} を発行しました。`,
      `プール残高: ${state.poolLeft} ${state.unit}`,
    ].join("\n");
  }

  private partialReport(state: RunState): string {
    const head =
      state.total === 0
        ? `${this.roleMentions(state)} への発行は始まっていません。`
        : `${this.roleMentions(state)} の ${state.total}人のうち ${state.issued}人に 合計 ${state.issuedAmount} ${state.unit} を発行し、中断しました。`;
    return [
      head,
      `中断: ${state.stoppedReason}`,
      "下の「再開」ボタンで続きから実行できます（発行済みの分は二重になりません）。",
    ].join("\n");
  }

  /** The two buttons a running or stopped screen offers — a finished run offers none. */
  private buttons(state: RunState): unknown[] {
    if (state.outcome === "done") {
      return [];
    }
    return [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            custom_id: `issue-role:refresh:${state.runId}`,
            label: "更新",
          },
          {
            type: 2,
            style: 1,
            custom_id: `issue-role:resume:${state.runId}`,
            label: "再開",
          },
        ],
      },
    ];
  }

  private roleMentions(state: RunState): string {
    return state.roleIds.map((id) => `<@&${id}>`).join(" ");
  }

  /** A role's name where one is known — a select's label cannot be a mention. */
  private roleLabel(state: RunState, roleId: string): string {
    return (state.roleNames[roleId] ?? roleId).slice(0, 45);
  }

  /** Best-effort: the panel shows the pool and the role names it last saw. */
  private async refreshGuild(state: RunState): Promise<void> {
    try {
      const currency = await VcClient.fromEnv(this.env).currency({
        guild: state.guildId,
      });
      state.unit = currency.unit ?? "";
      state.poolLeft = currency.pool_amount;
    } catch (error) {
      console.error("the guild's currency could not be read", error);
    }
    try {
      const roles = await this.rest().guildRoles(state.guildId);
      const names: Record<string, string> = {};
      for (const role of roles) {
        if (typeof role.id === "string" && typeof role.name === "string") {
          names[role.id] = role.name;
        }
      }
      state.roleNames = names;
    } catch (error) {
      console.error("the guild's roles could not be read", error);
    }
  }

  /** Edit the screen, throttled; a dead token only ends the screen, never the run. */
  private async message(
    state: RunState,
    content: string,
    force: boolean,
  ): Promise<void> {
    if (state.messageDead) return;
    if (!force && Date.now() - state.lastEditAt < EDIT_INTERVAL_MS) return;

    state.lastEditAt = Date.now();
    try {
      await this.rest().editOriginalInteractionResponse(
        state.applicationId,
        state.interactionToken,
        { content, components: this.screen(state).components },
      );
    } catch (error) {
      if (
        error instanceof DiscordError &&
        (error.status === 404 || error.status === 401)
      ) {
        state.messageDead = true;
        return;
      }
      console.error("a progress message could not be edited", error);
    }
  }

  private async done(state: RunState): Promise<void> {
    state.outcome = "done";
    await this.deliver(state);
  }

  private async stop(state: RunState, reason: string): Promise<void> {
    state.outcome = "stopped";
    state.stoppedReason = reason;
    await this.deliver(state);
  }

  /**
   * Say the last word. The state stays behind it: the screen's answers come
   * from it, and that is what keeps a stopped run resumable after everything
   * that made it stopped has been thought about.
   */
  private async deliver(state: RunState): Promise<void> {
    const screen = this.screen(state);

    if (!state.messageDead) {
      try {
        await this.rest().editOriginalInteractionResponse(
          state.applicationId,
          state.interactionToken,
          { content: screen.content, components: screen.components },
        );
        await this.ctx.storage.put("run", state);
        return;
      } catch (error) {
        if (
          error instanceof DiscordError &&
          (error.status === 404 || error.status === 401)
        ) {
          state.messageDead = true;
        } else {
          console.error("the run's final message could not be edited", error);
        }
      }
    }

    // The screen is gone — the interaction token lives fifteen minutes — so the
    // report goes to the person who started the run, buttons included: a stop
    // is still resumable from a DM.
    try {
      const dm = await this.rest().createDm(state.invokerId);
      await this.rest().sendMessage(dm.id, {
        content: screen.content,
        components: screen.components,
      });
    } catch (error) {
      console.error("the run's final report could not be delivered", error);
    }
    await this.ctx.storage.put("run", state);
  }

  private rest(): DiscordRest {
    return new DiscordRest(this.env.DISCORD_BOT_TOKEN);
  }
}

/**
 * The key every issuance of this member is made with: the run's own id, which
 * is unique per invocation — so two deliberate distributions never collide, and
 * a resumed run always replays its own keys.
 */
function issueKey(state: RunState, discordId: string): string {
  return `issue-role:${state.runId}:${discordId}`;
}

/** A whole, positive amount — what the modal's field has to hold. */
function parseAmount(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,15}$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function progressBar(done: number, total: number): string {
  const width = 10;
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** A number as the API writes them: a decimal string, with an empty pool as `""`. */
function toAmount(value: string): bigint {
  return value === "" ? 0n : BigInt(value);
}

/** A stop, in a sentence an administrator can act on. */
function describe(error: unknown): string {
  if (error instanceof VcApiError) {
    if (error.status === 429) {
      const wait =
        error.retryAfterSeconds === null
          ? ""
          : `（約${error.retryAfterSeconds}秒後）`;
      return `レート制限にかかりました${wait}`;
    }
    if (error.errorInfo === "not_enough_amount") {
      return "プールが足りなくなりました";
    }
    if (error.errorInfo === "not_found_currency") {
      return "このサーバーの通貨が見つかりません";
    }
    return `${error.status} ${error.error}${error.errorInfo === null ? "" : `（${error.errorInfo}）`}`;
  }
  if (error instanceof DiscordError) {
    return `Discord が ${error.status} を返しました`;
  }
  return error instanceof Error ? error.message : String(error);
}
