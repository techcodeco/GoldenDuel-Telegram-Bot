import assert from 'node:assert/strict'
import test from 'node:test'
import { groupReserveFilter } from '../src/core/services/reserve-filter'

test('a balance exactly equal to the group stake is sufficient', () => {
  const filter = groupReserveFilter(123, 'IRT', 5_000)
  assert.deepEqual(filter, {
    tgId: 123,
    'balances.IRT.available': { $gte: 5_000 },
  })
  assert.equal(5_000 >= filter['balances.IRT.available'].$gte, true)
})

test('a balance below the group stake is insufficient', () => {
  const filter = groupReserveFilter(123, 'IRT', 5_000)
  assert.equal(4_999 >= filter['balances.IRT.available'].$gte, false)
})

test('a balance above the group stake is sufficient', () => {
  const filter = groupReserveFilter(123, 'IRT', 5_000)
  assert.equal(5_001 >= filter['balances.IRT.available'].$gte, true)
})
