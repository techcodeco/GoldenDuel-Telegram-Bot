import { autoRetry } from '@grammyjs/auto-retry'
import { apiThrottler } from '@grammyjs/transformer-throttler'
import { Bot, type Context } from 'grammy'
import { BOT_TOKEN } from '../config'
import type { Lang } from '../i18n'
import type { CachedUser } from '../services/users'

export type BotContext = Context & { lang: Lang; u: CachedUser | null }

export const bot = new Bot<BotContext>(BOT_TOKEN)


function buttonStyle(text: unknown, callbackData?: unknown): 'primary' | 'success' | 'danger' | undefined {
  const label = String(text ?? '').toLowerCase()
  // These two private-chat main-menu buttons must remain unstyled. Without this
  // guard, the generic `/duel|دوئل/` rule below recolors them blue after the
  // keyboard builder has already removed their style property.
  if (/friendly duel|duel history|دوئل دوستانه|سابقه\s*دوئل/i.test(label)) return undefined

  const key = `${label} ${String(callbackData ?? '')}`.toLowerCase()
  if (/cancel|reject|withdraw|delete|remove|:no(?:$|:)|dq:x:|bc:cancel|danger|رد دعوت|لغو|برداشت/.test(key)) return 'danger'
  if (/deposit|confirm|approve|accept|save|:yes|bc:confirm|:amt:|واریز|تأیید|تایید|ذخیره|admin:home|btn.admin|مدیریت ربات|backup management|مدیریت بکاپ/.test(key)) return 'success'
  if (/duel|fight|competition|match|rock|paper|scissors|start|دوئل|رقابت|سنگ|کاغذ|قیچی|شروع ربات/.test(key)) return 'primary'
  return undefined
}

// Bot API 9.4 supports native primary/green/red styles for inline and reply-keyboard buttons.

// Respect Telegram's flood limits (in-process) and retry on 429 automatically
bot.api.config.use(apiThrottler())
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }))

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
  // Bot API 9.4 also supports `style` on object-shaped KeyboardButton entries.
  // Preserve explicitly selected styles and apply semantic colors to otherwise-unformatted buttons.
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


