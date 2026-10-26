import mongoose from "mongoose";
import {
  GroupDuel,
  GroupConfig,
  House,
  Ledger,
  SettingsModel,
  User,
} from "./models";
import { bot } from "./bot/instance";
import { logError } from "./logger";

type Lang = "fa" | "en";
const fmt = (n: number, c: string) =>
  c === "TON"
    ? (n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })
    : Math.round(n).toLocaleString("en-US");
const label = (c: string, lang: Lang) =>
  c === "IRT" ? (lang === "fa" ? "تومان" : "Toman") : "TON";
const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const tr = (lang: Lang, fa: string, en: string) => (lang === "fa" ? fa : en);
const langOf = (v: unknown): Lang => (v === "en" ? "en" : "fa");
const mention = (id: number, u: any, lang: Lang) => {
  const displayName =
    [u?.firstName, u?.lastName].filter(Boolean).join(" ") ||
    tr(lang, "کاربر", "Player");
  return `<a href="tg://user?id=${id}">${esc(displayName)}</a>`;
};
const beats = (a: string, b: string) =>
  (a === "r" && b === "s") ||
  (a === "s" && b === "p") ||
  (a === "p" && b === "r");
const choiceName = (c: string | null | undefined, lang: Lang) =>
  c === "r"
    ? tr(lang, "سنگ", "Rock")
    : c === "p"
      ? tr(lang, "کاغذ", "Paper")
      : c === "s"
        ? tr(lang, "قیچی", "Scissors")
        : tr(lang, "بدون انتخاب", "No move");

// New friendly duels have no stake. Keep legacy friendly invitations with an existing locked stake refundable.
const duelHasStake = (duel: any): boolean =>
  duel?.mode === "bet" ||
  (duel?.mode === "friendly" &&
    Number(duel?.amount) > 0 &&
    (duel?.currency === "IRT" || duel?.currency === "TON"));

async function releaseLocked(
  uid: number,
  currency: string,
  amount: number,
  key: string,
  session: any,
) {
  if (await Ledger.exists({ key }).session(session)) return;
  const result = await User.updateOne(
    { tgId: uid, [`balances.${currency}.locked`]: { $gte: amount } },
    {
      $inc: {
        [`balances.${currency}.available`]: amount,
        [`balances.${currency}.locked`]: -amount,
      },
    },
    { session },
  );
  if (!result.modifiedCount)
    throw new Error(
      `group locked-balance invariant failed: ${uid}/${currency}`,
    );
  await Ledger.create(
    [
      {
        key,
        userId: uid,
        currency,
        type: "group_release",
        available: amount,
        locked: -amount,
        ref: key,
      },
    ],
    { session },
  );
}

async function removeInviteButtons(duel: any) {
  if (!duel?.inviteMessageId) return;
  await bot.api
    .editMessageReplyMarkup(Number(duel.chatId), Number(duel.inviteMessageId), {
      reply_markup: {
        inline_keyboard: [],
      },
    })
    .catch(() => undefined);
}

async function postGroupReply(
  chatId: number,
  replyToMessageId: number | undefined,
  text: string,
) {
  if (replyToMessageId) {
    try {
      return await bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_parameters: { message_id: replyToMessageId },
      } as any);
    } catch (error) {
      // A deleted/unavailable source message must not suppress the actual duel result.
      logError("group_reply_reference_failed_fallback_to_chat", error, {
        chatId,
        replyToMessageId,
      });
    }
  }
  return bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
}

export async function processGroupInviteTimeout(
  id: string,
  deadline: number,
  scheduleSuccessor: (id: string, deadline: number) => Promise<void>,
): Promise<void> {
  let result: any = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const found = (await GroupDuel.findOne({ _id: id, status: "pending" })
        .session(session)
        .lean()) as any;
      if (!found) return;
      const due = Number(found.inviteDeadline ?? deadline);
      if (due > Date.now()) {
        result = { early: true, deadline: due };
        return;
      }
      const duel = (await GroupDuel.findOneAndUpdate(
        { _id: id, status: "pending", inviteDeadline: { $lte: Date.now() } },
        { $set: { status: "expired" } },
        { new: true, session },
      ).lean()) as any;
      if (!duel) return;
      if (duelHasStake(duel)) {
        await releaseLocked(
          Number(duel.initiatorId),
          String(duel.currency),
          Number(duel.amount),
          `group:invite-release:${id}`,
          session,
        );
      }
      result = duel;
    });
  } finally {
    await session.endSession();
  }
  if (result?.early) {
    await scheduleSuccessor(id, result.deadline);
    return;
  }
  if (!result) return;

  const config = (await GroupConfig.findOne({
    chatId: String(result.chatId),
  }).lean()) as any;
  const lang = langOf(config?.language);
  const [u1, u2] = await Promise.all([
    User.findOne({ tgId: result.initiatorId })
      .select("firstName lastName username")
      .lean(),
    User.findOne({ tgId: result.opponentId })
      .select("firstName lastName username")
      .lean(),
  ]);
  const p1 = mention(Number(result.initiatorId), u1, lang);
  const p2 = mention(Number(result.opponentId), u2, lang);
  const mode =
    result.mode === "friendly"
      ? tr(lang, "دوستانه", "friendly")
      : tr(lang, "شرطی", "bet");
  const hasStake =
    result.mode === "bet" && Number(result.amount) > 0 && duelHasStake(result);
  const text = tr(
    lang,
    hasStake
      ? `⌛ <b>مهلت دعوت تمام شد</b>\nدعوت ${p1} از ${p2} برای رقابت ${mode} به مبلغ ${fmt(Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)} خودکار رد شد و مبلغ رزروشده به کیف پول دعوت‌کننده برگشت.`
      : `⌛ <b>مهلت دعوت تمام شد</b>\nدعوت ${p1} از ${p2} برای رقابت ${mode} منقضی شد و به‌صورت خودکار رد شد؛ این دعوت شرط مالی نداشت.`,
    hasStake
      ? `⌛ <b>Invitation expired</b>\n${p1}’s ${mode} invitation to ${p2} for ${fmt(Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)} was automatically rejected, and the challenger’s reserved stake was returned.`
      : `⌛ <b>Invitation expired</b>\n${p1}’s ${mode} invitation to ${p2} expired and was automatically rejected without a stake.`,
  );
  await removeInviteButtons(result);
  await postGroupReply(
    Number(result.chatId),
    Number(result.inviteMessageId) || undefined,
    text,
  ).catch((error: unknown) =>
    logError("group_invite_timeout_notify_failed", error, { id }),
  );
}

export async function processGroupMatchReminder(
  id: string,
  reminderAt: number,
  scheduleSuccessor: (id: string, reminderAt: number) => Promise<void>,
): Promise<void> {
  const found = (await GroupDuel.findOne({ _id: id, status: "choosing" })
    .select(
      "_id chatId initiatorId opponentId p1Choice p2Choice reminderAt reminderSent deadline gameMessageId",
    )
    .lean()) as any;
  if (!found || found.reminderSent || !found.gameMessageId) return;

  const due = Number(found.reminderAt ?? reminderAt);
  if (!Number.isFinite(due)) return;
  if (due > Date.now()) {
    await scheduleSuccessor(id, due);
    return;
  }
  if (Number(found.deadline) <= Date.now()) return;
  if (found.p1Choice && found.p2Choice) return;

  // Claim the reminder so duplicate/recovered jobs do not normally announce twice.
  const claimed = (await GroupDuel.findOneAndUpdate(
    {
      _id: id,
      status: "choosing",
      reminderSent: { $ne: true },
      reminderAt: { $lte: Date.now() },
      deadline: { $gt: Date.now() },
      $or: [{ p1Choice: null }, { p2Choice: null }],
    },
    { $set: { reminderSent: true } },
    { new: true },
  ).lean()) as any;
  if (!claimed) return;

  try {
    // Re-read after claiming so a player who clicked at the same moment is not mentioned.
    const latest = (await GroupDuel.findOne({
      _id: id,
      status: "choosing",
      deadline: { $gt: Date.now() },
    })
      .select(
        "_id chatId initiatorId opponentId p1Choice p2Choice gameMessageId deadline",
      )
      .lean()) as any;
    if (!latest || (latest.p1Choice && latest.p2Choice)) return;

    const config = (await GroupConfig.findOne({ chatId: String(latest.chatId) })
      .select("language")
      .lean()) as any;
    const lang = langOf(config?.language);
    const missing1 = !latest.p1Choice;
    const missing2 = !latest.p2Choice;
    const [u1, u2] = await Promise.all([
      missing1
        ? User.findOne({ tgId: Number(latest.initiatorId) })
            .select("firstName lastName username")
            .lean()
        : Promise.resolve(null),
      missing2
        ? User.findOne({ tgId: Number(latest.opponentId) })
            .select("firstName lastName username")
            .lean()
        : Promise.resolve(null),
    ]);
    const p1 = mention(Number(latest.initiatorId), u1, lang);
    const p2 = mention(Number(latest.opponentId), u2, lang);
    const remainingSeconds = Math.max(
      1,
      Math.ceil((Number(latest.deadline) - Date.now()) / 1000),
    );
    const secondsFa = remainingSeconds.toLocaleString("fa-IR");
    const secondsEn = remainingSeconds.toLocaleString("en-US");
    const timeFa = `⏰ <b>فقط ${secondsFa} ثانیه تا پایان مهلت انتخاب باقی مانده است!</b>`;
    const timeEn = `⏰ <b>${secondsEn} second${remainingSeconds === 1 ? "" : "s"} remain to choose!</b>`;
    const text =
      missing1 && missing2
        ? tr(
            lang,
            `${timeFa}\n${p1} و ${p2} هنوز انتخابی ثبت نکرده‌اید. لطفاً پیش از پایان مهلت، سنگ، کاغذ یا قیچی را انتخاب کنید.`,
            `${timeEn}\n${p1} and ${p2}, neither of you has chosen yet. Please select rock, paper, or scissors before time runs out.`,
          )
        : tr(
            lang,
            `${timeFa}\n${missing1 ? p1 : p2} هنوز انتخابی ثبت نکرده است. لطفاً پیش از پایان مهلت، سنگ، کاغذ یا قیچی را انتخاب کن.`,
            `${timeEn}\n${missing1 ? p1 : p2} has not chosen yet. Please select rock, paper, or scissors before time runs out.`,
          );

    await postGroupReply(
      Number(latest.chatId),
      Number(latest.gameMessageId) || undefined,
      text,
    );
  } catch (error) {
    // Allow BullMQ's retry policy to attempt delivery again after a Telegram/API failure.
    await GroupDuel.updateOne(
      { _id: id, status: "choosing" },
      { $set: { reminderSent: false } },
    ).catch(() => undefined);
    logError("group_match_reminder_failed", error, { id, reminderAt: due });
    throw error;
  }
}

export async function processGroupMatchTimeout(
  id: string,
  deadline: number,
  scheduleSuccessor: (id: string, deadline: number) => Promise<void>,
): Promise<void> {
  let result: any = (await GroupDuel.findOne({
    _id: id,
    status: "settled",
    timeoutSettled: true,
    timeoutResultSentAt: { $exists: false },
  }).lean()) as any;

  if (!result) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const found = (await GroupDuel.findOne({ _id: id, status: "choosing" })
          .session(session)
          .lean()) as any;
        if (!found) return;
        const due = Number(found.deadline ?? deadline);
        if (due > Date.now()) {
          result = { early: true, deadline: due };
          return;
        }
        const duel = (await GroupDuel.findOneAndUpdate(
          { _id: id, status: "choosing", deadline: { $lte: Date.now() } },
          { $set: { status: "settling" } },
          { new: true, session },
        ).lean()) as any;
        if (!duel) return;
        if (!duel.gameMessageId) {
          if (duelHasStake(duel)) {
            await releaseLocked(
              Number(duel.initiatorId),
              String(duel.currency),
              Number(duel.amount),
              `group:cancel-release:${id}:${duel.initiatorId}`,
              session,
            );
            await releaseLocked(
              Number(duel.opponentId),
              String(duel.currency),
              Number(duel.amount),
              `group:cancel-release:${id}:${duel.opponentId}`,
              session,
            );
          }
          const cancelled = await GroupDuel.updateOne(
            { _id: id, status: "settling" },
            {
              $set: {
                status: "cancelled",
                outcome: "cancelled_before_start",
                fee: 0,
                reward: 0,
                settledAt: new Date(),
              },
            },
            { session },
          );
          if (!cancelled.modifiedCount)
            throw new Error("group cancel state race");
          result = { cancelled: true, ...duel };
          return;
        }

        const settings = (await SettingsModel.findById("main")
          .session(session)
          .lean()) as any;
        const fees = settings?.fees ?? {
          win: 1000,
          draw: 500,
          winTimeout: 2000,
          drawTimeout: 1000,
        };
        let winnerId: number | null = null;
        let fee = 0;
        let payout1 = 0;
        let payout2 = 0;
        let outcome = "draw_timeout";
        const amount = Number(duel.amount);

        if (duel.p1Choice && duel.p2Choice) {
          if (duel.p1Choice === duel.p2Choice) {
            const each = Math.floor((amount * Number(fees.draw)) / 10000);
            fee = each * 2;
            payout1 = amount - each;
            payout2 = payout1;
            outcome = "draw";
          } else {
            winnerId = beats(duel.p1Choice, duel.p2Choice)
              ? Number(duel.initiatorId)
              : Number(duel.opponentId);
            fee = Math.floor((amount * Number(fees.win)) / 10000);
            payout1 =
              winnerId === Number(duel.initiatorId) ? 2 * amount - fee : 0;
            payout2 =
              winnerId === Number(duel.opponentId) ? 2 * amount - fee : 0;
            outcome = "win";
          }
        } else if (duel.p1Choice || duel.p2Choice) {
          winnerId = duel.p1Choice
            ? Number(duel.initiatorId)
            : Number(duel.opponentId);
          fee = Math.floor((amount * Number(fees.winTimeout)) / 10000);
          payout1 =
            winnerId === Number(duel.initiatorId) ? 2 * amount - fee : 0;
          payout2 = winnerId === Number(duel.opponentId) ? 2 * amount - fee : 0;
          outcome = "win_timeout";
        } else {
          const each = Math.floor((amount * Number(fees.drawTimeout)) / 10000);
          fee = each * 2;
          payout1 = amount - each;
          payout2 = payout1;
          outcome = "draw_timeout";
        }

        const stakeBearing = duelHasStake(duel);
        const stakeFreeFriendly = duel.mode === "friendly" && !stakeBearing;
        if (duel.mode === "friendly") {
          // Do not touch balances for new friendly duels. Legacy stake-bearing friendly duels are still refunded.
          payout1 = stakeBearing ? amount : 0;
          payout2 = stakeBearing ? amount : 0;
          fee = 0;
          outcome =
            duel.p1Choice && duel.p2Choice
              ? duel.p1Choice === duel.p2Choice
                ? "draw"
                : "win"
              : winnerId
                ? "win_timeout"
                : "draw_timeout";
        }
        const rewardPercent = Math.max(
          0,
          Math.min(100, Number(settings?.groupRewardPercent ?? 20)),
        );
        const reward =
          duel.mode === "bet" ? Math.floor((fee * rewardPercent) / 100) : 0;
        const houseFee = fee - reward;

        for (const player of [
          { userId: Number(duel.initiatorId), payout: payout1 },
          { userId: Number(duel.opponentId), payout: payout2 },
        ]) {
          if (stakeFreeFriendly) {
            const update = await User.updateOne(
              { tgId: player.userId },
              {
                $inc: { duelsPlayed: 1 },
                $setOnInsert: {
                  tgId: player.userId,
                  lang: null,
                  role: "user",
                  referrerId: null,
                  referralPaid: false,
                  blockedBot: false,
                  "balances.IRT.available": 0,
                  "balances.IRT.locked": 0,
                  "balances.TON.available": 0,
                  "balances.TON.locked": 0,
                },
              },
              { session, upsert: true },
            );
            if (!update.modifiedCount && !update.upsertedCount)
              throw new Error(
                `group friendly duel stats update failed: ${player.userId}`,
              );
            continue;
          }
          const update = await User.updateOne(
            {
              tgId: player.userId,
              [`balances.${duel.currency}.locked`]: { $gte: amount },
            },
            {
              $inc: {
                [`balances.${duel.currency}.locked`]: -amount,
                [`balances.${duel.currency}.available`]: player.payout,
                duelsPlayed: 1,
              },
            },
            { session },
          );
          if (!update.modifiedCount)
            throw new Error(
              `group settlement locked-balance invariant failed: ${player.userId}`,
            );
          await Ledger.create(
            [
              {
                key: `group:settle:${id}:${player.userId}`,
                userId: player.userId,
                currency: duel.currency,
                type: `group_${outcome}`,
                available: player.payout,
                locked: -amount,
                ref: id,
              },
            ],
            { session },
          );
        }
        if (houseFee > 0) {
          await House.updateOne(
            { _id: "house" },
            { $inc: { [`balances.${duel.currency}`]: houseFee } },
            { upsert: true, session },
          );
          await Ledger.create(
            [
              {
                key: `group:house:${id}`,
                userId: 0,
                currency: duel.currency,
                type: "group_fee",
                available: houseFee,
                locked: 0,
                ref: id,
              },
            ],
            { session },
          );
        }
        if (reward > 0) {
          const updated = await User.updateOne(
            { tgId: Number(duel.activatorId) },
            {
              $inc: { [`balances.${duel.currency}.available`]: reward },
              $setOnInsert: {
                lang: null,
                role: "user",
                referrerId: null,
                referralPaid: false,
                duelsPlayed: 0,
                blockedBot: false,
                "balances.IRT.locked": 0,
                "balances.TON.locked": 0,
                [`balances.${duel.currency === "IRT" ? "TON" : "IRT"}.available`]: 0,
              },
            },
            { session, upsert: true },
          );
          if (!updated.modifiedCount && !updated.upsertedCount)
            throw new Error("group activator reward upsert failed");
          await Ledger.create(
            [
              {
                key: `group:reward:${id}`,
                userId: Number(duel.activatorId),
                currency: duel.currency,
                type: "group_reward",
                available: reward,
                locked: 0,
                ref: id,
              },
            ],
            { session },
          );
        }
        const changed = await GroupDuel.updateOne(
          { _id: id, status: "settling" },
          {
            $set: {
              status: "settled",
              winnerId,
              outcome,
              fee,
              reward,
              rewardPercent,
              rewardPaid: reward > 0,
              timeoutSettled: true,
              settledAt: new Date(),
            },
          },
          { session },
        );
        if (!changed.modifiedCount)
          throw new Error("group duel settlement race");
        result = {
          ...duel,
          winnerId,
          outcome,
          fee,
          reward,
          rewardPercent,
          houseFee,
          settledAt: new Date(),
        };
      });
    } finally {
      await session.endSession();
    }
  }
  if (result?.early) {
    await scheduleSuccessor(id, result.deadline);
    return;
  }
  if (!result) return;
  if (result.cancelled) {
    const config = (await GroupConfig.findOne({
      chatId: String(result.chatId),
    }).lean()) as any;
    const lang = langOf(config?.language);
    await postGroupReply(
      Number(result.chatId),
      Number(result.inviteMessageId) || undefined,
      duelHasStake(result)
        ? tr(
            lang,
            "⚠️ بازی قبل از ارسال دکمه‌های انتخاب لغو شد؛ مبالغ رزروشده آزاد شدند.",
            "⚠️ The game was cancelled before its move buttons were posted; reserved funds were released.",
          )
        : tr(
            lang,
            "⚠️ رقابت دوستانه قبل از شروع لغو شد؛ هیچ مبلغی رزرو نشده بود.",
            "⚠️ The friendly duel was cancelled before it started; no funds had been reserved.",
          ),
    ).catch(() => undefined);
    return;
  }

  const config = (await GroupConfig.findOne({
    chatId: String(result.chatId),
  }).lean()) as any;
  const lang = langOf(config?.language);
  const [u1, u2] = await Promise.all([
    User.findOne({ tgId: result.initiatorId })
      .select("firstName lastName username")
      .lean(),
    User.findOne({ tgId: result.opponentId })
      .select("firstName lastName username")
      .lean(),
  ]);
  const p1 = mention(Number(result.initiatorId), u1, lang);
  const p2 = mention(Number(result.opponentId), u2, lang);
  const winner =
    result.winnerId === Number(result.initiatorId)
      ? p1
      : result.winnerId === Number(result.opponentId)
        ? p2
        : null;
  const loser =
    result.winnerId === Number(result.initiatorId)
      ? p2
      : result.winnerId === Number(result.opponentId)
        ? p1
        : null;
  const resultLine = winner
    ? tr(
        lang,
        `🏆 <b>برنده:</b> ${winner}\n💔 <b>بازنده:</b> ${loser}`,
        `🏆 <b>Winner:</b> ${winner}\n💔 <b>Loser:</b> ${loser}`,
      )
    : tr(lang, "🤝 <b>نتیجه مساوی شد.</b>", "🤝 <b>The result is a draw.</b>");
  const mode =
    result.mode === "friendly"
      ? tr(lang, "دوستانه", "friendly")
      : tr(lang, "شرطی", "bet");
  const showStake = duelHasStake(result);
  const moneySummaryFa = showStake
    ? `\n💰 <b>مبلغ هر بازیکن:</b> ${fmt(Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🏦 <b>مجموع مبلغ رقابت:</b> ${fmt(2 * Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🧾 <b>کارمزد:</b> ${fmt(Number(result.fee), String(result.currency))} ${label(String(result.currency), lang)}`
    : "\n🆓 رقابت دوستانه بدون شرط مالی بود.";
  const moneySummaryEn = showStake
    ? `\n💰 <b>Stake per player:</b> ${fmt(Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🏦 <b>Total duel stake:</b> ${fmt(2 * Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🧾 <b>Fee:</b> ${fmt(Number(result.fee), String(result.currency))} ${label(String(result.currency), lang)}`
    : "\n🆓 This friendly duel had no stake.";
  const timeoutLine =
    result.outcome === "draw_timeout" && !result.p1Choice && !result.p2Choice
      ? tr(
          lang,
          "\n⌛ مهلت تمام شد و هیچ‌یک از بازیکنان انتخابی ثبت نکرد؛ رقابت مساوی شد.",
          "\n⌛ Time ran out before either player chose; the duel is a draw.",
        )
      : result.outcome === "win_timeout"
        ? tr(
            lang,
            "\n⌛ مهلت تمام شد؛ بازیکنی که انتخابش را ثبت کرده بود برنده شد.",
            "\n⌛ Time ran out; the player who submitted a move wins.",
          )
        : "";
  const resultText = tr(
    lang,
    `🏁 <b>پایان رقابت ${mode}</b>${timeoutLine}\n${resultLine}\n🎮 <b>انتخاب‌ها:</b> ${p1}: ${choiceName(result.p1Choice, lang)} · ${p2}: ${choiceName(result.p2Choice, lang)}${moneySummaryFa}`,
    `🏁 <b>${mode} duel finished</b>${timeoutLine}\n${resultLine}\n🎮 <b>Moves:</b> ${p1}: ${choiceName(result.p1Choice, lang)} · ${p2}: ${choiceName(result.p2Choice, lang)}${moneySummaryEn}`,
  );
  if (result.gameMessageId) {
    // Preserve the original game prompt and remove only inactive move buttons.
    await bot.api
      .editMessageReplyMarkup(
        Number(result.chatId),
        Number(result.gameMessageId),
        { reply_markup: { inline_keyboard: [] } },
      )
      .catch(() => undefined);
  }
  await postGroupReply(
    Number(result.chatId),
    Number(result.gameMessageId) || Number(result.inviteMessageId) || undefined,
    resultText,
  ).catch((error: unknown) => {
    logError("group_timeout_result_send_failed", error, {
      id,
      chatId: result.chatId,
      outcome: result.outcome,
    });
    // Let BullMQ retry. A retry reloads the already-settled duel and retries only this announcement.
    throw error;
  });
  await GroupDuel.updateOne(
    {
      _id: id,
      status: "settled",
      timeoutSettled: true,
      timeoutResultSentAt: { $exists: false },
    },
    { $set: { timeoutResultSentAt: new Date() } },
  );

  if (Number(result.reward) > 0) {
    const groupTitle = String(
      config?.title ?? tr(lang, "گروه تلگرام", "Telegram group"),
    );
    const rewardText = tr(
      lang,
      `🎉 <b>بابت برگزاری دوئل در گروهتان پاداش دریافت کردید</b>\n\n📍 <b>گروه:</b> ${esc(groupTitle)}\n⚔️ <b>رویداد:</b> یک دوئل ${mode} در این گروه به پایان رسید.\n💰 <b>مبلغ هر بازیکن:</b> ${fmt(Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🏦 <b>مجموع مبلغ دوئل:</b> ${fmt(2 * Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🧾 <b>کارمزد محاسبه‌شده:</b> ${fmt(Number(result.fee), String(result.currency))} ${label(String(result.currency), lang)}\n📊 <b>درصد پاداش فعال‌کننده:</b> ${Number(result.rewardPercent)}%\n🎁 <b>واریزی به کیف پولت:</b> +${fmt(Number(result.reward), String(result.currency))} ${label(String(result.currency), lang)}\n\nاین مبلغ به موجودی قابل‌استفادهٔ کیف پولت اضافه شد.`,
      `🎉 <b>You received a reward for hosting a duel in your group</b>\n\n📍 <b>Group:</b> ${esc(groupTitle)}\n⚔️ <b>Event:</b> A ${mode} duel finished in this group.\n💰 <b>Stake per player:</b> ${fmt(Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🏦 <b>Total duel stake:</b> ${fmt(2 * Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🧾 <b>Calculated fee:</b> ${fmt(Number(result.fee), String(result.currency))} ${label(String(result.currency), lang)}\n📊 <b>Activator reward rate:</b> ${Number(result.rewardPercent)}%\n🎁 <b>Credited to your wallet:</b> +${fmt(Number(result.reward), String(result.currency))} ${label(String(result.currency), lang)}\n\nThis amount was added to your available wallet balance.`,
    );
    await bot.api
      .sendMessage(Number(result.activatorId), rewardText, {
        parse_mode: "HTML",
      })
      .catch((error: unknown) => {
        logError("group_reward_private_notify_failed", error, {
          duelId: id,
          activatorId: result.activatorId,
          reward: result.reward,
        });
      });
  }
}
