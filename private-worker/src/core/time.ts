import type { Lang } from './i18n'

/** Human-readable duration that preserves sub-minute timeouts instead of rounding 30 seconds up to 1 minute. */
export function durationLabel(seconds: number, lang: Lang): string {
  const total = Math.max(0, Math.ceil(seconds))
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  const minuteWord = lang === 'fa' ? 'دقیقه' : 'minute'
  const secondWord = lang === 'fa' ? 'ثانیه' : 'second'

  if (minutes === 0) return `${total} ${secondWord}${lang === 'en' && total !== 1 ? 's' : ''}`
  if (remainder === 0) return `${minutes} ${minuteWord}${lang === 'en' && minutes !== 1 ? 's' : ''}`
  const secondsText = `${remainder} ${secondWord}${lang === 'en' && remainder !== 1 ? 's' : ''}`
  return lang === 'fa' ? `${minutes} ${minuteWord} و ${secondsText}` : `${minutes} ${minuteWord}${minutes !== 1 ? 's' : ''} ${secondsText}`
}
