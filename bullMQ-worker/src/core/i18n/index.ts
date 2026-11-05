import { en, type Key } from './en'
import { fa } from './fa'
import { ar } from './ar'
import { es } from './es'

export type Lang = 'fa' | 'en' | 'ar' | 'es'
export const LANGS: readonly Lang[] = ['fa', 'en', 'ar', 'es']
export type { Key }

const dict: Record<Lang, Record<Key, string>> = { en, fa, ar, es }

export function t(lang: Lang, key: Key, params?: Record<string, string | number>): string {
  const s = dict[lang][key] ?? dict.en[key]
  return params ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : s
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Reply-keyboard buttons: text (in any language) → action */
export const BUTTON_KEYS = [
  'btn.duel',
  'btn.friendly',
  'btn.balance',
  'btn.finance_history',
  'btn.duel_history',
  'btn.support',
  'btn.deposit',
  'btn.finance',
  'btn.language',
  'btn.profile',
  'btn.admin',
  'btn.withdraw',
  'btn.referral',
  'btn.back',
] as const satisfies readonly Key[]
export type ButtonKey = (typeof BUTTON_KEYS)[number]

const buttonLookup = new Map<string, ButtonKey>()
for (const lang of LANGS) for (const k of BUTTON_KEYS) buttonLookup.set(dict[lang][k], k)

export const matchButton = (text: string): ButtonKey | undefined => buttonLookup.get(text)

export const languageFromText = (text: string): Lang | undefined => {
  for (const lang of LANGS) if (text === dict.en[`lang.${lang}` as Key] || text === dict.fa[`lang.${lang}` as Key] || text === dict.ar[`lang.${lang}` as Key] || text === dict.es[`lang.${lang}` as Key]) return lang
  return undefined
}

const extraLabels: Record<'ar' | 'es', Record<string, string>> = {
  ar: {
    '✅ Confirm & create invoice': '✅ تأكيد وإنشاء الفاتورة', '❌ Cancel': '❌ إلغاء', '❌ Cancel withdrawal': '❌ إلغاء السحب',
    '👤 Users': '👤 المستخدمون', '👥 Groups': '👥 المجموعات', '👤 + 👥 Users and groups': '👤 + 👥 المستخدمون والمجموعات',
    'All eligible users': 'جميع المستخدمين المؤهلين', 'First N users': 'أول N مستخدم', 'Filter current TON/IRT balance': 'تصفية حسب رصيد TON/تومان الحالي',
    'Filter referral count': 'تصفية حسب عدد الإحالات', 'Filter total deposits': 'تصفية حسب إجمالي الإيداعات', 'Filter total withdrawals': 'تصفية حسب إجمالي عمليات السحب',
    '⬅️ Cancel': '⬅️ إلغاء', '🚀 Confirm and start': '🚀 تأكيد وبدء الإرسال', '❌ Cancel campaign': '❌ إلغاء الحملة', '⬅️ Previous': '⬅️ السابق', 'Next ➡️': 'التالي ➡️', '📣 Broadcast': '📣 رسالة جماعية', '✅ Check membership': '✅ التحقق من العضوية',
  },
  es: {
    '✅ Confirm & create invoice': '✅ Confirmar y crear factura', '❌ Cancel': '❌ Cancelar', '❌ Cancel withdrawal': '❌ Cancelar retirada',
    '👤 Users': '👤 Usuarios', '👥 Groups': '👥 Grupos', '👤 + 👥 Users and groups': '👤 + 👥 Usuarios y grupos',
    'All eligible users': 'Todos los usuarios aptos', 'First N users': 'Primeros N usuarios', 'Filter current TON/IRT balance': 'Filtrar saldo actual TON/IRT',
    'Filter referral count': 'Filtrar número de referidos', 'Filter total deposits': 'Filtrar depósitos totales', 'Filter total withdrawals': 'Filtrar retiradas totales',
    '⬅️ Cancel': '⬅️ Cancelar', '🚀 Confirm and start': '🚀 Confirmar e iniciar', '❌ Cancel campaign': '❌ Cancelar campaña', '⬅️ Previous': '⬅️ Anterior', 'Next ➡️': 'Siguiente ➡️', '📣 Broadcast': '📣 Difusión', '✅ Check membership': '✅ Comprobar membresía',
  },
}

export function text4(lang: Lang, faText: string, enText: string): string {
  if (lang === 'fa') return faText
  if (lang === 'en') return enText
  return extraLabels[lang][enText] ?? enText
}
