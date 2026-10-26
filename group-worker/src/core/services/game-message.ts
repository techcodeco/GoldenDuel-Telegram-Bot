import { InlineKeyboard } from "grammy";
import { bot, tr, curLabel, fmt, mention } from "../runtime";
import { GroupConfig, GroupDuel } from "../models/index";
import { getUser } from "../runtime";
import { langOf } from "../runtime";

function formatDuration(seconds: number, lang: "fa" | "en"): string {
  const total = Math.max(1, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;

  if (lang === "fa") {
    if (minutes === 0) return `${total} ثانیه`;
    if (remainingSeconds === 0) return `${minutes} دقیقه`;
    return `${minutes} دقیقه و ${remainingSeconds} ثانیه`;
  }

  if (minutes === 0) {
    return `${total} ${total === 1 ? "second" : "seconds"}`;
  }

  if (remainingSeconds === 0) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} and ${remainingSeconds} ${
    remainingSeconds === 1 ? "second" : "seconds"
  }`;
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
  const cfg = (await GroupConfig.findOne({
    chatId: String(duel.chatId),
  })
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

  const chosen = duel.p1Choice ? p1 : duel.p2Choice ? p2 : null;

  const progress = chosen
    ? tr(
        lang,
        `${chosen} انتخاب خود را ثبت کرده است. منتظر انتخاب حریف می‌مانیم.`,
        `${chosen} has made their choice. Waiting for the opponent.`,
      )
    : tr(
        lang,
        "هر بازیکن یک گزینه را انتخاب کند.",
        "Each player should make one choice.",
      );

  const stakeLineFa = isBet
    ? `\n💰 مبلغ هر بازیکن: <b>${fmt(
        Number(duel.amount),
        String(duel.currency),
      )} ${curLabel(String(duel.currency), lang)}</b>`
    : "\n🆓 بدون شرط مالی";

  const stakeLineEn = isBet
    ? `\n💰 Stake per player: <b>${fmt(
        Number(duel.amount),
        String(duel.currency),
      )} ${curLabel(String(duel.currency), lang)}</b>`
    : "\n🆓 No stake";

  const durationLineFa = `\n⏱️ مدت زمان انتخاب: <b>${durationText}</b>`;
  const durationLineEn = `\n⏱️ Choice time limit: <b>${durationText}</b>`;

  return tr(
    lang,
    [
      `⚔️ <b>رقابت ${mode}</b>`,
      `👤 ${p1}`,
      `👤 ${p2}${stakeLineFa}`,
      durationLineFa,
      "",
      progress,
    ].join("\n"),
    [
      `⚔️ <b>${mode} duel</b>`,
      `👤 ${p1}`,
      `👤 ${p2}${stakeLineEn}`,
      durationLineEn,
      "",
      progress,
    ].join("\n"),
  );
}

export async function refreshGameProgress(duel: any) {
  if (!duel?.gameMessageId) return;
  const text = await gameProgressText(duel);
  const lang = langOf(
    (
      (await GroupConfig.findOne({ chatId: String(duel.chatId) })
        .select("language")
        .lean()) as any
    )?.language,
  );
  await bot.api
    .editMessageText(Number(duel.chatId), Number(duel.gameMessageId), text, {
      parse_mode: "HTML",
      reply_markup: gameKeyboard(String(duel._id), lang),
    })
    .catch(() => undefined);
}

export async function disableGameMessage(
  duel: any,
  _langOverride?: "fa" | "en",
) {
  if (!duel?.gameMessageId) return;
  // Keep the original game prompt intact; only remove the now-inactive move buttons.
  // The result is posted as a reply, without adding a redundant end-of-duel message.
  await bot.api
    .editMessageReplyMarkup(Number(duel.chatId), Number(duel.gameMessageId), {
      reply_markup: {
        inline_keyboard: [],
      },
    })
    .catch(() => undefined);
}

export async function replyToGameMessage(duel: any, text: string) {
  const options: any = { parse_mode: "HTML" };
  if (duel.gameMessageId)
    options.reply_parameters = { message_id: Number(duel.gameMessageId) };
  else if (duel.inviteMessageId)
    options.reply_parameters = { message_id: Number(duel.inviteMessageId) };
  return bot.api.sendMessage(Number(duel.chatId), text, options);
}

export async function closeInviteKeyboard(duel: any) {
  if (!duel?.inviteMessageId) return;
  await bot.api
    .editMessageReplyMarkup(Number(duel.chatId), Number(duel.inviteMessageId), {
      reply_markup: {
        inline_keyboard: [],
      },
    })
    .catch(() => undefined);
}
