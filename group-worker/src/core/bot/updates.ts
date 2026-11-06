import { bot, exactTrigger, langOf, tr } from '../runtime'
import { GroupConfig, GroupTarget } from '../models/index'
import { saveGroup, sendWelcome, sendHelp, sendDashboard } from '../services/group'
import { beginFlow } from '../services/duel-flow'
import { handleCallback } from './callbacks'
import { sendEphemeralMessage } from './ephemeral'
import { logError } from '../logger'

export async function handleUpdate(fields: Record<string, string>) {
  const raw = fields.d
  if (!raw) return
  const u = JSON.parse(raw)

  if (u.my_chat_member) {
    const ev = u.my_chat_member
    const chat = ev.chat
    const status = ev.new_chat_member?.status
    const actor = Number(ev.from?.id)
    if (chat?.type === 'group' || chat?.type === 'supergroup') {
      const active = ['member', 'administrator'].includes(status) || (status === 'restricted' && ev.new_chat_member?.is_member === true)
      const removed = ['left', 'kicked'].includes(status) || (status === 'restricted' && ev.new_chat_member?.is_member === false)
      if (active) {
        // A fresh add after a leave/kick starts a clean group installation and assigns
        // the user who added the bot as the new activator, even if an earlier leave
        // update was missed by the gateway.
        const wasRemoved = ['left', 'kicked'].includes(ev.old_chat_member?.status)
          || (ev.old_chat_member?.status === 'restricted' && ev.old_chat_member?.is_member === false)
        if (wasRemoved) await saveGroup(chat, actor, 'left')
        await saveGroup(chat, actor, 'active')
        if (wasRemoved) await sendWelcome(chat, actor)
      } else if (removed) {
        await saveGroup(chat, actor, 'left')
      }
    }
    return
  }

  if (u.callback_query) {
    await handleCallback(u)
    return
  }

  const m = u.message
  if (!m || !['group', 'supergroup'].includes(m.chat?.type) || !m.from || m.from.is_bot) return
  const chatId = String(m.chat.id)
  const cfg = await GroupConfig.findOne({ chatId }).lean() as any
  if (!cfg || !cfg.enabled) return
  if (m.chat.title && String(m.chat.title) !== String(cfg.title ?? '')) {
    cfg.title = String(m.chat.title)
    await Promise.all([
      GroupConfig.updateOne({ chatId }, { $set: { title: cfg.title } }),
      GroupTarget.updateOne({ chatId }, { $set: { title: cfg.title, username: String(m.chat.username ?? ''), lastSeenAt: new Date() } }),
    ])
  }
  const lang = langOf(cfg.language)
  const trigger = exactTrigger(m.text)
  if (!trigger) return

  if (trigger === 'help') {
    await sendHelp(m.chat.id, lang, Number(m.from.id), Number(m.message_id))
      .catch((error) => logError('group_private_help_send_failed', error, { chatId, userId: m.from.id, messageId: m.message_id }))
    return
  }

  if (trigger === 'dashboard') {
    if (Number(cfg.activatorId) !== Number(m.from.id)) {
      try {
        await sendEphemeralMessage(m.chat.id, Number(m.from.id), tr(lang,
          '⛔ فقط فعال‌کنندهٔ این گروه اجازهٔ دسترسی به پنل مدیریت را دارد.',
          '⛔ Only this group’s activator can access its management panel.',
        ), {}, { replyMessageId: Number(m.message_id) })
      } catch (error) {
        // Never expose access-control notices as public group messages.
        logError('ephemeral_access_denied_notice_failed', error, { chatId: m.chat.id, userId: m.from.id })
      } finally {
        await bot.api.deleteMessage(m.chat.id, Number(m.message_id)).catch(() => undefined)
      }
      return
    }
    try {
      await sendDashboard(chatId, Number(m.from.id), cfg, Number(m.message_id))
    } catch (error) {
      logError('dashboard_request_failed', error, { chatId, userId: m.from.id, messageId: m.message_id })
    } finally {
      await bot.api.deleteMessage(m.chat.id, Number(m.message_id)).catch(() => undefined)
    }
    return
  }

  if (trigger === 'fight') {
    const reply = m.reply_to_message
    if (!reply) {
      // No reply target means an open group challenge: any eligible member may
      // accept it, and the first successful callback becomes the opponent.
      await beginFlow(chatId, m.from, undefined, Number(m.message_id))
      return
    }
    if (!reply.from || reply.from.is_bot || Number(reply.from.id) === Number(m.from.id)) {
      try {
        await sendEphemeralMessage(m.chat.id, Number(m.from.id), tr(lang,
          'برای دعوت مستقیم، باید روی پیام یک کاربر دیگر ریپلای کنی. برای ساخت دوئل عمومی، فقط واژهٔ دوئل را بدون ریپلای بفرست.',
          'For a direct challenge, reply to another user. To create an open duel, send the duel keyword without replying.',
        ), {}, { replyMessageId: Number(m.message_id) })
      } catch (error) {
        logError('invalid_group_challenge_notice_failed', error, { chatId, userId: m.from.id })
      } finally {
        await bot.api.deleteMessage(m.chat.id, Number(m.message_id)).catch(() => undefined)
      }
      return
    }
    await beginFlow(chatId, m.from, reply.from, Number(m.message_id), Number(reply.message_id))
  }
}
