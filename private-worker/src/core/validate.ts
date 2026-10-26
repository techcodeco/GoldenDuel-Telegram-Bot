import { Address } from '@ton/core'
import { type MoneyCurrency, normalizeDigits } from './money'

function luhn(num: string): boolean {
  let sum = 0
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** Returns a normalized bank card / IBAN or TON address, or null if invalid. */
export function parseDest(cur: MoneyCurrency, raw: string): string | null {
  const s = raw.trim()
  if (cur === 'TON') {
    try { return Address.parse(s).toString({ bounceable: false, urlSafe: true }) } catch { return null }
  }
  const d = normalizeDigits(s).toUpperCase().replace(/[-]/g, '')
  if (/^\d{16}$/.test(d)) return luhn(d) ? d : null
  if (/^IR\d{24}$/.test(d)) return d
  return null
}
