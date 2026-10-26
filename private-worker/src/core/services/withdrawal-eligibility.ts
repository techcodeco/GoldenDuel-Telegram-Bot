import { GroupDuel, Match } from '../models'

/**
 * Counts settled conditional (bet) duels completed by the user.
 * Friendly duels are deliberately excluded. Both private duels and group duels
 * count toward the withdrawal requirement. Records must explicitly have mode `bet`;
 * unknown or legacy mode values are not counted as conditional duels.
 */
export async function countConditionalDuelsForWithdrawal(userId: number): Promise<number> {
  const [privateDuels, groupDuels] = await Promise.all([
    Match.countDocuments({
      status: 'settled',
      mode: 'bet',
      $or: [{ p1: userId }, { p2: userId }],
    }),
    GroupDuel.countDocuments({
      status: 'settled',
      mode: 'bet',
      $or: [{ initiatorId: userId }, { opponentId: userId }],
    }),
  ])

  return privateDuels + groupDuels
}
