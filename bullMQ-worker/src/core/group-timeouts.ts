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

async function rawBotCall(method: string, payload: Record<string, unknown>): Promise<any> {
  const raw = (bot.api as any).raw;
  const call = raw?.[method];
  if (typeof call !== "function") throw new Error(`GRAMMY_RAW_METHOD_UNAVAILABLE:${method}`);
  return call(payload);
}

async function sendPrivateGroupMessage(chatId: number, receiverUserId: number, text: string, options: Record<string, unknown> = {}, replyMessageId?: number): Promise<number> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    ...options,
    ephemeral_message_parameters: { receiver_user_id: receiverUserId },
  };
  if (replyMessageId) payload.reply_parameters = { message_id: replyMessageId };
  const sent = await rawBotCall("sendMessage", payload);
  if (Number.isInteger(sent?.ephemeral_message_id)) return Number(sent.ephemeral_message_id);
  if (Number.isInteger(sent?.message_id)) {
    await bot.api.deleteMessage(chatId, Number(sent.message_id)).catch(() => undefined);
  }
  throw new Error("EPHEMERAL_SEND_NOT_PRIVATE");
}

async function deletePrivateGroupMessage(chatId: number, receiverUserId: number, ephemeralMessageId: number): Promise<void> {
  if (!ephemeralMessageId) return;
  await rawBotCall("deleteEphemeralMessage", {
    chat_id: chatId,
    receiver_user_id: receiverUserId,
    ephemeral_message_id: ephemeralMessageId,
  });
}

async function editPrivateGroupMessage(chatId: number, receiverUserId: number, ephemeralMessageId: number, text: string, options: Record<string, unknown> = {}): Promise<void> {
  if (!ephemeralMessageId) throw new Error("EPHEMERAL_MESSAGE_ID_REQUIRED");
  await rawBotCall("editEphemeralMessageText", {
    chat_id: chatId,
    receiver_user_id: receiverUserId,
    ephemeral_message_id: ephemeralMessageId,
    text,
    ...options,
  });
}

function groupMoveKeyboard(id: string, lang: Lang) {
  return { inline_keyboard: [[
    { text: tr(lang, "🪨 سنگ", "🪨 Rock"), callback_data: `gw:move:${id}:r`, style: "primary" },
    { text: tr(lang, "📄 کاغذ", "📄 Paper"), callback_data: `gw:move:${id}:p`, style: "primary" },
    { text: tr(lang, "✂️ قیچی", "✂️ Scissors"), callback_data: `gw:move:${id}:s`, style: "primary" },
  ]] };
}

async function cleanupPrivateGroupCards(duel: any): Promise<void> {
  const chatId = Number(duel.chatId);
  const items: Array<[number, unknown]> = [
    [Number(duel.initiatorId), duel.initiatorWaitEphemeralId],
    [Number(duel.opponentId), duel.opponentInviteEphemeralId],
    [Number(duel.initiatorId), duel.initiatorGameEphemeralId],
    [Number(duel.opponentId), duel.opponentGameEphemeralId],
  ];
  await Promise.all(items.filter(([, id]) => Number(id) > 0).map(([uid, id]) =>
    deletePrivateGroupMessage(chatId, uid, Number(id)).catch(() => undefined),
  ));
}

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
  if (Number(duel?.opponentInviteEphemeralId) > 0) {
    await deletePrivateGroupMessage(Number(duel.chatId), Number(duel.opponentId), Number(duel.opponentInviteEphemeralId)).catch(() => undefined);
  }
  if (Number(duel?.initiatorWaitEphemeralId) > 0) {
    await deletePrivateGroupMessage(Number(duel.chatId), Number(duel.initiatorId), Number(duel.initiatorWaitEphemeralId)).catch(() => undefined);
  }
  // Backward compatibility for invitations created by old releases.
  if (duel?.inviteMessageId) {
    await bot.api.editMessageReplyMarkup(Number(duel.chatId), Number(duel.inviteMessageId), {
      reply_markup: { inline_keyboard: [] },
    }).catch(() => undefined);
  }
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

async function sendGroupDuelNotice(duelId: string, chatId: number, text: string, replyToMessageId?: number): Promise<number> {
  const sent = await bot.api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_notification: false,
    ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
  } as any);
  const messageId = Number((sent as any)?.message_id) || 0;
  if (!messageId) throw new Error("GROUP_NOTICE_MESSAGE_ID_MISSING");
  try {
    const stored = await GroupDuel.updateOne({ _id: duelId }, { $addToSet: { publicNoticeMessageIds: messageId } });
    if (!stored.matchedCount) throw new Error("GROUP_NOTICE_DUEL_NOT_FOUND");
    return messageId;
  } catch (error) {
    // Prevent an announcement from becoming an untracked orphan if MongoDB fails.
    await bot.api.deleteMessage(chatId, messageId).catch(() => undefined);
    throw error;
  }
}

async function deleteGroupDuelPublicNotices(duel: any): Promise<void> {
  if (!duel?.chatId) return;
  const current = duel._id
    ? (await GroupDuel.findById(String(duel._id)).select("publicNoticeMessageIds gameMessageId inviteMessageId resultMessageId").lean()) as any
    : null;
  const keep = Number(duel.resultMessageId ?? current?.resultMessageId) || 0;
  const ids = [...new Set([
    ...(Array.isArray(duel.publicNoticeMessageIds) ? duel.publicNoticeMessageIds.map(Number) : []),
    ...(Array.isArray(current?.publicNoticeMessageIds) ? current.publicNoticeMessageIds.map(Number) : []),
    Number(duel.gameMessageId ?? current?.gameMessageId) || 0,
    Number(duel.inviteMessageId ?? current?.inviteMessageId) || 0,
  ].filter((id) => id > 0 && id !== keep))];
  await Promise.all(ids.map((messageId) =>
    bot.api.deleteMessage(Number(duel.chatId), messageId).catch(() => undefined),
  ));
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

  await removeInviteButtons(result);
  await deleteGroupDuelPublicNotices(result);
  const [initiator, opponent] = await Promise.all([
    User.findOne({ tgId: Number(result.initiatorId) }).select("firstName lastName username").lean(),
    User.findOne({ tgId: Number(result.opponentId) }).select("firstName lastName username").lean(),
  ]);
  const config = (await GroupConfig.findOne({ chatId: String(result.chatId) }).select("language").lean()) as any;
  const lang = langOf(config?.language);
  const p1 = mention(Number(result.initiatorId), initiator, lang);
  const p2 = mention(Number(result.opponentId), opponent, lang);
  const text = tr(lang,
    `⌛ مهلت دعوت ${p1} از ${p2} تمام شد؛ مبلغ رزروشده، در صورت وجود، آزاد شد.`,
    `⌛ ${p1}’s invitation to ${p2} expired; any reserved stake was released.`,
  );
  if (Number(result.lifecycleVersion) === 2) {
    await sendGroupDuelNotice(id, Number(result.chatId), text).catch((error) =>
      logError("group_invite_timeout_public_notice_failed", error, { id, chatId: result.chatId }),
    );
  }
  await Promise.all([Number(result.initiatorId), Number(result.opponentId)].map((uid) =>
    sendPrivateGroupMessage(Number(result.chatId), uid, text, { parse_mode: "HTML" }).catch((error) =>
      logError("group_invite_timeout_private_notice_failed", error, { id, uid }),
    ),
  ));
}

export async function processGroupMatchReminder(
  id: string,
  reminderAt: number,
  scheduleSuccessor: (id: string, reminderAt: number) => Promise<void>,
): Promise<void> {
  const found = (await GroupDuel.findOne({ _id: id, status: "choosing" })
    .select("_id chatId initiatorId opponentId p1Choice p2Choice reminderAt reminderSent reminderProcessingAt deadline initiatorGameEphemeralId opponentGameEphemeralId gameFormsSent lifecycleVersion")
    .lean()) as any;
  if (!found || found.reminderSent) return;

  const due = Number(found.reminderAt ?? reminderAt);
  if (!Number.isFinite(due)) return;
  if (due > Date.now()) {
    await scheduleSuccessor(id, due);
    return;
  }
  if (Number(found.deadline) <= Date.now() || (found.p1Choice && found.p2Choice)) return;

  const claimed = (await GroupDuel.findOneAndUpdate(
    {
      _id: id,
      status: "choosing",
      reminderSent: { $ne: true },
      reminderAt: { $lte: Date.now() },
      deadline: { $gt: Date.now() },
      $or: [
        { p1Choice: null }, { p2Choice: null },
      ],
      $and: [{ $or: [
        { reminderProcessingAt: { $exists: false } },
        { reminderProcessingAt: null },
        { reminderProcessingAt: { $lte: new Date(Date.now() - 120_000) } },
      ] }],
    },
    { $set: { reminderProcessingAt: new Date() } },
    { new: true },
  ).lean()) as any;
  if (!claimed) return;

  try {
    const latest = (await GroupDuel.findOne({ _id: id, status: "choosing", deadline: { $gt: Date.now() } })
      .select("_id chatId initiatorId opponentId p1Choice p2Choice initiatorGameEphemeralId opponentGameEphemeralId deadline lifecycleVersion publicNoticeMessageIds reminderAnnouncementMessageId")
      .lean()) as any;
    if (!latest) return;
    if (latest.p1Choice && latest.p2Choice) {
      await GroupDuel.updateOne({ _id: id, status: "choosing" }, { $set: { reminderSent: true }, $unset: { reminderProcessingAt: 1 } });
      return;
    }

    const config = (await GroupConfig.findOne({ chatId: String(latest.chatId) }).select("language").lean()) as any;
    const lang = langOf(config?.language);
    const missing1 = !latest.p1Choice;
    const missing2 = !latest.p2Choice;
    const [u1, u2] = await Promise.all([
      User.findOne({ tgId: Number(latest.initiatorId) }).select("firstName lastName username").lean(),
      User.findOne({ tgId: Number(latest.opponentId) }).select("firstName lastName username").lean(),
    ]);
    const p1 = mention(Number(latest.initiatorId), u1, lang);
    const p2 = mention(Number(latest.opponentId), u2, lang);
    const remainingSeconds = Math.max(1, Math.ceil((Number(latest.deadline) - Date.now()) / 1000));
    const secondsFa = remainingSeconds.toLocaleString("fa-IR");
    const secondsEn = remainingSeconds.toLocaleString("en-US");
    const timeFa = `⏰ <b>فقط ${secondsFa} ثانیه تا پایان مهلت انتخاب باقی مانده است!</b>`;
    const timeEn = `⏰ <b>${secondsEn} second${remainingSeconds === 1 ? "" : "s"} remain to choose!</b>`;
    const text = missing1 && missing2
      ? tr(lang,
          `${timeFa}\n${p1} و ${p2} هنوز انتخابی ثبت نکرده‌اید. اکنون سنگ، کاغذ یا قیچی را انتخاب کنید.`,
          `${timeEn}\n${p1} and ${p2}, neither of you has chosen yet. Select rock, paper, or scissors now.`,
        )
      : tr(lang,
          `${timeFa}\n${missing1 ? p1 : p2} هنوز انتخابی ثبت نکرده است. اکنون انتخاب کن.`,
          `${timeEn}\n${missing1 ? p1 : p2} has not chosen yet. Please choose now.`,
        );
    const markup = groupMoveKeyboard(id, lang);
    let reminderNoticeId = 0;
    if (Number(latest.lifecycleVersion) === 2) {
      reminderNoticeId = Number(latest.reminderAnnouncementMessageId) || 0;
      if (!reminderNoticeId) {
        reminderNoticeId = await sendGroupDuelNotice(id, Number(latest.chatId), text);
        await GroupDuel.updateOne(
          { _id: id, status: "choosing", reminderAnnouncementMessageId: { $exists: false } },
          { $set: { reminderAnnouncementMessageId: reminderNoticeId } },
        );
      }
      // Keep only the newest public status message while the duel is running.
      const oldNoticeIds = (Array.isArray(latest.publicNoticeMessageIds) ? latest.publicNoticeMessageIds : [])
        .map(Number).filter((messageId: number) => messageId > 0 && messageId !== reminderNoticeId);
      await Promise.all(oldNoticeIds.map((messageId: number) =>
        bot.api.deleteMessage(Number(latest.chatId), messageId).catch(() => undefined),
      ));
      await GroupDuel.updateOne({ _id: id, status: "choosing" }, { $set: { publicNoticeMessageIds: [reminderNoticeId] } });
      const stillChoosing = await GroupDuel.findOne({ _id: id, status: "choosing", deadline: { $gt: Date.now() } })
        .select("_id")
        .lean();
      if (!stillChoosing) {
        await bot.api.deleteMessage(Number(latest.chatId), reminderNoticeId).catch(() => undefined);
        await GroupDuel.updateOne({ _id: id }, {
          $pull: { publicNoticeMessageIds: reminderNoticeId },
          $unset: { reminderAnnouncementMessageId: 1 },
        });
        return;
      }
    }

    const pending: Array<{ uid: number; field: string; oldId: number }> = [];
    if (missing1) pending.push({ uid: Number(latest.initiatorId), field: "initiatorGameEphemeralId", oldId: Number(latest.initiatorGameEphemeralId) });
    if (missing2) pending.push({ uid: Number(latest.opponentId), field: "opponentGameEphemeralId", oldId: Number(latest.opponentGameEphemeralId) });

    for (const player of pending) {
      const choiceField = player.field === "initiatorGameEphemeralId" ? "p1Choice" : "p2Choice";
      const before = (await GroupDuel.findOne({ _id: id, status: "choosing", deadline: { $gt: Date.now() } })
        .select(`${choiceField} ${player.field}`)
        .lean()) as any;
      // A move may arrive while the reminder job is running. Re-check immediately before sending.
      if (!before || before[choiceField]) continue;
      let oldId = Number(before[player.field] ?? player.oldId);
      let newId = 0;
      let deleted = false;
      if (oldId > 0) {
        try {
          await deletePrivateGroupMessage(Number(latest.chatId), player.uid, oldId);
          deleted = true;
          await GroupDuel.updateOne(
            { _id: id, status: "choosing", [player.field]: oldId },
            { $unset: { [player.field]: 1 } },
          );
          oldId = 0;
        } catch {
          // If the old form cannot be deleted, edit it instead of creating a duplicate.
          await editPrivateGroupMessage(Number(latest.chatId), player.uid, oldId, text, {
            parse_mode: "HTML",
            reply_markup: markup,
          });
          newId = oldId;
        }
      }
      if (deleted || !oldId) {
        newId = await sendPrivateGroupMessage(Number(latest.chatId), player.uid, text, {
          parse_mode: "HTML",
          reply_markup: markup,
        }, reminderNoticeId || undefined);
      }
      const stored = await GroupDuel.updateOne(
        { _id: id, status: "choosing", [player.field]: oldId > 0 ? oldId : null },
        { $set: { [player.field]: newId } },
      );
      if (!stored.modifiedCount) {
        if (newId > 0) await deletePrivateGroupMessage(Number(latest.chatId), player.uid, newId).catch(() => undefined);
        continue;
      }
      const after = (await GroupDuel.findOne({ _id: id, status: "choosing" })
        .select(choiceField)
        .lean()) as any;
      if (after?.[choiceField]) {
        // The player completed their move during delivery; retain a button-free acknowledgement.
        const acknowledged = tr(lang,
          "✅ <b>انتخاب تو ثبت شد.</b>\n⌛ منتظر انتخاب حریف بمان.",
          "✅ <b>Your move has been recorded.</b>\n⌛ Waiting for your opponent to choose.",
        );
        await editPrivateGroupMessage(Number(latest.chatId), player.uid, newId, acknowledged, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        }).catch(() => undefined);
      }
    }
    await GroupDuel.updateOne(
      { _id: id, status: "choosing" },
      { $set: { reminderSent: true }, $unset: { reminderProcessingAt: 1 } },
    );
  } catch (error) {
    // A lease expires after two minutes, so a crash during reminder delivery is
    // recoverable by the regular Mongo-to-BullMQ reconciler.
    await GroupDuel.updateOne({ _id: id, status: "choosing" }, { $unset: { reminderProcessingAt: 1 } }).catch(() => undefined);
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
    lifecycleVersion: 2,
    $or: [
      { timeoutSettled: true, timeoutResultSentAt: { $exists: false } },
      { rematchFormsSent: { $ne: true } },
    ],
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
        if (!duel.gameFormsSent) {
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
              payout1,
              payout2,
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
          payout1,
          payout2,
          timeoutSettled: true,
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
    await cleanupPrivateGroupCards(result);
    await deleteGroupDuelPublicNotices(result);
    const config = (await GroupConfig.findOne({ chatId: String(result.chatId) }).select("language").lean()) as any;
    const lang = langOf(config?.language);
    const text = duelHasStake(result)
      ? tr(lang, "⚠️ بازی به‌دلیل ارسال‌نشدن فرم‌های خصوصی لغو شد؛ مبالغ رزروشده آزاد شدند.", "⚠️ The duel was cancelled because private forms could not be delivered; reserved funds were released.")
      : tr(lang, "⚠️ رقابت دوستانه به‌دلیل ارسال‌نشدن فرم‌های خصوصی لغو شد.", "⚠️ The friendly duel was cancelled because private forms could not be delivered.");
    await Promise.all([Number(result.initiatorId), Number(result.opponentId)].map((uid) =>
      sendPrivateGroupMessage(Number(result.chatId), uid, text).catch(() => undefined),
    ));
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
  const winnerPayout = result.winnerId === Number(result.initiatorId)
    ? Number(result.payout1)
    : result.winnerId === Number(result.opponentId)
      ? Number(result.payout2)
      : Number(result.payout1);
  const activatorRewardFa = Number(result.reward) > 0
    ? `\n🎁 <b>پاداش فعال‌کننده:</b> ${fmt(Number(result.reward), String(result.currency))} ${label(String(result.currency), lang)}`
    : "";
  const activatorRewardEn = Number(result.reward) > 0
    ? `\n🎁 <b>Activator reward:</b> ${fmt(Number(result.reward), String(result.currency))} ${label(String(result.currency), lang)}`
    : "";
  const moneySummaryFa = showStake
    ? `\n💰 <b>مبلغ هر بازیکن:</b> ${fmt(Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🏦 <b>مجموع مبلغ رقابت:</b> ${fmt(2 * Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🧾 <b>کارمزد:</b> ${fmt(Number(result.fee), String(result.currency))} ${label(String(result.currency), lang)}\n💵 <b>دریافتی برنده / هر نفر در مساوی:</b> ${fmt(winnerPayout, String(result.currency))} ${label(String(result.currency), lang)}${activatorRewardFa}`
    : "\n🆓 رقابت دوستانه بدون شرط مالی بود.";
  const moneySummaryEn = showStake
    ? `\n💰 <b>Stake per player:</b> ${fmt(Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🏦 <b>Total duel stake:</b> ${fmt(2 * Number(result.amount), String(result.currency))} ${label(String(result.currency), lang)}\n🧾 <b>Fee:</b> ${fmt(Number(result.fee), String(result.currency))} ${label(String(result.currency), lang)}\n💵 <b>Winner payout / each draw payout:</b> ${fmt(winnerPayout, String(result.currency))} ${label(String(result.currency), lang)}${activatorRewardEn}`
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
  await cleanupPrivateGroupCards(result);
  if (result.gameMessageId) {
    await bot.api.editMessageReplyMarkup(Number(result.chatId), Number(result.gameMessageId), {
      reply_markup: { inline_keyboard: [] },
    }).catch(() => undefined);
  }
  // The timeout result is the only public game message. Once its ID and sent
  // marker are saved, later recovery runs only repair private rematch cards.
  let publicResultId = Number(result.resultMessageId) || 0;
  const shouldPublishTimeoutResult = (result.timeoutSettled === true || Number(result.lifecycleVersion) === 2)
    && !result.timeoutResultSentAt
    && !(Number(result.resultMessageId) > 0);
  if (shouldPublishTimeoutResult) {
    let publicResult: any = null;
    const noticeIds = Array.isArray(result.publicNoticeMessageIds) ? result.publicNoticeMessageIds : [];
    const latestNoticeId = Number(noticeIds[noticeIds.length - 1]) || 0;
    await postGroupReply(
      Number(result.chatId),
      latestNoticeId || Number(result.gameMessageId) || Number(result.inviteMessageId) || undefined,
      resultText,
    ).then((sent) => { publicResult = sent; }).catch((error: unknown) => {
      logError("group_timeout_result_send_failed", error, {
        id,
        chatId: result.chatId,
        outcome: result.outcome,
      });
      // Let BullMQ retry. A retry reloads the already-settled duel and retries only this announcement.
      throw error;
    });
    publicResultId = Number(publicResult?.message_id) || 0;
    if (!(publicResultId > 0)) throw new Error("GROUP_TIMEOUT_RESULT_MESSAGE_ID_MISSING");
    const marked = await GroupDuel.updateOne(
      { _id: id, status: "settled", timeoutResultSentAt: { $exists: false }, $or: [
        { resultMessageId: { $exists: false } }, { resultMessageId: null }, { resultMessageId: 0 },
      ] },
      { $set: { timeoutResultSentAt: new Date(), ...(publicResultId > 0 ? { resultMessageId: publicResultId } : {}) } },
    );
    if (!marked.modifiedCount) {
      const current = await GroupDuel.findById(id).select("timeoutResultSentAt resultMessageId").lean() as any;
      if (!current?.timeoutResultSentAt) throw new Error("GROUP_TIMEOUT_RESULT_MARKER_NOT_SAVED");
      publicResultId = Number(current.resultMessageId) || publicResultId;
    }
  }

  await deleteGroupDuelPublicNotices({ ...result, resultMessageId: publicResultId });

  if (Number(result.lifecycleVersion) === 2) {
  const rematchKeyboard = { inline_keyboard: [[{ text: tr(lang, "🔁 شروع دوباره", "🔁 Rematch"), callback_data: `gw:rematch:${id}`, style: "primary" }]] };
  const rematchText = "\u2063";
  try {
    let initiatorCardId = Number(result.initiatorRematchEphemeralId) || 0;
    let opponentCardId = Number(result.opponentRematchEphemeralId) || 0;
    if (!initiatorCardId) {
      initiatorCardId = await sendPrivateGroupMessage(
        Number(result.chatId), Number(result.initiatorId), rematchText,
        { parse_mode: "HTML", reply_markup: rematchKeyboard }, publicResultId || undefined,
      );
      await GroupDuel.updateOne({ _id: id, status: "settled" }, { $set: { initiatorRematchEphemeralId: initiatorCardId } });
    }
    if (!opponentCardId) {
      opponentCardId = await sendPrivateGroupMessage(
        Number(result.chatId), Number(result.opponentId), rematchText,
        { parse_mode: "HTML", reply_markup: rematchKeyboard }, publicResultId || undefined,
      );
      await GroupDuel.updateOne({ _id: id, status: "settled" }, { $set: { opponentRematchEphemeralId: opponentCardId } });
    }
    const saved = await GroupDuel.updateOne({ _id: id, status: "settled" }, { $set: { rematchFormsSent: true } });
    if (!saved.modifiedCount) throw new Error("GROUP_REMATCH_FORMS_STATE_CHANGED");
  } catch (error) {
    logError("group_timeout_rematch_forms_failed", error, { id });
    // Re-throw so BullMQ retries; each successfully delivered card ID is persisted individually.
    throw error;
  }
  }

  if (result.timeoutSettled === true && Number(result.reward) > 0) {
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
