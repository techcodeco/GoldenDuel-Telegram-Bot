/** Build the atomic wallet predicate used by group bet reservations. */
export function groupReserveFilter(userId: number, currency: string, amount: number) {
  return {
    tgId: userId,
    [`balances.${currency}.available`]: { $gte: amount },
  }
}

