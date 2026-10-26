import test from 'node:test'
import assert from 'node:assert/strict'
import { groupModeNeedsStake, groupDuelHasStake } from '../src/core/contracts/group'

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
