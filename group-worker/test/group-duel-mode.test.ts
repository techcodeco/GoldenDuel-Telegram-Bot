import test from 'node:test'
import assert from 'node:assert/strict'
import { groupModeNeedsStake, groupDuelHasStake, isOpenGroupChallenge } from '../src/core/contracts/group'

test('friendly group duel bypasses currency and stake selection', () => {
  assert.equal(groupModeNeedsStake('friendly'), false)
  assert.equal(groupModeNeedsStake('bet'), true)
})

test('new friendly duels do not reserve funds, while bet duels do', () => {
  assert.equal(groupDuelHasStake({ mode: 'friendly', currency: null, amount: 0 }), false)
  assert.equal(groupDuelHasStake({ mode: 'bet', currency: 'IRT', amount: 10_000 }), true)
})

test('legacy stake-bearing friendly duels remain refundable during rollout', () => {
  assert.equal(groupDuelHasStake({ mode: 'friendly', currency: 'TON', amount: 100_000_000 }), true)
})


test('an open group challenge has no fixed opponent until the first acceptance', () => {
  assert.equal(isOpenGroupChallenge({ openChallenge: true, opponentId: 0 }), true)
  assert.equal(isOpenGroupChallenge({ openChallenge: false, opponentId: 0 }), true)
  assert.equal(isOpenGroupChallenge({ openChallenge: true, opponentId: 123 }), false)
  assert.equal(isOpenGroupChallenge({ openChallenge: false, opponentId: 123 }), false)
})
