import { InlineKeyboard } from "grammy";
import { bot, tr, curLabel, fmt, mention, getUser, langOf } from "../runtime";
import { GroupConfig, GroupDuel } from "../models/index";
import {
  deleteEphemeralMessage,
  editEphemeralMessage,
  sendEphemeralMessage,
} from "../bot/ephemeral";

function formatDuration(seconds: number, lang: "fa" | "en"): string {
  const total = Math.max(1, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  if (lang === "fa") {
    if (minutes === 0) return `${total} ثانیه`;
    if (remainingSeconds === 0) return `${minutes} دقیقه`;
    return `${minutes} دقیقه و ${remainingSeconds} ثانیه`;
  }
  if (minutes === 0) return `${total} ${total === 1 ? "second" : "seconds"}`;
  if (remainingSeconds === 0)
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} and ${remainingSeconds} ${remainingSeconds === 1 ? "second" : "seconds"}`;
}

export function gameKeyboard(id: string, lang: "fa" | "en") {
  const keyboard = new InlineKeyboard()
    .text(`🪨 ${tr(lang, "سنگ", "Rock")}`, `gw:move:${id}:r`)
    .text(`📄 ${tr(lang, "کاغذ", "Paper")}`, `gw:move:${id}:p`)
    .text(`✂️ ${tr(lang, "قیچی", "Scissors")}`, `gw:move:${id}:s`);
  for (const row of keyboard.inline_keyboard)
    for (const button of row) (button as any).style = "primary";
  return keyboard;
}

export async function gameProgressText(duel: any) {
  const cfg = (await GroupConfig.findOne({ chatId: String(duel.chatId) })
    .select("language betTimeoutSeconds friendlyTimeoutSeconds")
    .lean()) as any;
  const lang = langOf(cfg?.language);
  const [u1, u2] = await Promise.all([
    getUser(Number(duel.initiatorId)),
    getUser(Number(duel.opponentId)),
  ]);
  const p1 = mention(
    {
      id: duel.initiatorId,
      first_name: u1?.firstName,
      last_name: u1?.lastName,
      username: u1?.username,
    },
    lang,
  );
  const p2 = mention(
    {
      id: duel.opponentId,
      first_name: u2?.firstName,
      last_name: u2?.lastName,
      username: u2?.username,
    },
    lang,
  );
  const isBet = duel.mode === "bet";
  const mode = isBet
    ? tr(lang, "شرطی", "bet")
    : tr(lang, "دوستانه", "friendly");
  const configuredTimeout = Number(
    isBet ? cfg?.betTimeoutSeconds : cfg?.friendlyTimeoutSeconds,
  );
  const durationSeconds = Math.max(30, Math.min(600, configuredTimeout || 180));
  const durationText = formatDuration(durationSeconds, lang);
  const stakeFa = isBet
    ? `\n💰 مبلغ هر بازیکن: <b>${fmt(Number(duel.amount), String(duel.currency))} ${curLabel(String(duel.currency), lang)}</b>`
    : "\n🆓 بدون شرط مالی";
  const stakeEn = isBet
    ? `\n💰 Stake per player: <b>${fmt(Number(duel.amount), String(duel.currency))} ${curLabel(String(duel.currency), lang)}</b>`
    : "\n🆓 No stake";
  const durationFa = `\n⏱️ مهلت انتخاب: <b>${durationText}</b>`;
  const durationEn = `\n⏱️ Choice time limit: <b>${durationText}</b>`;
  return tr(
    lang,
    `⚔️ <b>رقابت ${mode}</b>\n👤 ${p1}\n👤 ${p2}${stakeFa}${durationFa}\n\nهر بازیکن فقط یک بار می‌تواند سنگ، کاغذ یا قیچی را انتخاب کند.`,
    `⚔️ <b>${mode} duel</b>\n👤 ${p1}\n👤 ${p2}${stakeEn}${durationEn}\n\nEach player can choose rock, paper, or scissors exactly once.`,
  );
}

/** Creates one independent private-in-group move form for each participant. */
export async function sendPlayerGameForms(
  duel: any,
  replyMessageId?: number,
): Promise<void> {
  const lang = langOf(
    (
      (await GroupConfig.findOne({ chatId: String(duel.chatId) })
        .select("language")
        .lean()) as any
    )?.language,
  );
  const text = await gameProgressText(duel);
  const markup = {
    inline_keyboard: gameKeyboard(String(duel._id), lang).inline_keyboard,
  };
  let first: any;
  let second: any;
  try {
    first = await sendEphemeralMessage(
      Number(duel.chatId),
      Number(duel.initiatorId),
      text,
      {
        parse_mode: "HTML",
        reply_markup: markup,
      },
      replyMessageId ? { replyMessageId } : {},
    );
    const firstStored = await GroupDuel.updateOne(
      {
        _id: String(duel._id),
        status: "choosing",
        gameFormsSent: { $ne: true },
      },
      {
        $set: { initiatorGameEphemeralId: Number(first.ephemeral_message_id) },
      },
    );
    if (!firstStored.modifiedCount)
      throw new Error("GROUP_INITIATOR_GAME_FORM_STATE_CHANGED");

    second = await sendEphemeralMessage(
      Number(duel.chatId),
      Number(duel.opponentId),
      text,
      {
        parse_mode: "HTML",
        reply_markup: markup,
      },
      replyMessageId ? { replyMessageId } : {},
    );
    const stored = await GroupDuel.updateOne(
      {
        _id: String(duel._id),
        status: "choosing",
        gameFormsSent: { $ne: true },
        initiatorGameEphemeralId: Number(first.ephemeral_message_id),
      },
      {
        $set: {
          opponentGameEphemeralId: Number(second.ephemeral_message_id),
          gameFormsSent: true,
        },
      },
    );
    if (!stored.modifiedCount) throw new Error("GROUP_GAME_FORM_STATE_CHANGED");
    const latest = (await GroupDuel.findById(String(duel._id)).lean()) as any;
    if (latest?.status === "choosing") {
      if (latest.p1Choice && !latest.p2Choice)
        await notifyOpponentChoice(latest, Number(latest.initiatorId));
      else if (latest.p2Choice && !latest.p1Choice)
        await notifyOpponentChoice(latest, Number(latest.opponentId));
    }
  } catch (error) {
    if (first?.ephemeral_message_id)
      await deleteEphemeralMessage(
        Number(duel.chatId),
        Number(duel.initiatorId),
        Number(first.ephemeral_message_id),
      ).catch(() => undefined);
    // A late database failure can happen after both private cards were delivered.
    if (second?.ephemeral_message_id)
      await deleteEphemeralMessage(
        Number(duel.chatId),
        Number(duel.opponentId),
        Number(second.ephemeral_message_id),
      ).catch(() => undefined);
    throw error;
  }
}

/** Edit the opponent's existing private move form; never send a second reminder message here. */
export async function notifyOpponentChoice(
  duel: any,
  chooserId: number,
): Promise<void> {
  const initiatorId = Number(duel.initiatorId);
  const opponentId = Number(duel.opponentId);
  const opponentUserId =
    chooserId === initiatorId
      ? opponentId
      : chooserId === opponentId
        ? initiatorId
        : 0;
  if (!opponentUserId) return;
  const opponentAlreadyChose =
    chooserId === initiatorId ? Boolean(duel.p2Choice) : Boolean(duel.p1Choice);
  if (opponentAlreadyChose) return;
  const messageId = Number(
    opponentUserId === initiatorId
      ? duel.initiatorGameEphemeralId
      : duel.opponentGameEphemeralId,
  );
  if (!messageId) return;

  const cfg = (await GroupConfig.findOne({ chatId: String(duel.chatId) })
    .select("language")
    .lean()) as any;
  const lang = langOf(cfg?.language);
  const [chooser] = await Promise.all([getUser(chooserId)]);
  const chooserMention = mention(
    {
      id: chooserId,
      first_name: chooser?.firstName,
      last_name: chooser?.lastName,
      username: chooser?.username,
    },
    lang,
  );
  const secondsLeft = Math.max(
    0,
    Math.ceil((Number(duel.deadline) - Date.now()) / 1000),
  );
  const base = await gameProgressText(duel);
  const text = tr(
    lang,
    `${base}\n\n✅ ${chooserMention} انتخاب خودش را ثبت کرده است.\n⏳ شما <b>${secondsLeft} ثانیه</b> برای انتخاب فرصت دارید.`,
    `${base}\n\n✅ ${chooserMention} has registered their choice.\n⏳ You have <b>${secondsLeft} seconds</b> left to choose.`,
  );
  try {
    await editEphemeralMessage(
      Number(duel.chatId),
      opponentUserId,
      messageId,
      text,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: gameKeyboard(String(duel._id), lang).inline_keyboard,
        },
      },
    );
  } catch {
    // Do not create another message: the existing private form is the only actionable prompt.
  }
}

export async function acknowledgePlayerChoice(
  duel: any,
  userId: number,
): Promise<void> {
  const lang = langOf(
    (
      (await GroupConfig.findOne({ chatId: String(duel.chatId) })
        .select("language")
        .lean()) as any
    )?.language,
  );
  const isP1 = userId === Number(duel.initiatorId);
  const messageId = Number(
    isP1 ? duel.initiatorGameEphemeralId : duel.opponentGameEphemeralId,
  );
  if (!messageId) return;
  const [u1, u2] = await Promise.all([
    getUser(Number(duel.initiatorId)),
    getUser(Number(duel.opponentId)),
  ]);
  const p1 = mention(
    {
      id: duel.initiatorId,
      first_name: u1?.firstName,
      last_name: u1?.lastName,
      username: u1?.username,
    },
    lang,
  );
  const p2 = mention(
    {
      id: duel.opponentId,
      first_name: u2?.firstName,
      last_name: u2?.lastName,
      username: u2?.username,
    },
    lang,
  );
  const text = tr(
    lang,
    `✅ <b>انتخاب تو ثبت شد.</b>\n${p1} و ${p2}\n\n⌛ منتظر انتخاب حریف بمان.`,
    `✅ <b>Your choice has been recorded.</b>\n${p1} and ${p2}\n\n⌛ Waiting for your opponent to choose.`,
  );
  try {
    await editEphemeralMessage(Number(duel.chatId), userId, messageId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    // Remove the form if editing fails so its old move buttons are no longer visible.
    await deleteEphemeralMessage(Number(duel.chatId), userId, messageId).catch(
      () => undefined,
    );
  }
}

export async function deleteDuelEphemeralCards(duel: any): Promise<void> {
  const chatId = Number(duel.chatId);
  const items: Array<[number, unknown]> = [
    [Number(duel.initiatorId), duel.initiatorWaitEphemeralId],
    [Number(duel.opponentId), duel.opponentInviteEphemeralId],
    [Number(duel.initiatorId), duel.initiatorGameEphemeralId],
    [Number(duel.opponentId), duel.opponentGameEphemeralId],
    [Number(duel.initiatorId), duel.initiatorRematchEphemeralId],
    [Number(duel.opponentId), duel.opponentRematchEphemeralId],
  ];
  await Promise.all(
    items
      .filter(([, id]) => Number(id) > 0)
      .map(([uid, id]) =>
        deleteEphemeralMessage(chatId, uid, Number(id)).catch(() => undefined),
      ),
  );
}

/** Legacy message cleanup, retained to handle duels created before the private-form rollout. */
export async function disableGameMessage(
  duel: any,
  _langOverride?: "fa" | "en",
) {
  await deleteDuelEphemeralCards(duel);
  if (!duel?.gameMessageId) return;
  await bot.api
    .editMessageReplyMarkup(Number(duel.chatId), Number(duel.gameMessageId), {
      reply_markup: { inline_keyboard: [] },
    })
    .catch(() => undefined);
}

export async function sendGroupDuelNotice(
  duelId: string,
  chatId: number | string,
  text: string,
  replyMessageId?: number,
): Promise<number> {
  const options: any = { parse_mode: "HTML", disable_notification: false };
  if (replyMessageId)
    options.reply_parameters = { message_id: Number(replyMessageId) };
  const sent = await bot.api.sendMessage(Number(chatId), text, options);
  const messageId = Number((sent as any)?.message_id) || 0;
  if (!messageId) throw new Error("GROUP_NOTICE_MESSAGE_ID_MISSING");
  try {
    const saved = await GroupDuel.updateOne(
      { _id: duelId },
      { $addToSet: { publicNoticeMessageIds: messageId } },
    );
    if (!saved.matchedCount) throw new Error("GROUP_NOTICE_DUEL_NOT_FOUND");
    return messageId;
  } catch (error) {
    // Never leave an untracked public notice behind if persistence fails.
    await bot.api
      .deleteMessage(Number(chatId), messageId)
      .catch(() => undefined);
    throw error;
  }
}

export async function deleteDuelPublicNotices(duel: any): Promise<void> {
  if (!duel?.chatId) return;
  // Re-read the durable list so a reminder posted concurrently with settlement
  // cannot survive as an orphaned public message.
  const current = duel._id
    ? ((await GroupDuel.findById(String(duel._id))
        .select(
          "publicNoticeMessageIds gameMessageId inviteMessageId resultMessageId",
        )
        .lean()) as any)
    : null;
  const resultId =
    Number(duel.resultMessageId ?? current?.resultMessageId) || 0;
  const ids = [
    ...new Set(
      [
        ...(Array.isArray(duel.publicNoticeMessageIds)
          ? duel.publicNoticeMessageIds.map(Number)
          : []),
        ...(Array.isArray(current?.publicNoticeMessageIds)
          ? current.publicNoticeMessageIds.map(Number)
          : []),
        Number(duel.gameMessageId ?? current?.gameMessageId) || 0,
        Number(duel.inviteMessageId ?? current?.inviteMessageId) || 0,
      ].filter((id) => id > 0 && id !== resultId),
    ),
  ];
  await Promise.all(
    ids.map((messageId) =>
      bot.api
        .deleteMessage(Number(duel.chatId), messageId)
        .catch(() => undefined),
    ),
  );
}

export async function replyToGameMessage(duel: any, text: string) {
  const options: any = { parse_mode: "HTML" };
  const notices = Array.isArray(duel.publicNoticeMessageIds)
    ? duel.publicNoticeMessageIds
    : [];
  const latestNoticeId = Number(notices[notices.length - 1]) || 0;
  const anchorId =
    latestNoticeId ||
    Number(duel.gameMessageId) ||
    Number(duel.inviteMessageId) ||
    0;
  if (anchorId) {
    try {
      return await bot.api.sendMessage(Number(duel.chatId), text, {
        ...options,
        reply_parameters: { message_id: anchorId },
      });
    } catch {
      // A reminder can be removed concurrently with settlement; do not lose the result.
    }
  }
  return bot.api.sendMessage(Number(duel.chatId), text, options);
}

export async function closeInviteKeyboard(duel: any) {
  await Promise.all([
    Number(duel?.opponentInviteEphemeralId) > 0
      ? deleteEphemeralMessage(
          Number(duel.chatId),
          Number(duel.opponentId),
          Number(duel.opponentInviteEphemeralId),
        ).catch(() => undefined)
      : Promise.resolve(),
    Number(duel?.initiatorWaitEphemeralId) > 0
      ? deleteEphemeralMessage(
          Number(duel.chatId),
          Number(duel.initiatorId),
          Number(duel.initiatorWaitEphemeralId),
        ).catch(() => undefined)
      : Promise.resolve(),
  ]);
  if (duel?.inviteMessageId) {
    await bot.api
      .editMessageReplyMarkup(
        Number(duel.chatId),
        Number(duel.inviteMessageId),
        { reply_markup: { inline_keyboard: [] } },
      )
      .catch(() => undefined);
  }
}
