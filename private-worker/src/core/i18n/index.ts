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
  'btn.add_group',
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

export { text4 } from './labels'
