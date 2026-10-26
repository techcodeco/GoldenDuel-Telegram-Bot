import { bot } from './instance'
import { logError, logWarn } from '../logger'

type ApiObject = Record<string, unknown>
type RawApi = Record<string, (payload: Record<string, unknown>) => Promise<any>>

const verifiedChats = new Set<string>()
const probeInFlight = new Map<string, Promise<void>>()
const INVISIBLE_PROBE_TEXT = '\u2063'

/**
 * grammY exposes raw Bot API calls via bot.api.raw.<method>(payload); it does
 * not expose bot.api.callApi. A short, invisible probe is used once per chat
 * before any private dashboard content is sent. This fails closed on older or
 * incompatible Bot API servers that silently ignore unknown parameters, so a
 * private dashboard is never intentionally sent as a regular public message.
 */
async function rawCall(method: string, payload: Record<string, unknown>): Promise<any> {
  const raw = (bot.api as any).raw as RawApi
  const call = raw[method]
  if (typeof call !== 'function') throw new Error(`GRAMMY_RAW_METHOD_UNAVAILABLE:${method}`)
  return call(payload)
}

async function verifyEphemeralSupport(chatId: number | string, receiverUserId: number): Promise<void> {
  const key = String(chatId)
  if (verifiedChats.has(key)) return

  const running = probeInFlight.get(key)
  if (running) return running

  const check = (async () => {
    const probe = await rawCall('sendMessage', {
      chat_id: chatId,
      text: INVISIBLE_PROBE_TEXT,
      ephemeral_message_parameters: { receiver_user_id: receiverUserId },
    })

    if (Number.isInteger(probe?.ephemeral_message_id)) {
      verifiedChats.add(key)
      await rawCall('deleteEphemeralMessage', {
        chat_id: chatId,
        receiver_user_id: receiverUserId,
        ephemeral_message_id: probe.ephemeral_message_id,
      }).catch((error) => logWarn('ephemeral_probe_cleanup_failed', { chatId, receiverUserId, err: error }))
      return
    }

    // If the server ignored the new parameter, it may have created a public
    // message. Delete it immediately and do not send any sensitive content.
    if (Number.isInteger(probe?.message_id)) {
      await bot.api.deleteMessage(chatId, Number(probe.message_id)).catch((error) => {
        logError('ephemeral_probe_public_message_cleanup_failed', error, {
          chatId, receiverUserId, messageId: probe.message_id,
        })
      })
    }
    throw new Error('EPHEMERAL_MESSAGES_UNSUPPORTED: Bot API did not return ephemeral_message_id')
  })()

  probeInFlight.set(key, check)
  try {
    await check
  } finally {
    probeInFlight.delete(key)
  }
}

export async function sendEphemeralMessage(
  chatId: number | string,
  receiverUserId: number,
  text: string,
  options: ApiObject = {},
  context: { callbackQueryId?: string; replyMessageId?: number; replyEphemeralMessageId?: number; replaceCallbackQueryMessage?: boolean } = {},
): Promise<any> {
  await verifyEphemeralSupport(chatId, receiverUserId)

  const ephemeral: Record<string, unknown> = { receiver_user_id: receiverUserId }
  if (context.callbackQueryId) ephemeral.callback_query_id = context.callbackQueryId
  if (context.replaceCallbackQueryMessage !== undefined) ephemeral.replace_callback_query_message = context.replaceCallbackQueryMessage
  const payload: ApiObject = { chat_id: chatId, text, ...options, ephemeral_message_parameters: ephemeral }
  if (context.replyEphemeralMessageId) {
    payload.reply_parameters = { ephemeral_message_id: context.replyEphemeralMessageId }
  } else if (context.replyMessageId) {
    payload.reply_parameters = { message_id: context.replyMessageId }
  }

  const sent = await rawCall('sendMessage', payload)
  if (!Number.isInteger(sent?.ephemeral_message_id)) {
    // A defensive guard against a server that stops honoring ephemeral mode.
    if (Number.isInteger(sent?.message_id)) {
      await bot.api.deleteMessage(chatId, Number(sent.message_id)).catch((error) => {
        logError('ephemeral_message_public_cleanup_failed', error, {
          chatId, receiverUserId, messageId: sent.message_id,
        })
      })
    }
    verifiedChats.delete(String(chatId))
    throw new Error('EPHEMERAL_SEND_NOT_PRIVATE: Bot API did not return ephemeral_message_id')
  }
  return sent
}

export async function editEphemeralMessage(
  chatId: number | string,
  receiverUserId: number,
  ephemeralMessageId: number,
  text: string,
  options: ApiObject = {},
): Promise<any> {
  return rawCall('editEphemeralMessageText', {
    chat_id: chatId,
    receiver_user_id: receiverUserId,
    ephemeral_message_id: ephemeralMessageId,
    text,
    ...options,
  })
}


export async function deleteEphemeralMessage(
  chatId: number | string,
  receiverUserId: number,
  ephemeralMessageId: number,
): Promise<any> {
  return rawCall('deleteEphemeralMessage', {
    chat_id: chatId,
    receiver_user_id: receiverUserId,
    ephemeral_message_id: ephemeralMessageId,
  })
}

export function messageReferenceFromCallback(message: any, userId: number) {
  if (!message?.chat?.id) return undefined
  if (Number.isInteger(message.ephemeral_message_id)) {
    return { chatId: message.chat.id, ephemeralMessageId: Number(message.ephemeral_message_id), receiverUserId: userId }
  }
  if (Number.isInteger(message.message_id)) {
    return { chatId: message.chat.id, messageId: Number(message.message_id) }
  }
  return undefined
}

export async function editMessageReference(ref: any, text: string, options: ApiObject = {}) {
  if (!ref) return undefined
  if (ref.ephemeralMessageId && ref.receiverUserId) {
    return editEphemeralMessage(ref.chatId, ref.receiverUserId, ref.ephemeralMessageId, text, options)
  }
  if (ref.messageId) {
    return bot.api.editMessageText(ref.chatId, ref.messageId, text, options as any)
  }
  return undefined
}
