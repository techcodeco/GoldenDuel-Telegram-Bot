import { logError } from '../logger'
import mongoose from 'mongoose'
import { InlineKeyboard } from 'grammy'
import { bot, langOf, tr, curLabel, fmt, mention, getUser } from '../runtime'
import { GroupConfig, GroupDuel, Settings, User, Ledger, House } from '../models/index'
import { disableGameMessage, replyToGameMessage, deleteDuelPublicNotices } from './game-message'
import { sendEphemeralMessage } from '../bot/ephemeral'
import { groupDuelHasStake } from '../contracts/group'

export async function settleDuel(id: string, timeout = false) {
  const session = await mongoose.startSession()
  let final: any = null
  try {
    await session.withTransaction(async () => {
      const found = await GroupDuel.findOne({ _id: id, status: 'choosing' }).session(session).lean() as any
      if (!found) return
      if (!timeout && !(found.p1Choice && found.p2Choice)) return
      if (timeout && Number(found.deadline) > Date.now()) return
      const duel = await GroupDuel.findOneAndUpdate(
        { _id: id, status: 'choosing' },
        { $set: { status: 'settling' } }, { new: true, session },
      ).lean() as any
      if (!duel) return

      const settings = await Settings.findById('main').session(session).lean() as any
      const fees = settings?.fees ?? { win: 1000, draw: 500, winTimeout: 2000, drawTimeout: 1000 }
      let winnerId: number | null = null
      let fee = 0
      let payout1 = 0
      let payout2 = 0
      let outcome: string = 'draw'

      if (duel.p1Choice && duel.p2Choice) {
        if (duel.p1Choice === duel.p2Choice) {
          const eachFee = Math.floor(Number(duel.amount) * Number(fees.draw) / 10000)
          fee = eachFee * 2
          payout1 = Number(duel.amount) - eachFee
          payout2 = payout1
          outcome = 'draw'
        } else {
          winnerId = beats(duel.p1Choice, duel.p2Choice) ? Number(duel.initiatorId) : Number(duel.opponentId)
          fee = Math.floor(Number(duel.amount) * Number(fees.win) / 10000)
          payout1 = winnerId === Number(duel.initiatorId) ? 2 * Number(duel.amount) - fee : 0
          payout2 = winnerId === Number(duel.opponentId) ? 2 * Number(duel.amount) - fee : 0
          outcome = 'win'
        }
      } else if (duel.p1Choice || duel.p2Choice) {
        winnerId = duel.p1Choice ? Number(duel.initiatorId) : Number(duel.opponentId)
        fee = Math.floor(Number(duel.amount) * Number(fees.winTimeout) / 10000)
        payout1 = winnerId === Number(duel.initiatorId) ? 2 * Number(duel.amount) - fee : 0
        payout2 = winnerId === Number(duel.opponentId) ? 2 * Number(duel.amount) - fee : 0
        outcome = 'win_timeout'
      } else {
        const eachFee = Math.floor(Number(duel.amount) * Number(fees.drawTimeout) / 10000)
        fee = eachFee * 2
        payout1 = Number(duel.amount) - eachFee
        payout2 = payout1
        outcome = 'draw_timeout'
      }

      const stakeBearing = groupDuelHasStake(duel)
      const stakeFreeFriendly = duel.mode === 'friendly' && !stakeBearing
      if (duel.mode === 'friendly') {
        // New friendly duels have no stake or wallet movement. Preserve compatibility
        // with any older pending friendly duels that still have funds locked.
        payout1 = stakeBearing ? Number(duel.amount) : 0
        payout2 = stakeBearing ? Number(duel.amount) : 0
        fee = 0
        outcome = duel.p1Choice && duel.p2Choice
          ? (duel.p1Choice === duel.p2Choice ? 'draw' : 'win')
          : winnerId ? 'win_timeout' : 'draw_timeout'
      }

      const rewardPercent = Math.max(0, Math.min(100, Number(settings?.groupRewardPercent ?? 20)))
      const reward = duel.mode === 'bet' ? Math.floor(fee * rewardPercent / 100) : 0
      const houseFee = fee - reward
      const users = [
        { uid: Number(duel.initiatorId), payout: payout1 },
        { uid: Number(duel.opponentId), payout: payout2 },
      ]
      for (const player of users) {
        if (stakeFreeFriendly) {
          const update = await User.updateOne(
            { tgId: player.uid },
            {
              $inc: { duelsPlayed: 1 },
              $setOnInsert: {
                tgId: player.uid, lang: null, role: 'user', referrerId: null,
                referralPaid: false, blockedBot: false,
                'balances.IRT.available': 0, 'balances.IRT.locked': 0,
                'balances.TON.available': 0, 'balances.TON.locked': 0,
              },
            },
            { session, upsert: true },
          )
          if (!update.modifiedCount && !update.upsertedCount) throw new Error('FRIENDLY_DUEL_STATS_UPDATE_FAILED')
          continue
        }
        const lock = Number(duel.amount)
        const exists = await User.findOne({ tgId: player.uid }).session(session)
        if (!exists) throw new Error('PLAYER_MISSING')
        const update = await User.updateOne(
          { tgId: player.uid, [`balances.${duel.currency}.locked`]: { $gte: lock } },
          { $inc: { [`balances.${duel.currency}.locked`]: -lock, [`balances.${duel.currency}.available`]: Number(player.payout), duelsPlayed: 1 } },
          { session },
        )
        if (!update.modifiedCount) throw new Error('LOCKED_BALANCE_INVARIANT')
        await Ledger.create([{
          key: `group:settle:${id}:${player.uid}`, userId: player.uid, currency: duel.currency,
          type: `group_${outcome}`, available: Number(player.payout), locked: -lock, ref: id,
        }], { session })
      }

      if (houseFee > 0) {
        await House.updateOne({ _id: 'house' }, { $inc: { [`balances.${duel.currency}`]: houseFee } }, { upsert: true, session })
        await Ledger.create([{ key: `group:house:${id}`, userId: 0, currency: duel.currency, type: 'group_fee', available: houseFee, locked: 0, ref: id }], { session })
      }
      if (reward > 0) {
        const updated = await User.updateOne(
          { tgId: Number(duel.activatorId) },
          {
            $inc: { [`balances.${duel.currency}.available`]: reward },
            $setOnInsert: {
              lang: null, role: 'user', referrerId: null, referralPaid: false, duelsPlayed: 0, blockedBot: false,
              'balances.IRT.locked': 0, 'balances.TON.locked': 0,
              [`balances.${duel.currency === 'IRT' ? 'TON' : 'IRT'}.available`]: 0,
            },
          },
          { session, upsert: true },
        )
        if (!updated.modifiedCount && !updated.upsertedCount) throw new Error('ACTIVATOR_MISSING')
        await Ledger.create([{ key: `group:reward:${id}`, userId: Number(duel.activatorId), currency: duel.currency, type: 'group_reward', available: reward, locked: 0, ref: id }], { session })
      }
      const changed = await GroupDuel.updateOne(
        { _id: id, status: 'settling' },
        { $set: { status: 'settled', winnerId, outcome, fee, payout1, payout2, reward, rewardPaid: reward > 0, settledAt: new Date() } },
        { session },
      )
      if (!changed.modifiedCount) throw new Error('DUEL_STATE_RACE')
      final = { ...duel, winnerId, outcome, fee, reward, rewardPercent, houseFee, payout1, payout2, settledAt: new Date() }
    })
  } finally {
    await session.endSession()
  }
  if (!final) return

  const group = await GroupConfig.findOne({ chatId: String(final.chatId) }).lean() as any
  const lang = langOf(group?.language)
  const [player1, player2] = await Promise.all([getUser(final.initiatorId), getUser(final.opponentId)])
  const p1 = mention({ id: final.initiatorId, first_name: player1?.firstName, last_name: player1?.lastName, username: player1?.username }, lang)
  const p2 = mention({ id: final.opponentId, first_name: player2?.firstName, last_name: player2?.lastName, username: player2?.username }, lang)
  const winner = final.winnerId === Number(final.initiatorId) ? p1 : final.winnerId === Number(final.opponentId) ? p2 : null
  const loser = final.winnerId === Number(final.initiatorId) ? p2 : final.winnerId === Number(final.opponentId) ? p1 : null
  const result = winner
    ? tr(lang, `🏆 <b>برنده:</b> ${winner}\n💔 <b>بازنده:</b> ${loser}`, `🏆 <b>Winner:</b> ${winner}\n💔 <b>Loser:</b> ${loser}`)
    : tr(lang, '🤝 <b>نتیجه: مساوی</b>', '🤝 <b>Result: Draw</b>')
  const choiceLabel = (choice: string | null) => choice === 'r' ? tr(lang, 'سنگ', 'Rock') : choice === 'p' ? tr(lang, 'کاغذ', 'Paper') : choice === 's' ? tr(lang, 'قیچی', 'Scissors') : tr(lang, 'بدون انتخاب', 'No move')
  const mode = final.mode === 'bet' ? tr(lang, 'شرطی', 'bet') : tr(lang, 'دوستانه', 'friendly')
  const showStake = groupDuelHasStake(final)
  const payout = Number(final.winnerId) === Number(final.initiatorId) ? Number(final.payout1) : Number(final.winnerId) === Number(final.opponentId) ? Number(final.payout2) : Number(final.payout1)
  const rewardLineFa = Number(final.reward) > 0 ? `\n🎁 <b>پاداش فعال‌کننده:</b> ${fmt(final.reward, String(final.currency))} ${curLabel(String(final.currency), lang)}` : ''
  const rewardLineEn = Number(final.reward) > 0 ? `\n🎁 <b>Activator reward:</b> ${fmt(final.reward, String(final.currency))} ${curLabel(String(final.currency), lang)}` : ''
  const moneySummaryFa = showStake
    ? `\n💰 <b>مبلغ هر بازیکن:</b> ${fmt(final.amount, String(final.currency))} ${curLabel(String(final.currency), lang)}\n🏦 <b>مجموع مبلغ رقابت:</b> ${fmt(2 * final.amount, String(final.currency))} ${curLabel(String(final.currency), lang)}\n🧾 <b>کارمزد:</b> ${fmt(final.fee, String(final.currency))} ${curLabel(String(final.currency), lang)}\n💵 <b>دریافتی برنده / هر بازیکن در مساوی:</b> ${fmt(payout, String(final.currency))} ${curLabel(String(final.currency), lang)}${rewardLineFa}`
    : '\n🆓 رقابت دوستانه بدون شرط مالی بود.'
  const moneySummaryEn = showStake
    ? `\n💰 <b>Stake per player:</b> ${fmt(final.amount, String(final.currency))} ${curLabel(String(final.currency), lang)}\n🏦 <b>Total duel stake:</b> ${fmt(2 * final.amount, String(final.currency))} ${curLabel(String(final.currency), lang)}\n🧾 <b>Fee:</b> ${fmt(final.fee, String(final.currency))} ${curLabel(String(final.currency), lang)}\n💵 <b>Winner payout / each draw payout:</b> ${fmt(payout, String(final.currency))} ${curLabel(String(final.currency), lang)}${rewardLineEn}`
    : '\n🆓 This friendly duel had no stake.'
  const resultText = tr(lang,
    `🏁 <b>پایان رقابت ${mode}</b>\n${result}\n🎮 <b>انتخاب‌ها:</b> ${p1}: ${choiceLabel(final.p1Choice)}  ·  ${p2}: ${choiceLabel(final.p2Choice)}${moneySummaryFa}`,
    `🏁 <b>${mode} duel finished</b>\n${result}\n🎮 <b>Moves:</b> ${p1}: ${choiceLabel(final.p1Choice)}  ·  ${p2}: ${choiceLabel(final.p2Choice)}${moneySummaryEn}`,
  )
  await disableGameMessage(final, lang)
  let resultMessage: any = null
  try {
    resultMessage = await replyToGameMessage(final, resultText)
    if (Number(resultMessage?.message_id) > 0) {
      await GroupDuel.updateOne({ _id: id, status: 'settled' }, { $set: { resultMessageId: Number(resultMessage.message_id) } })
      // Keep the result as the only public duel message once it has been posted.
      const savedResultState = await GroupDuel.findById(id).lean() as any
      await deleteDuelPublicNotices({ ...(savedResultState ?? final), resultMessageId: Number(resultMessage.message_id) })
    }
  } catch (error) {
    logError('group_result_message_failed', error, { duelId: id })
  }

  if (Number(final.lifecycleVersion) === 2) {
  // Each participant gets their own rematch control; no callback button is exposed publicly.
  const rematchKeyboard = new InlineKeyboard().text(tr(lang, '🔁 شروع دوباره', '🔁 Rematch'), `gw:rematch:${id}`)
  for (const row of rematchKeyboard.inline_keyboard) for (const button of row) (button as any).style = 'success'
  // Native Telegram does not support a recipient-specific keyboard on a public
  // message. Send a zero-width ephemeral reply containing only the button, anchored
  // directly under the public result; no second visible text message is created.
  const rematchButtonOnly = '\u2063'
  try {
    const currentCards = await GroupDuel.findById(id).select('initiatorRematchEphemeralId opponentRematchEphemeralId').lean() as any
    let initiatorCardId = Number(currentCards?.initiatorRematchEphemeralId) || 0
    let opponentCardId = Number(currentCards?.opponentRematchEphemeralId) || 0
    if (!initiatorCardId) {
      if (!resultMessage?.message_id) throw new Error('PUBLIC_RESULT_MESSAGE_MISSING_FOR_REMATCH')
      const r1 = await sendEphemeralMessage(Number(final.chatId), Number(final.initiatorId), rematchButtonOnly, {
        reply_markup: { inline_keyboard: rematchKeyboard.inline_keyboard },
      }, { replyMessageId: Number(resultMessage.message_id) })
      initiatorCardId = Number(r1?.ephemeral_message_id) || 0
      if (!initiatorCardId) throw new Error('INITIATOR_REMATCH_CARD_ID_MISSING')
      await GroupDuel.updateOne({ _id: id, status: 'settled' }, { $set: { initiatorRematchEphemeralId: initiatorCardId } })
    }
    if (!opponentCardId) {
      const r2 = await sendEphemeralMessage(Number(final.chatId), Number(final.opponentId), rematchButtonOnly, {
        reply_markup: { inline_keyboard: rematchKeyboard.inline_keyboard },
      }, { replyMessageId: Number(resultMessage.message_id) })
      opponentCardId = Number(r2?.ephemeral_message_id) || 0
      if (!opponentCardId) throw new Error('OPPONENT_REMATCH_CARD_ID_MISSING')
      await GroupDuel.updateOne({ _id: id, status: 'settled' }, { $set: { opponentRematchEphemeralId: opponentCardId } })
    }
    await GroupDuel.updateOne({ _id: id, status: 'settled' }, { $set: { rematchFormsSent: true } })
  } catch (error) {
    logError('group_rematch_forms_failed', error, { duelId: id })
    // BullMQ reconciliation retries any settled duel whose rematchFormsSent flag is still false.
  }
  }

  if (Number(final.reward) > 0) {
    const groupTitle = String(group?.title ?? tr(lang, 'گروه تلگرام', 'Telegram group'))
    const rewardText = tr(lang,
      `🎉 <b>شما بابت برگزاری یک رقابت در گروه‌تان پاداش دریافت کردید</b>\n\n📍 <b>گروه:</b> ${escapeHtml(groupTitle)}\n⚔️ <b>رویداد:</b> یک دوئل ${mode} در این گروه با موفقیت به پایان رسید.\n💰 <b>مبلغ هر بازیکن:</b> ${fmt(final.amount, final.currency)} ${curLabel(final.currency, lang)}\n🏦 <b>مجموع مبلغ رقابت:</b> ${fmt(2 * final.amount, final.currency)} ${curLabel(final.currency, lang)}\n🧾 <b>کارمزد محاسبه‌شده:</b> ${fmt(final.fee, final.currency)} ${curLabel(final.currency, lang)}\n🎁 <b>پاداش شما:</b> +${fmt(final.reward, final.currency)} ${curLabel(final.currency, lang)}\n\nاین پاداش به دلیل پایان موفق رقابت در گروه شما محاسبه شده و به موجودی قابل‌استفاده‌تان اضافه شده است.`,
      `🎉 <b>You received a reward because a duel was completed in your group</b>\n\n📍 <b>Group:</b> ${escapeHtml(groupTitle)}\n⚔️ <b>Event:</b> A ${mode} duel was successfully completed in this group.\n💰 <b>Stake per player:</b> ${fmt(final.amount, final.currency)} ${curLabel(final.currency, lang)}\n🏦 <b>Total duel stake:</b> ${fmt(2 * final.amount, final.currency)} ${curLabel(final.currency, lang)}\n🧾 <b>Calculated fee:</b> ${fmt(final.fee, final.currency)} ${curLabel(final.currency, lang)}\n🎁 <b>Your reward:</b> +${fmt(final.reward, final.currency)} ${curLabel(final.currency, lang)}\n\nThis reward is for a successfully completed duel in your group and has been added to your available balance.`,
    )
    // The wallet credit is durable even when Telegram disallows the private notification because the user has not started the bot.
    await bot.api.sendMessage(Number(final.activatorId), rewardText, { parse_mode: 'HTML' }).catch((error: unknown) => {
      logError('group_reward_notification_failed', error, { duelId: String(final._id), activatorId: final.activatorId, reward: final.reward })
    })
  }
}

export function beats(a: string, b: string) {
  return (a === 'r' && b === 's') || (a === 's' && b === 'p') || (a === 'p' && b === 'r')
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
