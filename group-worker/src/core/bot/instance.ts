import { Bot } from 'grammy'
import { TOKEN } from '../config'

export const bot = new Bot(TOKEN)

function buttonStyle(text: unknown, callbackData?: unknown): 'primary' | 'success' | 'danger' | undefined {
  const key = `${String(text ?? '')} ${String(callbackData ?? '')}`.toLowerCase()
  if (/cancel|reject|withdraw|delete|remove|:no(?:$|:)|dq:x:|bc:cancel|danger|رد دعوت|لغو|برداشت/.test(key)) return 'danger'
  if (/deposit|confirm|approve|accept|save|:yes|bc:confirm|:amt:|واریز|تأیید|تایید|ذخیره|مدیریت ربات|admin:home/.test(key)) return 'success'
  if (/duel|fight|competition|match|rock|paper|scissors|start|دوئل|رقابت|سنگ|کاغذ|قیچی/.test(key)) return 'primary'
  return undefined
}

// Bot API 9.4 supports native primary/green/red styles for inline and reply-keyboard buttons.
bot.api.config.use(async (prev, method, payload, signal) => {
  const p = payload as any
  const markup = p?.reply_markup
  if (Array.isArray(markup?.inline_keyboard)) {
    for (const row of markup.inline_keyboard) for (const button of row ?? []) {
      if (button && !button.style) button.style = buttonStyle(button.text, button.callback_data)
    }
  }
  // Bot API 9.4 supports style on object-shaped reply-keyboard buttons too.
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

