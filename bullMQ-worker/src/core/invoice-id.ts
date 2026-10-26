import { randomInt } from 'node:crypto'

/** Generate an unpredictable 7-digit human-readable invoice number. */
export function randomInvoiceNumber(): number {
  return randomInt(1_000_000, 10_000_000)
}

export function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 11000)
}
