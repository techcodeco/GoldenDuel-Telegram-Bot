import { GrammyError } from 'grammy'
import { logError } from '../logger'
import { markBlocked } from '../services/users'
import { bot } from './instance'

/** Send a message to a user; never throws (a blocked bot must not break money flows). */
export async function notify(
  userId: number,
  text: string,
  opts: { plain?: boolean; reply_markup?: any } = {},
): Promise<boolean> {
  try {
    await bot.api.sendMessage(userId, text, {
      ...(opts.plain ? {} : { parse_mode: 'HTML' as const }),
      ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    })
    return true
  } catch (e) {
    if (e instanceof GrammyError && e.error_code === 403) await markBlocked(userId, true).catch(() => {})
    else logError('notify_failed', e, { userId })
    return false
  }
}

/** Send a user message and return its Telegram message ID when it is needed for a later edit. */
export async function notifyWithMessage(
  userId: number,
  text: string,
  opts: { plain?: boolean; reply_markup?: any } = {},
): Promise<any | null> {
  try {
    return await bot.api.sendMessage(userId, text, {
      ...(opts.plain ? {} : { parse_mode: 'HTML' as const }),
      ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    })
  } catch (e) {
    if (e instanceof GrammyError && e.error_code === 403) await markBlocked(userId, true).catch(() => {})
    else logError('notify_failed', e, { userId })
    return null
  }
}
