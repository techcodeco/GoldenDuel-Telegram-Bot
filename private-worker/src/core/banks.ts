import { normalizeDigits } from './money'

export const bankData = [
  { bank: 'بانک مرکزی', code: '010' },
  { bank: 'بانک صنعت و معدن', code: '011' },
  { bank: 'بانک ملت', code: '012' },
  { bank: 'بانک رفاه', code: '013' },
  { bank: 'بانک مسکن', code: '014' },
  { bank: 'بانک سپه', code: '015' },
  { bank: 'بانک کشاورزی', code: '016' },
  { bank: 'بانک ملی ایران', code: '017' },
  { bank: 'بانک تجارت', code: '018' },
  { bank: 'بانک صادرات ایران', code: '019' },
  { bank: 'بانک توسعه صادرات ایران', code: '020' },
  { bank: 'پست بانک ایران', code: '021' },
  { bank: 'بانک مؤسسه اعتباری توسعه', code: '051' },
  { bank: 'بانک کارآفرین', code: '053' },
  { bank: 'بانک پارسیان', code: '054' },
  { bank: 'بانک اقتصاد نوین', code: '055' },
  { bank: 'بانک سامان', code: '056' },
  { bank: 'بانک پاسارگاد', code: '057' },
  { bank: 'بانک سرمایه', code: '058' },
] as const

/** Accept Iranian IBAN with or without the IR prefix; return a canonical IR-prefixed value only when checksum is valid. */
export function normalizeIranianIban(raw: string): string | null {
  const normalized = normalizeDigits(raw).toUpperCase().replace(/[\s-]/g, '')
  const digits = normalized.startsWith('IR') ? normalized.slice(2) : normalized
  if (!/^\d{24}$/.test(digits)) return null
  // ISO 13616 mod-97 check: BBAN + numeric country code (I=18, R=27) + check digits.
  const rearranged = digits.slice(2) + '1827' + digits.slice(0, 2)
  let remainder = 0
  for (const char of rearranged) remainder = (remainder * 10 + Number(char)) % 97
  if (remainder !== 1) return null
  return `IR${digits}`
}

/** Identify the bank from the 3-digit bank identifier, not from the checksum digits. */
export function getBankNameFromShaba(raw: string): { bank: string; code: string } | false {
  const normalized = normalizeDigits(raw).toUpperCase().replace(/[\s-]/g, '')
  const digits = normalized.startsWith('IR') ? normalized.slice(2) : normalized
  if (!/^\d{24}$/.test(digits)) return false
  const code = digits.slice(2, 5)
  return bankData.find((entry) => entry.code === code) ?? false
}

export function maskIranianIban(iban: string): string {
  return iban.length === 26 ? `${iban.slice(0, 6)}${'•'.repeat(16)}${iban.slice(-4)}` : iban
}
