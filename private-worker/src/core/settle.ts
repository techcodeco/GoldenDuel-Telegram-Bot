export type Choice = 'r' | 'p' | 's'
export const CHOICES: readonly Choice[] = ['r', 'p', 's']
export const isChoice = (v: unknown): v is Choice => v === 'r' || v === 'p' || v === 's'

/** Fees in basis points: 1000 = 10%. */
export interface Fees {
  win: number
  draw: number
  winTimeout: number
  drawTimeout: number
}
export type Outcome = 'win' | 'win_timeout' | 'draw' | 'draw_timeout'

export interface Settlement {
  outcome: Outcome
  /** 1 or 2, null on draw */
  winner: 1 | 2 | null
  /** Amount credited back to each player's available balance (both stakes were locked). */
  payout1: number
  payout2: number
  /** Total fee kept by the house. Invariant: payout1 + payout2 + fee === 2 * stake */
  fee: number
}

const BEATS: Record<Choice, Choice> = { r: 's', s: 'p', p: 'r' } // key beats value

/** floor(amount * bp / 10000) without float or overflow issues. Rounding favours the players. */
export function feeOf(amount: number, bp: number): number {
  return Number((BigInt(amount) * BigInt(bp)) / 10000n)
}

export function settle(stake: number, c1: Choice | null, c2: Choice | null, fees: Fees): Settlement {
  const win = (w: 1 | 2, outcome: Outcome, bp: number): Settlement => {
    const fee = feeOf(stake, bp)
    const payout = 2 * stake - fee
    return { outcome, winner: w, payout1: w === 1 ? payout : 0, payout2: w === 2 ? payout : 0, fee }
  }
  if (c1 && c2) {
    if (c1 === c2) {
      const f = feeOf(stake, fees.draw)
      return { outcome: 'draw', winner: null, payout1: stake - f, payout2: stake - f, fee: 2 * f }
    }
    return win(BEATS[c1] === c2 ? 1 : 2, 'win', fees.win)
  }
  if (c1 || c2) return win(c1 ? 1 : 2, 'win_timeout', fees.winTimeout)
  const f = feeOf(stake, fees.drawTimeout)
  return { outcome: 'draw_timeout', winner: null, payout1: stake - f, payout2: stake - f, fee: 2 * f }
}
