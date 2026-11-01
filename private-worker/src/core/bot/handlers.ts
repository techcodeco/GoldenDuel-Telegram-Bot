import { GrammyError } from "grammy";
import {
  esc,
  type Key,
  matchButton,
  languageFromText,
  type ButtonKey,
  type Lang,
  t,
} from "../i18n";
import { logError } from "../logger";
import {
  CURRENCIES,
  type Currency,
  formatAmount,
  isCurrency,
  normalizeDigits,
  parseAmount,
} from "../money";
import { IS_TON_TESTNET, OWNER_IDS } from "../config";
import {
  createTonDepositInvoice,
  checkTonDeposit,
} from "../services/tonPayments";
import {
  BroadcastCampaign,
  GroupTarget,
  Ledger,
  Ticket,
  Match,
} from "../models";
import { redis } from "../redis";
import { BACKUP_CONFIG_KEY, BACKUP_COMMAND_CHANNEL } from "../telemetry";
import {
  cancelTicket,
  chooseMove,
  currentMatchId,
  joinDuel,
  notifyOpponentChoice,
  relayChat,
} from "../services/duel";
import { userStateKey } from "../services/matchmaking";
import { getSettings } from "../services/settings";
import { clearState, getState, type St, setState } from "../services/state";
import {
  createUser,
  fullUser,
  getReferralCode,
  getUser,
  markBlocked,
  referralCount,
  setLang,
} from "../services/users";
import { getDuelStats, getFinanceStats } from "../services/profile";
import { countConditionalDuelsForWithdrawal } from "../services/withdrawal-eligibility";
import {
  createWithdrawal,
  grantRegistrationBonus,
  resolveWithdrawal,
} from "../services/wallet";
import {
  createManualDepositInvoice,
  ManualDepositAmountBelowMinimum,
  ManualDepositConfigurationError,
} from "../services/manualDeposits";
import { parseDest } from "../validate";
import {
  countEligibleUsers,
  getBroadcastCounts,
  parseBroadcastUserCondition,
} from "../services/broadcast";
import { getBankNameFromShaba, normalizeIranianIban } from "../banks";
import { durationLabel } from "../time";
import {
  addRequiredChannel,
  adminIds,
  advanceBroadcastAfterUserFilter,
  broadcastFilterLabel,
  handleManualInvoiceSearch,
  notifyAdminsWithdrawal,
  processManualDepositDecision,
  promptBroadcastMessage,
  registerAdmin,
  updateAdminSettingFromInput,
} from "./admin";
import { bot, type BotContext } from "./instance";
import {
  amountKeyboard,
  balanceActionsKeyboard,
  cancelKeyboard,
  adminMenuKeyboard,
  profileKeyboard,
  curName,
  currencyKeyboard,
  financeKeyboard,
  languageKeyboard,
  membershipKeyboard,
  mainKeyboard,
  withdrawalBankConfirmKeyboard,
  withdrawalTonConfirmKeyboard,
  broadcastConfirmKeyboard,
} from "./keyboards";
import { notify } from "./notify";
import { Context } from "grammy";
const say = (
  ctx: BotContext,
  key: Key,
  params?: Record<string, string | number>,
  extra: any = {},
) => ctx.reply(t(ctx.lang, key, params), { parse_mode: "HTML", ...extra });
const quiet = <T>(p: Promise<T>) => p.catch(() => undefined);

type RequiredChannel = {
  chatId: string;
  title: string;
  url: string;
  kind?: "channel" | "group" | "supergroup";
};
type MembershipResult = { ok: boolean; unavailable: boolean };

async function checkRequiredMembership(
  userId: number,
  channels: RequiredChannel[],
  _force = false,
): Promise<MembershipResult> {
  if (!channels.length) return { ok: true, unavailable: false };
  // Do not cache positive membership: a user who leaves a required destination
  // must be blocked on the very next interaction, not for a stale cache window.
  let unavailable = false;
  let allMember = true;
  for (const channel of channels) {
    try {
      const member = await bot.api.getChatMember(channel.chatId, userId);
      const isMember =
        member.status === "creator" ||
        member.status === "administrator" ||
        member.status === "member" ||
        (member.status === "restricted" && member.is_member === true);
      if (!isMember) allMember = false;
    } catch {
      unavailable = true;
      allMember = false;
    }
  }
  return { ok: allMember && !unavailable, unavailable };
}

async function applyLanguageAndShowMenu(
  ctx: BotContext,
  lang: Lang,
): Promise<void> {
  const initialLanguage = !ctx.u?.lang;
  const bonusPending = Boolean(ctx.u?.registrationBonusPending);
  await setLang(ctx.from!.id, lang);
  ctx.lang = lang;
  if (ctx.u) ctx.u.lang = lang;

  let welcome = t(lang, "welcome", { name: esc(ctx.from!.first_name) });
  const cfg = await getSettings();
  const isAdmin = ctx.u?.role === "admin" || ctx.u?.role === "owner";
  const membershipExempt =
    ctx.u?.role === "owner" || OWNER_IDS.has(ctx.from!.id);
  if (
    !membershipExempt &&
    cfg.membership.enabled &&
    cfg.membership.channels.length
  ) {
    const membership = await checkRequiredMembership(
      ctx.from!.id,
      cfg.membership.channels,
      true,
    );
    if (!membership.ok) {
      // Do not credit an account bonus until the new user passes the required-channel gate.
      await ctx.reply(welcome, { parse_mode: "HTML" });
      await ctx.reply(
        t(
          lang,
          membership.unavailable
            ? "membership.unavailable"
            : "membership.required",
        ),
        {
          parse_mode: "HTML",
          reply_markup: membershipKeyboard(cfg.membership.channels, lang),
        },
      );
      return;
    }
  }

  if (initialLanguage || bonusPending) {
    const currency: Currency = lang === "fa" ? "IRT" : "TON";
    const bonus = await grantRegistrationBonus(
      ctx.from!.id,
      currency,
      cfg.registrationBonus[currency],
      initialLanguage,
    );
    if (ctx.u) ctx.u.registrationBonusPending = false;
    if (bonus > 0)
      welcome += `\n\n${t(lang, "registration.bonus", { amount: formatAmount(bonus, currency), cur: curName(lang, currency) })}`;
  }
  await ctx.reply(welcome, {
    parse_mode: "HTML",
    reply_markup: mainKeyboard(lang, isAdmin),
  });
}

type WithdrawalAdminMessageRef = {
  chatId: number;
  messageId: number;
  originalText?: string;
};

async function finalizeWithdrawalDecision(
  ctx: BotContext,
  withdrawalId: string,
  approve: boolean,
  rejectionReason = "",
  origin?: WithdrawalAdminMessageRef,
): Promise<boolean> {
  const result = await resolveWithdrawal(
    withdrawalId,
    approve,
    ctx.from!.id,
    rejectionReason,
  );
  if (!result) {
    await ctx.reply(
      ctx.lang === "fa"
        ? "ℹ️ این فاکتور قبلاً بررسی شده یا پیدا نشد."
        : "ℹ️ This invoice was already reviewed or could not be found.",
    );
    return false;
  }
  const finalStatus = approve
    ? ctx.lang === "fa"
      ? "✅ پرداخت‌شده"
      : "✅ Paid"
    : ctx.lang === "fa"
      ? "❌ رد شده و مبلغ برگشت داده شد"
      : "❌ Rejected and refunded";
  const statusLabel = ctx.lang === "fa" ? "وضعیت" : "Status";
  const base = origin?.originalText ?? "";
  const statusPattern =
    ctx.lang === "fa" ? /وضعیت: <b>[^<]*<\/b>/ : /Status: <b>[^<]*<\/b>/;
  let updated = statusPattern.test(base)
    ? base.replace(statusPattern, `${statusLabel}: <b>${finalStatus}</b>`)
    : `${base}${base ? "\n" : ""}${statusLabel}: <b>${finalStatus}</b>`;
  if (!approve && rejectionReason.trim()) {
    updated += `\n${ctx.lang === "fa" ? "دلیل رد" : "Rejection reason"}: <b>${esc(rejectionReason.trim())}</b>`;
  }
  updated += `\n\n${
    approve
      ? ctx.lang === "fa"
        ? "✅ مبلغ از موجودی رزروشده تسویه شد."
        : "✅ Reserved funds were settled."
      : ctx.lang === "fa"
        ? "↩️ مبلغ به موجودی قابل استفاده کاربر برگشت."
        : "↩️ Funds were refunded to the user."
  }`;
  if (origin) {
    await ctx.api
      .editMessageText(origin.chatId, origin.messageId, updated, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  ctx.lang === "fa"
                    ? "⬅️ فاکتورهای برداشت"
                    : "⬅️ Withdrawal invoices",
                callback_data: "admin:withdrawals",
              },
            ],
          ],
        },
      })
      .catch(() => undefined);
  }
  const userLang: Lang = (await getUser(result.userId))?.lang ?? "en";
  await notify(
    result.userId,
    t(userLang, approve ? "withdraw.paid" : "withdraw.rejected", {
      id: result.id,
      amount: formatAmount(result.amount, result.currency),
      gross: formatAmount(result.amount, result.currency),
      fee: formatAmount(result.fee, result.currency),
      payout: formatAmount(result.payoutAmount, result.currency),
      cur: curName(userLang, result.currency),
      reason: esc(rejectionReason.trim()),
    }),
  );
  return true;
}

async function saveKnownGroup(
  chat: any,
  status: "active" | "left",
): Promise<void> {
  if (
    !chat ||
    !["group", "supergroup"].includes(chat.type) ||
    chat.id === undefined
  )
    return;
  if (status === "left") {
    await GroupTarget.deleteOne({ chatId: String(chat.id) });
    return;
  }
  await GroupTarget.findOneAndUpdate(
    { chatId: String(chat.id) },
    {
      $set: {
        title: String(chat.title ?? ""),
        username: String(chat.username ?? ""),
        type: chat.type,
        status: "active",
        lastSeenAt: new Date(),
      },
      $setOnInsert: { addedAt: new Date() },
    },
    { upsert: true, new: true },
  );
}

function isOwnerUser(ctx: BotContext): boolean {
  return ctx.u?.role === "owner" || OWNER_IDS.has(ctx.from?.id ?? 0);
}

export function registerHandlers(): void {
  // Telegram API errors (message not modified, user blocked the bot…) are not worth retrying: log and move on.
  // Everything else (Mongo / Redis problems) is re-thrown so the stream entry is retried.
  bot.catch((err) => {
    if (err.error instanceof GrammyError) {
      logError("telegram_api_error", err.error, { method: err.error.method });
      return;
    }
    throw err.error;
  });

  // ───────────── user loading, flood control, language gate ─────────────
  bot.use(async (ctx: any, next) => {
    // The app normally handles private-chat flows only. Keep group membership events so the
    // owner can later broadcast to groups where the bot is present, but never run game logic in groups.
    if (
      ctx.chat &&
      (ctx.chat.type === "group" || ctx.chat.type === "supergroup")
    ) {
      if (ctx.myChatMember) {
        const newMember: any = ctx.myChatMember.new_chat_member;
        const memberStatus = newMember.status;
        const noLongerMember =
          memberStatus === "left" ||
          memberStatus === "kicked" ||
          (memberStatus === "restricted" && newMember.is_member === false);
        await saveKnownGroup(ctx.chat, noLongerMember ? "left" : "active");
      } else if (
        ctx.message &&
        "text" in ctx.message &&
        /^\/start(?:@\w+)?(?:\s|$)/i.test(ctx.message.text)
      ) {
        // Lets the owner re-register an already-added group with /start@BotUsername.
        await saveKnownGroup(ctx.chat, "active");
      }
      return;
    }
    const from = ctx.from;
    if (!from || from.is_bot || ctx.chat?.type !== "private") return;
    // Add a lightning reaction to every /start message before membership/language gates.
    if (
      ctx.message &&
      "text" in ctx.message &&
      /^\/start(?:@\w+)?(?:\s|$)/i.test(ctx.message.text)
    ) {
      try {
        const api = bot.api as any;
        if (typeof api.setMessageReaction !== "function") {
          throw new Error("GRAMMY_SET_MESSAGE_REACTION_UNAVAILABLE");
        }
        await api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [
          { type: "emoji", emoji: "⚡" },
        ]);
      } catch (error) {
        // Reaction support is decorative: a Telegram/client/API mismatch must never block /start.
        logError("start_reaction_failed", error, {
          userId: from.id,
          chatId: ctx.chat?.id,
        });
      }
    }
    const n = await redis.incr(`rl:${from.id}`);
    if (n === 1) await redis.pexpire(`rl:${from.id}`, 1000);
    if (n > 15) return; // more than 15 updates per second from one user: ignore

    let u = await getUser(from.id);
    if (!u) {
      const ref = /^\/start\s+ref_([A-Za-z0-9_-]{7,12})/.exec(
        ctx.message?.text ?? "",
      );
      await createUser(from, ref ? ref[1]! : null);
      u = await getUser(from.id);
    }
    ctx.u = u;
    ctx.lang = u?.lang ?? "en";

    const isStart = !!ctx.message?.text?.startsWith("/start");
    const isLang = !!ctx.callbackQuery?.data?.startsWith("lang:");
    const isLangText = languageFromText(ctx.message?.text ?? "") !== undefined;
    const isMembershipCheck = ctx.callbackQuery?.data === "membership:check";
    if (!u?.lang && !isStart && !isLang && !isLangText && !ctx.myChatMember) {
      await ctx.reply(t("fa", "lang.pick"), {
        reply_markup: languageKeyboard(),
      });
      return;
    }

    // Enforce every required group/channel on every interaction, including /start.
    // Only the owner is exempt; ordinary admins must satisfy the same membership rules.
    if (
      u?.lang &&
      u.role !== "owner" &&
      !OWNER_IDS.has(from.id) &&
      !isMembershipCheck
    ) {
      const cfg = await getSettings();
      if (cfg.membership.enabled && cfg.membership.channels.length) {
        const result = await checkRequiredMembership(
          from.id,
          cfg.membership.channels,
          isStart,
        );
        if (!result.ok) {
          const key = result.unavailable
            ? "membership.unavailable"
            : "membership.required";
          await ctx.reply(t(ctx.lang, key), {
            parse_mode: "HTML",
            reply_markup: membershipKeyboard(cfg.membership.channels, ctx.lang),
          });
          return;
        }
      }
    }
    await next();
  });

  // the user blocked / unblocked the bot
  bot.on("my_chat_member", async (ctx) => {
    await markBlocked(
      ctx.from.id,
      ctx.myChatMember.new_chat_member.status === "kicked",
    );
  });

  // ───────────── /start and language ─────────────
  bot.command("start", async (ctx) => {
    if (await currentMatchId(ctx.from!.id))
      return void (await say(ctx, "duel.busy"));
    if (!ctx.u?.lang)
      return void (await ctx.reply(t("fa", "lang.pick"), {
        parse_mode: "HTML",
        reply_markup: languageKeyboard(),
      }));
    await say(
      ctx,
      "welcome",
      { name: esc(ctx.from!.first_name) },
      {
        reply_markup: mainKeyboard(
          ctx.lang,
          ctx.u?.role === "admin" || ctx.u?.role === "owner",
        ),
      },
    );
  });

  bot.callbackQuery(/^lang:(fa|en)$/, async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    await quiet(ctx.deleteMessage());
    await applyLanguageAndShowMenu(ctx, ctx.match[1] as Lang);
  });

  bot.callbackQuery("profile:language", async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    // Language options are always reply-keyboard buttons, including when opened from Profile.
    await ctx.reply(t(ctx.lang, "lang.pick"), {
      parse_mode: "HTML",
      reply_markup: languageKeyboard(),
    });
  });

  bot.callbackQuery("membership:check", async (ctx) => {
    const cfg = await getSettings();
    if (!cfg.membership.enabled || !cfg.membership.channels.length) {
      await quiet(ctx.answerCallbackQuery());
      await quiet(ctx.deleteMessage());
      return void (await say(ctx, "membership.verified", undefined, {
        reply_markup: mainKeyboard(
          ctx.lang,
          ctx.u?.role === "admin" || ctx.u?.role === "owner",
        ),
      }));
    }
    const result = await checkRequiredMembership(
      ctx.from.id,
      cfg.membership.channels,
      true,
    );
    if (!result.ok) {
      const key = result.unavailable
        ? "membership.unavailable"
        : "membership.not_member";
      await quiet(
        ctx.answerCallbackQuery({
          text: t(ctx.lang, key).replace(/<[^>]+>/g, ""),
          show_alert: true,
        }),
      );
      return void (await quiet(
        ctx.editMessageText(t(ctx.lang, key), {
          parse_mode: "HTML",
          reply_markup: membershipKeyboard(cfg.membership.channels, ctx.lang),
        }),
      ));
    }
    await quiet(ctx.answerCallbackQuery());
    await quiet(ctx.deleteMessage());
    await say(ctx, "membership.verified");
    await applyLanguageAndShowMenu(ctx, ctx.lang);
  });

  // Legacy callbacks are retained for messages sent by older versions.
  bot.callbackQuery("dm:back", async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    await quiet(
      ctx.editMessageText(t(ctx.lang, "menu.hint"), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      }),
    );
  });

  bot.callbackQuery("dm:bet", async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    await quiet(
      ctx.editMessageText(t(ctx.lang, "duel.choose_currency"), {
        parse_mode: "HTML",
        reply_markup: currencyKeyboard(ctx.lang, "dq:c"),
      }),
    );
  });

  bot.callbackQuery("dm:friendly", async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    const r = await joinDuel(ctx.from.id, "IRT", 0, "friendly");
    await quiet(ctx.editMessageReplyMarkup());
    if (r.status === "disabled") return void (await say(ctx, "duel.disabled"));
    if (r.status === "busy") return void (await say(ctx, "duel.busy"));
    if (r.status === "queued") {
      return void (await say(
        ctx,
        "duel.searching_friendly",
        { duration: durationLabel(r.seconds, ctx.lang) },
        { reply_markup: cancelKeyboard(ctx.lang, r.ticketId) },
      ));
    }
    if (r.status === "matched") return;
    if (r.status === "insufficient")
      return void (await say(ctx, "duel.insufficient"));
    return void (await say(ctx, "duel.invalid"));
  });

  // ───────────── duel: currency → amount → queue ─────────────
  bot.callbackQuery(/^dq:c:(IRT|TON)$/, async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    const cur = ctx.match[1] as Currency;
    const cfg = await getSettings();
    if (!cfg.features.duelsEnabled)
      return void (await say(ctx, "duel.disabled"));
    await quiet(
      ctx.editMessageText(
        t(ctx.lang, "duel.choose_amount", { cur: curName(ctx.lang, cur) }),
        {
          parse_mode: "HTML",
          reply_markup: amountKeyboard(
            ctx.lang,
            cur,
            cfg.bets[cur],
            new Set(
              (
                await Ticket.find({
                  currency: cur,
                  mode: "bet",
                  status: "queued",
                })
                  .select("amount createdAtMs queueTimeoutSeconds")
                  .lean()
              )
                .filter(
                  (ticket: any) =>
                    Date.now() <
                    Number(ticket.createdAtMs) +
                      Number(ticket.queueTimeoutSeconds ?? cfg.queue.seconds) *
                        1000,
                )
                .map((ticket: any) => Number(ticket.amount)),
            ),
          ),
        },
      ),
    );
  });

  bot.callbackQuery("dq:back", async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    await quiet(
      ctx.editMessageText(t(ctx.lang, "duel.choose_currency"), {
        parse_mode: "HTML",
        reply_markup: currencyKeyboard(ctx.lang, "dq:c"),
      }),
    );
  });

  bot.callbackQuery(/^dq:a:(IRT|TON):(\d+)$/, async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    const cur = ctx.match[1] as Currency;
    const amount = Number(ctx.match[2]);
    const r = await joinDuel(ctx.from.id, cur, amount);
    await quiet(ctx.deleteMessage());
    switch (r.status) {
      case "invalid":
        return void (await say(ctx, "duel.invalid"));
      case "disabled":
        return void (await say(ctx, "duel.disabled"));
      case "insufficient":
        return void (await say(ctx, "duel.insufficient"));
      case "busy": {
        const st = await redis.get(userStateKey(ctx.from.id));
        return void (await say(
          ctx,
          "duel.busy",
          undefined,
          st?.startsWith("q:")
            ? { reply_markup: cancelKeyboard(ctx.lang, st.slice(2)) }
            : {},
        ));
      }
      case "queued":
        return void (await say(
          ctx,
          "duel.searching",
          {
            amount: formatAmount(amount, cur),
            cur: curName(ctx.lang, cur),
            duration: durationLabel(r.seconds, ctx.lang),
          },
          { reply_markup: cancelKeyboard(ctx.lang, r.ticketId) },
        ));
      case "matched":
        return; // both players already received the "opponent found" message
    }
  });

  bot.callbackQuery(/^dq:x:([\w-]+)$/, async (ctx) => {
    const ticket = (await Ticket.findById(ctx.match[1]!)
      .select("userId mode")
      .lean()) as any;
    const r = await cancelTicket(ctx.from.id, ctx.match[1]!);
    if (r === "cancelled") {
      const isFriendly = ticket?.mode === "friendly";
      await quiet(
        ctx.answerCallbackQuery({
          text: t(
            ctx.lang,
            isFriendly ? "duel.cancelled_friendly" : "duel.cancelled_bet",
          ),
          show_alert: false,
        }),
      );
      await quiet(ctx.deleteMessage());
    } else if (r === "late") {
      await quiet(
        ctx.answerCallbackQuery({
          text: t(ctx.lang, "duel.cancel_late").replace(/<[^>]+>/g, ""),
          show_alert: true,
        }),
      );
    } else {
      await quiet(
        ctx.answerCallbackQuery({
          text: t(ctx.lang, "duel.cancel_late").replace(/<[^>]+>/g, ""),
          show_alert: true,
        }),
      );
    }
  });

  // Clear the rematch control under both private result messages after either player starts it.
  async function removeRematchKeyboards(match: any): Promise<void> {
    const refs: Array<[number, number | undefined]> = [
      [Number(match.p1), Number(match.resultMessageId1) || undefined],
      [Number(match.p2), Number(match.resultMessageId2) || undefined],
    ];
    await Promise.all(
      refs.map(([chatId, messageId]) => {
        if (!messageId) return Promise.resolve();
        return quiet(
          bot.api.editMessageReplyMarkup(chatId, messageId, {
            reply_markup: { inline_keyboard: [] },
          }),
        );
      }),
    );
  }

  // ───────────── rematch from the result card ─────────────
  bot.callbackQuery(/^rematch:([\w-]+)$/, async (ctx) => {
    const matchId = ctx.match[1]!;
    const previous = (await Match.findById(matchId).lean()) as any;
    if (
      !previous ||
      previous.status !== "settled" ||
      ![Number(previous.p1), Number(previous.p2)].includes(ctx.from.id)
    ) {
      await quiet(
        ctx.answerCallbackQuery({
          text:
            ctx.lang === "fa"
              ? "این دکمه برای شما معتبر نیست یا دوئل پیدا نشد."
              : "This rematch button is invalid or the duel could not be found.",
          show_alert: true,
        }),
      );
      return;
    }

    if (previous.rematchStartedAt) {
      await removeRematchKeyboards(previous);
      await quiet(
        ctx.answerCallbackQuery({
          text: t(ctx.lang, "duel.rematch_already_started"),
          show_alert: true,
        }),
      );
      return;
    }

    // One rematch queue per finished match, even if both participants tap at once.
    const lockKey = `rematch:click:${matchId}`;
    const lock = await redis.set(lockKey, "1", "EX", 86400, "NX");
    if (lock !== "OK") {
      await quiet(
        ctx.answerCallbackQuery({
          text: t(ctx.lang, "duel.rematch_already_started"),
          show_alert: true,
        }),
      );
      return;
    }

    const mode = previous.mode === "friendly" ? "friendly" : "bet";
    const currency = previous.currency as Currency;
    const amount = mode === "friendly" ? 0 : Number(previous.amount);
    try {
      const r = await joinDuel(ctx.from.id, currency, amount, mode);
      if (r.status === "queued") {
        let sent: any;
        try {
          sent = await ctx.reply(
            mode === "friendly"
              ? t(ctx.lang, "duel.searching_friendly", {
                  duration: durationLabel(r.seconds, ctx.lang),
                })
              : t(ctx.lang, "duel.searching", {
                  amount: formatAmount(amount, currency),
                  cur: curName(ctx.lang, currency),
                  duration: durationLabel(r.seconds, ctx.lang),
                }),
            {
              parse_mode: "HTML",
              reply_markup: cancelKeyboard(ctx.lang, r.ticketId),
            },
          );
        } catch (sendError) {
          // Do not leave a reserved stake in the queue if the rematch search card cannot be shown.
          await cancelTicket(ctx.from.id, r.ticketId).catch(() => undefined);
          throw sendError;
        }
        await Match.updateOne(
          { _id: matchId, status: "settled" },
          {
            $set: {
              rematchStartedBy: ctx.from.id,
              rematchStartedAt: new Date(),
            },
          },
        );
        const latest = (await Match.findById(matchId).lean()) as any;
        await removeRematchKeyboards(latest ?? previous);
        await quiet(
          ctx.answerCallbackQuery({
            text: t(ctx.lang, "duel.rematch_search_started"),
          }),
        );
        return sent;
      }
      if (r.status === "matched") {
        await Match.updateOne(
          { _id: matchId, status: "settled" },
          {
            $set: {
              rematchStartedBy: ctx.from.id,
              rematchStartedAt: new Date(),
            },
          },
        );
        const latest = (await Match.findById(matchId).lean()) as any;
        await removeRematchKeyboards(latest ?? previous);
        await quiet(
          ctx.answerCallbackQuery({
            text: t(ctx.lang, "duel.rematch_started"),
          }),
        );
        return;
      }

      await redis.del(lockKey);
      const key =
        r.status === "busy"
          ? "duel.busy"
          : r.status === "insufficient"
            ? "duel.insufficient"
            : r.status === "disabled"
              ? "duel.disabled"
              : "duel.invalid";
      await quiet(
        ctx.answerCallbackQuery({
          text: t(ctx.lang, key).replace(/<[^>]+>/g, ""),
          show_alert: true,
        }),
      );
    } catch (error) {
      await redis.del(lockKey);
      logError("rematch_start_failed", error, { matchId, userId: ctx.from.id });
      await quiet(
        ctx.answerCallbackQuery({
          text:
            ctx.lang === "fa"
              ? "شروع دوباره انجام نشد؛ دوباره تلاش کن."
              : "Could not start the rematch. Please try again.",
          show_alert: true,
        }),
      );
    }
  });

  // ───────────── duel: picking a move ─────────────
  bot.callbackQuery(/^m:([\w-]+):([rps])$/, async (ctx) => {
    const matchId = ctx.match[1]!;
    const r = await chooseMove(
      ctx.from.id,
      matchId,
      ctx.match[2] as "r" | "p" | "s",
    );
    const msg: Partial<Record<typeof r, Key>> = {
      saved: "duel.chosen",
      settled: "duel.chosen_settled",
      already: "duel.already_chosen",
      finished: "duel.finished",
      late: "duel.time_over",
      not_yours: "duel.not_yours",
    };
    await quiet(
      ctx.answerCallbackQuery({
        text: t(ctx.lang, msg[r]!).replace(/<[^>]+>/g, ""),
        show_alert: r !== "saved" && r !== "settled",
      }),
    );
    if (r === "finished" || r === "late") {
      // The alert tells the user what happened; remove the stale Rock/Paper/Scissors buttons too.
      await quiet(ctx.deleteMessage());
      return;
    }
    if (r === "saved" || r === "settled") {
      // The second pick completes the duel, so do not tell that player we are still waiting for an opponent.
      const confirmationKey: Key =
        r === "settled" ? "duel.chosen_settled" : "duel.chosen";
      await quiet(
        ctx.editMessageText(t(ctx.lang, confirmationKey), {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        }),
      );
      if (r === "saved")
        await notifyOpponentChoice(matchId, ctx.from.id).catch((e) =>
          logError("opponent_choice_notify_failed", e, { matchId }),
        );
    } else if (r === "already") {
      await quiet(ctx.editMessageReplyMarkup());
    }
  });

  // ───────────── profile dashboard ─────────────
  bot.callbackQuery(/^profile:(home|duels|finance)$/, async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    await showProfile(ctx, ctx.match[1] as "home" | "duels" | "finance", true);
  });

  bot.callbackQuery(/^profile:tx:(\d+)$/, async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    const page = Math.max(0, Math.min(100_000, Number(ctx.match[1])));
    await showProfile(ctx, "finance", true, page);
  });

  // Inline deposit/withdraw shortcuts are shown beneath the Assets message.
  bot.callbackQuery(/^balance:(deposit|withdraw)$/, async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    const cfg = await getSettings();
    const action = ctx.match[1];
    if (action === "deposit") {
      if (!cfg.features.depositsEnabled)
        return void (await say(ctx, "deposit.disabled"));
      await quiet(
        ctx.editMessageText(t(ctx.lang, "deposit.choose"), {
          parse_mode: "HTML",
          reply_markup: currencyKeyboard(ctx.lang, "dep"),
        }),
      );
    } else {
      if (!cfg.features.withdrawalsEnabled)
        return void (await say(ctx, "withdraw.disabled"));
      await quiet(
        ctx.editMessageText(t(ctx.lang, "withdraw.choose"), {
          parse_mode: "HTML",
          reply_markup: currencyKeyboard(ctx.lang, "wd"),
        }),
      );
    }
  });

  bot.callbackQuery(/^toncheck:(\d{1,12})$/, async (ctx) => {
    const invoiceNumber = Number(ctx.match[1]);
    const cooldownKey = `ton-deposit-check:${ctx.from.id}`;
    const canCheck = await redis.set(cooldownKey, "1", "EX", 3, "NX");
    if (canCheck !== "OK") {
      await quiet(
        ctx.answerCallbackQuery({
          text:
            ctx.lang === "fa"
              ? "کمی صبر کن و دوباره بررسی کن."
              : "Please wait a moment before checking again.",
          show_alert: true,
        }),
      );
      return;
    }
    await quiet(ctx.answerCallbackQuery());
    try {
      const result = await checkTonDeposit(invoiceNumber, ctx.from.id);
      if (result.status === "paid") {
        const u = await fullUser(ctx.from.id);
        const invoice = result.invoice;
        const text = t(ctx.lang, "deposit.ton_paid", {
          invoice: invoice.invoiceNumber,
          amount: formatAmount(invoice.amount, "TON"),
          txHash: esc(invoice.txHash ?? "—"),
          balance: formatAmount(
            Number(u?.balances?.TON?.available ?? 0),
            "TON",
          ),
        });
        await ctx
          .editMessageText(text, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
          })
          .catch(async () => {
            await say(ctx, "deposit.ton_paid", {
              invoice: invoice.invoiceNumber,
              amount: formatAmount(invoice.amount, "TON"),
              txHash: esc(invoice.txHash ?? "—"),
              balance: formatAmount(
                Number(u?.balances?.TON?.available ?? 0),
                "TON",
              ),
            });
          });
      } else if (result.status === "pending") {
        await say(ctx, "deposit.ton_pending");
      } else if (result.status === "already_used") {
        await say(ctx, "deposit.ton_already_used");
      } else if (result.status === "not_found") {
        await say(ctx, "deposit.ton_not_found");
      } else {
        await say(ctx, "deposit.ton_check_failed");
      }
    } catch (error) {
      logError("ton_deposit_check_failed", error, {
        invoiceNumber,
        userId: ctx.from.id,
      });
      await say(ctx, "deposit.ton_check_failed");
    }
  });

  // ───────────── deposit / withdraw: currency choice ─────────────
  bot.callbackQuery(/^dep:(IRT|TON)$/, async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    if (!(await getSettings()).features.depositsEnabled)
      return void (await say(ctx, "deposit.disabled"));
    const cur = ctx.match[1] as Currency;
    const cfg = await getSettings();
    await setState(ctx.from.id, { s: "dep", cur });
    await quiet(ctx.editMessageReplyMarkup());
    await say(ctx, cur === "IRT" ? "deposit.ask_IRT" : "deposit.ask_TON", {
      min: formatAmount(cfg.limits.minDeposit[cur], cur),
    });
  });

  bot.callbackQuery(/^wd:(IRT|TON)$/, async (ctx) => {
    await quiet(ctx.answerCallbackQuery());
    await quiet(ctx.editMessageReplyMarkup());
    const cfg = await getSettings();
    if (!cfg.features.withdrawalsEnabled)
      return void (await say(ctx, "withdraw.disabled"));
    const cur = ctx.match[1] as Currency;
    const u = await fullUser(ctx.from.id);
    if (!u) return;
    // At withdrawal start, check only that the user has at least the configured minimum balance.
    // Referral/duel eligibility and all invoice-specific validations run after the user confirms creation.
    const available = u.balances[cur].available;
    const min = cfg.limits.minWithdraw[cur];
    if (available < min)
      return void (await say(ctx, "withdraw.insufficient", {
        min: formatAmount(min, cur),
        cur: curName(ctx.lang, cur),
        available: formatAmount(available, cur),
      }));
    await setState(ctx.from.id, { s: "wd_amt", cur });
    await say(ctx, "withdraw.ask_amount", {
      cur: curName(ctx.lang, cur),
      min: formatAmount(min, cur),
      available: formatAmount(available, cur),
    });
  });

  // Confirm the resolved bank/IBAN before a Toman withdrawal invoice is created.
  bot.callbackQuery("wdc:no", async (ctx) => {
    const confirmLock = `withdraw-confirm:${ctx.from.id}`;
    const lockAcquired = await redis.set(confirmLock, "1", "EX", 30, "NX");
    if (lockAcquired !== "OK") {
      await quiet(
        ctx.answerCallbackQuery({
          text:
            ctx.lang === "fa"
              ? "درخواست برداشت در حال ثبت است."
              : "Withdrawal is already being registered.",
          show_alert: true,
        }),
      );
      return;
    }
    await quiet(ctx.answerCallbackQuery());
    try {
      const st = await getState(ctx.from.id);
      await quiet(ctx.editMessageReplyMarkup());
      if (!st || st.s !== "wd_confirm")
        return void (await say(ctx, "withdraw.confirm_expired"));
      await clearState(ctx.from.id);
      await say(ctx, "withdraw.cancelled", undefined, {
        reply_markup: mainKeyboard(
          ctx.lang,
          ctx.u?.role === "admin" || ctx.u?.role === "owner",
        ),
      });
    } finally {
      await redis.del(confirmLock).catch(() => {});
    }
  });

  bot.callbackQuery("wdc:yes", async (ctx) => {
    const confirmLock = `withdraw-confirm:${ctx.from.id}`;
    const lockAcquired = await redis.set(confirmLock, "1", "EX", 30, "NX");
    if (lockAcquired !== "OK") {
      await quiet(
        ctx.answerCallbackQuery({
          text:
            ctx.lang === "fa"
              ? "درخواست برداشت در حال ثبت است."
              : "Withdrawal is already being registered.",
          show_alert: true,
        }),
      );
      return;
    }
    await quiet(ctx.answerCallbackQuery());
    try {
      const st = await getState(ctx.from.id);
      if (!st || st.s !== "wd_confirm" || st.cur !== "IRT") {
        await quiet(ctx.editMessageReplyMarkup());
        return void (await say(ctx, "withdraw.confirm_expired"));
      }
      const cfg = await getSettings();
      if (!cfg.features.withdrawalsEnabled) {
        await clearState(ctx.from.id);
        return void (await say(ctx, "withdraw.disabled"));
      }
      const u = await fullUser(ctx.from.id);
      if (!u) {
        await clearState(ctx.from.id);
        return;
      }
      const referrals = await referralCount(ctx.from.id);
      if (referrals < cfg.limits.minReferralsForWithdraw) {
        await clearState(ctx.from.id);
        return void (await say(ctx, "withdraw.need_referrals", {
          need: cfg.limits.minReferralsForWithdraw,
          have: referrals,
        }));
      }
      const conditionalDuels = await countConditionalDuelsForWithdrawal(
        ctx.from.id,
      );
      if (conditionalDuels < cfg.limits.minDuelsForWithdraw) {
        await clearState(ctx.from.id);
        return void (await say(ctx, "withdraw.need_duels", {
          need: cfg.limits.minDuelsForWithdraw,
          have: conditionalDuels,
        }));
      }
      if (st.amount < cfg.limits.minWithdraw.IRT) {
        await clearState(ctx.from.id);
        return void (await say(ctx, "withdraw.too_low", {
          min: formatAmount(cfg.limits.minWithdraw.IRT, "IRT"),
          cur: curName(ctx.lang, "IRT"),
        }));
      }
      if (st.amount > u.balances.IRT.available) {
        await clearState(ctx.from.id);
        return void (await say(ctx, "withdraw.too_high", {
          available: formatAmount(u.balances.IRT.available, "IRT"),
          cur: curName(ctx.lang, "IRT"),
        }));
      }
      const fee = cfg.withdrawalFees.IRT ?? 0;
      if (!Number.isSafeInteger(fee) || fee < 0 || fee >= st.amount) {
        await clearState(ctx.from.id);
        return void (await say(ctx, "withdraw.fee_too_high", {
          fee: formatAmount(Math.max(0, Number(fee) || 0), "IRT"),
          cur: curName(ctx.lang, "IRT"),
        }));
      }
      const payoutAmount = st.amount - fee;
      const wid = await createWithdrawal({
        userId: ctx.from.id,
        currency: "IRT",
        amount: st.amount,
        fee,
        dest: st.dest,
        bankName: st.bankName,
        fullName: st.fullName,
      });
      await clearState(ctx.from.id);
      await quiet(ctx.editMessageReplyMarkup());
      if (!wid)
        return void (await say(ctx, "withdraw.too_high", {
          available: "—",
          cur: curName(ctx.lang, "IRT"),
        }));
      await say(
        ctx,
        "withdraw.created",
        {
          id: wid,
          amount: formatAmount(st.amount, "IRT"),
          fee: formatAmount(fee, "IRT"),
          payout: formatAmount(payoutAmount, "IRT"),
          feeReason:
            ctx.lang === "fa" ? "کارمزد ثابت بین‌بانکی" : "Fixed interbank fee",
          cur: curName(ctx.lang, "IRT"),
        },
        {
          reply_markup: mainKeyboard(
            ctx.lang,
            ctx.u?.role === "admin" || ctx.u?.role === "owner",
          ),
        },
      );
      await notifyAdminsWithdrawal({
        id: wid,
        userId: ctx.from.id,
        username: ctx.from.username,
        currency: "IRT",
        amount: st.amount,
        fee,
        payoutAmount,
        dest: st.dest,
        bankName: st.bankName,
        fullName: st.fullName,
      });
    } finally {
      await redis.del(confirmLock).catch(() => {});
    }
  });

  // TON withdrawals require an explicit destination confirmation before reserving funds or creating an invoice.
  bot.callbackQuery(/^wdt:(yes|no)$/, async (ctx) => {
    const id = ctx.from.id;
    const confirmLock = `withdraw-confirm:${id}`;
    const lockAcquired = await redis.set(confirmLock, "1", "EX", 30, "NX");
    if (lockAcquired !== "OK") {
      await quiet(
        ctx.answerCallbackQuery({
          text:
            ctx.lang === "fa"
              ? "درخواست برداشت در حال ثبت است."
              : "Withdrawal is already being registered.",
          show_alert: true,
        }),
      );
      return;
    }
    await quiet(ctx.answerCallbackQuery());
    try {
      const st = await getState(id);
      await quiet(ctx.editMessageReplyMarkup());
      if (!st || st.s !== "wd_confirm_ton")
        return void (await say(ctx, "withdraw.confirm_expired"));
      if (ctx.match[1] === "no") {
        await clearState(id);
        return void (await say(ctx, "withdraw.cancelled", undefined, {
          reply_markup: mainKeyboard(
            ctx.lang,
            ctx.u?.role === "admin" || ctx.u?.role === "owner",
          ),
        }));
      }
      const cfg = await getSettings();
      if (!cfg.features.withdrawalsEnabled) {
        await clearState(id);
        return void (await say(ctx, "withdraw.disabled"));
      }
      const u = await fullUser(id);
      if (!u) {
        await clearState(id);
        return;
      }
      const referrals = await referralCount(id);
      if (referrals < cfg.limits.minReferralsForWithdraw) {
        await clearState(id);
        return void (await say(ctx, "withdraw.need_referrals", {
          need: cfg.limits.minReferralsForWithdraw,
          have: referrals,
        }));
      }
      const conditionalDuels = await countConditionalDuelsForWithdrawal(id);
      if (conditionalDuels < cfg.limits.minDuelsForWithdraw) {
        await clearState(id);
        return void (await say(ctx, "withdraw.need_duels", {
          need: cfg.limits.minDuelsForWithdraw,
          have: conditionalDuels,
        }));
      }
      if (st.amount < cfg.limits.minWithdraw.TON) {
        await clearState(id);
        return void (await say(ctx, "withdraw.too_low", {
          min: formatAmount(cfg.limits.minWithdraw.TON, "TON"),
          cur: curName(ctx.lang, "TON"),
        }));
      }
      if (st.amount > u.balances.TON.available) {
        await clearState(id);
        return void (await say(ctx, "withdraw.too_high", {
          available: formatAmount(u.balances.TON.available, "TON"),
          cur: curName(ctx.lang, "TON"),
        }));
      }
      const dest = parseDest("TON", st.dest);
      if (!dest || dest !== st.dest) {
        await clearState(id);
        return void (await say(ctx, "withdraw.bad_dest"));
      }
      const fee = cfg.withdrawalFees.TON ?? 0;
      if (!Number.isSafeInteger(fee) || fee < 0 || fee >= st.amount) {
        await clearState(id);
        return void (await say(ctx, "withdraw.fee_too_high", {
          fee: formatAmount(Math.max(0, Number(fee) || 0), "TON"),
          cur: curName(ctx.lang, "TON"),
        }));
      }
      const payoutAmount = st.amount - fee;
      const wid = await createWithdrawal({
        userId: id,
        currency: "TON",
        amount: st.amount,
        fee,
        dest,
      });
      await clearState(id);
      if (!wid)
        return void (await say(ctx, "withdraw.too_high", {
          available: "—",
          cur: curName(ctx.lang, "TON"),
        }));
      await say(
        ctx,
        "withdraw.created",
        {
          id: wid,
          amount: formatAmount(st.amount, "TON"),
          fee: formatAmount(fee, "TON"),
          payout: formatAmount(payoutAmount, "TON"),
          feeReason:
            ctx.lang === "fa"
              ? "کارمزد ثابت شبکه TON"
              : "Fixed TON network fee",
          cur: curName(ctx.lang, "TON"),
        },
        {
          reply_markup: mainKeyboard(
            ctx.lang,
            ctx.u?.role === "admin" || ctx.u?.role === "owner",
          ),
        },
      );
      await notifyAdminsWithdrawal({
        id: wid,
        userId: id,
        username: ctx.from.username,
        currency: "TON",
        amount: st.amount,
        fee,
        payoutAmount,
        dest,
      });
    } finally {
      await redis.del(confirmLock).catch(() => {});
    }
  });

  // Withdrawal rejections require an administrator-provided reason before refunding the user.
  bot.callbackQuery(/^wda:(ok|no):([\w-]+)$/, async (ctx) => {
    if (ctx.u?.role !== "owner" && !OWNER_IDS.has(ctx.from.id)) {
      await quiet(
        ctx.answerCallbackQuery({
          text:
            ctx.lang === "fa"
              ? "فقط مالک می‌تواند فاکتور برداشت را بررسی کند."
              : "Only the owner can review withdrawal invoices.",
          show_alert: true,
        }),
      );
      return;
    }
    await quiet(ctx.answerCallbackQuery());
    const approve = ctx.match[1] === "ok";
    const withdrawalId = ctx.match[2]!;
    const message = ctx.callbackQuery.message;
    const ref =
      message && "message_id" in message
        ? {
            chatId: message.chat.id,
            messageId: message.message_id,
            originalText: "text" in message ? message.text : "",
          }
        : undefined;
    if (!approve) {
      await setState(ctx.from.id, {
        s: "admin_withdraw_reject_reason",
        withdrawalId,
        ...(ref
          ? {
              chatId: ref.chatId,
              messageId: ref.messageId,
              originalText: ref.originalText,
            }
          : {}),
      });
      await ctx.reply(t(ctx.lang, "admin.withdraw_rejection_reason_prompt"), {
        parse_mode: "HTML",
      });
      return;
    }
    await finalizeWithdrawalDecision(ctx, withdrawalId, true, "", ref);
  });

  registerAdmin(); // commands must be registered before the generic text router

  // ───────────── plain text: duel chat, menu buttons, dialogue steps ─────────────
  bot.on("message:text", async (ctx) => {
    const id = ctx.from.id;
    const text = ctx.message.text;
    const activeState = await getState(id);
    if (activeState?.s === "admin_broadcast" && activeState.step === "message")
      return handleState(ctx, activeState, text);

    const selectedLang = languageFromText(text);
    if (selectedLang) {
      await applyLanguageAndShowMenu(ctx, selectedLang);
      return;
    }

    const matchId = await currentMatchId(id);
    if (matchId) {
      if (matchButton(text)) return void (await say(ctx, "duel.busy")); // menu is locked during a duel
      if (text.startsWith("/")) return;
      const r = await relayChat(id, matchId, text, ctx.message.message_id);
      if (r === "blocked") await say(ctx, "chat.blocked");
      else if (r === "limit") await say(ctx, "chat.limit");
      else if (r === "too_long") await say(ctx, "chat.too_long");
      else if (r === "disabled") await say(ctx, "chat.disabled");
      else if (typeof r === "object" && r.status === "penalized") {
        await say(ctx, "chat.profanity_penalty", {
          amount: formatAmount(r.amount, r.currency),
          cur: curName(ctx.lang, r.currency),
        });
      } else if (typeof r === "object" && r.status === "penalty_insufficient") {
        await say(ctx, "chat.profanity_penalty_no_balance", {
          amount: formatAmount(r.amount, r.currency),
          cur: curName(ctx.lang, r.currency),
        });
      }
      return;
    }

    const btn = matchButton(text);
    if (btn) {
      await clearState(id);
      return runButton(ctx, btn);
    }
    const st = await getState(id);
    if (st) return handleState(ctx, st, text);
    await say(ctx, "menu.hint", undefined, {
      reply_markup: mainKeyboard(
        ctx.lang,
        ctx.u?.role === "admin" || ctx.u?.role === "owner",
      ),
    });
  });

  // Media, stickers and other non-text messages can be used as a broadcast source too.
  bot.on("message", async (ctx) => {
    const id = ctx.from?.id;
    if (!id || ctx.chat?.type !== "private") return;
    const state = await getState(id);
    if (state?.s === "admin_broadcast" && state.step === "message")
      return handleState(ctx, state, "");
    if (await currentMatchId(id)) await say(ctx, "chat.text_only");
  });
}

async function showProfile(
  ctx: BotContext,
  section: "home" | "duels" | "finance",
  edit = false,
  requestedTxPage = 0,
): Promise<void> {
  const id = ctx.from!.id;
  const user = await fullUser(id);
  if (!user) return;
  const name = esc(user.firstName ?? ctx.from!.first_name ?? "Player");
  const username = user.username
    ? `@${esc(user.username)}`
    : ctx.lang === "fa"
      ? "ثبت نشده"
      : "not set";
  const joined = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString(
        ctx.lang === "fa" ? "fa-IR" : "en-GB",
      )
    : "—";
  const identity = t(ctx.lang, "profile.identity", { name, username, joined });
  let text = `${t(ctx.lang, "profile.title")}
${identity}`;
  if (section === "home" || section === "duels") {
    const d = await getDuelStats(id);
    text += `

${t(ctx.lang, "profile.duels", { total: d.total, bet: d.bet, friendly: d.friendly, wins: d.wins, losses: d.losses, draws: d.draws })}`;
  }
  if (section === "home" || section === "finance") {
    const f = await getFinanceStats(id);
    const values = {
      depIRT: formatAmount(f.deposited.IRT, "IRT"),
      depTON: formatAmount(f.deposited.TON, "TON"),
      wonIRT: formatAmount(f.won.IRT, "IRT"),
      wonTON: formatAmount(f.won.TON, "TON"),
      lostIRT: formatAmount(f.lost.IRT, "IRT"),
      lostTON: formatAmount(f.lost.TON, "TON"),
      wdIRT: formatAmount(f.withdrawn.IRT, "IRT"),
      wdTON: formatAmount(f.withdrawn.TON, "TON"),
      refIRT: formatAmount(f.referral.IRT, "IRT"),
      refTON: formatAmount(f.referral.TON, "TON"),
      bonusIRT: formatAmount(f.registrationBonus.IRT, "IRT"),
      bonusTON: formatAmount(f.registrationBonus.TON, "TON"),
      groupRewardIRT: formatAmount(f.groupReward.IRT, "IRT"),
      groupRewardTON: formatAmount(f.groupReward.TON, "TON"),
      balIRT: formatAmount(f.available.IRT, "IRT"),
      balTON: formatAmount(f.available.TON, "TON"),
      lockIRT: formatAmount(f.locked.IRT, "IRT"),
      lockTON: formatAmount(f.locked.TON, "TON"),
    };
    text += `

${t(ctx.lang, "profile.finance", values)}

${ctx.lang === "fa" ? "🎁 درآمد پاداش فعال‌سازی گروه: " : "🎁 Group activation rewards: "}<b>${values.groupRewardIRT} ${curName(ctx.lang, "IRT")} · ${values.groupRewardTON} ${curName(ctx.lang, "TON")}</b>`;
    const transactionCount = await Ledger.countDocuments({
      userId: id,
      currency: { $in: ["IRT", "TON"] },
    });
    const txPages = Math.max(1, Math.ceil(transactionCount / 6));
    const txPage = Math.max(0, Math.min(requestedTxPage, txPages - 1));
    const rows = await Ledger.find({
      userId: id,
      currency: { $in: ["IRT", "TON"] },
    })
      .sort({ at: -1, _id: -1 })
      .skip(txPage * 6)
      .limit(6)
      .lean();
    if (transactionCount) {
      const labels: Record<string, string> =
        ctx.lang === "fa"
          ? {
              deposit: "واریز",
              referral: "پاداش زیرمجموعه",
              registration_bonus: "بونوس ثبت‌نام",
              withdraw_hold: "درخواست برداشت",
              withdraw_paid: "برداشت پرداخت‌شده",
              withdraw_rejected: "برداشت ردشده",
              hold: "رزرو شرط",
              unhold: "بازگشت شرط",
              settle: "تسویه دوئل",
              admin_adjust: "اصلاح توسط مدیر",
              profanity_penalty: "جریمه کلمه فیلترشده",
              group_reward: "پاداش فعال‌سازی گروه",
              group_reserve: "رزرو دوئل گروهی",
              group_release: "آزادسازی دوئل گروهی",
              group_bet: "تسویه دوئل گروهی",
              group_friendly: "پایان دوئل دوستانه گروهی",
            }
          : {
              deposit: "Deposit",
              referral: "Referral reward",
              registration_bonus: "Signup bonus",
              withdraw_hold: "Withdrawal request",
              withdraw_paid: "Withdrawal paid",
              withdraw_rejected: "Withdrawal rejected",
              hold: "Bet reserved",
              unhold: "Bet refunded",
              settle: "Duel settlement",
              admin_adjust: "Admin adjustment",
              profanity_penalty: "Filtered-word penalty",
              group_reward: "Group activation reward",
              group_reserve: "Group duel reserve",
              group_release: "Group duel release",
              group_bet: "Group duel settlement",
              group_friendly: "Group friendly duel",
            };
      text += `\n\n${ctx.lang === "fa" ? "📜 <b>سابقه تراکنش‌ها</b>" : "📜 <b>Transaction history</b>"} · ${ctx.lang === "fa" ? `صفحه ${txPage + 1} از ${txPages}` : `Page ${txPage + 1} of ${txPages}`}`;
      for (const row of rows) {
        const cur = row.currency as Currency;
        const availableDelta = Number(row.available ?? 0);
        const lockedDelta = Number(row.locked ?? 0);
        const netDelta = availableDelta + lockedDelta;
        let amountText: string;
        if (netDelta !== 0) {
          const signed = netDelta > 0 ? "+" : "";
          amountText = `${signed}${formatAmount(netDelta, cur)} ${curName(ctx.lang, cur)}`;
        } else if (lockedDelta > 0) {
          amountText = `${ctx.lang === "fa" ? "رزرو" : "Reserved"} ${formatAmount(lockedDelta, cur)} ${curName(ctx.lang, cur)}`;
        } else if (lockedDelta < 0) {
          amountText = `${ctx.lang === "fa" ? "آزادسازی" : "Released"} ${formatAmount(-lockedDelta, cur)} ${curName(ctx.lang, cur)}`;
        } else {
          amountText = `0 ${curName(ctx.lang, cur)}`;
        }
        const date = row.at
          ? new Date(row.at).toLocaleDateString(
              ctx.lang === "fa" ? "fa-IR" : "en-GB",
            )
          : "—";
        text += `\n• ${date} — ${labels[row.type] ?? row.type}: <b>${amountText}</b>`;
      }
    }
  }
  const historyCount =
    section === "home" || section === "finance"
      ? await Ledger.countDocuments({
          userId: id,
          currency: { $in: ["IRT", "TON"] },
        })
      : 0;
  const markup = profileKeyboard(
    ctx.lang,
    section,
    Math.min(requestedTxPage, Math.max(0, Math.ceil(historyCount / 6) - 1)),
    Math.max(1, Math.ceil(historyCount / 6)),
  );
  if (edit && ctx.callbackQuery?.message) {
    await quiet(
      ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: markup }),
    );
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: markup });
  }
}

// ───────────── reply-keyboard buttons ─────────────
async function runButton(ctx: any, btn: ButtonKey): Promise<void> {
  const lang = ctx.lang;
  switch (btn) {
    case "btn.duel": {
      const cfg = await getSettings();
      if (!cfg.features.duelsEnabled)
        return void (await say(ctx, "duel.disabled"));
      return void (await say(ctx, "duel.choose_currency", undefined, {
        reply_markup: currencyKeyboard(lang, "dq:c"),
      }));
    }
    case "btn.add_group": {
      const me = await bot.api.getMe();
      if (!me.username) {
        return void (await ctx.reply(
          lang === "fa"
            ? "⚠️ برای ساخت لینک افزودن گروه، نام کاربری عمومی ربات تنظیم نشده است."
            : "⚠️ The bot does not have a public username, so a group-add link cannot be created.",
        ));
      }
      const url = `https://t.me/${me.username}?startgroup&admin=delete_messages`;
      return void (await ctx.reply(
        lang === "fa"
          ? "برای افزودن ربات به گروه، دکمهٔ زیر را بزن."
          : "Tap below to add the bot to a group.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    lang === "fa"
                      ? "👥 افزودن ربات به گروه"
                      : "👥 Add bot to group",
                  url,
                  style: "success",
                },
              ],
            ],
          } as any,
        },
      ));
    }
    case "btn.friendly": {
      const r = await joinDuel(ctx.from!.id, "IRT", 0, "friendly");
      if (r.status === "disabled")
        return void (await say(ctx, "duel.disabled"));
      if (r.status === "busy") return void (await say(ctx, "duel.busy"));
      if (r.status === "queued")
        return void (await say(
          ctx,
          "duel.searching_friendly",
          { duration: durationLabel(r.seconds, ctx.lang) },
          { reply_markup: cancelKeyboard(lang, r.ticketId) },
        ));
      if (r.status === "insufficient")
        return void (await say(ctx, "duel.insufficient"));
      if (r.status === "invalid") return void (await say(ctx, "duel.invalid"));
      return;
    }
    case "btn.profile":
      return void (await showProfile(ctx, "home"));
    case "btn.finance_history":
      return void (await showProfile(ctx, "finance"));
    case "btn.duel_history":
      return void (await showProfile(ctx, "duels"));
    case "btn.admin":
      if (ctx.u?.role !== "owner" && !OWNER_IDS.has(ctx.from.id))
        return void (await say(ctx, "admin.not_allowed"));
      return void (await ctx.reply(t(lang, "admin.panel"), {
        parse_mode: "HTML",
        reply_markup: adminMenuKeyboard(
          lang,
          ctx.u?.role === "owner" || OWNER_IDS.has(ctx.from!.id),
        ),
      }));
    case "btn.balance": {
      const u = await fullUser(ctx.from!.id);
      if (!u) return;
      const lines = CURRENCIES.map((c) =>
        t(lang, "balance.line", {
          cur: curName(lang, c),
          available: formatAmount(u.balances[c].available, c),
          locked: formatAmount(u.balances[c].locked, c),
        }),
      );
      return void (await ctx.reply(
        [t(lang, "balance.title"), ...lines].join("\n"),
        { parse_mode: "HTML", reply_markup: balanceActionsKeyboard(lang) },
      ));
    }
    case "btn.deposit": {
      const cfg = await getSettings();
      if (!cfg.features.depositsEnabled)
        return void (await say(ctx, "deposit.disabled"));
      return void (await say(ctx, "deposit.choose", undefined, {
        reply_markup: currencyKeyboard(lang, "dep"),
      }));
    }
    case "btn.withdraw": {
      const cfg = await getSettings();
      if (!cfg.features.withdrawalsEnabled)
        return void (await say(ctx, "withdraw.disabled"));
      return void (await say(ctx, "withdraw.choose", undefined, {
        reply_markup: currencyKeyboard(lang, "wd"),
      }));
    }
    case "btn.finance":
      return void (await say(ctx, "finance.menu", undefined, {
        reply_markup: financeKeyboard(lang),
      }));
    case "btn.referral": {
      const cfg = await getSettings();
      const code = await getReferralCode(ctx.from!.id);
      const link = `https://t.me/${bot.botInfo.username}?start=ref_${code}`;
      return void (await say(ctx, "referral.info", {
        link,
        count: await referralCount(ctx.from!.id),
        reward: formatAmount(
          cfg.referral.reward[ctx.lang === "fa" ? "IRT" : "TON"],
          ctx.lang === "fa" ? "IRT" : "TON",
        ),
        cur: curName(ctx.lang, ctx.lang === "fa" ? "IRT" : "TON"),
      }));
    }
    case "btn.language":
      return void (await ctx.reply(t(lang, "lang.pick"), {
        parse_mode: "HTML",
        reply_markup: languageKeyboard(),
      }));
    case "btn.support": {
      const support = (await getSettings()).manualDeposit.supportUsername;
      if (!support) return void (await say(ctx, "support.info"));
      return void (await ctx.reply(
        `${t(lang, "support.info")}\n<a href="https://t.me/${support}">@${support}</a>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      ));
    }
    case "btn.back":
      return void (await say(ctx, "menu.hint", undefined, {
        reply_markup: mainKeyboard(
          lang,
          ctx.u?.role === "admin" || ctx.u?.role === "owner",
        ),
      }));
  }
}

// ───────────── multi-step dialogues (deposit amount, withdraw amount + destination) ─────────────
async function handleState(
  ctx: BotContext,
  st: St,
  text: string,
): Promise<void> {
  const id = ctx.from!.id;
  if (
    st.s === "admin_deposit_reject_reason" ||
    st.s === "admin_withdraw_reject_reason"
  ) {
    if (text.trim() === "/cancel") {
      await clearState(id);
      return void (await ctx.reply(
        ctx.lang === "fa"
          ? "✅ عملیات رد فاکتور لغو شد؛ فاکتور همچنان در انتظار بررسی است."
          : "✅ Rejection cancelled; the invoice remains pending.",
      ));
    }
    if (
      st.s === "admin_withdraw_reject_reason"
        ? ctx.u?.role !== "owner" && !OWNER_IDS.has(id)
        : ctx.u?.role !== "admin" && ctx.u?.role !== "owner"
    ) {
      await clearState(id);
      return void (await say(ctx, "admin.not_allowed"));
    }
    const reason = text.trim();
    if (reason.length < 3 || reason.length > 500)
      return void (await say(ctx, "admin.rejection_reason_invalid"));
    if (st.s === "admin_deposit_reject_reason") {
      await processManualDepositDecision(
        ctx,
        st.invoiceNumber,
        false,
        reason,
        st.chatId !== undefined && st.messageId !== undefined
          ? { chatId: st.chatId, messageId: st.messageId }
          : undefined,
      );
    } else {
      await finalizeWithdrawalDecision(
        ctx,
        st.withdrawalId,
        false,
        reason,
        st.chatId !== undefined && st.messageId !== undefined
          ? {
              chatId: st.chatId,
              messageId: st.messageId,
              originalText: st.originalText,
            }
          : undefined,
      );
    }
    await clearState(id);
    return;
  }
  if (st.s === "admin_invoice_search") {
    if (text.trim() === "/cancel") {
      await clearState(id);
      return void (await ctx.reply(
        ctx.lang === "fa"
          ? "✅ جستجوی فاکتور لغو شد."
          : "✅ Invoice search cancelled.",
      ));
    }
    if (ctx.u?.role !== "admin" && ctx.u?.role !== "owner") {
      await clearState(id);
      return void (await say(ctx, "admin.not_allowed"));
    }
    // One-shot state: later user messages must not accidentally be treated as invoice codes.
    await clearState(id);
    return handleManualInvoiceSearch(ctx, text);
  }
  if (st.s === "admin_channel_add") {
    if (text.trim() === "/cancel") {
      await clearState(id);
      return void (await ctx.reply("✅ افزودن کانال لغو شد."));
    }
    if (ctx.u?.role !== "admin" && ctx.u?.role !== "owner") {
      await clearState(id);
      return void (await say(ctx, "admin.not_allowed"));
    }
    const result = await addRequiredChannel(id, text);
    await ctx.reply(result, { parse_mode: "HTML" });
    if (result.startsWith("✅")) await clearState(id);
    return;
  }
  if (st.s === "admin_backup_interval") {
    if (text.trim() === "/cancel") {
      await clearState(id);
      return void (await ctx.reply(
        ctx.lang === "fa"
          ? "✅ تنظیم فاصلهٔ بکاپ لغو شد."
          : "✅ Backup interval change cancelled.",
      ));
    }
    if (!isOwnerUser(ctx)) {
      await clearState(id);
      return void (await ctx.reply(
        ctx.lang === "fa"
          ? "⛔ این تنظیم فقط برای مالک ربات است."
          : "⛔ Only the bot owner can change backup settings.",
      ));
    }
    const normalized = normalizeDigits(text.trim());
    const minutes = Number(normalized);
    if (
      !/^\d+$/.test(normalized) ||
      !Number.isSafeInteger(minutes) ||
      minutes < 1 ||
      minutes > 1440
    ) {
      return void (await ctx.reply(
        ctx.lang === "fa"
          ? "❌ فاصله باید یک عدد صحیح بین ۱ تا ۱۴۴۰ دقیقه باشد. نمونه: <code>32</code> یا <code>120</code>. برای لغو /cancel را بفرست."
          : "❌ Enter a whole number from 1 to 1440 minutes, e.g. <code>32</code> or <code>120</code>. Send /cancel to abort.",
        { parse_mode: "HTML" },
      ));
    }
    await redis.set(
      BACKUP_CONFIG_KEY,
      JSON.stringify({
        intervalMinutes: minutes,
        updatedAt: new Date().toISOString(),
        updatedBy: id,
      }),
    );
    await redis.publish(
      BACKUP_COMMAND_CHANNEL,
      JSON.stringify({ action: "refresh-config", requestedBy: id }),
    );
    await clearState(id);
    await ctx.reply(
      ctx.lang === "fa"
        ? `✅ فاصلهٔ بکاپ ذخیره شد: هر <b>${minutes}</b> دقیقه. Worker تنظیم جدید را اعمال می‌کند.`
        : `✅ Backup interval saved: every <b>${minutes}</b> minutes. The worker will apply it.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (st.s === "admin_setting") {
    if (text.trim() === "/cancel") {
      await clearState(id);
      return void (await ctx.reply("✅ تغییر تنظیم لغو شد.", {
        reply_markup: mainKeyboard(
          ctx.lang,
          ctx.u?.role === "admin" || ctx.u?.role === "owner",
        ),
      }));
    }
    if (ctx.u?.role !== "admin" && ctx.u?.role !== "owner") {
      await clearState(id);
      return void (await say(ctx, "admin.not_allowed"));
    }
    const result = await updateAdminSettingFromInput(id, st.key, text);
    await ctx.reply(result.message, { parse_mode: "HTML" });
    if (result.ok) await clearState(id);
    return;
  }
  if (st.s === "admin_broadcast" || st.s === "admin_broadcast_confirm") {
    if (!isOwnerUser(ctx)) {
      await clearState(id);
      return void (await ctx.reply(
        "⛔ فقط مالک می‌تواند پیام انبوه را مدیریت کند.",
      ));
    }
    if (text.trim() === "/cancel") {
      await clearState(id);
      return void (await ctx.reply("✅ تنظیم پیام انبوه لغو شد."));
    }
    if (st.s === "admin_broadcast_confirm") {
      return void (await ctx.reply(
        "برای شروع یا لغو کمپین از دکمه‌های تأیید/لغو زیر خلاصه استفاده کن.",
      ));
    }
    if (st.step === "user_filter")
      return void (await ctx.reply(
        "ابتدا یکی از گزینه‌های فیلتر کاربران را از دکمه‌های زیر انتخاب کن.",
      ));
    if (st.step === "user_limit") {
      const normalized = normalizeDigits(text.trim());
      const count = Number(normalized);
      if (
        !/^\d+$/.test(normalized) ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 200000
      ) {
        return void (await ctx.reply("❌ عدد باید بین ۱ تا ۲۰۰۰۰۰ باشد."));
      }
      const filter = { type: "limit" as const, limit: count };
      const matching = await countEligibleUsers(filter);
      if (!matching)
        return void (await ctx.reply(
          "⚠️ هیچ کاربر واجد شرایطی پیدا نشد. عدد دیگری وارد کن.",
        ));
      return void (await advanceBroadcastAfterUserFilter(ctx, {
        ...st,
        userFilter: filter,
      }));
    }
    if (st.step === "user_condition") {
      const kind = st.pendingFilter;
      if (!kind)
        return void (await ctx.reply(
          "❌ نوع فیلتر مشخص نیست؛ تنظیم فیلتر را دوباره شروع کن.",
        ));
      const filter = parseBroadcastUserCondition(kind, text);
      if (!filter)
        return void (await ctx.reply(
          "❌ شرط نامعتبر است. نمونه: <code>TON &gt; 10</code>، <code>IRT &lt; 50000</code> یا برای زیرمجموعه <code>&gt; 5</code>.",
          { parse_mode: "HTML" },
        ));
      const matching = await countEligibleUsers(filter);
      if (!matching)
        return void (await ctx.reply(
          "⚠️ هیچ کاربری با این شرط پیدا نشد. شرط را اصلاح کن.",
        ));
      return void (await advanceBroadcastAfterUserFilter(ctx, {
        ...st,
        userFilter: filter,
        pendingFilter: undefined,
      }));
    }
    if (st.step === "group_limit") {
      const normalized = normalizeDigits(text.trim());
      const amount = Number(normalized);
      if (
        !/^\d+$/.test(normalized) ||
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        amount > 200000
      ) {
        return void (await ctx.reply(
          "❌ تعداد گروه باید از صفر (همه گروه‌ها) تا ۲۰۰۰۰۰ باشد.",
        ));
      }
      const groups = await GroupTarget.countDocuments({ status: "active" });
      if (groups === 0 && st.audience === "groups") {
        await clearState(id);
        return void (await ctx.reply(
          "⚠️ هیچ گروه فعالی در فهرست ثبت نشده است. مطمئن شو Gateway آپدیت‌های my_chat_member را به Stream ارسال می‌کند و ربات در گروه‌ها حضور دارد.",
        ));
      }
      if (groups === 0 && st.audience === "both") {
        await ctx.reply(
          "⚠️ هنوز گروه فعالی ثبت نشده؛ کمپین در ادامه فقط برای کاربران ارسال می‌شود.",
        );
        return void (await promptBroadcastMessage(ctx, {
          ...st,
          audience: "users",
          groupLimit: undefined,
        }));
      }
      const groupLimit = amount === 0 ? undefined : Math.min(amount, groups);
      return void (await promptBroadcastMessage(ctx, { ...st, groupLimit }));
    }
    if (st.step === "message") {
      const message = (ctx as any).message;
      if (!message?.message_id || !ctx.chat)
        return void (await ctx.reply(
          "❌ این پیام قابل استفاده به‌عنوان محتوای کمپین نیست.",
        ));
      const counts =
        st.counts ??
        (await getBroadcastCounts(st.userFilter ?? { type: "all" }));
      const targetUsers = st.audience === "groups" ? 0 : counts.matchingUsers;
      const targetGroups = ["groups", "both"].includes(st.audience)
        ? Math.min(
            counts.activeGroups,
            st.groupLimit && st.groupLimit > 0
              ? st.groupLimit
              : counts.activeGroups,
          )
        : 0;
      await setState(id, {
        s: "admin_broadcast_confirm",
        audience: st.audience,
        userFilter: st.userFilter,
        groupLimit: st.groupLimit,
        sourceChatId: String(ctx.chat.id),
        sourceMessageId: message.message_id,
        totalUsers: counts.registeredUsers,
        totalGroups: counts.activeGroups,
        targetUsers,
        targetGroups,
      });
      const contentType = "text" in message ? "متن" : "رسانه/محتوا";
      return void (await ctx.reply(
        `🔎 <b>پیش‌نمایش کمپین پیام انبوه</b>

` +
          `نوع محتوا: <b>${contentType}</b>
مخاطب: <b>${st.audience === "users" ? "کاربران" : st.audience === "groups" ? "گروه‌ها" : "کاربران و گروه‌ها"}</b>
` +
          `👤 کل کاربران ثبت‌شده: <b>${counts.registeredUsers.toLocaleString("en-US")}</b>
👤 کاربران فعال و قابل ارسال: <b>${counts.eligibleUsers.toLocaleString("en-US")}</b>
🎯 کاربران انتخاب‌شده: <b>${targetUsers.toLocaleString("en-US")}</b>
` +
          `👥 کل گروه‌های فعال: <b>${counts.activeGroups.toLocaleString("en-US")}</b>
🎯 گروه‌های فعال انتخاب‌شده: <b>${targetGroups.toLocaleString("en-US")}</b>
` +
          `📦 مجموع ارسال‌ها: <b>${(targetUsers + targetGroups).toLocaleString("en-US")}</b>
` +
          `${
            st.audience !== "groups"
              ? `فیلتر کاربران: <b>${broadcastFilterLabel(st.userFilter)}</b>
`
              : ""
          }
` +
          `ارسال در Worker مستقل، با سرعت محدود و گزارش نهایی انجام می‌شود. آیا کمپین را شروع کنم؟`,
        {
          parse_mode: "HTML",
          reply_markup: broadcastConfirmKeyboard(ctx.lang),
        },
      ));
    }
    return;
  }
  const cfg = await getSettings();
  if (st.s === "wd_confirm" || st.s === "wd_confirm_ton")
    return void (await say(ctx, "withdraw.confirm_use_buttons"));
  const cur = st.cur;
  if (st.s === "dep" && !cfg.features.depositsEnabled) {
    await clearState(id);
    return void (await say(ctx, "deposit.disabled"));
  }
  if (
    (st.s === "wd_amt" || st.s === "wd_dest" || st.s === "wd_name") &&
    !cfg.features.withdrawalsEnabled
  ) {
    await clearState(id);
    return void (await say(ctx, "withdraw.disabled"));
  }

  if (st.s === "dep") {
    const amount = parseAmount(text, cur);
    if (amount === null) return void (await say(ctx, "deposit.bad_amount"));
    const min = cfg.limits.minDeposit[cur];
    if (amount < min)
      return void (await say(ctx, "deposit.too_low", {
        min: formatAmount(min, cur),
        cur: curName(ctx.lang, cur),
      }));
    try {
      if (cur === "TON") {
        const invoice = await createTonDepositInvoice({ userId: id, amount });
        await clearState(id);
        const testnetNote = IS_TON_TESTNET
          ? ctx.lang === "fa"
            ? "\n\n🧪 <b>حالت تست (testnet)</b>: دکمه‌ی Tonkeeper غیرفعال است؛ از ولت testnet به آدرس بالا با مبلغ دقیق و کامنت بالا ارسال کن."
            : "\n\n🧪 <b>Testnet mode</b>: the Tonkeeper button is disabled; send from a testnet wallet to the address above with the exact amount and comment."
          : "";
        const text =
          t(ctx.lang, "deposit.ton_invoice", {
            invoice: invoice.invoiceNumber,
            amount: formatAmount(invoice.amount, "TON"),
            address: esc(invoice.recipientAddress),
            comment: esc(invoice.comment),
          }) + testnetNote;
        await ctx.reply(text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard: [
              ...(invoice.paymentUrl
                ? [
                    [
                      {
                        text:
                          ctx.lang === "fa"
                            ? "💎 پرداخت با Tonkeeper"
                            : "💎 Pay with Tonkeeper",
                        url: invoice.paymentUrl,
                      },
                    ],
                  ]
                : []),
              [
                {
                  text:
                    ctx.lang === "fa"
                      ? "🔍 بررسی تراکنش"
                      : "🔍 Check transaction",
                  callback_data: `toncheck:${invoice.invoiceNumber}`,
                },
              ],
            ],
          },
        });
        return;
      }
      const invoice = await createManualDepositInvoice({
        userId: id,
        currency: cur,
        amount,
      });
      await clearState(id);
      const paymentDetails =
        cur === "IRT"
          ? `💳 ${ctx.lang === "fa" ? "شماره کارت" : "Bank card"}: <code>${esc(invoice.cardNumber)}</code>\n👤 ${ctx.lang === "fa" ? "به نام" : "Card holder"}: <b>${esc(invoice.cardHolder)}</b>`
          : `💎 ${ctx.lang === "fa" ? "واریز TON از مسیر شبکه TON انجام می‌شود." : "TON deposits are handled through the TON network flow."}`;
      const supportLink = `<a href="https://t.me/${invoice.supportUsername}">@${esc(invoice.supportUsername)}</a>`;
      const username = invoice.userUsername
        ? `@${esc(invoice.userUsername)}`
        : ctx.lang === "fa"
          ? "ثبت نشده"
          : "not set";
      const createdAt = invoice.createdAt
        ? new Date(invoice.createdAt).toLocaleString(
            ctx.lang === "fa" ? "fa-IR" : "en-GB",
          )
        : "—";
      await say(
        ctx,
        "deposit.manual_invoice",
        {
          invoice: invoice.invoiceNumber,
          name: esc(invoice.userFirstName || ctx.from!.first_name),
          username,
          userId: id,
          amount: formatAmount(amount, cur),
          cur: curName(ctx.lang, cur),
          createdAt: esc(createdAt),
          paymentDetails,
          supportLink,
        },
        { link_preview_options: { is_disabled: true } },
      );
    } catch (e) {
      await clearState(id);
      if (e instanceof ManualDepositAmountBelowMinimum) {
        return void (await say(ctx, "deposit.too_low", {
          min: formatAmount(e.minimum, cur),
          cur: curName(ctx.lang, cur),
        }));
      }
      if (e instanceof ManualDepositConfigurationError) {
        return void (await say(ctx, "deposit.manual_unconfigured"));
      }
      logError("create_manual_deposit_invoice_failed", e, {
        userId: id,
        currency: cur,
        amount,
      });
      await say(ctx, "deposit.unavailable");
    }
    return;
  }

  if (st.s === "wd_name") {
    const fullName = text.trim().replace(/\s+/g, " ");
    const parts = fullName.split(" ");
    if (
      parts.length < 2 ||
      fullName.length < 3 ||
      fullName.length > 80 ||
      !/^[\p{L}][\p{L}\s'’ .\u200c-]*$/u.test(fullName)
    ) {
      return void (await say(ctx, "withdraw.bad_account_name"));
    }
    const fee = st.fee ?? cfg.withdrawalFees.IRT ?? 0;
    // Fee validity is deliberately checked only after the user clicks Create Invoice.
    await setState(id, {
      s: "wd_confirm",
      cur: "IRT",
      amount: st.amount,
      fee,
      dest: st.dest,
      bankName: st.bankName,
      fullName,
    });
    return void (await say(
      ctx,
      "withdraw.iban_confirm",
      {
        amount: formatAmount(st.amount, "IRT"),
        cur: curName(ctx.lang, "IRT"),
        fullName: esc(fullName),
        bank: esc(st.bankName),
        iban: esc(st.dest),
      },
      { reply_markup: withdrawalBankConfirmKeyboard(ctx.lang) },
    ));
  }

  if (st.s === "wd_amt") {
    const u = await fullUser(id);
    const amount = parseAmount(text, cur);
    if (!u || amount === null)
      return void (await say(ctx, "withdraw.bad_amount"));

    // Validate the requested amount immediately: it must satisfy the configured minimum
    // withdrawal and cannot exceed the user's currently available balance. Referral/conditional-
    // duel eligibility and fee validity are intentionally deferred until invoice confirmation.
    const minimum = cfg.limits.minWithdraw[cur];
    if (amount < minimum) {
      return void (await say(ctx, "withdraw.too_low", {
        min: formatAmount(minimum, cur),
        cur: curName(ctx.lang, cur),
      }));
    }
    const available = u.balances[cur].available;
    if (amount > available) {
      return void (await say(ctx, "withdraw.too_high", {
        available: formatAmount(available, cur),
        cur: curName(ctx.lang, cur),
      }));
    }

    const fee = cfg.withdrawalFees[cur] ?? 0;
    await setState(id, { s: "wd_dest", cur, amount, fee });
    return void (await say(
      ctx,
      cur === "IRT" ? "withdraw.ask_dest_IRT" : "withdraw.ask_dest_TON",
    ));
  }

  // Validate destination syntax while collecting details. Eligibility, withdrawal feature status,
  // and fee rules are checked after the final confirmation button; amount and balance are checked
  // here and revalidated again at confirmation to handle balance changes during data entry.
  if (cur === "IRT") {
    const iban = normalizeIranianIban(text);
    if (!iban) return void (await say(ctx, "withdraw.bad_dest"));
    const identified = getBankNameFromShaba(iban);
    const bankName = identified
      ? identified.bank
      : ctx.lang === "fa"
        ? "بانک نامشخص"
        : "Unknown bank";
    await setState(id, {
      s: "wd_name",
      cur: "IRT",
      amount: st.amount,
      fee: st.fee ?? cfg.withdrawalFees.IRT ?? 0,
      dest: iban,
      bankName,
    });
    return void (await say(ctx, "withdraw.ask_account_name", {
      bank: esc(bankName),
    }));
  }

  const dest = parseDest(cur, text);
  if (!dest) return void (await say(ctx, "withdraw.bad_dest"));
  if (cur === "TON") {
    const fee = st.fee ?? cfg.withdrawalFees.TON ?? 0;
    // Fee validity is deliberately checked only after the user clicks Create Invoice.
    await setState(id, {
      s: "wd_confirm_ton",
      cur: "TON",
      amount: st.amount,
      fee,
      dest,
    });
    return void (await say(
      ctx,
      "withdraw.ton_confirm",
      {
        amount: formatAmount(st.amount, "TON"),
        cur: curName(ctx.lang, "TON"),
        address: esc(dest),
      },
      { reply_markup: withdrawalTonConfirmKeyboard(ctx.lang) },
    ));
  }
  const fee = cfg.withdrawalFees[cur] ?? 0;
  if (!Number.isSafeInteger(fee) || fee < 0 || fee >= st.amount)
    return void (await say(ctx, "withdraw.fee_too_high", {
      fee: formatAmount(Math.max(0, Number(fee) || 0), cur),
      cur: curName(ctx.lang, cur),
    }));
  const payoutAmount = st.amount - fee;
  const wid = await createWithdrawal({
    userId: id,
    currency: cur,
    amount: st.amount,
    fee,
    dest,
  });
  await clearState(id);
  if (!wid)
    return void (await say(ctx, "withdraw.too_high", {
      available: "—",
      cur: curName(ctx.lang, cur),
    }));
  await say(
    ctx,
    "withdraw.created",
    {
      id: wid,
      amount: formatAmount(st.amount, cur),
      fee: formatAmount(fee, cur),
      payout: formatAmount(payoutAmount, cur),
      feeReason:
        cur === "IRT"
          ? ctx.lang === "fa"
            ? "کارمزد ثابت بین‌بانکی"
            : "Fixed interbank fee"
          : ctx.lang === "fa"
            ? "کارمزد ثابت شبکه TON"
            : "Fixed TON network fee",
      cur: curName(ctx.lang, cur),
    },
    {
      reply_markup: mainKeyboard(
        ctx.lang,
        ctx.u?.role === "admin" || ctx.u?.role === "owner",
      ),
    },
  );
  await notifyAdminsWithdrawal({
    id: wid,
    userId: id,
    username: ctx.from!.username,
    currency: cur,
    amount: st.amount,
    fee,
    payoutAmount,
    dest,
  });
}

export { adminIds };
