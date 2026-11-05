import type { Lang } from './i18n'

/** Human-readable duration that preserves sub-minute timeouts instead of rounding 30 seconds up to 1 minute. */
export function durationLabel(seconds: number, lang: Lang): string {
  const total = Math.max(0, Math.ceil(seconds))
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  const words = {
    fa: { minute: 'دقیقه', second: 'ثانیه', join: ' و ' },
    en: { minute: 'minute', second: 'second', join: ' ' },
    ar: { minute: 'دقيقة', second: 'ثانية', join: ' و ' },
    es: { minute: 'minuto', second: 'segundo', join: ' y ' },
  }[lang]
  const unit = (word: string, amount: number) => {
    if (lang === 'en') return `${word}${amount === 1 ? '' : 's'}`
    if (lang === 'es') return amount === 1 ? word : word === 'minuto' ? 'minutos' : 'segundos'
    return word
  }
  if (minutes === 0) return `${total} ${unit(words.second, total)}`
  if (remainder === 0) return `${minutes} ${unit(words.minute, minutes)}`
  return `${minutes} ${unit(words.minute, minutes)}${words.join}${remainder} ${unit(words.second, remainder)}`
}
