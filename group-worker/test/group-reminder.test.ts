import test from 'node:test'
import assert from 'node:assert/strict'
import { groupReminderAt } from '../src/core/contracts/group'

test('group move reminder runs after 85% of the move window', () => {
  assert.equal(groupReminderAt(1_000, 32), 28_200)
  assert.equal(groupReminderAt(10_000, 180), 163_000)
})

test('group move reminder rejects invalid durations', () => {
  assert.throws(() => groupReminderAt(1_000, 0), /INVALID_GROUP_MOVE_DURATION/)
  assert.throws(() => groupReminderAt(Number.NaN, 32), /INVALID_GROUP_MOVE_DURATION/)
})
