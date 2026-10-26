/** Active currencies: IRT (whole toman) and native TON stored as nanoTON (9 decimals). */
export type Currency = 'IRT' | 'TON'
export type MoneyCurrency = Currency
export const CURRENCIES: readonly Currency[] = ['IRT', 'TON']
export const DECIMALS: Record<MoneyCurrency, number> = { IRT: 0, TON: 9 }
export const isCurrency = (v: unknown): v is Currency => v === 'IRT' || v === 'TON'
export const isMoneyCurrency = isCurrency

/** Persian/Arabic digits → latin, strips thousand separators and spaces. */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[۰-۹٠-٩]/g, (ch) => {
      const c = ch.charCodeAt(0)
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660)
    })
    .replace(/٫/g, '.')
    .replace(/[٬,،\s_]/g, '')
}

/** Parse a user-entered amount into the currency's smallest unit (never a float balance). */
export function parseAmount(input: string, cur: Currency): number | null {
  const d = DECIMALS[cur]
  const m = new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${d || 1}}))?$`).exec(normalizeDigits(input.trim()))
  if (!m) return null
  const frac = m[2] ?? ''
  if (frac.length > d) return null
  const units = Number(m[1]) * 10 ** d + (frac ? Number(frac.padEnd(d, '0')) : 0)
  return Number.isSafeInteger(units) && units > 0 ? units : null
}

export function formatAmount(units: number, cur: MoneyCurrency): string {
  const d = DECIMALS[cur]
  const neg = units < 0
  const s = String(Math.abs(units)).padStart(d + 1, '0')
  const int = d ? s.slice(0, -d) : s
  const frac = d ? s.slice(-d).replace(/0+$/, '') : ''
  return (neg ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '')
}
