import { autoRetry } from '@grammyjs/auto-retry'
import { apiThrottler } from '@grammyjs/transformer-throttler'
import { Bot } from 'grammy'
import { BOT_TOKEN } from '../config'

export const bot = new Bot(BOT_TOKEN)

// The worker sends Telegram API requests only; message handlers and context types stay in private-worker.
bot.api.config.use(apiThrottler())
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }))

/** Apply the same semantic Bot API button colors as private-worker to every queued message. */
function buttonStyle(text: unknown, callbackData?: unknown): 'primary' | 'success' | 'danger' | undefined {
  const label = String(text ?? '').toLowerCase()
  // These main-menu buttons are intentionally plain, including when the worker rebuilds the keyboard.
  if (/friendly duel|duel history|دوئل دوستانه|سابقه\s*دوئل/i.test(label)) return undefined
  const key = `${label} ${String(callbackData ?? '')}`.toLowerCase()
  if (/cancel|reject|withdraw|delete|remove|:no(?:$|:)|dq:x:|bc:cancel|danger|رد دعوت|لغو|برداشت/.test(key)) return 'danger'
  if (/deposit|confirm|approve|accept|save|:yes|bc:confirm|:amt:|واریز|تأیید|تایید|ذخیره|admin:home|btn.admin|مدیریت ربات|backup management|مدیریت بکاپ/.test(key)) return 'success'
  if (/duel|fight|competition|match|rock|paper|scissors|start|دوئل|رقابت|سنگ|کاغذ|قیچی|شروع ربات/.test(key)) return 'primary'
  return undefined
}

bot.api.config.use(async (prev, method, payload, signal) => {
  const p = payload as any
  const markup = p?.reply_markup
  if (Array.isArray(markup?.inline_keyboard)) {
    for (const row of markup.inline_keyboard) for (const button of row ?? []) {
      if (button && !button.style) {
        const style = buttonStyle(button.text, button.callback_data)
        if (style) button.style = style
      }
    }
  }
  if (Array.isArray(markup?.keyboard)) {
    for (const row of markup.keyboard) for (const button of row ?? []) {
      if (button && typeof button === 'object' && !button.style) {
        const style = buttonStyle(button.text)
        if (style) button.style = style
      }
    }
  }
  return prev(method, payload, signal)
})
