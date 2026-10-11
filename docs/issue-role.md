# `/issue-role`: the guild's pool pays roles

```
/issue-role [role:<role>] [amount:<n>]
```

Opens a **settings screen** — private to whoever ran the command — where the
roles to pay and **an amount per role** are decided, and 実行 starts it.
Structured like this because the command line is a bad place for a decision:
one role is a picker entry, several are a multi-select, and an amount is a
number worth checking against the pool before anything runs.

`role` and `amount` are **pre-fills**: given, the screen opens with that role
at that amount, and the amount is the default for roles picked up later;
omitted, the screen opens empty.

The core bot's `/issue` pays one user at a time, by an administrator's hand;
this pays whole roles at once, which is the shape a guild actually wants for
rewards, event payouts and role salaries — which is why it lives out here
rather than there. Nothing about it bypasses the core: the money is the
guild's pool, the permission is a `vc.issue` grant an administrator approves
once, and every issuance is an ordinary `POST /api/v2/currencies/issue` that
the core applies all of its own checks to.

## The settings screen

```
⚙️ ロールへの一斉発行
通貨: nyan（プール: 1,000）
ロールと金額:
　<@&…> — 10 nyan
　<@&…> — （金額未設定）
1人が複数のロールを持つときは、合計額を1回で受け取ります。
「実行」で開始します。
[ ロールを選ぶ ▾ ]  [ 金額を設定するロールを選ぶ ▾ ]  [ 実行 ] [ 更新 ]
```

- **The role select** takes up to 25 roles — Discord's own ceiling for a
  role select — and the chosen ones come back as the screen's next state, so
  they can be changed until 実行 is pressed.
- **The amount select** lists the chosen roles by name; picking one opens a
  modal for that role's amount — a whole positive number. One role at a time
  is what keeps this working for any number of roles, where one modal with a
  field per role would top out at five.
- **実行** is disabled until every chosen role has an amount.
- **更新** re-reads the pool and the roles, for a screen someone left open.

## Several roles, and an amount for each

One run pays the **union** of the chosen roles, and each member's amount is
the **sum** of the amounts of the roles they carry: give a role 10 and another
50, and someone holding both is paid 60, in one issuance. The rule is that
every amount given to a role reaches the people who carry it — a "highest role
wins" would quietly drop one of the two things the operator said.

Each member is still paid once per run, whatever roles they hold, and the
issuance is one request with that sum. The pool check is the sum over
everyone (`合計 X nyan 必要`), not a count times one price.

The scan is one walk of the member list against the set of roles, so several
roles in one run are also cheaper than several runs — which matters because
the service's rate limit is counted per application, not per guild.

If what you want is a member paid once *per role* at the same amount, that is
not this: run it twice, and they are paid twice.

**Runs are independent, and concurrent.** Each `/issue-role` invocation is its
own run with its own clock (`run.ts` is a Durable Object per run), so nothing
stops two guilds — or one guild and two overlapping roles — from being paid at
the same time; they only share the service's rate limit, which each run waits
out on its own.

## The progress screen, and the run that continues by itself

Once 実行 is pressed the same message becomes the progress screen:

```
発行中… ▰▰▰▰▱▱▱▱▱▱ 12/50人
残り 38人 · プール残高: 620 nyan
```

Nothing on that screen needs a person to do anything twice. The run lives in a
Durable Object with its own alarm, so:

- **a distribution larger than one invocation simply takes more ticks** — the
  loop works in bounded ticks and re-arms itself;
- **the service's rate limit is waited out** — the run re-arms for its
  `Retry-After` and picks up at the same member ("約61秒後に自動で再開します");
- **a transient failure is retried a few times** before it is worth reporting;
- **an approval is noticed by the run itself** — the wait is polled every few
  seconds, and approving with the core bot is the whole of the interactive
  half. If the ask expires unanswered, the run asks again and says so on the
  same screen.

The screen carries two buttons:

- **更新** — answer with the run's state as it is now. The screen also updates
  by itself; this is for wanting it *now*.
- **再開** — the same run, asked to go on: from a stop that was a refusal, from
  a wait, or from wherever it stands. The run continues under its own keys, so
  members already paid are only answered again — nobody is paid twice.

The screen depends on Discord keeping the interaction token alive for fifteen
minutes. A run that outlives it keeps working — the money is the point, the
screen is a courtesy — and its final report goes to the invoker's DM, buttons
included, so a stopped run stays resumable from there too. Every press hands
the run a fresh token, so a panel someone keeps pressing stays editable
indefinitely.

## The run names itself, and running the command again is a new distribution

Every issuance carries an idempotency key built from the run's own id and the
member:

```
"issue-role:<runId>:<member>"
```

The id is the run's identity from the moment it starts — unique per
invocation — so there is nothing to name, remember, or reuse. What follows:

- **resuming is the 再開 button.** A run that stopped picks up from where the
  money stopped: members already paid replay their answers instead of being
  paid again. Nothing to type.
- **running the command again is a new distribution.** Same roles, same
  amount, new run, new keys — everyone is paid again. That is deliberate: a
  command is a person saying "pay these roles". When what you want is the
  *rest of an interrupted run*, that is the button, not the command.
- **the buttons know whose they are.** Only the person who started the run can
  press them; anyone else is answered "このボタンは、実行した人だけが押せます。"

## First use in a guild: one approval

The first run in a guild cannot issue anything, because the bot has no
permission there yet. It asks for one and puts the code on the screen:

> ⏳ 発行権限の承認待ちです（1回だけです）。
> コアBotで `/grant approve code:ABCD-1234` を実行してください（残り約600秒）。
> 承認を検知すると、自動で発行を続けます。実行し直す必要はありません。
> 対象: 12人 × 10 = 120 nyan

An administrator approves with the core bot, and the run continues on its own.
The approval is remembered — a token pair in D1 (`guild_grants`), renewed from
its refresh token as it ages — so it is once per guild. If the grant is ever
revoked, the next run asks again.

Pending asks are also harvested by the bot's clock (a Cron Trigger, once a
minute, `src/vc/guild-grant.ts`), so an approval that lands when no run is
watching is remembered for the next one — and both pollers write through the
same two statements, so there is no state either can invent about the other.

## What a run refuses, before it asks anyone for anything

In order, and all of it before the approval step:

- the caller is not an administrator;
- a role that is `@everyone` (Discord never lists it in a member's `roles`, so
  it cannot be counted — dropped from a selection, refused on the command line);
- the guild has no currency yet;
- the guild is past the size Discord hands member lists for — 75,000, the
  figure its own gateway documentation states — refused rather than paid from a
  partial list;
- nobody carries any of the roles;
- the pool cannot pay for everyone (`holders × amount`).

Nobody is asked to approve a run that cannot happen.

## Refusals a run stops on, and the rest

A real refusal from the service — the pool ran dry mid-run
(`not_enough_amount`), the currency is gone, a 4xx that is not a rate limit —
ends the run with a partial report. Everything else is machinery the run
handles: rate limits, 5xx, network failures, Discord stumbling. The other
stops a person can see:

- **the member list cannot be read** — the bot must be in the guild and the
  `GUILD_MEMBERS` intent must be enabled in the Developer Portal; a 403 from
  Discord is answered with exactly that instruction;
- **the approval was never given** — the wait ends with the screen's own
  lifetime (fifteen minutes), and says so.

A stop keeps the screen's buttons, so the answer to every one of them is the
same: fix the reason, and press 再開. If the reason is gone by the time the
button is pressed — the daily refill put money back in the pool, the currency
was created, the intent was enabled — the run simply goes on. If it is not, the
run stops again with the same explanation, and nothing was paid twice in the
attempt.

## Server setup

- Invite the bot to the guild (it needs `applications.commands` for the
  command and the guild's membership for the member list).
- Developer Portal → Bot → **SERVER MEMBERS INTENT**: on.
- The guild needs a currency — the core bot's `/create`, by an administrator.
- The worker needs its D1 database and migrations; `docs/operations.md` has the
  two commands.
