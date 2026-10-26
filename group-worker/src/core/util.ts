import { User } from './models/index'

export const normalize = (s: string) => s.normalize('NFKC').replace(/[ي]/g,'ی').replace(/[ك]/g,'ک').trim().toLocaleLowerCase('en-US')
const triggers: Record<string,string> = {
  fight:'fight', '/fight':'fight', duel:'fight', '/duel':'fight', competition:'fight', '/competition':'fight', 'دوئل':'fight', 'فایت':'fight', 'رقابت':'fight',
  help:'help', '/help':'help', guide:'help', '/guide':'help', 'راهنما':'help', 'کمک':'help',
  dashboard:'dashboard', '/dashboard':'dashboard', panel:'dashboard', '/panel':'dashboard', management:'dashboard', '/management':'dashboard', 'پنل':'dashboard', 'پانل':'dashboard', 'مدیریت':'dashboard', 'داشبورد':'dashboard'
}
export function exactTrigger(text: string | undefined): string | null {
  if (!text) return null
  const s = normalize(text)
  if (!s.startsWith('/')) return triggers[s] ?? null
  if (!/^\/[a-z]+(?:@[a-z0-9_]+)?$/i.test(s)) return null
  const at = s.indexOf('@')
  const command = at >= 0 ? s.slice(0, at) : s
  const addressedTo = at >= 0 ? s.slice(at + 1) : ''
  const botUsername = (process.env.BOT_USERNAME ?? '').replace(/^@/, '').toLocaleLowerCase('en-US')
  if (addressedTo && botUsername && addressedTo !== botUsername) return null
  return triggers[command] ?? null
}
export const langOf = (v: unknown): 'fa'|'en' => v === 'en' ? 'en' : 'fa'
export const tr = (lang: 'fa'|'en', fa: string, en: string) => lang === 'fa' ? fa : en
export const esc = (s: unknown) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
export const curLabel = (cur: string, lang: 'fa'|'en') => cur === 'IRT' ? (lang === 'fa' ? 'تومان' : 'Toman') : 'TON'
export const fmt = (n: number, cur: string) => cur === 'TON' ? (n / 1e9).toLocaleString('en-US',{maximumFractionDigits:9}) : Math.round(n).toLocaleString('en-US')
export const mention = (u: any, lang: 'fa'|'en' = 'fa') => { const name = [u?.first_name ?? u?.firstName, u?.last_name ?? u?.lastName].filter(Boolean).join(' ') || (lang === 'fa' ? 'کاربر' : 'Player'); return `<a href="tg://user?id=${Number(u?.id)}">${esc(name)}</a>` }
export const userStarted = async (id: number) => Boolean(await User.exists({ tgId: id, lang: { $in: ['fa','en'] } }))
export const startKeyboard = (lang:'fa'|'en') => { const username=(process.env.BOT_USERNAME??'').replace(/^@/,'').trim(); return username ? { inline_keyboard: [[{ text: tr(lang,'▶️ شروع ربات','▶️ Start bot'), url: `https://t.me/${username}?start=group_duel` }]] } : undefined }
export const getUser = async (id: number) => User.findOne({ tgId: id }).lean() as any
export const groupKeyboard = (rows: Array<Array<{text:string; callback_data:string}>>) => ({
  inline_keyboard: rows.map((row) => row.map((button) => ({
    ...button,
    style: /reject|cancel|:back|disable|delete|:no(?:$|:)/i.test(`${button.callback_data} ${button.text}`) ? 'danger'
      : /accept|confirm|:amt:|save|yes|approve|enable|:both/i.test(`${button.callback_data} ${button.text}`) ? 'success'
        : 'primary',
  }))),
})
