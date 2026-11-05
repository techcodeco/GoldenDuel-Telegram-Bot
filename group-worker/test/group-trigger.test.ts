import assert from 'node:assert/strict'
import test from 'node:test'
import { exactTrigger } from '../src/core/util'

test('group worker recognizes the same Persian challenge words as gateway', () => {
  for (const word of ['دوئل', 'فایت', 'رقابت', 'چالش', 'چلنج', 'چالنج']) {
    assert.equal(exactTrigger(word), 'fight', word)
  }
})

test('group worker recognizes supported English challenge words and commands', () => {
  for (const word of ['duel', '/duel', 'fight', '/fight', 'challenge', '/challenge', 'competition', '/competition']) {
    assert.equal(exactTrigger(word), 'fight', word)
  }
})

test('help and management words remain separate from duel routing', () => {
  assert.equal(exactTrigger('راهنما'), 'help')
  assert.equal(exactTrigger('guide'), 'help')
  assert.equal(exactTrigger('پنل'), 'dashboard')
  assert.equal(exactTrigger('panel'), 'dashboard')
  assert.equal(exactTrigger('این فقط یک پیام عادی است'), null)
})
